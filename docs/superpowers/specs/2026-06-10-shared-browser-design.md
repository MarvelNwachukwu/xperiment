# Shared Browser & Write-Concurrency Guard — Design

**Date:** 2026-06-10
**Status:** Approved (design); pending implementation plan

## Purpose

Today every tool (`follow-bot`, `chain-runner`, `prospect`, `dm-bot`, `unfollow-bot`) calls `launchPersistentContext(PROFILE_DIR, …)` on the same `.chrome-profile` directory. Chrome enforces a single-instance lock per user-data-dir (`SingletonLock`), so a second tool launched while one is running collides — they fight over the same window or the second errors out.

We want to run multiple tools at once — specifically a write tool (e.g. `follow`/`chain`) alongside a read-only tool (e.g. `prospect enrich`, "seeding") — sharing one logged-in session, without collision. We also want a guard that prevents two *write* tools from running concurrently, since that would multiply follow/unfollow velocity past the daily caps the pacing system enforces.

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

Tool classification:

- **Write** (acquire the lock): `follow`, `chain`, `unfollow`, `dm --live`
- **Read** (never touch the lock): `prospect sync` / `enrich` / `filter`, `dm` dry-run, `login`

Lock file: `output/.write.lock`, JSON `{ tool, pid, startedAt }`.

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
acquireWriteLock(tool: string, force: boolean): () => void  // returns release()
```

- Reads `output/.write.lock` (if any), calls `decideLock` with `isAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }`.
- `"refuse"` → print the refusal and `process.exit(1)`:
  ```
  ✋ '<holder.tool>' is already running (pid <holder.pid>, since <startedAt>).
  Running two write tools doubles follow velocity past the daily cap. Refusing.
  (use --force to override)
  ```
- `"acquire"`/`"reclaim"` → write the lock file with this process's `{ tool, pid, startedAt }`, return `release()` which deletes the file.
- `"bypass"` (force over a live holder) → log a prominent warning ("⚠ --force: write-guard bypassed, running concurrently with '<holder.tool>'") and return a **no-op `release()`** that leaves the holder's lock untouched.

Lifecycle: write tools acquire the lock at startup, **before** `acquireBrowser()`. Release in a `finally`, and also register a `process.on("SIGINT")` / `process.on("exit")` best-effort cleanup so Ctrl-C frees it. The stale-PID check is the real safety net for hard kills.

Each write tool's CLI parses a `--force` flag and threads it into `acquireWriteLock`.

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
- Per-action-type write locks (e.g. allowing `dm --live` concurrently with `follow`). v1 uses one global write lock for simplicity; revisit if needed.
- Coordinating daily caps across concurrent tools (the single write lock makes this unnecessary for writes; reads have their own caps).

## Constants (added to `config.ts`)

- `CDP_PORT = 9222` — debug port the shared browser listens on / tools connect to.
- `WRITE_LOCK_FILE = path.join(OUTPUT_DIR, ".write.lock")`.
