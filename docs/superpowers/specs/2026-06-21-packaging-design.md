# Packaging Xperiment into a Distributable — Design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan
**Builds on:** the released app (`main`, v0.1.0), the Tauri shell (`desktop/`), and the CLI engine. Revises an assumption in [ADR 0002](../../adr/0002-tauri-over-electron.md); adds ADR 0004 (require system Chrome).

## Purpose

Turn the `tauri dev`-only app into installable artifacts a non-technical user can run: a macOS `.dmg` and a Windows `.exe`, with no repo, no Node, no `npx` on the target machine. The only prerequisite is **Google Chrome**. This is the deferred "Plan 3".

## Key finding (reframes the effort)

The engine launches Chrome via `chromium.launchPersistentContext(PROFILE_DIR, { channel: "chrome" })` (`browser.ts:39-41`). It drives the user's **installed Google Chrome**, not Playwright's bundled Chromium. So ADR 0002's premise ("must ship ~190MB of Chromium") does not match the code. We require Chrome instead of bundling a browser, which removes the largest and riskiest packaging piece and keeps the installer to roughly 60-80MB. Recorded as **ADR 0004**.

## Decisions (from brainstorming)

| Area | Decision |
|---|---|
| Platforms | **macOS + Windows**, built via GitHub Actions CI (Windows cannot be built on the Mac) |
| Browser | **Require installed Chrome** (keep `channel:'chrome'`); check on launch, link to chrome.com if missing |
| Engine sidecar | **Bundled Node + compiled JS + pruned prod `node_modules`** as Tauri resources; app spawns the bundled Node |
| Signing | **Unsigned for v1**; document the one-time Gatekeeper/SmartScreen bypass |
| Node runtime | Pin **Node 22 LTS** for the bundled binary (dev uses whatever is installed) |

## Architecture

```
build time (per OS, in CI):
  tsc (engine) -> engine-dist/*.js
  npm ci --omit=dev (engine), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 -> pruned node_modules
  fetch Node 22 LTS binary for the target OS
  tauri build -> bundles the above as resources -> .dmg / .exe

runtime (packaged):
  Tauri app
    -> resolves resourceDir + appDataDir
    -> spawns: <resourceDir>/node <resourceDir>/engine-dist/<cmd>.js <args>
       cwd = appDataDir, env XPERIMENT_DATA_DIR = appDataDir
    -> engine writes output/ + .chrome-profile under appDataDir
    -> engine drives the user's installed Chrome
```

### Components

**1. Engine compiled to JS (`engine-dist/`).**
A `tsconfig.engine.json` compiles the root engine `*.ts` (excluding `*.test.ts`) to runnable JS in `engine-dist/`. Module/target settings chosen so the output runs under plain Node (the engine mixes `require.main === module` with ESM-style imports; the compiled output must be internally consistent — CommonJS is the safe target). This is a build artifact, not committed.

**2. Writable paths (`config.ts`).**
Replace the two `__dirname`-relative writable paths with env-driven resolution, dev-fallback preserved:

```ts
const DATA_DIR = process.env.XPERIMENT_DATA_DIR ?? __dirname;
export const OUTPUT_DIR = path.join(DATA_DIR, "output");
export const PROFILE_DIR = path.join(DATA_DIR, ".chrome-profile");
```

In dev, `XPERIMENT_DATA_DIR` is unset → identical to today (`__dirname/output`, `__dirname/.chrome-profile`). Packaged, the app sets it to Tauri's app-data dir. No other engine file changes.

**3. Dev/packaged launcher (`desktop/src/engine.ts` + `config.ts`).**
Arg builders in `steps.ts` keep emitting logical args (`["tsx","follow-bot.ts",…]`). A pure resolver maps logical args to the real spawn:

```ts
// dev:      npx tsx follow-bot.ts <rest>        cwd=REPO_DIR
// packaged: <node> engine-dist/follow-bot.js <rest>   cwd=dataDir, env XPERIMENT_DATA_DIR
resolveSpawn(logicalArgs, { packaged, resourceDir, dataDir }) -> { program, args, cwd, env }
```

It strips the leading `["tsx", "<file>.ts"]`, and in packaged mode substitutes `<file>.js` under `engine-dist/` and the bundled Node path. Packaged-ness is detected via Tauri (e.g. resource path exists / not dev). `REPO_DIR` stays a dev-only constant; packaged paths come from Tauri's `resolveResource` + `appDataDir` at runtime.

**4. Chrome check.**
On app launch, check for Chrome (macOS: `/Applications/Google Chrome.app`; Windows: `HKLM/HKCU` `App Paths\chrome.exe` or `%ProgramFiles%`). If absent, show a status-bar banner: "Google Chrome is required. Download it from google.com/chrome." Tools that need the browser surface the engine's existing error otherwise.

**5. Capability scope (`capabilities/default.json`).**
Add the bundled Node resource path to the shell `execute`/`spawn` allowlist (scoped with the `$RESOURCE` path variable), keeping the `npx` entry for dev. This also tightens the previously-noted over-broad scope: the allowlist is exactly `{npx (dev), <resource>/node (packaged)}`.

**6. Bundle config (`tauri.conf.json`).**
`bundle.resources` includes `node` (per-OS binary), `engine-dist/`, and the pruned `node_modules`. `bundle.targets` = `["dmg"]` on macOS, `["nsis"]` on Windows (CI selects per-OS). Keep `productName`/icons from v0.1.0.

**7. CI (`.github/workflows/release.yml`).**
Matrix `[macos-latest, windows-latest]`, triggered on `v*` tags (and manual dispatch). Each job: checkout; setup Node; `npm ci` for `desktop/`; install + `tsc` the engine; `npm ci --omit=dev` + `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` for the engine's prod `node_modules`; download the Node 22 LTS binary for the OS; `tauri build`; upload the `.dmg`/`.exe` as artifacts and attach to the GH release for the tag. Uses `tauri-apps/tauri-action`.

## Data flow

```
launch -> Chrome check -> Connect X (unchanged)
tool run -> resolveSpawn(logical args, packaged?) -> bundled node engine-dist/<cmd>.js
         -> engine reads XPERIMENT_DATA_DIR -> output/, .chrome-profile there
         -> drives installed Chrome -> streams stdout to the log
```

## Error handling

- **Chrome missing:** launch banner + chrome.com link; engine error surfaced in the log if a tool is run anyway.
- **First run:** app-data dir created on first spawn; no session yet → existing Connect X flow.
- **Unsigned install:** documented bypass — macOS right-click → Open (one time); Windows SmartScreen → More info → Run anyway.
- **Bundled spawn failure (path wrong):** the resolver logs the resolved program/args to the console log so packaging path bugs are diagnosable.

## Testing

- **Unit (pure):**
  - `resolveSpawn` — logical args map correctly in both dev and packaged modes (program, args, cwd, env), including the `.ts`→`.js` and `tsx`→node substitution and `XPERIMENT_DATA_DIR` injection.
  - engine `config.ts` path resolution — `XPERIMENT_DATA_DIR` set vs unset yields the right `OUTPUT_DIR`/`PROFILE_DIR` (small, injectable check).
- **Build verification:** CI `tauri build` produces a `.dmg` and `.exe` (the gate that the bundle config + resources are correct).
- **Operator smoke:** install the `.dmg` on a machine without the repo, confirm Chrome check, Connect X, and one tool run writing to the app-data dir; same for the `.exe` on Windows.

## Out of scope

- Code signing / notarization (a later milestone; v1 ships unsigned).
- Auto-update.
- Linux targets.
- Bundling Chromium (we require system Chrome, per ADR 0004).
- Single-binary engine (Bun/pkg) — rejected for v1 as riskier than the bundled-Node approach.
