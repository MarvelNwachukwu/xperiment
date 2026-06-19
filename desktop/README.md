# List Builder — Desktop Shell (dev)

A Tauri v2 desktop GUI that drives the existing list-builder engine through a point-and-click UI. Phase 1 (read-only): Connect X, define seeds + target criteria, run the crawl/enrich/filter pipeline with live progress, view results, export CSV. No code changes to the engine — the app is a launcher over commands that already exist in the repo root.

## Prerequisites

1. **Rust + Tauri toolchain** — install if you don't have it: <https://tauri.app/start/prerequisites/>
2. **Node** (v18+ recommended) — the engine runs via `npx tsx`.
3. **The repo root** — the engine (`prospect.ts`, `follow-bot.ts`) lives there and must be checked out alongside `desktop/`.
4. **A logged-in X session** — either use the in-app Connect X button (see flow below), or run `npm run login` from the repo root before launching the app.

## Setup

1. Open `desktop/src/config.ts` and set `REPO_DIR` to the absolute path of the repo root on your machine:

   ```ts
   export const REPO_DIR = "/absolute/path/to/xperiment";
   ```

2. Install desktop dependencies and start the dev app:

   ```bash
   cd desktop
   npm install
   npm run tauri dev
   ```

   A desktop window opens. First launch triggers a Rust compile — this takes a minute or two; subsequent starts are fast.

## In-app flow

1. **Connect X** — click "Connect X". A Chrome window opens to X login. Sign in, then click "I've logged in" in the app. The session is saved to the engine's profile directory and persists across runs.

2. **Define** — enter one seed `@handle` per line, choose crawl side (following/followers), type "Looking for" keywords (e.g. `lawyer, attorney`), and optionally a Location filter (e.g. `nigeria, lagos`).

3. **Build list** — click the button. The log pane streams the engine's stdout: crawl → enrich → filter. This drives your real Chrome instance against X.

4. **Results** — when the pipeline finishes, the results table shows matches with handle, name, location, follower count, and matched keywords.

5. **Export CSV** — click "Export CSV". The engine writes `output/candidates.csv` in the repo root and the file manager opens revealing it.

## Notes

- **This is the dev shell.** It runs against Node and Chrome installed on your machine via `npx` — no bundled runtime. Packaging into a double-click installer (bundling Node + Chromium, signing/notarization, per-OS builds) is a separate future step (Plan 3) and requires a human to click through the GUI smoke tests.
- The engine's output files (`output/candidates.json`, `output/candidates.csv`) are written to the repo root, not inside `desktop/`.
- If X rate-limits a crawl, rerun just that step from the CLI (`npm run crawl <handle>`) and then resume from the app.
