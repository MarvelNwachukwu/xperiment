# Xperiment — Desktop Console

Xperiment is a Tauri v2 desktop command-center for the X growth toolkit. It exposes the full engine (Build List, Follow, Chain, Unfollow, DM) through a graphite/violet GUI with a sidebar nav, live log, daily cap meters, and Stop/Cleanup controls. No code changes to the engine — the app spawns the existing CLI tools from the repo root.

## Install

### Prerequisite

**Google Chrome must be installed.** The app drives Chrome to handle X authentication; it does not bundle its own browser.

### Getting the app

Download the latest installer from the [GitHub Releases](https://github.com/MarvelNwachukwu/xperiment/releases) page:

- **macOS (Apple Silicon):** `.dmg` file
- **Windows:** `.exe` file

### First-open bypass (unsigned app)

On first launch, you may see a security warning because the app is not yet code-signed. Follow these steps:

**macOS:**
1. Right-click the Xperiment app
2. Click "Open"
3. Click "Open" again on the confirmation dialog

**Windows:**
1. SmartScreen will appear
2. Click "More info"
3. Click "Run anyway"

### Running from source

If you clone the repo and want to build and run the app locally during development, use:

```bash
npm run tauri dev
```

### Data location

Your data (built lists, login session) are stored in your operating system's app-data directory, not in the repo. This means the data persists even if you move or delete the installation folder.

### CI builds

Release packages are built automatically on GitHub Actions when you push a tag matching `v*` (e.g., `v0.2.0`). Download the `.dmg` or `.exe` from the draft release.

## Prerequisites for development

This section applies if you are running the app from source.

1. **Rust + Tauri toolchain** — install if you don't have it: <https://tauri.app/start/prerequisites/>
2. **Node** (v18+ recommended) — the engine runs via `npx tsx`.
3. **The repo root** — all engine scripts (`follow-bot.ts`, `chain-runner.ts`, etc.) live there and must be checked out alongside `desktop/`.
4. **A logged-in X session** — use the in-app **Connect X** button in the status bar (see below). The app opens a Chrome window to X; once detected as signed in, the status bar turns green and the window can be closed.

## Setup for development

1. Open `desktop/src/config.ts` and set `REPO_DIR` to YOUR local clone's absolute path. This is a hardcoded constant in that file — you must edit it before running `tauri dev`. It is only used in dev mode; packaged builds ignore it entirely.

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

## Console layout

The window is divided into three regions:

**Status bar (top):** Shows the connection dot (grey = not connected, green = connected), cap meters (`follow N/350 · dm N/30` refreshed every 4 s), a **Stop** button (kills any running engine process), and a **Cleanup** button (kills stray engine/Chrome processes and removes stale write-locks).

**Sidebar (left):** Five nav buttons — one per tool. Click to switch panels; the active panel is highlighted in violet.

**Log pane (bottom):** Streams the engine's stdout/stderr in a monospace pane. Cleared automatically when you start a new run.

## Tools

- **Build List** — crawl seed accounts (following or followers side), enrich profiles, filter to keyword/location matches, view results table, export CSV.
- **Follow** — follow people from a target account's followers or following list; optionally filter to tech accounts only. Safe-paced with the 350/day cap.
- **Chain** — long-running follow run that hops the social graph from a seed account. Use **Stop** in the status bar to end it; **Resume last** restarts from where it left off.
- **Unfollow** — scan who you currently follow, review the non-tech candidates in a table (uncheck anyone you want to keep), then unfollow the checked ones.
- **DM** — write a template with `{name}`/`{location}` placeholders; the panel personalises it per candidate, runs a dry-run first, then shows a confirm step before sending real DMs (30/day cap).

## Strictly safe

The GUI never exposes burst mode, `--force`, or cap overrides. Write-lock banners appear on Follow/Chain/Unfollow panels when a conflicting tool is already running. DM is always dry-run first — real sends require an explicit second click on the confirm button.

## Notes

- **Connect X** — click the button in the status bar. A Chrome window opens; if an existing session is detected the status flips to Connected immediately. Otherwise sign in manually; the sentinel is emitted when you complete login.
- Output files (`output/*.json`, `output/candidates.csv`) are written to the OS app-data directory when running the installed app (see the **Data location** section under Install). In dev mode (`tauri dev`) they are written to `output/` under the repo root.
- Installers (`.dmg` for macOS, `.exe` for Windows) are available now — see the **Install** section above or download from [GitHub Releases](https://github.com/MarvelNwachukwu/xperiment/releases).
