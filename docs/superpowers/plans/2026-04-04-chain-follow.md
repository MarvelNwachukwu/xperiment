# Chain Follow Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the follow bot to chain indefinitely through the X social graph by automatically picking the next target from successfully followed tech accounts, with crash recovery via a cron watchdog.

**Architecture:** Orchestrator pattern — new `chain-runner.ts` imports the existing `followFromPage()` engine from `follow-bot.ts`. A shared `config.ts` centralizes all constants. The runner manages chain state (persisted to `chain-state.json`), heartbeat, and chain-hop decisions. A `watchdog.sh` script runs via cron to restart the process if it dies or hangs.

**Tech Stack:** TypeScript, Playwright, tsx, bash/cron

---

### Task 1: Extract shared config to `config.ts`

**Files:**
- Create: `config.ts`
- Modify: `follow-bot.ts:7-17`

- [ ] **Step 1: Create `config.ts` with all constants**

```ts
import * as path from "path";

// ── Paths ─────────────────────────────────────────────────────
export const LOG_FILE = path.join(__dirname, "follow-log.json");
export const PROFILE_DIR = path.join(__dirname, ".chrome-profile");
export const CHAIN_STATE_FILE = path.join(__dirname, "chain-state.json");
export const CHAIN_LOG_FILE = path.join(__dirname, "chain-log.txt");

// ── Follow Engine ─────────────────────────────────────────────
export const MIN_DELAY_SEC = 15;
export const MAX_DELAY_SEC = 45;
export const FOLLOW_TIMEOUT_MS = 5000;
export const SCROLL_WAIT_MS = 5000;

// ── Rate Limiting ─────────────────────────────────────────────
export const RATE_LIMIT_THRESHOLD = 3;
export const RATE_LIMIT_COOLDOWN_MIN = 15;
export const MAX_RATE_LIMIT_WAITS = 5;

// ── Chain Runner ──────────────────────────────────────────────
export const DRY_STREAK_THRESHOLD = 20;
export const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
```

- [ ] **Step 2: Update `follow-bot.ts` to import from config**

Replace lines 7-17 of `follow-bot.ts`:

```ts
// ── Configuration ──────────────────────────────────────────────
const MAX_FOLLOWS = 150;
const MIN_DELAY_SEC = 15;
const MAX_DELAY_SEC = 45;
const LOG_FILE = path.join(__dirname, "follow-log.json");
const FOLLOW_TIMEOUT_MS = 5000;
const SCROLL_WAIT_MS = 5000;
const PROFILE_DIR = path.join(__dirname, ".chrome-profile");
const RATE_LIMIT_THRESHOLD = 3;       // consecutive failures before assuming rate limit
const RATE_LIMIT_COOLDOWN_MIN = 15;   // minutes to wait when rate-limited
const MAX_RATE_LIMIT_WAITS = 5;       // give up after this many cooldowns in one session
```

With:

```ts
import {
  LOG_FILE,
  PROFILE_DIR,
  MIN_DELAY_SEC,
  MAX_DELAY_SEC,
  FOLLOW_TIMEOUT_MS,
  SCROLL_WAIT_MS,
  RATE_LIMIT_THRESHOLD,
  RATE_LIMIT_COOLDOWN_MIN,
  MAX_RATE_LIMIT_WAITS,
} from "./config";
```

Remove the `import * as path from "path";` line from `follow-bot.ts` since it's no longer needed there (LOG_FILE and PROFILE_DIR come from config now).

- [ ] **Step 3: Verify the existing bot still runs**

Run: `npx tsx follow-bot.ts`
Expected: Shows usage message (no crash), confirming imports work.

- [ ] **Step 4: Commit**

```bash
git add config.ts follow-bot.ts
git commit -m "refactor: extract shared config to config.ts"
```

---

### Task 2: Refactor `followFromPage()` to return `FollowResult`

**Files:**
- Modify: `follow-bot.ts:19-356`

- [ ] **Step 1: Add `FollowResult` type and update `FollowEngineOptions`**

After the existing `FollowRecord` interface (line 25), add:

```ts
export interface FollowResult {
  followCount: number;
  followedUsers: string[];
  reason: "exhausted" | "dry_streak" | "rate_limited";
}
```

Update `FollowEngineOptions` to add `dryStreakThreshold`:

```ts
export interface FollowEngineOptions {
  page: Page;
  target: string;
  pageUrl: string;
  bioFilter?: (bio: string) => boolean;
  source: "followers" | "following";
  dryStreakThreshold?: number;
}
```

- [ ] **Step 2: Update `followFromPage()` signature and tracking variables**

Change the function signature from:

```ts
async function followFromPage(options: FollowEngineOptions): Promise<number> {
```

To:

```ts
export async function followFromPage(options: FollowEngineOptions): Promise<FollowResult> {
```

After destructuring options, add:

```ts
const { page, target, pageUrl, bioFilter, source, dryStreakThreshold } = options;
```

After `let followCount = 0;` (line 190), add:

```ts
const followedUsers: string[] = [];
let dryStreak = 0;
```

- [ ] **Step 3: Remove `MAX_FOLLOWS` from the engine loop**

Replace line 204:
```ts
while (followCount < MAX_FOLLOWS) {
```
With:
```ts
while (true) {
```

Remove line 210:
```ts
if (followCount >= MAX_FOLLOWS) break;
```

- [ ] **Step 4: Track dry streak on bio filter skip**

Replace the bio filter skip block (lines 244-250):

```ts
      // Skip check 3: bio filter (--tech-only)
      if (bioFilter) {
        const rawBio = await extractBio(cell);
        const bio = rawBio.replace(`@${username}`, "").trim();
        if (!bioFilter(bio)) {
          console.log(`  Skipping @${username} (bio doesn't match filter)`);
          continue;
        }
      }
```

With:

```ts
      // Skip check 3: bio filter (--tech-only)
      if (bioFilter) {
        const rawBio = await extractBio(cell);
        const bio = rawBio.replace(`@${username}`, "").trim();
        if (!bioFilter(bio)) {
          dryStreak++;
          console.log(`  Skipping @${username} (bio doesn't match filter) [dry streak: ${dryStreak}]`);
          if (dryStreakThreshold && dryStreak >= dryStreakThreshold) {
            console.log(`  Dry streak threshold (${dryStreakThreshold}) reached. Chaining to next target.`);
            return { followCount, followedUsers, reason: "dry_streak" };
          }
          continue;
        }
      }
```

- [ ] **Step 5: Reset dry streak on successful follow and track followed users**

After `consecutiveFailures = 0;` (line 298), add:

```ts
        dryStreak = 0;
```

After `followedSet.add(username);` (line 310), add:

```ts
        followedUsers.push(username);
```

Update the success log line from:
```ts
        console.log(`  ✓ Followed @${username} (${followCount}/${MAX_FOLLOWS})`);
```
To:
```ts
        console.log(`  ✓ Followed @${username} (${followCount} this session)`);
```

Remove the `MAX_FOLLOWS` guard around delay (line 314):
```ts
        if (followCount < MAX_FOLLOWS) {
          await randomDelay(MIN_DELAY_SEC, MAX_DELAY_SEC);
        }
```
Replace with:
```ts
        await randomDelay(MIN_DELAY_SEC, MAX_DELAY_SEC);
```

- [ ] **Step 6: Update rate limit exit to return `FollowResult`**

Replace the rate limit max break (lines 275-277):
```ts
            if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
              console.log(`\n  Hit rate limit ${MAX_RATE_LIMIT_WAITS} times this session. Stopping to be safe.`);
              break;
            }
```
With:
```ts
            if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
              console.log(`\n  Hit rate limit ${MAX_RATE_LIMIT_WAITS} times this session. Stopping to be safe.`);
              return { followCount, followedUsers, reason: "rate_limited" };
            }
```

Replace the outer rate limit break (lines 324-325):
```ts
    if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) break;
```
With nothing (remove it — the return above handles this).

- [ ] **Step 7: Update "exhausted" return**

Replace the final `return followCount;` (line 355):
```ts
  return followCount;
```
With:
```ts
  return { followCount, followedUsers, reason: "exhausted" };
```

Also replace the "no more to load" break (line 349):
```ts
        console.log(`  No more ${source} to load. Ending session.`);
        break;
```
With:
```ts
        console.log(`  No more ${source} to load. Ending session.`);
        return { followCount, followedUsers, reason: "exhausted" };
