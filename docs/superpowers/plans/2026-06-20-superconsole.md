# Xperiment Superconsole Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the bare Tauri dev shell into **Xperiment** — a graphite/violet command-center exposing the full toolkit (Build List, Follow, Chain, Unfollow, DM) with strictly-safe write guards and first-class stop/kill/cleanup.

**Architecture:** Evolve `desktop/` (Tauri v2 + vanilla TS). A shared `console` chrome (sidebar nav, status bar, persistent log, Stop/Cleanup) hosts per-tool panels; each panel builds an arg list (pure, tested) and runs it through `engine.ts` (spawn the existing CLI via the shell plugin, stream stdout to the log, kill on demand). One small additive engine change (login auto-detect) and one new engine command (`cleanup.ts`). Results read from `output/*.json`.

**Tech Stack:** Tauri v2, `@tauri-apps/plugin-shell`/`-fs`/`-opener`, vanilla TS, Node `node:test`. Reuses the repo engine. No new deps.

## Global Constraints

- Branch off `gui`; PR into `gui` (never `main`). `main` stays the frozen CLI baseline.
- Tauri **v2**, **vanilla TS** frontend (no React/Vue/Svelte). No new npm deps.
- App name **Xperiment**; look **graphite + violet** (dark graphite surfaces, violet `#8b5cf6` accent); icon = social-graph nodes (violet on graphite).
- **Strictly safe:** GUI uses safe defaults only. Visible daily-cap meters, write-lock banner, Stop + Cleanup, DM dry-run default with explicit live-send confirm. **Never** expose burst / `--force` / cap-override in the GUI.
- Engine commands are spawned as `npx tsx <file> …` with `cwd: REPO_DIR`. Read-only data from `output/*.json`.
- Pure-logic tests via `npx tsx --test <file>` (run from repo root so tsx resolves; `./import` is relative to the test file). Type-check via the filtered `tsc` command used elsewhere in the repo. Frontend builds via `cd desktop && npm run build`. **Do NOT run `npm run tauri dev`** in any task (GUI/blocks) — verify by build + type-check; window click-throughs are deferred to the operator.
- No engine CLI regression: the only engine files this plan may touch are a new `cleanup.ts` and an **additive** change to `follow-bot.ts` login. Everything else under `desktop/`.

## Spec reference
`docs/superpowers/specs/2026-06-20-superconsole-design.md`. Existing working shell: `desktop/src/main.ts`, `index.html`, `styles.css`, `src/config.ts` (`ENGINE="npx"`, `REPO_DIR`), `src/steps.ts` (`buildSteps`).

## File Structure

| File | Responsibility |
|---|---|
| `cleanup.ts` (new, repo root) | Engine command: clear stale write-locks + kill stray engine/Chrome processes. |
| `cleanup.test.ts` (new) | Test the stale-lock clearing. |
| `follow-bot.ts` (modify) | `login` gains additive auto-detect + sentinel; CLI behavior preserved. |
| `desktop/src/steps.ts` (modify) | Add `followArgs`/`chainArgs`/`unfollowScanArgs`/`unfollowArgs`/`dmArgs` (pure). |
| `desktop/src/steps.test.ts` (modify) | Tests for the new arg builders. |
| `desktop/src/status.ts` (new) | Pure `countToday` cap counting + `capLabel`. |
| `desktop/src/status.test.ts` (new) | Tests for counting. |
| `desktop/src/engine.ts` (new) | `runEngine(args,onLine)` → spawn/stream/kill + child registry + `killAllEngine`. |
| `desktop/src/engine.test.ts` (new) | Test the child registry bookkeeping (pure parts). |
| `desktop/index.html` (rewrite) | Minimal mount: `<div id="app">`. |
| `desktop/src/styles.css` (rewrite) | Graphite + violet command-center theme. |
| `desktop/src/console.ts` (new) | Build chrome (sidebar/status bar/log/panel host), router, status refresh, Stop/Cleanup, Connect. |
| `desktop/src/main.ts` (rewrite) | Bootstrap console + register the 5 panels. |
| `desktop/src/tools/build.ts` (new) | Build List panel (re-home existing flow). |
| `desktop/src/tools/follow.ts` (new) | Follow panel. |
| `desktop/src/tools/chain.ts` (new) | Chain panel. |
| `desktop/src/tools/unfollow.ts` (new) | Unfollow panel (scan→review→unfollow). |
| `desktop/src/tools/dm.ts` (new) | DM panel (template→dry-run→confirm). |
| `desktop/src-tauri/tauri.conf.json` (modify) | productName/title/identifier = Xperiment. |
| `desktop/src-tauri/icons/*` (regenerate) | Social-graph violet icon set. |
| `desktop/README.md` (modify) | Update for the console + tools. |
| `package.json` (modify) | Add `cleanup` script. |

---

## Task 1: `cleanup.ts` — stop/kill/cleanup engine command

**Files:** Create `cleanup.ts`, `cleanup.test.ts` (repo root); Modify `package.json`.

**Interfaces:**
- Consumes: `decideLock`, `LockInfo` from `./write-lock`; `OUTPUT_DIR` from `./config`.
- Produces: `staleLockFiles(dir, isAlive): string[]` (pure — lock files whose PID is dead); CLI `npx tsx cleanup.ts` that removes those + kills stray engine/Chrome processes and prints a summary.

- [ ] **Step 1: Write the failing test — create `cleanup.test.ts`:**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { staleLockFiles } from "./cleanup";

test("staleLockFiles returns only locks whose pid is dead", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locks-"));
  fs.writeFileSync(path.join(dir, ".write-follow.lock"), JSON.stringify({ tool: "follow", pid: 999999, startedAt: "x" }));
  fs.writeFileSync(path.join(dir, ".write-dm.lock"), JSON.stringify({ tool: "dm", pid: process.pid, startedAt: "x" }));
  fs.writeFileSync(path.join(dir, "other.json"), "{}");
  const isAlive = (pid: number) => pid === process.pid;
  const stale = staleLockFiles(dir, isAlive).map((p) => path.basename(p)).sort();
  assert.deepEqual(stale, [".write-follow.lock"]); // dm's pid is alive; other.json ignored
});

