# Packaging Xperiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build installable macOS `.dmg` + Windows `.exe` for Xperiment that run with no repo/Node, requiring only Google Chrome.

**Architecture:** Compile the engine TS to JS (`engine-dist/`), bundle it with a pinned Node binary + pruned prod `node_modules` as Tauri resources. A pure `resolveSpawn` maps logical args to `npx tsx` (dev) or bundled `node engine-dist/*.js` (packaged). Writable paths move to an app-data dir via `XPERIMENT_DATA_DIR`. GitHub Actions builds both OSes on tag.

**Tech Stack:** Tauri v2, TypeScript via `tsc` (engine build) + `tsx` (dev/tests), Playwright (`channel:'chrome'`), GitHub Actions + `tauri-apps/tauri-action`.

## Global Constraints

- Engine files at repo root, run via `tsx` in dev; `npm test` = `tsx --test *.test.ts`, `node:test` + `node:assert/strict`. Tests are the gate (no engine tsconfig today; this plan adds one for the build only).
- **No behavior change in dev.** `tauri dev`, `npm run scan`, etc. must work exactly as before. `XPERIMENT_DATA_DIR` unset → engine uses `__dirname` paths (today's behavior).
- **Require Chrome, do not bundle Chromium** (ADR 0004). Install Playwright with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.
- **Pin Node 22 LTS** for the bundled binary: `NODE_VERSION = v22.11.0` (bump the patch if a newer 22 LTS is current at build time; keep it 22.x).
- **Unsigned v1.** No signing identity in the Tauri config or CI.
- Platforms: macOS (`dmg`) + Windows (`nsis`), built in CI.
- Keep `productName` "Xperiment", identifier `com.xperiment.app`, and the v0.1.0 icon set.
- Decisions: `docs/superpowers/specs/2026-06-21-packaging-design.md`, `docs/adr/0004-require-system-chrome.md`.

---

### Task 1: Engine writable paths via `XPERIMENT_DATA_DIR`

**Files:**
- Modify: `config.ts` (root engine config)
- Test: `config-paths.test.ts` (new, root)

**Interfaces:**
- Produces: `OUTPUT_DIR`, `PROFILE_DIR` now resolve from `process.env.XPERIMENT_DATA_DIR ?? __dirname`. A pure helper `dataDir(env, dirname)` is exported for testing.

- [ ] **Step 1: Write the failing test**

Create `config-paths.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { dataDir } from "./config";
import * as path from "path";

test("dataDir: uses XPERIMENT_DATA_DIR when set", () => {
  assert.equal(dataDir({ XPERIMENT_DATA_DIR: "/data/x" }, "/app"), "/data/x");
});
test("dataDir: falls back to dirname when unset", () => {
  assert.equal(dataDir({}, "/app"), "/app");
});
test("OUTPUT_DIR/PROFILE_DIR are under the resolved data dir", async () => {
  // Importing config.ts (no env) must keep dev behavior: under __dirname.
  const cfg = await import("./config");
  assert.ok(cfg.OUTPUT_DIR.endsWith(path.join("output")));
  assert.ok(cfg.PROFILE_DIR.endsWith(".chrome-profile"));
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npm test`
Expected: FAIL (`dataDir` is not exported).

- [ ] **Step 3: Implement**

In `config.ts`, replace the two `__dirname`-based writable paths. Add the helper and use it:

```typescript
// Writable state lives under XPERIMENT_DATA_DIR when set (packaged app),
// else next to the engine (dev). Keeps dev behavior identical.
export function dataDir(env: Record<string, string | undefined>, dirname: string): string {
  return env.XPERIMENT_DATA_DIR ?? dirname;
}
const DATA_DIR = dataDir(process.env, __dirname);

export const OUTPUT_DIR = path.join(DATA_DIR, "output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
// ... (all the *_FILE exports stay as path.join(OUTPUT_DIR, ...), unchanged)

export const PROFILE_DIR = path.join(DATA_DIR, ".chrome-profile");
```

Leave every `*_FILE` export and the rest of the file unchanged.

- [ ] **Step 4: Run, verify it passes**

Run: `npm test`
Expected: PASS (3 new tests + all existing green).

- [ ] **Step 5: Commit**

```bash
git add config.ts config-paths.test.ts
git commit -m "feat(engine): resolve writable paths from XPERIMENT_DATA_DIR (dev fallback)"
```

---

### Task 2: Compile the engine to JS (`engine-dist/`)

**Files:**
- Create: `tsconfig.engine.json` (root)
- Modify: `package.json` (root — add `build:engine` script; ensure runtime deps are in `dependencies`)
- Create: `.gitignore` entry for `engine-dist/`

**Interfaces:**
- Produces: `npm run build:engine` -> compiled CommonJS in `engine-dist/` (e.g. `engine-dist/follow-bot.js`, `chain-runner.js`, `unfollow-bot.js`, `roster.ts` is not built — only existing engine entry files), runnable by plain Node.

- [ ] **Step 1: Add the engine tsconfig**

Create `tsconfig.engine.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "engine-dist",
    "rootDir": ".",
    "resolveJsonModule": true
  },
  "include": ["*.ts"],
  "exclude": ["*.test.ts", "desktop/**", "engine-dist/**"]
}
```

- [ ] **Step 2: Ensure runtime deps are in `dependencies`**

Open `package.json`. Confirm `playwright` (and any other module the engine imports at runtime) is under `"dependencies"`, and `tsx` / `typescript` / `@types/*` are under `"devDependencies"`. Move any misplaced runtime dep into `dependencies`. Add the build script:

```json
"scripts": {
  "build:engine": "tsc -p tsconfig.engine.json"
}
```

(Merge into the existing `scripts` block; keep all current scripts.)

- [ ] **Step 3: Ignore the build output**

Append to `.gitignore` (create if absent): `engine-dist/`

- [ ] **Step 4: Build and verify the compiled engine runs under Node**

Run:
```bash
npm run build:engine
XPERIMENT_DATA_DIR="$(mktemp -d)" node -e "require('./engine-dist/config.js'); console.log('engine-dist config loads')"
ls engine-dist/follow-bot.js engine-dist/chain-runner.js engine-dist/unfollow-bot.js engine-dist/x-graph.js
```
Expected: prints `engine-dist config loads`, and the listed files exist. (Confirms the engine compiles to runnable CJS and respects `XPERIMENT_DATA_DIR`.)

- [ ] **Step 5: Confirm dev + tests still pass**

Run: `npm test`
Expected: PASS (compiling does not change the `tsx`-run sources).

- [ ] **Step 6: Commit**

```bash
git add tsconfig.engine.json package.json .gitignore
git commit -m "build(engine): compile to engine-dist via tsconfig.engine.json"
```

---

### Task 3: `resolveSpawn` — dev/packaged launcher resolver

**Files:**
- Create: `desktop/src/launcher.ts`
- Test: `desktop/src/launcher.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface LaunchCtx { packaged: boolean; nodePath: string; engineDir: string; repoDir: string; dataDir: string; }`
  - `interface Spawn { program: string; args: string[]; cwd: string; env: Record<string, string>; }`
  - `function resolveSpawn(logicalArgs: string[], ctx: LaunchCtx): Spawn`

Logical args always start `["tsx", "<file>.ts", ...rest]` (from `steps.ts`). Dev: run them via `npx` at the repo. Packaged: run the compiled `.js` with the bundled Node, cwd = data dir, inject `XPERIMENT_DATA_DIR`.

- [ ] **Step 1: Write the failing test**

Create `desktop/src/launcher.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSpawn } from "./launcher";

const base = { nodePath: "/res/node", engineDir: "/res/engine-dist", repoDir: "/repo", dataDir: "/data" };

test("resolveSpawn dev: npx tsx at the repo", () => {
  const s = resolveSpawn(["tsx", "follow-bot.ts", "follow", "x"], { ...base, packaged: false });
  assert.equal(s.program, "npx");
  assert.deepEqual(s.args, ["tsx", "follow-bot.ts", "follow", "x"]);
  assert.equal(s.cwd, "/repo");
});

test("resolveSpawn packaged: bundled node + compiled js, data dir env", () => {
  const s = resolveSpawn(["tsx", "follow-bot.ts", "follow", "x"], { ...base, packaged: true });
  assert.equal(s.program, "/res/node");
  assert.deepEqual(s.args, ["/res/engine-dist/follow-bot.js", "follow", "x"]);
  assert.equal(s.cwd, "/data");
  assert.equal(s.env.XPERIMENT_DATA_DIR, "/data");
});

test("resolveSpawn packaged: maps the .ts entry to .js", () => {
  const s = resolveSpawn(["tsx", "cleanup.ts"], { ...base, packaged: true });
  assert.deepEqual(s.args, ["/res/engine-dist/cleanup.js"]);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx tsx --test desktop/src/launcher.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `desktop/src/launcher.ts`:

```typescript
export interface LaunchCtx {
  packaged: boolean;
  nodePath: string;   // bundled node (packaged only)
  engineDir: string;  // bundled engine-dist (packaged only)
  repoDir: string;    // dev repo root
  dataDir: string;    // writable app-data dir (packaged); repoDir in dev
}

export interface Spawn {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

// Logical args look like ["tsx", "<file>.ts", ...rest].
export function resolveSpawn(logicalArgs: string[], ctx: LaunchCtx): Spawn {
  const [, entry, ...rest] = logicalArgs; // drop "tsx"
  if (!ctx.packaged) {
    return { program: "npx", args: logicalArgs, cwd: ctx.repoDir, env: {} };
  }
  const js = entry.replace(/\.ts$/, ".js");
  return {
    program: ctx.nodePath,
    args: [`${ctx.engineDir}/${js}`, ...rest],
    cwd: ctx.dataDir,
    env: { XPERIMENT_DATA_DIR: ctx.dataDir },
  };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `npx tsx --test desktop/src/launcher.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/launcher.ts desktop/src/launcher.test.ts
git commit -m "feat(app): resolveSpawn — dev npx vs packaged bundled-node launcher"
```

---

### Task 4: Wire the launcher + Chrome check into the app

**Files:**
- Modify: `desktop/src/config.ts`, `desktop/src/engine.ts`, `desktop/src/console.ts`
- Exclude the new `*.test.ts` from the browser build if needed (`desktop/tsconfig.json`)

**Interfaces:**
- Consumes: `resolveSpawn`, `LaunchCtx` (Task 3).
- Produces: `getLaunchCtx(): Promise<LaunchCtx>` in `config.ts`; `runEngine` uses the resolved ctx; a Chrome-missing banner in the status bar.

- [ ] **Step 1: Resolve the launch context (`desktop/src/config.ts`)**

Replace `desktop/src/config.ts` with:

```typescript
import { resolveResource } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import type { LaunchCtx } from "./launcher";

// Dev repo path (only used when running via `tauri dev`).
export const REPO_DIR = "/Users/0xmarvel/superconductor/projects/xperiment";

let cached: LaunchCtx | null = null;
export async function getLaunchCtx(): Promise<LaunchCtx> {
  if (cached) return cached;
  const packaged = !import.meta.env.DEV; // tauri dev => Vite DEV=true
  if (!packaged) {
    cached = { packaged: false, nodePath: "", engineDir: "", repoDir: REPO_DIR, dataDir: REPO_DIR };
  } else {
    const data = await appDataDir();
    cached = {
      packaged: true,
      nodePath: await resolveResource("resources/node"),       // see Task 5 layout
      engineDir: await resolveResource("resources/engine-dist"),
      repoDir: REPO_DIR,
      dataDir: data,
    };
  }
  return cached;
}
```

- [ ] **Step 2: Use it in `runEngine` (`desktop/src/engine.ts`)**

Replace the `import` and the `Command.create(...)` line. `runEngine` resolves the ctx, then spawns via `resolveSpawn`:

```typescript
import { Command, type Child } from "@tauri-apps/plugin-shell";
import { getLaunchCtx } from "./config";
import { resolveSpawn } from "./launcher";
// ... ChildRegistry, EngineRun, registry, activeCount, killAllEngine unchanged ...

export function runEngine(args: string[], onLine: (line: string) => void): EngineRun {
  let child: Child | null = null;
  const done = (async () => {
    const ctx = await getLaunchCtx();
    const s = resolveSpawn(args, ctx);
    const cmd = Command.create(s.program, s.args, { cwd: s.cwd, env: s.env });
    cmd.stdout.on("data", (l) => onLine(l));
    cmd.stderr.on("data", (l) => onLine(l));
    await new Promise<void>((resolve) => {
      cmd.on("close", () => { if (child) registry.remove(child); resolve(); });
      cmd.spawn().then((c) => { child = c; registry.add(c); });
    });
  })();
  return { done, kill: async () => { if (child) await child.kill(); } };
}
```

(Note: `Command.create`'s options accept `env`. Passing `{}` in dev is a no-op.)

- [ ] **Step 3: Chrome-missing banner (`desktop/src/console.ts`)**

Add a check after mounting the status bar. Use the shell plugin to test for Chrome; simplest cross-platform check is to attempt a lightweight `Command` that resolves Chrome, but to avoid spawn-scope complexity, check known paths via the fs plugin:

```typescript
import { exists } from "@tauri-apps/plugin-fs";
// after the status bar is in the DOM:
async function checkChrome() {
  const mac = "/Applications/Google Chrome.app";
  const win1 = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const win2 = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
  const ok = (await exists(mac).catch(() => false))
    || (await exists(win1).catch(() => false))
    || (await exists(win2).catch(() => false));
  if (!ok) {
    const bar = document.querySelector<HTMLElement>(".statusbar")!;
    const b = document.createElement("span");
    b.className = "meter";
    b.style.color = "var(--danger)";
    b.textContent = "Google Chrome required — get it at google.com/chrome";
    bar.insertBefore(b, bar.querySelector("#meters"));
  }
}
void checkChrome();
```

Add `fs:allow-exists` is already granted for `$HOME/**`; broaden the existing `fs:allow-exists` allow-list to include the Chrome paths (Task 5 covers capability edits) — for this task, wrap the `exists` calls in `.catch(() => false)` so a scope denial degrades to "assume present" rather than throwing.

- [ ] **Step 4: Verify the desktop build + app tests**

Run:
```bash
cd desktop && npm run build
npx tsx --test src/launcher.test.ts src/steps.test.ts src/status.test.ts src/engine.test.ts
```
Expected: build PASS; all app tests PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/config.ts desktop/src/engine.ts desktop/src/console.ts desktop/tsconfig.json
git commit -m "feat(app): spawn via resolveSpawn + launch context; Chrome-missing banner"
```

---

### Task 5: Resource assembly + Tauri bundle config

**Files:**
- Create: `desktop/scripts/prepare-resources.mjs`
- Modify: `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/capabilities/default.json`
- Modify: `desktop/package.json` (a `prebundle` script)

**Interfaces:**
- Produces: `desktop/src-tauri/resources/{node, engine-dist/, node_modules/}` assembled before `tauri build`, and `tauri.conf.json` bundling them.

- [ ] **Step 1: Resource-assembly script**

Create `desktop/scripts/prepare-resources.mjs`. It (a) builds the engine, (b) installs pruned prod deps with no Playwright browser download, (c) downloads the pinned Node binary for the current OS, and stages everything under `src-tauri/resources/`:

```javascript
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, createWriteStream, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform, arch } from "node:os";
import { pipeline } from "node:stream/promises";

const NODE_VERSION = "v22.11.0";
const repo = join(import.meta.dirname, "..", "..");      // engine repo root
const res = join(import.meta.dirname, "..", "src-tauri", "resources");

rmSync(res, { recursive: true, force: true });
mkdirSync(res, { recursive: true });

// 1. compiled engine
execSync("npm run build:engine", { cwd: repo, stdio: "inherit" });
cpSync(join(repo, "engine-dist"), join(res, "engine-dist"), { recursive: true });

// 2. pruned prod node_modules (no chromium)
execSync("npm ci --omit=dev", {
  cwd: repo, stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
});
cpSync(join(repo, "node_modules"), join(res, "node_modules"), { recursive: true });

// 3. node binary for this OS
const isWin = platform() === "win32";
const plat = isWin ? "win" : "darwin";
const a = arch() === "arm64" ? "arm64" : "x64";
const ext = isWin ? "zip" : "tar.gz";
const name = `node-${NODE_VERSION}-${plat}-${a}`;
const url = `https://nodejs.org/dist/${NODE_VERSION}/${name}.${ext}`;
const tmp = join(tmpdir(), `${name}.${ext}`);
const r = await fetch(url);
if (!r.ok) throw new Error(`node download failed: ${r.status} ${url}`);
await pipeline(r.body, createWriteStream(tmp));
const work = join(tmpdir(), name);
rmSync(work, { recursive: true, force: true });
if (isWin) {
  execSync(`tar -xf "${tmp}" -C "${tmpdir()}"`); // bsdtar on win extracts zip
  cpSync(join(work, "node.exe"), join(res, "node.exe"));
} else {
  execSync(`tar -xf "${tmp}" -C "${tmpdir()}"`);
  const nodeBin = join(res, "node");
  cpSync(join(work, "bin", "node"), nodeBin);
  chmodSync(nodeBin, 0o755);
}
console.log("resources prepared at", res);
```

- [ ] **Step 2: Wire the script + ignore the output**

In `desktop/package.json` scripts add:
```json
"prepare-resources": "node scripts/prepare-resources.mjs"
```
Append `src-tauri/resources/` to `desktop/.gitignore` (create if absent).

- [ ] **Step 3: Bundle the resources (`tauri.conf.json`)**

In `desktop/src-tauri/tauri.conf.json`, set `bundle.resources` and per-OS targets:
```json
"bundle": {
  "active": true,
  "targets": ["dmg", "nsis"],
  "resources": ["resources/node", "resources/node.exe", "resources/engine-dist/**/*", "resources/node_modules/**/*"],
  "icon": ["icons/32x32.png","icons/128x128.png","icons/128x128@2x.png","icons/icon.icns","icons/icon.ico"]
}
```
(Tauri ignores a `resources` glob that matches nothing, so listing both `node` and `node.exe` is fine per-OS.)

- [ ] **Step 4: Capability scope for the bundled node (`capabilities/default.json`)**

Replace the two `npx`-only shell entries so they allow BOTH dev `npx` and the bundled node by resource path:
```json
{ "identifier": "shell:allow-execute", "allow": [
  { "name": "npx", "cmd": "npx", "args": true },
  { "name": "node", "cmd": "$RESOURCE/resources/node", "args": true },
  { "name": "node-win", "cmd": "$RESOURCE/resources/node.exe", "args": true }
]},
{ "identifier": "shell:allow-spawn", "allow": [
  { "name": "npx", "cmd": "npx", "args": true },
  { "name": "node", "cmd": "$RESOURCE/resources/node", "args": true },
  { "name": "node-win", "cmd": "$RESOURCE/resources/node.exe", "args": true }
]}
```
Also extend the existing `fs:allow-exists` allow list with the three Chrome paths from Task 4 so the check is permitted:
```json
{ "identifier": "fs:allow-exists", "allow": [
  { "path": "$HOME/**" },
  { "path": "/Applications/Google Chrome.app" },
  { "path": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  { "path": "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" }
]}
```

- [ ] **Step 5: Local macOS build verification**

Run:
```bash
cd desktop
npm run prepare-resources
npm run tauri build
ls src-tauri/target/release/bundle/dmg/*.dmg
```
Expected: a `.dmg` is produced. (This proves the resource layout + bundle config are valid on macOS. Windows is verified in CI, Task 6.)

- [ ] **Step 6: Commit**

```bash
git add desktop/scripts/prepare-resources.mjs desktop/package.json desktop/.gitignore desktop/src-tauri/tauri.conf.json desktop/src-tauri/capabilities/default.json
git commit -m "build(app): assemble node+engine resources and bundle dmg/nsis"
```

---

### Task 6: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Produces: on a `v*` tag (or manual dispatch), builds macOS + Windows installers and attaches them to the GitHub release.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    tags: ["v*"]
  workflow_dispatch:

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
          - os: windows-latest
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: Install desktop deps
        run: npm ci
        working-directory: desktop
      - name: Prepare engine resources
        run: npm run prepare-resources
        working-directory: desktop
      - uses: dtolnay/rust-toolchain@stable
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          projectPath: desktop
          tagName: ${{ github.ref_name }}
          releaseName: "Xperiment ${{ github.ref_name }}"
          releaseDraft: true
          args: ${{ matrix.os == 'macos-latest' && '--bundles dmg' || '--bundles nsis' }}
```

- [ ] **Step 2: Validate the workflow YAML**

Run: `npx --yes js-yaml .github/workflows/release.yml >/dev/null && echo "yaml ok"`
Expected: `yaml ok` (parses; no syntax errors). Full execution is verified by pushing a tag (operator step).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: build mac/windows installers on tag via tauri-action"
```

---

### Task 7: Docs + install instructions

**Files:**
- Modify: `desktop/README.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Document install + prerequisites**

Update `desktop/README.md` with an "Install" section: the prerequisite (Google Chrome), where to get the `.dmg`/`.exe` (the GitHub release), and the one-time unsigned bypass — macOS: right-click the app → Open → Open; Windows: SmartScreen → More info → Run anyway. Note that running from source is still `npm run tauri dev`. Note that data (lists, login session) lives in the OS app-data dir, and packaging is built in CI on `v*` tags.

- [ ] **Step 2: Commit**

```bash
git add desktop/README.md
git commit -m "docs(app): install instructions, prerequisites, unsigned bypass"
```

---

## Notes for the operator (after the plan)

- `git tag v0.2.0 && git push origin v0.2.0` triggers the CI build; download the draft release's `.dmg`/`.exe`.
- Smoke: install the `.dmg` on a machine without the repo, confirm the Chrome banner logic, Connect X, and one tool run writing to the app-data dir. Repeat with the `.exe` on Windows.
- Code signing / notarization is the next milestone (this ships unsigned).