```

- [ ] **Step 8: Export browser and utility functions**

Add `export` to these function declarations:

```ts
export async function launchBrowser(): Promise<BrowserContext> {
```

```ts
export async function dismissPopups(page: Page): Promise<void> {
```

```ts
export function loadLog(): FollowRecord[] {
```

```ts
export function saveLog(records: FollowRecord[]): void {
```

```ts
export function matchesTechKeywords(bio: string): boolean {
```

Also export the `FollowRecord` type:
```ts
export interface FollowRecord {
```

And export `FollowEngineOptions`:
```ts
export interface FollowEngineOptions {
```

- [ ] **Step 9: Update standalone `follow()` to handle new return type**

In the `follow()` function (line 359), update the call site. Replace:

```ts
  const followCount = await followFromPage({
    page,
    target,
    pageUrl,
    source,
    bioFilter: techOnly ? matchesTechKeywords : undefined,
  });

  console.log(`\nSession complete. Followed ${followCount} users.`);
```

With:

```ts
  const result = await followFromPage({
    page,
    target,
    pageUrl,
    source,
    bioFilter: techOnly ? matchesTechKeywords : undefined,
  });

  console.log(`\nSession complete. Followed ${result.followCount} users. (${result.reason})`);
```

- [ ] **Step 10: Verify standalone mode still works**

Run: `npx tsx follow-bot.ts`
Expected: Shows usage message, no crash.

- [ ] **Step 11: Commit**

```bash
git add follow-bot.ts
git commit -m "refactor: followFromPage returns FollowResult with reason and followed users"
```

---

### Task 3: Create `chain-runner.ts` — state management and chain loop

**Files:**
- Create: `chain-runner.ts`

- [ ] **Step 1: Create chain state types and persistence functions**

```ts
import * as fs from "fs";
import {
  CHAIN_STATE_FILE,
  CHAIN_LOG_FILE,
  DRY_STREAK_THRESHOLD,
  HEARTBEAT_INTERVAL_MS,
} from "./config";
import {
  launchBrowser,
  followFromPage,
  loadLog,
  matchesTechKeywords,
} from "./follow-bot";
import type { FollowResult } from "./follow-bot";

// ── Types ─────────────────────────────────────────────────────
interface ChainState {
  seedTarget: string;
  currentTarget: string;
  chainDepth: number;
  chainHistory: string[];
  candidatePool: string[];
  totalFollowed: number;
  lastHeartbeat: string;
  status: "running" | "paused";
}

// ── State Persistence ─────────────────────────────────────────
function loadChainState(): ChainState | null {
  if (!fs.existsSync(CHAIN_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CHAIN_STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveChainState(state: ChainState): void {
  state.lastHeartbeat = new Date().toISOString();
  fs.writeFileSync(CHAIN_STATE_FILE, JSON.stringify(state, null, 2));
}

function initChainState(seedTarget: string): ChainState {
  return {
    seedTarget,
    currentTarget: seedTarget,
    chainDepth: 0,
    chainHistory: [seedTarget],
    candidatePool: [],
    totalFollowed: 0,
    lastHeartbeat: new Date().toISOString(),
    status: "running",
  };
}

// ── Chain Log ─────────────────────────────────────────────────
function chainLog(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  fs.appendFileSync(CHAIN_LOG_FILE, line);
}
```

- [ ] **Step 2: Add the `pickNextTarget` function**

```ts
function pickNextTarget(state: ChainState): string | null {
  // Filter out anyone already in chain history
  const historySet = new Set(state.chainHistory);
  const available = state.candidatePool.filter((u) => !historySet.has(u));

  if (available.length === 0) {
    // Fallback: pick from entire follow log
    const logRecords = loadLog();
    const allFollowed = logRecords.map((r) => r.username);
    const fallback = allFollowed.filter((u) => !historySet.has(u));
    if (fallback.length === 0) return null;
    const pick = fallback[Math.floor(Math.random() * fallback.length)];
    chainLog(`Candidate pool empty. Falling back to follow log — picked @${pick}`);
    return pick;
  }

  const pick = available[Math.floor(Math.random() * available.length)];
  // Remove from pool
  state.candidatePool = state.candidatePool.filter((u) => u !== pick);
  return pick;
}
```

- [ ] **Step 3: Add the heartbeat interval**

```ts
function startHeartbeat(state: ChainState): NodeJS.Timeout {
  return setInterval(() => {
    saveChainState(state);
  }, HEARTBEAT_INTERVAL_MS);
}
```

- [ ] **Step 4: Add the main chain loop**

```ts
async function runChain(state: ChainState): Promise<void> {
  const context = await launchBrowser();
  const page = await context.newPage();
  const heartbeat = startHeartbeat(state);

  try {
    while (true) {
      const target = state.currentTarget;
      const pageUrl = `https://x.com/${target}/following`;

      chainLog(`Chain depth ${state.chainDepth}: following tech accounts from @${target}'s following`);
      state.status = "running";
      saveChainState(state);

      let result: FollowResult;
      try {
        result = await followFromPage({
          page,
          target,
          pageUrl,
          source: "following",
          bioFilter: matchesTechKeywords,
          dryStreakThreshold: DRY_STREAK_THRESHOLD,
        });
      } catch (err) {
        chainLog(`Engine error on @${target}: ${err}. Saving state and exiting.`);
        state.status = "paused";
        saveChainState(state);
        break;
      }

      // Collect followed users into candidate pool
      for (const u of result.followedUsers) {
        if (!state.chainHistory.includes(u) && !state.candidatePool.includes(u)) {
          state.candidatePool.push(u);
        }
      }
      state.totalFollowed += result.followCount;

      chainLog(`Finished @${target}: ${result.followCount} followed (reason: ${result.reason}). Total: ${state.totalFollowed}`);

      if (result.reason === "rate_limited") {
        chainLog("Rate-limited. Saving state and exiting for cron restart.");
        state.status = "paused";
        saveChainState(state);
        break;
      }

      // Pick next target (dry_streak or exhausted)
      const next = pickNextTarget(state);
      if (!next) {
        chainLog("No more candidates available. Chain complete.");
        state.status = "paused";
        saveChainState(state);
        break;
      }

      state.currentTarget = next;
      state.chainDepth++;
      state.chainHistory.push(next);
      saveChainState(state);

      chainLog(`Chaining to @${next} (depth ${state.chainDepth}, pool size: ${state.candidatePool.length})`);
    }
  } finally {
    clearInterval(heartbeat);
    await context.close();
  }
}
```

- [ ] **Step 5: Add CLI argument parsing and entry point**

```ts
// ── CLI ───────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resume = args.includes("--resume");

  let state: ChainState;

  if (resume) {
    const loaded = loadChainState();
    if (!loaded) {
      console.error("No chain-state.json found. Start a new chain with: npm run chain -- @handle");
      process.exit(1);
    }
    chainLog(`Resuming chain from @${loaded.currentTarget} (depth ${loaded.chainDepth}, total followed: ${loaded.totalFollowed})`);
    state = loaded;
  } else {
    const targetArg = args.find((a) => a.startsWith("@") || (!a.startsWith("-") && a.length > 0));
    if (!targetArg) {
      console.error("Usage:\n  npm run chain -- @handle      Start a new chain\n  npm run chain -- --resume     Resume after crash");
      process.exit(1);
    }
    const target = targetArg.replace(/^@/, "");
    state = initChainState(target);
    chainLog(`Starting new chain from seed @${target}`);
  }

  await runChain(state);
}

main().catch((err) => {
  console.error("Chain runner crashed:", err);
  process.exit(1);
});
```

- [ ] **Step 6: Verify it compiles**

Run: `npx tsx chain-runner.ts`
Expected: Shows usage message ("Usage: npm run chain -- @handle ..."), no crash.

- [ ] **Step 7: Commit**

```bash
git add chain-runner.ts
git commit -m "feat: add chain-runner.ts orchestrator for infinite social graph chaining"
```

---

### Task 4: Create `watchdog.sh` and update project files

**Files:**
- Create: `watchdog.sh`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create `watchdog.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/chain-state.json"
LOG_FILE="$SCRIPT_DIR/chain-log.txt"
STALE_MINUTES=10

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] WATCHDOG: $1" >> "$LOG_FILE"
}

# Check if state file exists
if [ ! -f "$STATE_FILE" ]; then
  log "No chain-state.json found. Nothing to watch."
  exit 0
fi

# Read status — if not paused/running, skip
STATUS=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['status'])" 2>/dev/null || echo "unknown")
if [ "$STATUS" = "unknown" ]; then
  log "Could not read state file. Skipping."
  exit 0
fi

# Read last heartbeat
HEARTBEAT=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['lastHeartbeat'])" 2>/dev/null || echo "")
if [ -z "$HEARTBEAT" ]; then
  log "No heartbeat found. Restarting."
else
  # Check if heartbeat is stale
  HEARTBEAT_EPOCH=$(date -jf "%Y-%m-%dT%H:%M:%S" "$(echo "$HEARTBEAT" | cut -d. -f1 | sed 's/Z$//')" +%s 2>/dev/null || date -d "$HEARTBEAT" +%s 2>/dev/null || echo "0")
  NOW_EPOCH=$(date +%s)
  AGE_MIN=$(( (NOW_EPOCH - HEARTBEAT_EPOCH) / 60 ))

  if [ "$AGE_MIN" -lt "$STALE_MINUTES" ]; then
    # Heartbeat is fresh — script is alive
    exit 0
  fi

  log "Heartbeat is ${AGE_MIN}m old (threshold: ${STALE_MINUTES}m). Script is dead or hung."
fi

# Kill any hung process
PIDS=$(pgrep -f "chain-runner" || true)
if [ -n "$PIDS" ]; then
  log "Killing hung chain-runner processes: $PIDS"
  kill $PIDS 2>/dev/null || true
  sleep 2
  kill -9 $PIDS 2>/dev/null || true
fi

# Restart
log "Restarting chain-runner with --resume"
cd "$SCRIPT_DIR"
nohup npx tsx chain-runner.ts --resume >> "$LOG_FILE" 2>&1 &
log "Restarted with PID $!"
```

- [ ] **Step 2: Make watchdog executable**

```bash
chmod +x watchdog.sh
```

- [ ] **Step 3: Update `package.json` — add chain script**

Add to the `"scripts"` section:

```json
    "chain": "tsx chain-runner.ts"
```

The full scripts block becomes:

```json
  "scripts": {
    "login": "tsx follow-bot.ts login",
    "follow": "tsx follow-bot.ts follow",
    "scan": "tsx unfollow-bot.ts scan",
    "unfollow": "tsx unfollow-bot.ts unfollow",
    "chain": "tsx chain-runner.ts"
  },
```

- [ ] **Step 4: Update `.gitignore`**

Append:

```
chain-state.json
chain-log.txt
```

- [ ] **Step 5: Commit**

```bash
git add watchdog.sh package.json .gitignore
git commit -m "feat: add watchdog.sh cron script, chain npm script, update gitignore"
```

---

### Task 5: Update README with chain mode documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add chain mode section to README**

Add after existing usage docs:

```markdown
## Chain Mode (Long-Running)

Chain mode follows tech accounts indefinitely by automatically hopping to new targets from the social graph.

### Usage

```bash
# Start a new chain from a seed account
npm run chain -- @vitalik

# Resume after crash or restart
npm run chain -- --resume
```

### How It Works

1. Starts following tech accounts from the seed account's following list
2. When the list is exhausted or 20 consecutive non-tech users are found (dry streak), picks a random previously-followed tech account as the next target
3. Continues chaining through the social graph indefinitely
4. Persists state to `chain-state.json` — survives crashes and restarts

### Cron Watchdog

For 12+ hour unattended runs, set up the watchdog via cron:

```bash
# Edit crontab
crontab -e

# Add this line (checks every 5 minutes):
*/5 * * * * /path/to/project/watchdog.sh
```

The watchdog:
- Checks if the heartbeat in `chain-state.json` is stale (>10 minutes)
- Kills any hung processes
- Restarts with `--resume`

### Configuration

All constants are centralized in `config.ts`:

| Setting | Default | Description |
|---|---|---|
| `DRY_STREAK_THRESHOLD` | 20 | Non-tech skips before chaining to next target |
| `HEARTBEAT_INTERVAL_MS` | 120000 | How often heartbeat is written (2 min) |
| `MIN_DELAY_SEC` | 15 | Min seconds between follows |
| `MAX_DELAY_SEC` | 45 | Max seconds between follows |
| `RATE_LIMIT_THRESHOLD` | 3 | Consecutive failures before rate-limit cooldown |
| `RATE_LIMIT_COOLDOWN_MIN` | 15 | Minutes to wait when rate-limited |
| `MAX_RATE_LIMIT_WAITS` | 5 | Max cooldowns before exiting (cron restarts) |
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add chain mode and cron watchdog documentation"
```