test("staleLockFiles tolerates missing dir and corrupt files", () => {
  assert.deepEqual(staleLockFiles("/no/such/dir", () => true), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locks2-"));
  fs.writeFileSync(path.join(dir, ".write-follow.lock"), "not json");
  // corrupt lock -> treat as removable (can't prove owner alive)
  assert.deepEqual(staleLockFiles(dir, () => true).map((p) => path.basename(p)), [".write-follow.lock"]);
});
```

- [ ] **Step 2: Run — `npx tsx --test cleanup.test.ts` — FAIL (cannot find module './cleanup').**

- [ ] **Step 3: Create `cleanup.ts`:**

```typescript
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { OUTPUT_DIR } from "./config";
import { decideLock, type LockInfo } from "./write-lock";

// Lock files in `dir` whose owning process is no longer alive (or that are
// corrupt and can't prove an owner). Pure given an isAlive probe.
export function staleLockFiles(dir: string, isAlive: (pid: number) => boolean): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name.startsWith(".write-") || !name.endsWith(".lock")) continue;
    const file = path.join(dir, name);
    let info: LockInfo | null = null;
    try {
      info = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      out.push(file); // corrupt -> removable
      continue;
    }
    // decideLock("reclaim") == existing lock whose pid is dead.
    if (decideLock(info, isAlive, false) === "reclaim") out.push(file);
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Engine processes the GUI may have spawned. Matched by command substring.
const ENGINE_PATTERNS = [
  "tsx prospect.ts",
  "tsx follow-bot.ts",
  "tsx chain-runner.ts",
  "tsx dm-bot.ts",
  "tsx unfollow-bot.ts",
];

function killByPattern(pattern: string): number {
  try {
    // -f match full arg line; exclude ourselves. Returns nonzero if none matched.
    execSync(`pkill -f ${JSON.stringify(pattern)}`, { stdio: "ignore" });
    return 1;
  } catch {
    return 0;
  }
}

function cleanup(): void {
  let killed = 0;
  for (const p of ENGINE_PATTERNS) killed += killByPattern(p);
  // Stray automation Chrome bound to our profile dir.
  killed += killByPattern(".chrome-profile");

  const stale = staleLockFiles(OUTPUT_DIR, pidAlive);
  for (const f of stale) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
  console.log(`Cleanup done. Killed ~${killed} process group(s); removed ${stale.length} stale lock(s).`);
}

if (require.main === module) cleanup();
```

- [ ] **Step 4: Run — `npx tsx --test cleanup.test.ts` — PASS (2 pass, 0 fail).**

- [ ] **Step 5: Add a script to `package.json`** `"scripts"`: `"cleanup": "tsx cleanup.ts"`.

- [ ] **Step 6: Type-check** `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck cleanup.ts write-lock.ts config.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"` → empty.

- [ ] **Step 7: Commit** `git add cleanup.ts cleanup.test.ts package.json && git commit -m "feat: cleanup command — kill stray engine procs + clear stale write-locks"`

---

## Task 2: `login` auto-detect (additive engine change)

**Files:** Modify `follow-bot.ts`.

**Interfaces:**
- Produces: `login` prints the exact sentinel line `XPERIMENT_LOGGED_IN` once a live X session is confirmed, then still waits for Enter (so the CLI `npm run login` is unchanged). The GUI watches stdout for that sentinel.

Background: today `login()` opens the browser and calls `waitForEnter()`. We add a pre-check: after the page loads, if it's NOT on a login URL, the session is already live → print the sentinel immediately. Either way the existing Enter wait stays as the fallback (manual login completion).

- [ ] **Step 1: Read `follow-bot.ts` `login()`.** It does roughly: `launchBrowser`/`acquireBrowser`, `page.goto("https://x.com/login")`, `await waitForEnter()`, close.

- [ ] **Step 2: Modify `login()`** so that after navigation it detects an existing session and emits the sentinel, keeping the manual flow:

```typescript
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const onLoginPage = page.url().includes("/login") || page.url().includes("/i/flow/login");
  if (!onLoginPage) {
    console.log("XPERIMENT_LOGGED_IN"); // already authenticated — GUI flips to Connected
  } else {
    console.log("Log in in the browser window…");
  }
  await waitForEnter(); // CLI: press Enter when done. GUI: writes "\n" after it sees the sentinel or the user finishes.
```
(Navigate to `/home` rather than `/login` so an existing session is detectable; `/home` redirects to login when logged out. Keep the rest of `login()` — `acquireBrowser`/close — intact.)

- [ ] **Step 3: Type-check** `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck follow-bot.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"` → empty.

- [ ] **Step 4: Engine regression check** — `npm test` → existing suite still passes (no engine logic changed except login). Paste counts. (login itself is browser-driven; not unit-tested. Confirm the CLI contract is intact by reading: `npm run login` still opens a window and waits for Enter.)

- [ ] **Step 5: Commit** `git add follow-bot.ts && git commit -m "feat: login emits XPERIMENT_LOGGED_IN sentinel when session already live (additive)"`

---

## Task 3: `steps.ts` arg builders

**Files:** Modify `desktop/src/steps.ts`, `desktop/src/steps.test.ts`.

**Interfaces:**
- Produces (all return `string[]` — the args after `ENGINE`):
  - `followArgs(target: string, opts: { following: boolean; techOnly: boolean }): string[]`
  - `chainArgs(seed: string, opts: { resume: boolean }): string[]`
  - `unfollowScanArgs(): string[]`
  - `unfollowArgs(): string[]`
  - `dmArgs(opts: { live: boolean }): string[]`

- [ ] **Step 1: Append to `desktop/src/steps.test.ts`:**

```typescript
import { followArgs, chainArgs, unfollowScanArgs, unfollowArgs, dmArgs } from "./steps";

test("followArgs strips @, adds flags only when set", () => {
  assert.deepEqual(followArgs("@dev", { following: true, techOnly: true }),
    ["tsx", "follow-bot.ts", "follow", "dev", "--following", "--tech-only"]);
  assert.deepEqual(followArgs("dev", { following: false, techOnly: false }),
    ["tsx", "follow-bot.ts", "follow", "dev"]);
});

test("chainArgs: seed vs resume", () => {
  assert.deepEqual(chainArgs("@x", { resume: false }), ["tsx", "chain-runner.ts", "x"]);
  assert.deepEqual(chainArgs("", { resume: true }), ["tsx", "chain-runner.ts", "--resume"]);
});

test("unfollow + dm args", () => {
  assert.deepEqual(unfollowScanArgs(), ["tsx", "unfollow-bot.ts", "scan"]);
  assert.deepEqual(unfollowArgs(), ["tsx", "unfollow-bot.ts", "unfollow"]);
  assert.deepEqual(dmArgs({ live: false }), ["tsx", "dm-bot.ts", "send"]);
  assert.deepEqual(dmArgs({ live: true }), ["tsx", "dm-bot.ts", "send", "--live"]);
});
```

- [ ] **Step 2: Run — `npx tsx --test desktop/src/steps.test.ts` — FAIL (no such exports).**

- [ ] **Step 3: Append to `desktop/src/steps.ts`:**

