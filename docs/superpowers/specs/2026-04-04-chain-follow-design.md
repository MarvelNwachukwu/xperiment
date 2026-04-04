# Chain Follow Mode — Design Spec

**Date:** 2026-04-04
**Status:** Approved

## Problem

The follow bot currently stops when it exhausts a single target's following/followers list or hits 150 follows. The user wants a script that runs 12+ hours unattended, automatically chaining through the social graph by picking new targets from successfully followed tech accounts.

## Requirements

1. **Chain-following**: When the current target's list is exhausted (or hit rate drops too low), automatically pick a new target from people we successfully followed and continue.
2. **Tech-only chaining**: Only chain to people we followed (confirmed tech via bio filter), ensuring the pool stays tech-heavy.
3. **Dry-streak detection**: If 20 consecutive users are skipped (non-tech), chain early instead of scrolling through hundreds of irrelevant accounts.
4. **Infinite chaining**: No hop limit — run until manually stopped.
5. **Crash recovery**: Persist chain state to disk. A cron-based watchdog restarts the script if it dies or hangs.
6. **Heartbeat**: Script writes a timestamp every 2 minutes. Watchdog considers the script dead if heartbeat is older than 10 minutes.

## Architecture: Orchestrator Pattern

### Approach

New `chain-runner.ts` wraps the existing `followFromPage()` engine. The engine handles following people on a single page; the runner handles chaining between targets, state persistence, and heartbeat.

### File Changes

**New files:**

- `chain-runner.ts` — orchestrator (chain loop, state management, heartbeat)
- `watchdog.sh` — cron script for crash recovery
- `chain-state.json` — auto-generated runtime state (gitignored)
- `chain-log.txt` — append-only log of chain hops/restarts (gitignored)

**Modified files:**

- `follow-bot.ts` — export functions, add FollowResult return type, add dry-streak detection, remove MAX_FOLLOWS from engine
- `package.json` — add `chain` npm script
- `.gitignore` — add chain-state.json, chain-log.txt
- `README.md` — document chain mode and cron setup

**Unchanged:**

- `unfollow-bot.ts`
- `follow-log.json` (still used as dedup source)

## Chain State Persistence

File: `chain-state.json`

```json
{
  "seedTarget": "@vitalik",
  "currentTarget": "@elonmusk",
  "chainDepth": 3,
  "chainHistory": ["@vitalik", "@balajis", "@elonmusk"],
  "candidatePool": ["@user1", "@user2", "@user3"],
  "totalFollowed": 87,
  "lastHeartbeat": "2026-04-04T12:34:56Z",
  "status": "running"
}
```

- **candidatePool**: users we successfully followed (tech-confirmed) that we haven't chained to yet. This is the queue of next targets.
- **chainHistory**: prevents revisiting the same target twice.
- Saved to disk after every chain hop and periodically during follows.
- On restart, the runner reads this file and resumes from `currentTarget`.

## Chain Runner Logic

```
1. Load chain-state.json (or initialize from CLI seed target)
2. Loop forever:
   a. Call followFromPage() for currentTarget
      - Returns: { followCount, followedUsers[], reason }
      - reason: "exhausted" | "dry_streak" | "rate_limited"
   b. Collect followedUsers into candidatePool
   c. If reason is "dry_streak" or "exhausted":
      - Pick random candidate from candidatePool
      - Remove from pool, add to chainHistory
      - Set as new currentTarget
      - Save state, continue loop
   d. If reason is "rate_limited" (hit 5 cooldowns):
      - Save state with status: "paused"
      - Exit process (cron will restart later)
   e. Write heartbeat timestamp every cycle
```

**Dry-streak threshold**: 20 consecutive non-tech users triggers early chain. Defined as a constant, easy to tune.

**Edge case — empty candidate pool**: If `candidatePool` is empty when we need to chain (no tech users were found on current target), fall back to picking a random user from `follow-log.json` that isn't in `chainHistory`. If that's also empty, log and exit gracefully.

## Refactoring follow-bot.ts

### Exports

- `followFromPage()` — main engine function
- `launchBrowser()` — browser lifecycle (runner reuses browser across chain hops)
- `dismissPopups()` — popup handling

### New Return Type

```ts
interface FollowResult {
  followCount: number;
  followedUsers: string[];
  reason: "exhausted" | "dry_streak" | "rate_limited";
}
```

### Dry-Streak Tracking

Counter inside `followFromPage()` increments when a user is skipped (non-tech), resets on successful follow. When it hits the threshold (passed as option), return early with `reason: "dry_streak"`.

### MAX_FOLLOWS

Removed from the engine. The runner controls session lifetime.

### Standalone Mode Preserved

The CLI block at the bottom of `follow-bot.ts` still works for one-off runs. Only executes when run directly, not when imported.

## Heartbeat & Cron Recovery

### Heartbeat

- Runner writes `lastHeartbeat` to `chain-state.json` every 2 minutes during active following
- Also writes after each chain hop and before exiting

### Watchdog (`watchdog.sh`)

Runs every 5 minutes via crontab:

1. Read `lastHeartbeat` from `chain-state.json`
2. If heartbeat is older than 10 minutes, script is dead/hung
3. If process is still running but hung, kill it
4. Restart: `npx tsx chain-runner.ts --resume`

### CLI Interface

```bash
# Start a new chain
npm run chain -- @vitalik --tech-only

# Resume after crash (what cron calls)
npm run chain -- --resume
```

### Logging

Chain hops and restarts logged to `chain-log.txt` (append-only) for overnight review.

## Constants

| Constant | Value | Location |
|---|---|---|
| DRY_STREAK_THRESHOLD | 20 | chain-runner.ts |
| HEARTBEAT_INTERVAL_MIN | 2 | chain-runner.ts |
| WATCHDOG_STALE_MIN | 10 | watchdog.sh |
| WATCHDOG_CRON_INTERVAL | */5 * * * * | crontab |
| RATE_LIMIT_THRESHOLD | 3 | follow-bot.ts (unchanged) |
| RATE_LIMIT_COOLDOWN_MIN | 15 | follow-bot.ts (unchanged) |
| MAX_RATE_LIMIT_WAITS | 5 | follow-bot.ts (unchanged) |
