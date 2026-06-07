import * as fs from "fs";
import {
  CHAIN_STATE_FILE,
  CHAIN_LOG_FILE,
  DRY_STREAK_THRESHOLD,
  HEARTBEAT_INTERVAL_MS,
  MAX_FOLLOWS_PER_DAY,
  MIN_DELAY_SEC,
  MAX_DELAY_SEC,
  BURST_MIN_DELAY_SEC,
  BURST_MAX_DELAY_SEC,
} from "./config";
import {
  launchBrowser,
  followFromPage,
  loadLog,
  followsToday,
  matchesTechKeywords,
} from "./follow-bot";
import type { FollowResult, PacingOptions } from "./follow-bot";

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

// ── Target Selection ──────────────────────────────────────────
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

// ── Heartbeat ─────────────────────────────────────────────────
function startHeartbeat(state: ChainState): NodeJS.Timeout {
  return setInterval(() => {
    saveChainState(state);
  }, HEARTBEAT_INTERVAL_MS);
}

// ── Chain Loop ────────────────────────────────────────────────
async function runChain(state: ChainState, pacing: PacingOptions): Promise<void> {
  // Don't even launch Chrome if today's budget is already spent — the cron
  // watchdog will keep retrying, and we want those retries to be near-free
  // until the cap resets at UTC midnight. (Skipped in burst mode: cap = ∞.)
  const usedToday = followsToday(loadLog());
  if (usedToday >= pacing.maxFollowsPerDay) {
    chainLog(`Daily cap reached (${usedToday}/${pacing.maxFollowsPerDay}). Sleeping until UTC midnight.`);
    state.status = "paused";
    saveChainState(state);
    return;
  }

  const context = await launchBrowser();
  const heartbeat = startHeartbeat(state);

  try {
    while (true) {
      const target = state.currentTarget;
      const pageUrl = `https://x.com/${target}/following`;

      // Fresh page per hop to avoid memory accumulation over long runs
      const page = await context.newPage();

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
          pacing,
        });
      } catch (err) {
        chainLog(`Engine error on @${target}: ${err}. Saving state and exiting.`);
        await page.close().catch(() => {});
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

      // Close page to free memory before next hop
      await page.close();

      if (result.reason === "rate_limited") {
        chainLog("Rate-limited. Saving state and exiting for cron restart.");
        state.status = "paused";
        saveChainState(state);
        break;
      }

      if (result.reason === "daily_cap") {
        chainLog("Daily follow cap reached. Saving state and exiting until UTC midnight.");
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

// ── CLI ───────────────────────────────────────────────────────
function parsePacing(args: string[]): PacingOptions {
  // Burst: no daily cap + fast delays. Deliberate manual runs only.
  if (args.includes("--burst")) {
    return {
      maxFollowsPerDay: Infinity,
      minDelaySec: BURST_MIN_DELAY_SEC,
      maxDelaySec: BURST_MAX_DELAY_SEC,
    };
  }
  // Safe long-running default, with an optional daily-cap override.
  let maxFollowsPerDay = MAX_FOLLOWS_PER_DAY;
  const i = args.indexOf("--max-per-day");
  if (i !== -1) {
    const n = Number(args[i + 1]);
    if (!Number.isFinite(n) || n <= 0) {
      console.error("--max-per-day requires a positive number, e.g. --max-per-day 150");
      process.exit(1);
    }
    maxFollowsPerDay = n;
  }
  return { maxFollowsPerDay, minDelaySec: MIN_DELAY_SEC, maxDelaySec: MAX_DELAY_SEC };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resume = args.includes("--resume");
  const pacing = parsePacing(args);

  if (pacing.maxFollowsPerDay === Infinity) {
    chainLog("⚠ Burst mode: daily cap OFF, fast delays. Higher ban risk — manual runs only.");
  } else {
    chainLog(`Pacing: ${pacing.maxFollowsPerDay}/day, ${pacing.minDelaySec}-${pacing.maxDelaySec}s between follows.`);
  }

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
    // Seed = first non-flag arg (skip the value consumed by --max-per-day).
    const maxIdx = args.indexOf("--max-per-day");
    const targetArg = args.find(
      (a, idx) =>
        !a.startsWith("-") && a.length > 0 && (maxIdx === -1 || idx !== maxIdx + 1)
    );
    if (!targetArg) {
      console.error(
        "Usage:\n" +
          "  npm run chain -- @handle                 Start a new chain (safe paced)\n" +
          "  npm run chain -- @handle --burst         Ignore daily cap, fast (manual only)\n" +
          "  npm run chain -- @handle --max-per-day N  Override the daily cap\n" +
          "  npm run chain -- --resume                Resume after crash/cron restart"
      );
      process.exit(1);
    }
    const target = targetArg.replace(/^@/, "");
    state = initChainState(target);
    chainLog(`Starting new chain from seed @${target}`);
  }

  await runChain(state, pacing);
}

main().catch((err) => {
  console.error("Chain runner crashed:", err);
  process.exit(1);
});