```typescript
export function followArgs(target: string, opts: { following: boolean; techOnly: boolean }): string[] {
  const args = ["tsx", "follow-bot.ts", "follow", target.trim().replace(/^@/, "")];
  if (opts.following) args.push("--following");
  if (opts.techOnly) args.push("--tech-only");
  return args;
}

export function chainArgs(seed: string, opts: { resume: boolean }): string[] {
  if (opts.resume) return ["tsx", "chain-runner.ts", "--resume"];
  return ["tsx", "chain-runner.ts", seed.trim().replace(/^@/, "")];
}

export function unfollowScanArgs(): string[] {
  return ["tsx", "unfollow-bot.ts", "scan"];
}

export function unfollowArgs(): string[] {
  return ["tsx", "unfollow-bot.ts", "unfollow"];
}

export function dmArgs(opts: { live: boolean }): string[] {
  const args = ["tsx", "dm-bot.ts", "send"];
  if (opts.live) args.push("--live");
  return args;
}
```

- [ ] **Step 4: Run — `npx tsx --test desktop/src/steps.test.ts` — PASS (existing + 3 new).**

- [ ] **Step 5: Commit** `git add desktop/src/steps.ts desktop/src/steps.test.ts && git commit -m "feat(app): arg builders for follow/chain/unfollow/dm"`

---

## Task 4: `status.ts` — cap-meter counting (pure)

**Files:** Create `desktop/src/status.ts`, `desktop/src/status.test.ts`.

**Interfaces:**
- Produces: `countToday(timestamps: string[], nowISO: string): number` (entries on the same UTC day as now); `capLabel(used: number, max: number): string` → `"<used>/<max>"`.

- [ ] **Step 1: Create `desktop/src/status.test.ts`:**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { countToday, capLabel } from "./status";

test("countToday counts same-UTC-day timestamps", () => {
  const ts = ["2026-06-20T01:00:00.000Z", "2026-06-20T23:00:00.000Z", "2026-06-19T23:00:00.000Z"];
  assert.equal(countToday(ts, "2026-06-20T12:00:00.000Z"), 2);
});

test("capLabel formats used/max", () => {
  assert.equal(capLabel(120, 350), "120/350");
});
```

- [ ] **Step 2: Run — `npx tsx --test desktop/src/status.test.ts` — FAIL.**

- [ ] **Step 3: Create `desktop/src/status.ts`:**

```typescript
// Pure cap-meter helpers. Reading the JSON logs happens in console.ts (impure);
// the counting stays pure and tested.
export function countToday(timestamps: string[], nowISO: string): number {
  const day = nowISO.slice(0, 10);
  return timestamps.filter((t) => typeof t === "string" && t.slice(0, 10) === day).length;
}

export function capLabel(used: number, max: number): string {
  return `${used}/${max}`;
}
```

- [ ] **Step 4: Run — PASS (2/0).**

- [ ] **Step 5: Commit** `git add desktop/src/status.ts desktop/src/status.test.ts && git commit -m "feat(app): pure cap-meter counting"`

---

## Task 5: `engine.ts` — run / stream / kill + child registry

**Files:** Create `desktop/src/engine.ts`, `desktop/src/engine.test.ts`.

**Interfaces:**
- Consumes: `Command`, `Child` from `@tauri-apps/plugin-shell`; `ENGINE`, `REPO_DIR` from `./config`.
- Produces:
  - `runEngine(args: string[], onLine: (line: string) => void): EngineRun` where `EngineRun = { done: Promise<void>; kill: () => Promise<void> }`. Spawns `Command.create(ENGINE, args, {cwd: REPO_DIR})`, streams stdout+stderr lines to `onLine`, resolves `done` on close, registers/deregisters the child.
  - `activeCount(): number` and `killAllEngine(): Promise<void>` for the Stop-all / window-close path.
  - A testable registry: `registry` with `add(child)`, `remove(child)`, `size()`, `killAll(kill)` — pure bookkeeping over an injected kill fn.

- [ ] **Step 1: Create `desktop/src/engine.test.ts`** (tests the pure registry, not the browser spawn):

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildRegistry } from "./engine";

test("registry tracks add/remove/size and killAll calls kill on each", async () => {
  const reg = new ChildRegistry<{ id: number }>();
  const a = { id: 1 }, b = { id: 2 };
  reg.add(a); reg.add(b);
  assert.equal(reg.size(), 2);
  reg.remove(a);
  assert.equal(reg.size(), 1);
  const killed: number[] = [];
  await reg.killAll(async (c) => { killed.push(c.id); });
  assert.deepEqual(killed, [2]);
  assert.equal(reg.size(), 0);
});
```

- [ ] **Step 2: Run — `npx tsx --test desktop/src/engine.test.ts` — FAIL.**

- [ ] **Step 3: Create `desktop/src/engine.ts`:**

```typescript
import { Command, type Child } from "@tauri-apps/plugin-shell";
import { ENGINE, REPO_DIR } from "./config";

// Pure registry of live children, testable without a browser.
export class ChildRegistry<T> {
  private items = new Set<T>();
  add(c: T) { this.items.add(c); }
  remove(c: T) { this.items.delete(c); }
  size() { return this.items.size; }
  async killAll(kill: (c: T) => Promise<void>) {
    for (const c of [...this.items]) {
      await kill(c).catch(() => {});
      this.items.delete(c);
    }
  }
}

export interface EngineRun {
  done: Promise<void>;
  kill: () => Promise<void>;
}

const registry = new ChildRegistry<Child>();
export function activeCount(): number { return registry.size(); }
export async function killAllEngine(): Promise<void> {
  await registry.killAll((c) => c.kill());
}

// Spawn an engine command, streaming stdout+stderr lines to onLine.
export function runEngine(args: string[], onLine: (line: string) => void): EngineRun {
  const cmd = Command.create(ENGINE, args, { cwd: REPO_DIR });
  cmd.stdout.on("data", (l) => onLine(l));
  cmd.stderr.on("data", (l) => onLine(l));
  let child: Child | null = null;
  const done = new Promise<void>((resolve) => {
    cmd.on("close", () => {
      if (child) registry.remove(child);
      resolve();
    });
    cmd.spawn().then((c) => { child = c; registry.add(c); });
  });
  return {
    done,
    kill: async () => { if (child) await child.kill(); },
  };
}
```

- [ ] **Step 4: Run — `npx tsx --test desktop/src/engine.test.ts` — PASS (1/0).** Then type-check: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck desktop/src/engine.ts desktop/src/config.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"` → empty.

