# Shared Browser & Write-Concurrency Guard — Design

**Date:** 2026-06-10
**Status:** Approved (design); pending implementation plan

## Purpose

Today every tool (`follow-bot`, `chain-runner`, `prospect`, `dm-bot`, `unfollow-bot`) calls `launchPersistentContext(PROFILE_DIR, …)` on the same `.chrome-profile` directory. Chrome enforces a single-instance lock per user-data-dir (`SingletonLock`), so a second tool launched while one is running collides — they fight over the same window or the second errors out.

We want to run multiple tools at once — specifically a write tool (e.g. `follow`/`chain`) alongside a read-only tool (e.g. `prospect enrich`, "seeding") — sharing one logged-in session, without collision. We also want a guard that prevents two *write* tools of the **same kind** from running concurrently, since that would multiply velocity past the daily caps the pacing system enforces. Writes are grouped into categories (`follow`-graph mutations vs `dm`), so tools in different categories — e.g. a follow tool and `dm --live` — may run together, but two follow-graph tools (or two `dm --live`) may not.

## Architecture

Two new, independent modules plus call-site changes:

- **`browser.ts`** — owns all browser acquisition. Connect-or-launch over CDP so one Chrome process is shared.
- **`write-lock.ts`** — a file lock ensuring at most one *write* tool runs at a time. Orthogonal to browser sharing.

```
first write/read tool starts
  → acquireWriteLock (write tools only)        [write-lock.ts]
  → acquireBrowser                              [browser.ts]
       connectOverCDP(:9222) ?
         success → CONNECTOR (reuse shared context, release = disconnect)
         fail    → OWNER (launchPersistentContext + --remote-debugging-port,
                          release = close browser)
  → run loop (open own page(s) in the shared persistent context)
  → finally: release browser, release write-lock
```

### Reused / preserved

- Not-logged-in detection, rate-limit cooldowns, daily caps, burst pacing — all unchanged. Only *how the browser is obtained* changes.
- `PROFILE_DIR` stays the single `.chrome-profile`; one login serves all tools.

## Component: `browser.ts`

Exports:

```ts
acquireBrowser(): Promise<{ context: BrowserContext; release: () => Promise<void> }>
```

Behavior:

1. Try `chromium.connectOverCDP("http://localhost:<CDP_PORT>")`.
   - **Success → CONNECTOR role.** Reuse the existing logged-in persistent context (`browser.contexts()[0]`). `release()` disconnects only — it never closes the shared Chrome.
2. Connect fails → **OWNER role.** `launchPersistentContext(PROFILE_DIR, { headless: false, channel: "chrome", args: ["--remote-debugging-port=<CDP_PORT>", …existing automation-hiding flags] })`. `release()` closes the context (which closes the browser).

Both roles return the **one shared persistent context** — that is where login cookies live. The module never calls `newContext()` (a fresh context would be logged out). If `connectOverCDP` succeeds but `browser.contexts()` is empty, throw a clear error rather than opening a logged-out page.

`CDP_PORT` is a new constant in `config.ts` (default `9222`).

### Call-site changes

Replace the two `launchBrowser()` definitions (`follow-bot.ts`, `unfollow-bot.ts`) and update all call sites to use `acquireBrowser()`:

- `follow-bot.ts`: `login` and `follow`
- `chain-runner.ts`: chain loop
- `prospect.ts`: `sync` and `enrich`
- `dm-bot.ts`: `send`
- `unfollow-bot.ts`: scan and unfollow

Each call site changes from `const context = await launchBrowser(); … await context.close()` to `const { context, release } = await acquireBrowser(); … await release()`. Tools open their own page(s) via `context.newPage()` and close those pages in their `finally` before calling `release()`.

`follow-bot.ts` currently exports `launchBrowser`; that export is removed and importers switch to `browser.ts`.

## Component: `write-lock.ts`

Tool classification — write tools are grouped into **categories**; the lock is per-category, so tools in *different* categories can run concurrently, but two tools in the *same* category cannot:

- **`follow` category** (graph mutations — share one lock): `follow`, `chain`, `unfollow`. These all change who you follow; running two at once doubles follow velocity, and `follow` + `unfollow` together is the heavily-flagged follow-churn pattern.
- **`dm` category** (own lock): `dm --live`. DMs are a separate action with their own limit, so `dm --live` may run **concurrently with a follow-category tool** (e.g. `follow` + `dm --live`), but not with another `dm --live`.
- **Read** (never touch any lock): `prospect sync` / `enrich` / `filter`, `dm` dry-run, `login`.

Lock file is per category: `output/.write-<category>.lock` (e.g. `.write-follow.lock`, `.write-dm.lock`), JSON `{ tool, pid, startedAt }`.

