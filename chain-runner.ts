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