- [ ] **Step 5: Commit** `git add desktop/src/engine.ts desktop/src/engine.test.ts && git commit -m "feat(app): engine runner — spawn/stream/kill + child registry"`

---

## Task 6: Console chrome + theme + Build List panel

**Files:** Rewrite `desktop/index.html`, `desktop/src/styles.css`, `desktop/src/main.ts`; Create `desktop/src/console.ts`, `desktop/src/tools/build.ts`. Build-verified (no `tauri dev`).

**Interfaces:**
- Consumes: `runEngine`/`killAllEngine`/`activeCount` (Task 5).
- Produces:
  - `console.ts`: `mountConsole(panels: Panel[])` builds the chrome and renders the first panel; exposes a `ConsoleCtx` to panels: `{ log(line), clearLog(), setBusy(bool), readJson<T>(relPath): Promise<T|null>, run(args): EngineRun }`. `Panel = { id: string; label: string; render(host: HTMLElement, ctx: ConsoleCtx): void }`.
  - `tools/build.ts`: `export const buildPanel: Panel` — the existing sync/crawl→enrich→filter→export flow, re-homed (uses `ctx.run`/`ctx.log`/`ctx.readJson`).

- [ ] **Step 1: Rewrite `desktop/index.html`:**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="/src/styles.css" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Xperiment</title>
    <script type="module" src="/src/main.ts" defer></script>
  </head>
  <body><div id="app"></div></body>
</html>
```

- [ ] **Step 2: Rewrite `desktop/src/styles.css`** (graphite + violet command-center):

```css
:root {
  --bg:#161618; --panel:#1e1e22; --side:#1b1b1f; --border:#2c2c31;
  --text:#ededf0; --muted:#9a9aa3; --accent:#8b5cf6; --accent-soft:#241f31;
  --ok:#4ade80; --warn:#f5b301; --danger:#f87171;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  color-scheme: dark;
}
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--bg); color:var(--text); height:100vh; overflow:hidden; }
#app { height:100vh; display:flex; flex-direction:column; }

.statusbar { display:flex; align-items:center; gap:14px; padding:9px 14px;
  background:var(--side); border-bottom:1px solid var(--border); font-size:13px; }
