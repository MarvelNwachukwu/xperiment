# Xperiment Superconsole — Design

**Date:** 2026-06-20
**Status:** Approved (design); pending implementation plan
**Builds on:** the Tauri app shell (`desktop/`, on `gui`) and the full CLI engine. Glossary in `CONTEXT.md`; prior specs in `docs/superpowers/specs/`.

## Purpose

Turn the bare dev shell into **Xperiment** — a polished "command center" desktop app that surfaces the **full toolkit** (list-building + follow + chain + unfollow + DM) with a slick graphite/violet look, while keeping every account-risky action safe-by-default. The app stays glue over the existing engine; no engine rewrite.

## Decisions (from brainstorming)

| Area | Decision |
|---|---|
| Tools | Full suite: **Build List, Follow, Chain, Unfollow, DM** |
| Layout | **Command center**: left tool sidebar · main tool panel · persistent live log · top status bar |
| Look | **Graphite + Violet** (dark graphite surfaces, violet accent) |
| Name | **Xperiment** (window title, dock, status-bar mark) |
| Icon | **Social-graph nodes** (violet on graphite, macOS rounded-square) |
| Safety | **Strictly safe**: visible cap meters, write-lock banner, Stop button, DM dry-run + confirm. Burst / `--force` / cap-override stay CLI-only — never in the GUI. |

## Architecture

Evolve `desktop/` (Tauri v2 + vanilla TS). The single `main.ts` splits into focused modules so no file does too much:

```
desktop/src/
  console.ts      shell chrome: sidebar nav, status bar, persistent log, Stop, panel router
  engine.ts       spawn an engine command via shell plugin, stream stdout→log, resolve on close; kill()
  status.ts       cap meters (read output logs) + connect state + write-lock state
  tools/
    build.ts      Build List panel (today's sync/crawl→enrich→filter→export)
    follow.ts     Follow panel
    chain.ts      Chain panel
    unfollow.ts   Unfollow panel (scan → review → unfollow)
    dm.ts         DM panel (template → dry-run → confirm send)
  steps.ts        existing pure arg-builders (extended per tool)
  config.ts       ENGINE, REPO_DIR (dev), constants
```

Engine integration is the proven pattern, unchanged: a panel builds an arg list (pure, tested) → `engine.run(args)` spawns `npx tsx <cmd>` via the shell plugin with `cwd: REPO_DIR` → stdout streams into the shared log → results read from `output/*.json` via the fs plugin.

## Components

### Console chrome (`console.ts`)
- **Sidebar:** Build / Follow / Chain / Unfollow / DM. Clicking swaps the main panel. Active item highlighted (violet).
- **Status bar:** `◆ Xperiment` mark · Connect state (`● Connected` / `○ Not connected`) · live **cap meters** for the day (`follow 120/350`, `dm 4/30`) · a **Stop** button (visible while a tool runs).
- **Persistent log:** the always-on terminal-style pane; every tool streams here. The "console" element.

### Tool panels → CLI mapping
- **Build List** — seeds + Target Criteria + side → `crawl` (per seed) → `enrich` → `filter --who/--where` → results table → `export-csv`. (Already built; re-homed into the new shell.)
- **Follow** — target `@handle`, toggle followers/following, toggle tech-only, **Start** → `follow @target [--following] [--tech-only]` (safe pacing always).
- **Chain** — seed `@handle`, **Start** → `chain @seed`; panel marks it long-running and offers **Resume** (`chain --resume`). Live total from the log.
- **Unfollow** — **Scan** → `unfollow-bot scan` → render `output/unfollow-candidates.json` as a list with keep/drop checkboxes (writes the edited file back) → **Unfollow** → `unfollow-bot unfollow`.
- **DM** — choose recipients (from `candidates.json` or pasted handles), write a **Message Template** with `{name}`/`{location}` → app fills it into `messages.json` → **Preview (dry-run)** runs `dm send` (dry-run) showing who'd be messaged vs skipped → **Confirm send** runs `dm send --live` after an explicit "Send N real DMs?" confirm.

## Safety mechanics

- **Cap meters (`status.ts`):** read `output/follow-log.json`, `output/dm-log.json`, `output/profiles.json` via fs plugin; count today's UTC entries (same rule as the engine's `todayCountUTC`); render meters. Refresh on a timer while a tool runs.
- **Write-lock surfaced:** the engine already enforces one follow-category write tool at a time (`output/.write-follow.lock`; DM is its own category). The app reads the lock files to **pre-disable** Start for a second follow-category tool and show a banner ("Follow is running — stop it first"); if the engine still refuses (e.g. a CLI run holds it), the app surfaces the engine's `✋` message from the log.
- **Stop:** kills the running child (`Child.kill()`). The engine's lock is freed on exit, or auto-reclaimed next run via the stale-PID check.
- **DM:** dry-run is the default action; **Confirm send** is a separate, explicitly-labelled button gated by a count confirm. No `--live` without that confirm.
- **No footguns in GUI:** burst mode, `--force`, and cap overrides are never exposed. Power users use the CLI.

### Connect X (redesigned)
Replace the clunky "I've logged in" button with auto-detection. On **Connect X**, the app spawns login; the engine's login flow is enhanced (additively, CLI behavior preserved) to **detect a live session** (already-logged-in profile or completed login) and emit a sentinel line; the app watches for it and flips the status to **Connected ✓** on its own. This is the one small engine change — kept backward-compatible (`npm run login` still works).

## Branding

`tauri.conf.json` `productName` + window `title` + bundle identifier → "Xperiment"; the status bar shows the violet ◆-graph mark. The **icon** (social-graph nodes, violet on graphite) is authored as an SVG and rasterized to 1024px by screenshotting it with the project's existing Playwright (headless), then `tauri icon` generates the platform icon set.

## Error handling

- Reuse the shell's stdout/stderr streaming; a failing command's output shows in the log; the panel re-enables its Start button on close.
- Not-connected: tools that need a session surface the engine's "Not logged in" message; Connect X is the fix.
- Missing output files (no candidates yet): panels show an empty state, not an error.
- Selectors / DOM drift in the engine are the engine's concern (unchanged), surfaced via the log.

## Testing

- **Unit (pure):** per-tool arg builders in `steps.ts` (e.g. `followArgs`, `chainArgs`, `dmArgs`), and the cap-meter counting in `status.ts` (inject `now`, like `todayCountUTC`).
- **Smoke (human at the window):** each panel's run, the cap meters updating, the write-lock banner, DM dry-run→confirm, Connect auto-detect. These need a display + a logged-in X session — the operator runs them.

## Phasing (for the plan)

- **Phase A — Console shell:** graphite/violet restyle into the command-center (sidebar, status bar w/ cap meters + Stop, persistent log), branding (name + icon), Connect-X auto-detect, and re-home the existing Build List as the first panel. Ships a polished, working app (read-only) on its own.
- **Phase B — Write-tool panels:** Follow, Chain, Unfollow, DM panels + the safety mechanics (write-lock surfacing, DM dry-run/confirm). Adds the write half.

## Out of scope

- Packaging into a distributable installer (bundle Node + Chromium, signing) — still the separate packaging plan; this remains `tauri dev`-runnable.
- Burst / `--force` / cap-override in the GUI — deliberately CLI-only.
- Multi-account; any hosted/server component (local-only, per ADR 0001).