Pure decision core (unit-tested):

```ts
type LockInfo = { tool: string; pid: number; startedAt: string };
decideLock(existing: LockInfo | null, isAlive: (pid: number) => boolean, force: boolean):
  "acquire" | "reclaim" | "refuse" | "bypass";
```

- no existing lock → `"acquire"`
- existing + PID alive + not force → `"refuse"`
- existing + PID alive + force → `"bypass"` (proceed but do NOT overwrite the holder's lock, so the holder isn't orphaned; caller logs a warning)
- existing + PID dead (stale) → `"reclaim"`

Imperative shell:

```ts
type WriteCategory = "follow" | "dm";
acquireWriteLock(category: WriteCategory, tool: string, force: boolean): () => void  // returns release()
```

- Reads `output/.write-<category>.lock` (if any), calls `decideLock` with `isAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }`. Only the lock for *this* category is consulted — a `dm --live` ignores the `follow` lock and vice-versa.
- `"refuse"` → print the refusal and `process.exit(1)`:
  ```
  ✋ '<holder.tool>' is already running (pid <holder.pid>, since <startedAt>).
  Another '<category>' write tool would double velocity past the daily cap. Refusing.
  (use --force to override)
  ```
- `"acquire"`/`"reclaim"` → write the lock file with this process's `{ tool, pid, startedAt }`, return `release()` which deletes the file.
- `"bypass"` (force over a live holder) → log a prominent warning ("⚠ --force: write-guard bypassed, running concurrently with '<holder.tool>'") and return a **no-op `release()`** that leaves the holder's lock untouched.

Lifecycle: write tools acquire their category's lock at startup, **before** `acquireBrowser()`. Release in a `finally`, and also register a `process.on("SIGINT")` / `process.on("exit")` best-effort cleanup so Ctrl-C frees it. The stale-PID check is the real safety net for hard kills.

Each write tool's CLI parses a `--force` flag and threads it into `acquireWriteLock` along with its category (`follow` for `follow`/`chain`/`unfollow`, `dm` for `dm --live`).

## Login flow

`npm run login` uses `acquireBrowser()` like everything else: attaches if a shared browser is up (opens `x.com/login` in a page there), otherwise becomes the owner. It is **not** a write tool — no lock. Caveat documented for the user: if logging in while other tools are attached, finish the login before the owner tool exits.

## Error Handling

- **Owner exits while a connector is live:** the connector's next Playwright call throws a disconnect error. Catch at the tool's top level and exit with: "Shared browser closed (the owning tool exited). Restart this tool." README guidance: **start the longer-running tool first** (e.g. `chain`/`enrich` before a short `follow` run).
- **Stale port / zombie Chrome:** if `connectOverCDP` fails *and* `launchPersistentContext` then fails with a `SingletonLock`/port error, surface: "A browser may be half-running — close stray Chrome windows using this profile, or check port `<CDP_PORT>`." No automatic process killing.
- **Empty `contexts()` after connect:** throw a clear error (never open a logged-out page).
- **Write-lock before browser:** cheap, fast failure path; releasing happens in reverse order in `finally`.

## Testing

- **Unit (`write-lock.test.ts`, `node:test`):** `decideLock` across all four outcomes — `acquire` (no lock), `refuse` (live holder, no force), `bypass` (live holder + force), `reclaim` (dead/stale holder) — with an injected `isAlive`. No filesystem or real processes touched.
- **Smoke (manual, deferred — need a logged-in browser):**
  1. Terminal A `enrich`, then Terminal B `follow` → both attach to one window, no `SingletonLock` error.
  2. `follow`, then `chain` → second refuses with the guard message; `chain --force` overrides.
  3. `kill -9` a write tool, then start another write tool → stale lock reclaimed.
- **No unit test for the CDP connect/launch branch** — it is I/O against a live browser, covered by the smoke runs (consistent with how `prospect`/`dm-bot` browser code is verified).

## Out of Scope

- A persistent keep-alive browser daemon that survives all tools exiting (explicitly declined in favor of auto-launch-on-first-use).
- Finer-grained locks beyond the two categories (`follow`, `dm`). If a future action type needs its own concurrency lane, add a category; v1 ships these two.
- Coordinating daily caps across concurrent tools (the per-category write locks make this unnecessary — within a category only one tool runs; across categories the action types are independent; reads have their own caps).

## Constants (added to `config.ts`)

- `CDP_PORT = 9222` — debug port the shared browser listens on / tools connect to.
- Write-lock files are derived per category as `path.join(OUTPUT_DIR, ".write-<category>.lock")` (no single constant needed).