.statusbar .brand { font-weight:700; color:#fff; }
.statusbar .brand .mk { color:var(--accent); }
.statusbar .dot { width:8px; height:8px; border-radius:50%; background:#5a5a63; }
.statusbar .dot.on { background:var(--ok); }
.statusbar .meter { color:var(--muted); font-variant-numeric:tabular-nums; }
.statusbar .grow { flex:1; }
.statusbar button { font:inherit; font-size:12px; font-weight:600; padding:5px 11px;
  border:1px solid var(--border); border-radius:7px; background:var(--panel); color:var(--text); cursor:pointer; }
.statusbar button.danger { color:var(--danger); border-color:#3a2426; }
.statusbar button:disabled { opacity:.4; cursor:default; }

.main { flex:1; display:flex; min-height:0; }
.sidebar { width:150px; background:var(--side); border-right:1px solid var(--border); padding:10px 8px; display:flex; flex-direction:column; gap:3px; }
.sidebar .nav { text-align:left; font:inherit; font-size:14px; padding:9px 12px; border:none; border-radius:8px;
  background:transparent; color:var(--muted); cursor:pointer; }
.sidebar .nav:hover { color:var(--text); }
.sidebar .nav.active { background:var(--accent-soft); color:#fff; border-left:2px solid var(--accent); }

.panel { flex:1; padding:20px 24px; overflow:auto; }
.panel h2 { font-size:18px; margin-bottom:4px; }
.panel .sub { color:var(--muted); font-size:13px; margin-bottom:16px; }
.banner { background:#2a1f10; color:var(--warn); border:1px solid #3a2c10; border-radius:8px; padding:8px 12px; font-size:13px; margin-bottom:14px; }

.field { display:block; margin-bottom:14px; max-width:520px; }
.field > span { display:block; font-size:13px; font-weight:600; margin-bottom:5px; }
.field small { font-weight:400; color:var(--muted); }
input, textarea, select { width:100%; font:inherit; font-size:14px; padding:9px 11px;
  border:1px solid var(--border); border-radius:8px; background:var(--panel); color:var(--text); }
textarea { resize:vertical; }
select { width:auto; min-width:150px; }
.check { display:flex; align-items:center; gap:8px; font-size:14px; margin-bottom:12px; }
.check input { width:auto; }

button.primary { font:inherit; font-weight:700; font-size:14px; padding:9px 18px; border:none;
  border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
button.primary:hover { filter:brightness(1.06); }
button.primary:disabled { opacity:.45; cursor:default; }
button.ghost { font:inherit; font-weight:600; font-size:13px; padding:8px 14px; border:1px solid var(--border);
  border-radius:8px; background:var(--panel); color:var(--text); cursor:pointer; }

.log { font-family:var(--mono); font-size:12px; line-height:1.5; background:#0e0e10; color:#c7c7cf;
  border-top:1px solid var(--border); padding:10px 14px; height:200px; overflow:auto; white-space:pre-wrap; word-break:break-word; }
.log:empty::before { content:"Output will appear here…"; color:#555; }

table { width:100%; border-collapse:collapse; font-size:13px; margin-top:12px; }
th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--border); vertical-align:top; }
th { color:var(--muted); }
.confirm { background:#2a1f10; border:1px solid #3a2c10; border-radius:8px; padding:12px; margin-top:12px; }
.confirm .warn { color:var(--warn); font-weight:600; margin-bottom:8px; }
```

- [ ] **Step 3: Create `desktop/src/console.ts`:**

```typescript
import { readTextFile } from "@tauri-apps/plugin-fs";
import { runEngine, killAllEngine, type EngineRun } from "./engine";
import { REPO_DIR } from "./config";

export interface ConsoleCtx {
  log: (line: string) => void;
  clearLog: () => void;
  setBusy: (busy: boolean) => void;
  readJson: <T>(relPath: string) => Promise<T | null>;
  run: (args: string[]) => EngineRun;
}

export interface Panel {
  id: string;
  label: string;
  render: (host: HTMLElement, ctx: ConsoleCtx) => void;
}

export function mountConsole(panels: Panel[]): void {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="statusbar">
      <span class="brand"><span class="mk">◆</span> Xperiment</span>
      <span class="dot" id="conn-dot"></span><span id="conn-text">Not connected</span>
      <button id="btn-connect" class="ghost" style="padding:4px 10px">Connect X</button>
      <span class="grow"></span>
      <span class="meter" id="meters"></span>
      <button id="btn-stop" disabled>Stop</button>
      <button id="btn-cleanup" class="danger">Cleanup</button>
    </div>
    <div class="main">
      <div class="sidebar" id="nav"></div>
      <div class="panel" id="host"></div>
    </div>
    <pre class="log" id="log"></pre>`;

  const logEl = app.querySelector<HTMLPreElement>("#log")!;
  const host = app.querySelector<HTMLElement>("#host")!;
  const nav = app.querySelector<HTMLElement>("#nav")!;
  const stopBtn = app.querySelector<HTMLButtonElement>("#btn-stop")!;

  let current: EngineRun | null = null;
  const ctx: ConsoleCtx = {
    log: (line) => { logEl.textContent += line + "\n"; logEl.scrollTop = logEl.scrollHeight; },
    clearLog: () => { logEl.textContent = ""; },
    setBusy: (busy) => { stopBtn.disabled = !busy; },
    readJson: async <T>(rel: string) => {
      try { return JSON.parse(await readTextFile(`${REPO_DIR}/${rel}`)) as T; } catch { return null; }
    },
    run: (args) => { const r = runEngine(args, ctx.log); current = r; ctx.setBusy(true);
      r.done.then(() => { ctx.setBusy(false); current = null; }); return r; },
  };

  // nav + panels
  const navButtons: HTMLButtonElement[] = [];
  const select = (p: Panel, btn: HTMLButtonElement) => {
    navButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    host.innerHTML = "";
    p.render(host, ctx);
  };
  panels.forEach((p, i) => {
    const btn = document.createElement("button");
    btn.className = "nav"; btn.textContent = p.label;
    btn.onclick = () => select(p, btn);
    nav.appendChild(btn); navButtons.push(btn);
    if (i === 0) select(p, btn);
  });

  // Stop / Cleanup / window-close
  stopBtn.onclick = async () => { if (current) await current.kill(); await killAllEngine(); ctx.setBusy(false); };
  app.querySelector<HTMLButtonElement>("#btn-cleanup")!.onclick = () => {
    ctx.log("\n— Cleanup —");
    runEngine(["tsx", "cleanup.ts"], ctx.log);
  };
  window.addEventListener("beforeunload", () => { void killAllEngine(); });

  // Connect (wired fully in the Connect task; basic spawn here)
  app.querySelector<HTMLButtonElement>("#btn-connect")!.onclick = () => connectX(ctx, app);
}

let loginRun: EngineRun | null = null;
function connectX(ctx: ConsoleCtx, app: HTMLElement): void {
  const dot = app.querySelector<HTMLElement>("#conn-dot")!;
  const text = app.querySelector<HTMLElement>("#conn-text")!;
  text.textContent = "Opening login…";
  const setConnected = () => { dot.classList.add("on"); text.textContent = "Connected"; };
  const r = runEngine(["tsx", "follow-bot.ts", "login"], (line) => {
    ctx.log(line);
    if (line.includes("XPERIMENT_LOGGED_IN")) setConnected();
  });
  loginRun = r;
  r.done.then(() => { setConnected(); loginRun = null; });
}
```

- [ ] **Step 4: Create `desktop/src/tools/build.ts`** (re-home the existing list-build flow):

```typescript
import type { Panel, ConsoleCtx } from "../console";
import { buildSteps, type ListForm } from "../steps";

interface Candidate { handle: string; name: string; location: string | null; followers: number | null; matchedKeywords: string[]; }

export const buildPanel: Panel = {
  id: "build",
  label: "Build List",
  render(host: HTMLElement, ctx: ConsoleCtx) {
    host.innerHTML = `
      <h2>Build List</h2>
      <div class="sub">Crawl seed accounts, enrich profiles, filter to matches, export CSV.</div>
      <label class="field"><span>Seed accounts <small>(one @handle per line)</small></span>
        <textarea id="seeds" rows="3" placeholder="@NigerianBar"></textarea></label>
      <label class="field"><span>Crawl side</span>
        <select id="side"><option value="following">following</option><option value="followers">followers</option></select></label>
      <label class="field"><span>Looking for <small>(keywords)</small></span>
        <input id="who" placeholder="lawyer, attorney, barrister, SAN" /></label>
      <label class="field"><span>Location <small>(optional)</small></span>
        <input id="where" placeholder="nigeria, lagos, abuja" /></label>
      <button id="run" class="primary">Build list</button>
      <button id="export" class="ghost" hidden>Export CSV</button>
      <div id="results"></div>`;
    const $ = (id: string) => host.querySelector<HTMLElement>("#" + id)!;
    $("run").addEventListener("click", async () => {
      ctx.clearLog();
      const form: ListForm = {
        seeds: ($("seeds") as HTMLTextAreaElement).value.split("\n"),
        side: ($("side") as HTMLSelectElement).value as "following" | "followers",
        who: ($("who") as HTMLInputElement).value,
        where: ($("where") as HTMLInputElement).value,
      };
      for (const step of buildSteps(form)) { ctx.log(`\n— ${step.label} —`); await ctx.run(step.args).done; }
      const cands = (await ctx.readJson<Candidate[]>("output/candidates.json")) ?? [];
      $("results").innerHTML = cands.length
        ? `<p>${cands.length} matches.</p><table><thead><tr><th>Handle</th><th>Name</th><th>Location</th><th>Followers</th><th>Matched</th></tr></thead><tbody>${cands.map((c) => `<tr><td>@${c.handle}</td><td>${c.name ?? ""}</td><td>${c.location ?? ""}</td><td>${c.followers ?? ""}</td><td>${(c.matchedKeywords ?? []).join(", ")}</td></tr>`).join("")}</tbody></table>`
        : `<p class="sub">No matches.</p>`;
      ($("export") as HTMLButtonElement).hidden = cands.length === 0;
    });
    $("export").addEventListener("click", async () => { ctx.log("\n— Export CSV —"); await ctx.run(["tsx", "prospect.ts", "export-csv"]).done; });
  },
};
```

- [ ] **Step 5: Rewrite `desktop/src/main.ts`:**

```typescript
import { mountConsole } from "./console";
import { buildPanel } from "./tools/build";

mountConsole([buildPanel]); // follow/chain/unfollow/dm panels added in later tasks
```

- [ ] **Step 6: Build** `cd desktop && npm run build` → tsc + vite clean (0 errors). (Do NOT run `tauri dev`.)

- [ ] **Step 7: Commit** `cd .. && git add desktop/index.html desktop/src/styles.css desktop/src/console.ts desktop/src/main.ts desktop/src/tools/build.ts && git commit -m "feat(app): graphite/violet console chrome + Build List panel"`

---

## Task 7: Status wiring — cap meters, connect persistence, write-lock banner

**Files:** Modify `desktop/src/console.ts`.

**Interfaces:**
- Consumes: `countToday`, `capLabel` (Task 4); `readJson` (ctx).
- Produces: a meter refresher and a `lockedCategory()` helper the panels use to pre-disable Start.

- [ ] **Step 1: Add imports + a meter refresher to `console.ts`** (inside `mountConsole`, after `ctx` is defined):

```typescript
  // ---- cap meters (refresh every 4s) ----
  const meters = app.querySelector<HTMLElement>("#meters")!;
  const refreshMeters = async () => {
    const now = new Date().toISOString();
    const follows = (await ctx.readJson<{ timestamp: string }[]>("output/follow-log.json")) ?? [];
    const dms = (await ctx.readJson<{ status: string; timestamp: string }[]>("output/dm-log.json")) ?? [];
    const f = countToday(follows.map((r) => r.timestamp), now);
    const d = countToday(dms.filter((r) => r.status === "sent").map((r) => r.timestamp), now);
    meters.textContent = `follow ${capLabel(f, 350)}   ·   dm ${capLabel(d, 30)}`;
  };
  void refreshMeters();
  setInterval(refreshMeters, 4000);
```
Add at top: `import { countToday, capLabel } from "./status";`

- [ ] **Step 2: Export a lock helper from `console.ts`** so panels can pre-disable Start when a follow-category tool is running:

```typescript
import { exists } from "@tauri-apps/plugin-fs";
import { REPO_DIR } from "./config";

// True if a follow-category write tool is currently running (lock file present).
export async function followLockHeld(): Promise<boolean> {
  try { return await exists(`${REPO_DIR}/output/.write-follow.lock`); } catch { return false; }
}
```
(If `exists` isn't exported by the installed `@tauri-apps/plugin-fs`, use `readTextFile` in a try/catch instead — present→held, throw→not held. Confirm the export name; the scaffold task recorded fs exports.) Add `fs:allow-exists` to `desktop/src-tauri/capabilities/default.json` permissions if using `exists`.

- [ ] **Step 3: Build** `cd desktop && npm run build` → clean.

- [ ] **Step 4: Commit** `cd .. && git add desktop/src/console.ts desktop/src-tauri/capabilities/default.json && git commit -m "feat(app): live cap meters + follow-lock helper"`

---

## Task 8: Follow panel

**Files:** Create `desktop/src/tools/follow.ts`; Modify `desktop/src/main.ts`.

**Interfaces:** Consumes `followArgs` (Task 3), `followLockHeld` (Task 7), `Panel`/`ConsoleCtx`.

- [ ] **Step 1: Create `desktop/src/tools/follow.ts`:**

```typescript
import type { Panel, ConsoleCtx } from "../console";
import { followLockHeld } from "../console";
import { followArgs } from "../steps";

export const followPanel: Panel = {
  id: "follow",
  label: "Follow",
  render(host: HTMLElement, ctx: ConsoleCtx) {
    host.innerHTML = `
      <h2>Follow</h2>
      <div class="sub">Follow people from an account's followers or following. Safe-paced; daily cap 350.</div>
      <div class="banner" id="lock" hidden>A follow-type tool is already running — Stop it first.</div>
      <label class="field"><span>Target account</span><input id="target" placeholder="@somedev" /></label>
      <label class="check"><input type="checkbox" id="following" /> Pull from their <b>&nbsp;following</b> (default: followers)</label>
      <label class="check"><input type="checkbox" id="tech" checked /> Tech accounts only</label>
      <button id="run" class="primary">Start</button>`;
    const $ = (id: string) => host.querySelector<HTMLElement>("#" + id)!;
    const run = $("run") as HTMLButtonElement;
    followLockHeld().then((held) => { ($("lock") as HTMLElement).hidden = !held; run.disabled = held; });
    run.addEventListener("click", async () => {
      const target = ($("target") as HTMLInputElement).value.trim();
      if (!target) { ctx.log("Enter a target account."); return; }
      ctx.clearLog();
      run.disabled = true;
      const args = followArgs(target, {
        following: ($("following") as HTMLInputElement).checked,
        techOnly: ($("tech") as HTMLInputElement).checked,
      });
      await ctx.run(args).done;
      run.disabled = false;
    });
  },
};
```

- [ ] **Step 2: Register it in `main.ts`:**

```typescript
import { mountConsole } from "./console";
import { buildPanel } from "./tools/build";
import { followPanel } from "./tools/follow";

mountConsole([buildPanel, followPanel]);
```

- [ ] **Step 3: Build** `cd desktop && npm run build` → clean.
- [ ] **Step 4: Commit** `cd .. && git add desktop/src/tools/follow.ts desktop/src/main.ts && git commit -m "feat(app): Follow panel"`

---

## Task 9: Chain panel

**Files:** Create `desktop/src/tools/chain.ts`; Modify `desktop/src/main.ts`.

**Interfaces:** Consumes `chainArgs` (Task 3), `followLockHeld` (Task 7).

- [ ] **Step 1: Create `desktop/src/tools/chain.ts`:**

```typescript
import type { Panel, ConsoleCtx } from "../console";
import { followLockHeld } from "../console";
import { chainArgs } from "../steps";

export const chainPanel: Panel = {
  id: "chain",
  label: "Chain",
  render(host: HTMLElement, ctx: ConsoleCtx) {
    host.innerHTML = `
      <h2>Chain</h2>
      <div class="sub">Long-running: follows tech accounts, hopping the social graph. Safe-paced; daily cap 350. Use Stop to end it.</div>
      <div class="banner" id="lock" hidden>A follow-type tool is already running — Stop it first.</div>
      <label class="field"><span>Seed account</span><input id="seed" placeholder="@vitalik" /></label>
      <button id="run" class="primary">Start chain</button>
      <button id="resume" class="ghost">Resume last</button>`;
    const $ = (id: string) => host.querySelector<HTMLElement>("#" + id)!;
    const run = $("run") as HTMLButtonElement;
    const resume = $("resume") as HTMLButtonElement;
    followLockHeld().then((held) => { ($("lock") as HTMLElement).hidden = !held; run.disabled = held; resume.disabled = held; });
    run.addEventListener("click", async () => {
      const seed = ($("seed") as HTMLInputElement).value.trim();
      if (!seed) { ctx.log("Enter a seed account."); return; }
      ctx.clearLog(); run.disabled = true;
      await ctx.run(chainArgs(seed, { resume: false })).done; run.disabled = false;
    });
    resume.addEventListener("click", async () => {
      ctx.clearLog(); resume.disabled = true;
      await ctx.run(chainArgs("", { resume: true })).done; resume.disabled = false;
    });
  },
};
```

- [ ] **Step 2: Register in `main.ts`** (add `import { chainPanel }` and include in the array after `followPanel`).
- [ ] **Step 3: Build** `cd desktop && npm run build` → clean.
- [ ] **Step 4: Commit** `cd .. && git add desktop/src/tools/chain.ts desktop/src/main.ts && git commit -m "feat(app): Chain panel"`

---

## Task 10: Unfollow panel (scan → review → unfollow)

**Files:** Create `desktop/src/tools/unfollow.ts`; Modify `desktop/src/main.ts`; add `fs:allow-write-text-file` to capabilities.

**Interfaces:** Consumes `unfollowScanArgs`/`unfollowArgs` (Task 3), `followLockHeld` (Task 7). Reads/writes `output/unfollow-candidates.json`.

- [ ] **Step 1: Add `fs:allow-write-text-file` (scoped to `$HOME/**`) to `desktop/src-tauri/capabilities/default.json`** so the review step can save edits:

```json
    { "identifier": "fs:allow-write-text-file", "allow": [{ "path": "$HOME/**" }] }
```

- [ ] **Step 2: Create `desktop/src/tools/unfollow.ts`:**

```typescript
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { Panel, ConsoleCtx } from "../console";
import { followLockHeld } from "../console";
import { unfollowScanArgs, unfollowArgs } from "../steps";
import { REPO_DIR } from "../config";

interface ScanRow { username: string; displayName: string; bio: string; isTech: boolean; matchedKeywords: string[]; markedForUnfollow: boolean; }

export const unfollowPanel: Panel = {
  id: "unfollow",
  label: "Unfollow",
  render(host: HTMLElement, ctx: ConsoleCtx) {
    host.innerHTML = `
      <h2>Unfollow</h2>
      <div class="sub">Scan who you follow, review the non-tech list, then unfollow the ones you keep checked.</div>
      <div class="banner" id="lock" hidden>A follow-type tool is already running — Stop it first.</div>
      <button id="scan" class="primary">Scan following</button>
      <div id="review"></div>`;
    const $ = (id: string) => host.querySelector<HTMLElement>("#" + id)!;
    const scan = $("scan") as HTMLButtonElement;
    followLockHeld().then((held) => { ($("lock") as HTMLElement).hidden = !held; scan.disabled = held; });

    scan.addEventListener("click", async () => {
      ctx.clearLog(); scan.disabled = true;
      await ctx.run(unfollowScanArgs()).done; scan.disabled = false;
      const rows = (await ctx.readJson<ScanRow[]>("output/unfollow-candidates.json")) ?? [];
      const flagged = rows.filter((r) => r.markedForUnfollow);
      $("review").innerHTML = `<p class="sub">${flagged.length} marked for unfollow. Uncheck anyone to keep, then Unfollow.</p>
        <table><tbody>${flagged.map((r, i) => `<tr><td><input type="checkbox" data-i="${i}" checked></td><td>@${r.username}</td><td>${(r.bio || "").slice(0, 70)}</td></tr>`).join("")}</tbody></table>
        <button id="go" class="primary" style="margin-top:12px">Unfollow checked</button>`;
      $("review").querySelector<HTMLButtonElement>("#go")!.addEventListener("click", async () => {
        // Persist edits: only checked rows stay markedForUnfollow=true.
        const checks = [...$("review").querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
        const keepIdx = new Set(checks.filter((c) => c.checked).map((c) => Number(c.dataset.i)));
        flagged.forEach((r, i) => { r.markedForUnfollow = keepIdx.has(i); });
        const byName = new Map(flagged.map((r) => [r.username, r]));
        const merged = rows.map((r) => byName.get(r.username) ?? r);
        await writeTextFile(`${REPO_DIR}/output/unfollow-candidates.json`, JSON.stringify(merged, null, 2));
        ctx.clearLog();
        await ctx.run(unfollowArgs()).done;
      });
    });
  },
};
```

- [ ] **Step 3: Register in `main.ts`** (`import { unfollowPanel }`, add after `chainPanel`).
- [ ] **Step 4: Build** `cd desktop && npm run build` → clean.
- [ ] **Step 5: Commit** `cd .. && git add desktop/src/tools/unfollow.ts desktop/src/main.ts desktop/src-tauri/capabilities/default.json && git commit -m "feat(app): Unfollow panel (scan/review/unfollow)"`

---

## Task 11: DM panel (template → dry-run → confirm)

**Files:** Create `desktop/src/tools/dm.ts`; Modify `desktop/src/main.ts`. Writes `output/messages.json`.

**Interfaces:** Consumes `dmArgs` (Task 3). Reads `output/candidates.json`; writes `output/messages.json`.

- [ ] **Step 1: Create `desktop/src/tools/dm.ts`:**

```typescript
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { Panel, ConsoleCtx } from "../console";
import { dmArgs } from "../steps";
import { REPO_DIR } from "../config";

interface Candidate { handle: string; name: string; location: string | null; }

// Fill {name}/{location}/{handle} per candidate into the messages.json dm-bot reads.
function fillTemplate(tpl: string, c: Candidate): string {
  return tpl
    .replaceAll("{name}", c.name || c.handle)
    .replaceAll("{location}", c.location || "")
    .replaceAll("{handle}", c.handle);
}

export const dmPanel: Panel = {
  id: "dm",
  label: "DM",
  render(host: HTMLElement, ctx: ConsoleCtx) {
    host.innerHTML = `
      <h2>DM</h2>
      <div class="sub">Write one template; it personalizes per candidate. Dry-run first — sending is a separate confirm. Daily cap 30.</div>
      <label class="field" style="max-width:640px"><span>Message template <small>(use {name}, {location})</small></span>
        <textarea id="tpl" rows="4" placeholder="Hi {name}, I'm reaching out to legal professionals in {location} about…"></textarea></label>
      <button id="prep" class="primary">Preview (dry-run)</button>
      <div id="out"></div>`;
    const $ = (id: string) => host.querySelector<HTMLElement>("#" + id)!;

    async function writeMessages(): Promise<number> {
      const cands = (await ctx.readJson<Candidate[]>("output/candidates.json")) ?? [];
      const tpl = ($("tpl") as HTMLTextAreaElement).value.trim();
      if (!tpl) { ctx.log("Write a template first."); return 0; }
      if (cands.length === 0) { ctx.log("No candidates.json — build a list first."); return 0; }
      const messages: Record<string, { tone: string; text: string }> = {};
      for (const c of cands) messages[c.handle] = { tone: "warm", text: fillTemplate(tpl, c) };
      await writeTextFile(`${REPO_DIR}/output/messages.json`, JSON.stringify(messages, null, 2));
      return cands.length;
    }

    $("prep").addEventListener("click", async () => {
      ctx.clearLog();
      const n = await writeMessages();
      if (n === 0) return;
      await ctx.run(dmArgs({ live: false })).done; // dry-run
      $("out").innerHTML = `<div class="confirm"><div class="warn">⚠ Dry-run above shows who WOULD be messaged.</div>
        Send real DMs to up to ${n} people (closed-DM ones auto-skip, max 30/day)?
        <div style="margin-top:10px"><button id="send" class="primary">Send for real</button></div></div>`;
      $("out").querySelector<HTMLButtonElement>("#send")!.addEventListener("click", async () => {
        $("out").innerHTML = "";
        ctx.clearLog();
        await ctx.run(dmArgs({ live: true })).done; // live
      });
    });
  },
};
```

- [ ] **Step 2: Register in `main.ts`** (`import { dmPanel }`, add last). Final `main.ts`:

```typescript
import { mountConsole } from "./console";
import { buildPanel } from "./tools/build";
import { followPanel } from "./tools/follow";
import { chainPanel } from "./tools/chain";
import { unfollowPanel } from "./tools/unfollow";
import { dmPanel } from "./tools/dm";

mountConsole([buildPanel, followPanel, chainPanel, unfollowPanel, dmPanel]);
```

- [ ] **Step 3: Build** `cd desktop && npm run build` → clean.
- [ ] **Step 4: Commit** `cd .. && git add desktop/src/tools/dm.ts desktop/src/main.ts && git commit -m "feat(app): DM panel (template/dry-run/confirm)"`

---

## Task 12: Branding + icon

**Files:** Modify `desktop/src-tauri/tauri.conf.json`; regenerate `desktop/src-tauri/icons/`; create a throwaway icon-gen script.

- [ ] **Step 1: Set name in `tauri.conf.json`** — `productName: "Xperiment"`, `app.windows[0].title: "Xperiment"`, and `identifier: "com.xperiment.app"`.

- [ ] **Step 2: Generate the icon PNG via Playwright** (reuses the repo's Playwright; the repo root has it). Create `desktop/gen-icon.mjs`:

```javascript
import { chromium } from "playwright";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs>
  <rect width="1024" height="1024" rx="230" fill="#161618"/>
  <g stroke="#6d5bbd" stroke-width="42">
    <line x1="320" y1="360" x2="700" y2="280"/><line x1="320" y1="360" x2="460" y2="720"/>
    <line x1="700" y1="280" x2="460" y2="720"/><line x1="700" y1="280" x2="780" y2="660"/>
  </g>
  <g fill="url(#g)"><circle cx="320" cy="360" r="92"/><circle cx="700" cy="280" r="118"/><circle cx="460" cy="720" r="84"/><circle cx="780" cy="660" r="66"/></g>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<body style="margin:0">${svg}</body>`);
const out = join(process.cwd(), "app-icon.png");
await page.locator("svg").screenshot({ path: out, omitBackground: true });
await browser.close();
console.log("wrote", out);
```

- [ ] **Step 3: Run icon gen + Tauri icon set** (from `desktop/`):
```bash
cd desktop && npx tsx gen-icon.mjs && npx tauri icon app-icon.png && rm app-icon.png gen-icon.mjs
```
Expected: `npx tauri icon` writes `src-tauri/icons/` (icon.icns, icon.ico, png sizes). (Remove the throwaway script + png after.)

- [ ] **Step 4: Build** `cd desktop && npm run build` → clean. (Icon shows on the next `tauri dev`/build — operator verifies the dock icon visually.)

- [ ] **Step 5: Commit** `cd .. && git add desktop/src-tauri/tauri.conf.json desktop/src-tauri/icons && git commit -m "feat(app): brand as Xperiment + social-graph icon"`

---

## Task 13: README + full test run

**Files:** Modify `desktop/README.md`.

- [ ] **Step 1: Run the full suites** — from repo root: `npm test` (engine, expect unchanged pass count) and `npx tsx --test desktop/src/*.test.ts` (app pure logic: steps, status, engine, build). Paste counts. If anything fails, STOP and report.

- [ ] **Step 2: Update `desktop/README.md`** — describe Xperiment: prerequisites (Rust/Tauri, Node, logged-in X via Connect X), `REPO_DIR` setup, `cd desktop && npm install && npm run tauri dev`; the console (sidebar tools, status bar with cap meters + Stop + Cleanup, live log); each tool in one line; the strictly-safe note (no burst/force in GUI; DM dry-run→confirm); that packaging is a separate future step.

- [ ] **Step 3: Commit** `cd .. && git add desktop/README.md && git commit -m "docs(app): Xperiment console README"`

---

## Self-Review

- **Spec coverage:** full suite panels → Tasks 6,8,9,10,11; command-center chrome → Task 6; graphite/violet → Task 6 styles; cap meters → Task 7; write-lock banner → Tasks 7–11; Stop/kill/cleanup → Task 1 (`cleanup.ts`) + Task 6 (Stop/Cleanup/window-close via `engine.killAllEngine`); DM dry-run→confirm → Task 11; Connect auto-detect → Task 2 (sentinel) + Task 6 (`connectX` watches for it); branding + icon → Task 12; no footguns → no burst/force args anywhere in `steps.ts` builders. Testing → Tasks 1,3,4,5 pure tests; smokes deferred. Covered.
- **Placeholder scan:** none — pure modules have full code+tests; UI files have complete code; the two unknowns (fs `exists` export name; capability identifiers) are explicit confirm steps from Task 1's recorded findings, not silent TODOs.
- **Type consistency:** `ConsoleCtx`/`Panel` defined in Task 6 and consumed by every panel; `runEngine`/`EngineRun`/`killAllEngine`/`ChildRegistry` from Task 5 used in Task 6; `followArgs`/`chainArgs`/`unfollowScanArgs`/`unfollowArgs`/`dmArgs` from Task 3 used in Tasks 8–11; `countToday`/`capLabel` from Task 4 used in Task 7; `followLockHeld` defined in Task 7 used in Tasks 8–10; `staleLockFiles` from Task 1 self-contained. `XPERIMENT_LOGGED_IN` sentinel string identical in Task 2 (emit) and Task 6 (watch).

## Notes on verification
Only pure logic is unit-tested (process registry, arg builders, cap counting, stale-lock detection). All panel behavior, the live cap meters, the write-lock banner, DM dry-run→confirm, Connect auto-detect, Stop/Cleanup, and the icon are **smoke-tested by the operator at the window** (`npm run tauri dev`) — they need a display and a logged-in X session. Packaging into an installer remains a separate future plan.
