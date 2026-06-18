# Shared Browser & Write-Concurrency Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let multiple tools run at once by sharing one logged-in Chrome over CDP (`browser.ts`), and prevent two same-category write tools from running concurrently with a per-category file lock (`write-lock.ts`) — while letting `dm --live` run alongside a follow tool.

**Architecture:** A new `browser.ts` provides `acquireBrowser()` that connects to an already-running shared Chrome over CDP or launches one (owner) with `--remote-debugging-port`. A new `write-lock.ts` provides `acquireWriteLock(category, tool, force)` backed by a pure `decideLock`. Every tool's `launchBrowser()` call is replaced by `acquireBrowser()`; write tools additionally acquire their category's lock.

**Tech Stack:** TypeScript, Playwright (Chrome) over CDP, `tsx`, Node's `node:test`. No new dependencies.

**Branch / dependency:** Implement on `feat/shared-browser` (already created, stacked on `feat/profile-pipeline` where `prospect.ts`/`dm-bot.ts`/`config OUTPUT_DIR` live). Spec: `docs/superpowers/specs/2026-06-10-shared-browser-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `browser.ts` (new) | `acquireBrowser()` — connect-or-launch the shared Chrome; returns `{context, release}`. |
| `write-lock.ts` (new) | `decideLock` (pure) + `acquireWriteLock(category, tool, force)` per-category file lock. |
| `write-lock.test.ts` (new) | Unit tests for `decideLock`. |
| `config.ts` (modify) | Add `CDP_PORT`. |
| `follow-bot.ts` (modify) | Remove local `launchBrowser`; use `acquireBrowser`; `follow` acquires `follow` lock + `--force`. |
| `chain-runner.ts` (modify) | Use `acquireBrowser`; acquire `follow` lock + `--force`. |
| `unfollow-bot.ts` (modify) | Remove local `launchBrowser`; use `acquireBrowser`; `unfollow` acquires `follow` lock + `--force`. |
| `prospect.ts` (modify) | Use `acquireBrowser` (read-only — no lock). |
| `dm-bot.ts` (modify) | Use `acquireBrowser`; acquire `dm` lock when `--live`; `--force`. |
| `README.md` (modify) | Document shared browser + write guard. |

---

## Task 1: `browser.ts` + `CDP_PORT`

**Files:** Modify `config.ts`; Create `browser.ts`. Browser-driven core — verified by type-check now, smoke later (no unit test).

- [ ] **Step 1: Add `CDP_PORT` to `config.ts`**

Append to `config.ts` (after the `PROFILE_DIR` line in the Paths section, or at end — anywhere top-level):

```typescript
// ── Shared Browser ────────────────────────────────────────────
// Debug port the first ("owner") tool launches Chrome on; later tools connect
// to it over CDP so one logged-in browser is shared. See browser.ts.
export const CDP_PORT = 9222;
```

- [ ] **Step 2: Create `browser.ts`**

```typescript
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import { PROFILE_DIR, CDP_PORT } from "./config";

const CDP_ENDPOINT = `http://localhost:${CDP_PORT}`;

export interface AcquiredBrowser {
  context: BrowserContext;
  release: () => Promise<void>;
}

// Connect to an already-running shared browser, or launch one if none exists.
// First tool = OWNER (launches Chrome on CDP_PORT; release() closes it).
// Later tools = CONNECTOR (attach over CDP; release() only disconnects, never
// kills the shared browser). Both reuse the one logged-in persistent context.
export async function acquireBrowser(): Promise<AcquiredBrowser> {
  let browser = null;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  } catch {
    browser = null; // nothing listening — we'll launch as owner
  }

  if (browser) {
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      await browser.close();
      throw new Error(
        `Connected to the shared browser on :${CDP_PORT} but it has no context ` +
          `(logged-out?). Close stray Chrome windows using this profile and retry.`
      );
    }
    console.log(`Attached to shared browser on :${CDP_PORT} (connector).`);
    const connected = browser;
    return { context: contexts[0], release: async () => { await connected.close(); } };
  }

  try {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: "chrome",
      viewport: { width: 1280, height: 800 },
      args: [
        `--remote-debugging-port=${CDP_PORT}`,
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    console.log(`Launched shared browser on :${CDP_PORT} (owner).`);
    return { context, release: async () => { await context.close(); } };
  } catch (err) {
    throw new Error(
      `Could not start the browser. A browser may be half-running — close stray ` +
        `Chrome windows using this profile, or check port ${CDP_PORT}. Original: ${err}`
    );
  }
}
```

- [ ] **Step 3: Verify type-check**

Run: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck browser.ts config.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add browser.ts config.ts
git commit -m "feat: browser.ts — shared Chrome via connect-or-launch over CDP"
```

