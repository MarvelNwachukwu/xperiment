# Task 4 Report

**Status:** DONE

**Commit SHA:** 702f057

**Summary:** Build PASS (tsc + vite, 24 modules); Tests PASS (13/13).

**Concerns:**
- The brief specifies `import { resolveResource } from "@tauri-apps/api/core"` but `resolveResource` is actually exported from `@tauri-apps/api/path` in this version of the package. Fixed to use the correct path.
- `import.meta.env.DEV` required a `/// <reference types="vite/client" />` triple-slash directive at the top of `config.ts` because the tsconfig does not include `vite/client` types. Added inline rather than modifying tsconfig.

## Fix

### FIX 1 — Chrome check inverted (`desktop/src/console.ts`)
Added Linux paths (`/usr/bin/google-chrome`, `/opt/google/chrome/chrome`) alongside the existing mac and two Windows paths. Changed all `exists(p).catch(() => false)` calls to `exists(p).catch(() => true)` so a permission/scope denial degrades to "assume present" rather than falsely triggering the banner. The banner now only shows when ALL five paths return `false`.

### FIX 2 — Kill race (`desktop/src/engine.ts`)
Added a `killRequested` flag. After `spawn()` resolves and assigns `child`, the code now checks `if (killRequested) c.kill().catch(() => {})`, ensuring a `kill()` call that arrives before the child is assigned is still honoured once the child spawns.

### FIX 3 — `done` must never reject (`desktop/src/engine.ts`)
Wrapped the entire `runEngine` async IIFE body in a `try/catch`. The `spawn().catch(...)` path now calls `resolve()` on error so the inner Promise always settles. Any uncaught outer error is caught and forwarded to `onLine`. `done` is now guaranteed to resolve (never reject).

### FIX 4 — Packaged file paths (`desktop/src/config.ts`, `console.ts`, `tools/dm.ts`, `tools/unfollow.ts`)
Added `dataPath(rel)` helper to `config.ts` that resolves paths via `getLaunchCtx().dataDir`. Updated `readJson` and `followLockHeld` in `console.ts`, `writeTextFile` in `dm.ts`, and `writeTextFile` in `unfollow.ts` to use `await dataPath(...)`. Removed the now-unused `REPO_DIR` import from all three consumer files.

### FIX 5/6 — `getLaunchCtx` promise cache + `Promise.all` (`desktop/src/config.ts`)
Changed `cached` from `LaunchCtx | null` to `Promise<LaunchCtx> | null` so concurrent callers share the same in-flight promise (deduplication). Extracted the resolution logic into `buildLaunchCtx()`. The packaged branch now uses `Promise.all([resolveResource(...), resolveResource(...), appDataDir()])` to resolve all three resources concurrently instead of serially.

### Build output
```
> tsc && vite build
✓ 24 modules transformed.
dist/assets/index-DVxDHF2Z.js  34.49 kB │ gzip: 10.38 kB
✓ built in 107ms
```

### Test output
```
✔ registry tracks add/remove/size and killAll calls kill on each
✔ resolveSpawn dev: npx tsx at the repo
✔ resolveSpawn packaged: bundled node + compiled js, data dir env
✔ resolveSpawn packaged: maps the .ts entry to .js
✔ countToday counts same-UTC-day timestamps
✔ capLabel formats used/max
✔ crawl per seed, then enrich, then filter with who+where
✔ omits --where when blank; drops blank seeds; strips @
✔ followArgs strips @, adds flags only when set
✔ followArgs: keywords override --tech-only
✔ chainArgs: seed vs resume
✔ chainArgs: custom keywords (and blank is omitted)
✔ unfollow + dm args
ℹ tests 13  pass 13  fail 0
```