---

## Task 2: `write-lock.ts` + tests

**Files:** Create `write-lock.ts`, `write-lock.test.ts`.

- [ ] **Step 1: Write the failing test — create `write-lock.test.ts`:**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideLock, type LockInfo } from "./write-lock";

const HOLDER: LockInfo = { tool: "follow", pid: 4242, startedAt: "2026-06-10T00:00:00.000Z" };
const alive = () => true;
const dead = () => false;

test("no existing lock -> acquire", () => {
  assert.equal(decideLock(null, alive, false), "acquire");
});

test("live holder, no force -> refuse", () => {
  assert.equal(decideLock(HOLDER, alive, false), "refuse");
});

test("live holder, force -> bypass", () => {
  assert.equal(decideLock(HOLDER, alive, true), "bypass");
});

test("dead holder (stale) -> reclaim", () => {
  assert.equal(decideLock(HOLDER, dead, false), "reclaim");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test write-lock.test.ts`
Expected: FAIL — `Cannot find module './write-lock'`.

- [ ] **Step 3: Write minimal implementation — create `write-lock.ts`:**

```typescript
import * as fs from "fs";
import * as path from "path";
import { OUTPUT_DIR } from "./config";

export type WriteCategory = "follow" | "dm";

export interface LockInfo {
  tool: string;
  pid: number;
  startedAt: string;
}

export type LockDecision = "acquire" | "reclaim" | "refuse" | "bypass";

// Pure decision: given the existing lock (if any), whether its owner is alive,
// and whether --force was passed, decide what to do.
export function decideLock(
  existing: LockInfo | null,
  isAlive: (pid: number) => boolean,
  force: boolean
): LockDecision {
  if (!existing) return "acquire";
  if (!isAlive(existing.pid)) return "reclaim"; // stale lock from a crashed run
  return force ? "bypass" : "refuse";
}

function lockPath(category: WriteCategory): string {
  return path.join(OUTPUT_DIR, `.write-${category}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
    return true;
  } catch {
    return false;
  }
}

// Acquire the write lock for a category. Exits the process on refusal.
// Returns release() which frees the lock (no-op when --force bypassed a holder).
export function acquireWriteLock(category: WriteCategory, tool: string, force: boolean): () => void {
  const file = lockPath(category);
  let existing: LockInfo | null = null;
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      existing = null;
    }
  }

  const decision = decideLock(existing, pidAlive, force);

  if (decision === "refuse") {
    console.error(
      `\n✋ '${existing?.tool}' is already running (pid ${existing?.pid}, since ${existing?.startedAt}).\n` +
        `Another '${category}' write tool would double velocity past the daily cap. Refusing.\n` +
        `(use --force to override)\n`
    );
    process.exit(1);
  }

  if (decision === "bypass") {
    console.warn(`⚠ --force: write-guard bypassed, running concurrently with '${existing?.tool}'.`);
    return () => {}; // no-op: must not clobber the holder's lock
  }

  // acquire or reclaim — write our own lock
  const info: LockInfo = { tool, pid: process.pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(info, null, 2));

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  };

  // Best-effort cleanup if the process exits or is Ctrl-C'd.
  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(130);
  });

  return release;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test write-lock.test.ts`
Expected: PASS — `pass 4`, `fail 0`.

- [ ] **Step 5: Verify type-check**

Run: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck write-lock.ts config.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add write-lock.ts write-lock.test.ts
git commit -m "feat: write-lock — per-category single-writer guard (decideLock + acquire)"
```

---

## Task 3: Adopt `acquireBrowser` at every call site

**Files:** Modify `follow-bot.ts`, `chain-runner.ts`, `prospect.ts`, `dm-bot.ts`, `unfollow-bot.ts`. Browser-driven — type-check verified; smoke deferred.

The uniform transform at each call site:
- `const context = await launchBrowser();` → `const { context, release } = await acquireBrowser();`
- every `await context.close();` → `await release();`

- [ ] **Step 1: `follow-bot.ts`**

(a) Replace the playwright imports at the top:
```typescript
import { chromium } from "playwright";
import type { Page, BrowserContext, ElementHandle } from "playwright";
```
with:
```typescript
import type { Page, ElementHandle } from "playwright";
import { acquireBrowser } from "./browser";
```

(b) Delete the entire `launchBrowser` function (the `export async function launchBrowser(): Promise<BrowserContext> { … }` block, including its leading `// ── Browser Launch ──` comment).

(c) In `login()`: change `const context = await launchBrowser();` → `const { context, release } = await acquireBrowser();` and the `await context.close();` → `await release();`.

(d) In `follow()`: change `const context = await launchBrowser();` → `const { context, release } = await acquireBrowser();` and `await context.close();` → `await release();`.

- [ ] **Step 2: `chain-runner.ts`**

(a) In the `from "./follow-bot"` import block, remove `launchBrowser,` and add a new import line below it:
```typescript
import { acquireBrowser } from "./browser";
```

(b) In `runChain`: `const context = await launchBrowser();` → `const { context, release } = await acquireBrowser();`; the `await context.close();` (in the `finally`) → `await release();`.

- [ ] **Step 3: `prospect.ts`**

(a) Replace `import { launchBrowser } from "./follow-bot";` with `import { acquireBrowser } from "./browser";` (keep the separate `import { loadLog } from "./follow-bot";`).

(b) Both call sites (`sync` and `enrich`): `const context = await launchBrowser();` → `const { context, release } = await acquireBrowser();`; each `await context.close();` → `await release();`.

- [ ] **Step 4: `dm-bot.ts`**

(a) Replace `import { launchBrowser } from "./follow-bot";` with `import { acquireBrowser } from "./browser";`.

(b) In `send`: `const context = await launchBrowser();` → `const { context, release } = await acquireBrowser();`; `await context.close();` → `await release();`.

- [ ] **Step 5: `unfollow-bot.ts`**

(a) Replace the playwright import line `import { chromium } from "playwright";` — remove it. Change `import type { Page, BrowserContext } from "playwright";` to `import type { Page } from "playwright";`. Add `import { acquireBrowser } from "./browser";`.

(b) In the config import block, remove `PROFILE_DIR,` (it was only used by the local launchBrowser).

(c) Delete the local `async function launchBrowser(): Promise<BrowserContext> { … }` definition.

(d) Both `const context = await launchBrowser();` call sites → `const { context, release } = await acquireBrowser();`. Every `await context.close();` (there are several, in scan and unfollow paths) → `await release();`.

- [ ] **Step 6: Verify type-check across all touched files**

Run: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck browser.ts follow-bot.ts chain-runner.ts prospect.ts dm-bot.ts unfollow-bot.ts config.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"`
Expected: no output. (If `chromium` or `BrowserContext` is reported unused-ish via a real error, ensure the removed imports are fully gone.)

- [ ] **Step 7: Commit**

```bash
git add follow-bot.ts chain-runner.ts prospect.ts dm-bot.ts unfollow-bot.ts
git commit -m "refactor: all tools acquire the shared browser via browser.ts"
```

---

## Task 4: Adopt the write-lock in write tools

**Files:** Modify `follow-bot.ts`, `chain-runner.ts`, `unfollow-bot.ts`, `dm-bot.ts`. Type-check verified.

Pattern: parse `--force` from argv, acquire the category lock at the **start** of the command (before `acquireBrowser`), and release it in a `finally` after the browser is released.

- [ ] **Step 1: `follow-bot.ts` — `follow()` acquires the `follow` lock**

Add the import near the other imports:
```typescript
import { acquireWriteLock } from "./write-lock";
```

In `follow()`, just after `const args = process.argv.slice(3);` and the existing flag parsing, add:
```typescript
  const force = args.includes("--force");
  const releaseLock = acquireWriteLock("follow", "follow", force);
```
Then wrap the browser work so the lock is always released. Change the body from:
```typescript
  const { context, release } = await acquireBrowser();
  // ... existing follow logic ...
  await release();
```
to:
```typescript
  const { context, release } = await acquireBrowser();
  try {
    // ... existing follow logic (unchanged) ...
  } finally {
    await release();
    releaseLock();
  }
```
(If the existing logic already has its own try/finally for `release()`, just add `releaseLock();` after `await release();` in that finally.)

- [ ] **Step 2: `chain-runner.ts` — acquire the `follow` lock in `main()`**

Add import:
```typescript
import { acquireWriteLock } from "./write-lock";
```

In `main()`, after `const pacing = parsePacing(args);`, add:
```typescript
  const force = args.includes("--force");
  const releaseLock = acquireWriteLock("follow", "chain", force);
```
Wrap the `await runChain(state, pacing);` call:
```typescript
  try {
    await runChain(state, pacing);
  } finally {
    releaseLock();
  }
```
(`runChain` already closes the browser via `release()` in its own `finally`; the lock release wraps the whole run.)

- [ ] **Step 3: `unfollow-bot.ts` — `unfollow` acquires the `follow` lock (scan does not)**

Add import:
```typescript
import { acquireWriteLock } from "./write-lock";
```

`scan` is read-only — no lock. For the `unfollow` command path: locate the function that runs on `command === "unfollow"` (the unfollow runner). At its start, add:
```typescript
  const force = process.argv.slice(3).includes("--force");
  const releaseLock = acquireWriteLock("follow", "unfollow", force);
```
and ensure it is released after the browser is released — wrap the existing browser work in `try { … } finally { await release(); releaseLock(); }` (fold into the existing finally if one exists).

- [ ] **Step 4: `dm-bot.ts` — acquire the `dm` lock only when `--live`**

Add import:
```typescript
import { acquireWriteLock } from "./write-lock";
```

In `send()`, after `const { live, approve } = parseDmFlags(args);`, add:
```typescript
  const force = args.includes("--force");
  const releaseLock = live ? acquireWriteLock("dm", "dm", force) : () => {};
```
(Dry-run is read-only → no lock.) Then ensure `releaseLock()` runs in the `finally` alongside `await release()`:
```typescript
  } finally {
    await release();
    releaseLock();
  }
```

- [ ] **Step 5: Verify type-check**

Run: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck follow-bot.ts chain-runner.ts unfollow-bot.ts dm-bot.ts write-lock.ts config.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add follow-bot.ts chain-runner.ts unfollow-bot.ts dm-bot.ts
git commit -m "feat: write tools acquire a per-category lock (follow/dm); dm --live runs alongside follow"
```

---

## Task 5: README + full test run

**Files:** Modify `README.md`.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all `*.test.ts` pass, `fail 0` (now includes `write-lock.test.ts`). Paste counts. If anything fails, STOP and report.

- [ ] **Step 2: Add a README section**

Add a `## Running multiple tools at once` section to `README.md` (place it after the "## Sending DMs (dm-bot.ts)" section), in the same plain tone. Document:
- All tools now share **one** Chrome over CDP (port from `CDP_PORT`, default 9222): the first tool you start launches the browser; later tools attach. One login serves all. So you can run, e.g., `prospect:enrich` in one terminal and `follow`/`chain` in another, and they won't collide.
- **Start the longer-running tool first** — the tool that launched the browser owns it; if it exits while another is attached, the shared browser closes and the attached tool stops with a "shared browser closed" message.
- **Write guard:** only one *follow-category* write tool (`follow`, `chain`, `unfollow`) runs at a time — starting a second refuses with a message naming the holder. `dm --live` is its own category, so it **can** run alongside a follow tool, but not alongside another `dm --live`. Read-only commands (`prospect sync`/`enrich`/`filter`, `dm` dry-run, `login`) are never blocked. `--force` overrides the refusal (logs a warning; doesn't clobber the holder's lock).
- Locks live at `output/.write-follow.lock` / `output/.write-dm.lock`; a crashed run's stale lock is auto-reclaimed (PID liveness check).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document shared browser and write-concurrency guard"
```

---

## Self-Review

- **Spec coverage:** connect-or-launch core → Task 1 (`browser.ts`); per-category write lock w/ stale-reclaim + `--force` bypass (no-op release) → Task 2; `acquireBrowser` adopted everywhere (login included) → Task 3; write tools acquire correct category, `dm --live` separate so it runs with follow, dry-run/read tools unlocked → Task 4; login uses `acquireBrowser` (Task 3 Step 1c); error messages (logged-out empty context, half-running) → Task 1; README/guidance incl. "start longer tool first" → Task 5; unit tests on `decideLock` → Task 2. Covered.
- **Placeholder scan:** none — new files have complete code; call-site edits give exact old→new strings and enumerate every site.
- **Type consistency:** `acquireBrowser(): Promise<{context, release}>` used identically at all call sites; `acquireWriteLock(category, tool, force): () => void` and `WriteCategory`/`LockInfo`/`LockDecision`/`decideLock` consistent between `write-lock.ts` (Task 2) and consumers (Task 4); `CDP_PORT` defined in Task 1, consumed in `browser.ts`.

## Notes for the smoke run (Task 3/4 are not unit-tested for browser behavior)

After implementation, verify manually (needs a logged-in profile):
1. Terminal A `npm run prospect:enrich`, Terminal B `npm run follow -- @x --tech-only` → both attach to one window; no `SingletonLock` error.
2. `npm run follow -- @x` then (second terminal) `npm run chain -- @y` → second refuses; `npm run chain -- @y --force` overrides.
3. `npm run follow -- @x` + `npm run dm -- --live` → both run (different categories).
4. `kill -9` a follow tool, then start `chain` → stale `.write-follow.lock` reclaimed.
5. Confirm the connector exiting does NOT close the shared browser; the owner exiting does.
