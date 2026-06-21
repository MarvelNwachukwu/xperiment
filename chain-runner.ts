import * as fs from "fs";
import {
  CHAIN_STATE_FILE,
  CHAIN_LOG_FILE,
  DRY_STREAK_THRESHOLD,
  HEARTBEAT_INTERVAL_MS,
  MAX_FOLLOWS_PER_DAY,
  CLUSTER_MIN,
  CLUSTER_MAX,
  INTRA_DELAY_MIN_SEC,
  INTRA_DELAY_MAX_SEC,
  REST_DELAY_MIN_SEC,
  REST_DELAY_MAX_SEC,
  BURST_CLUSTER_MIN,
  BURST_CLUSTER_MAX,
  BURST_INTRA_DELAY_MIN_SEC,
  BURST_INTRA_DELAY_MAX_SEC,
  BURST_REST_DELAY_MIN_SEC,
  BURST_REST_DELAY_MAX_SEC,
} from "./config";
import {
  followFromPage,
  loadLog,
  followsToday,
  matchesTechKeywords,
} from "./follow-bot";
import type { FollowResult, PacingOptions } from "./follow-bot";
import { matchCriteria } from "./criteria-filter";
import { acquireBrowser } from "./browser";
import { acquireWriteLock } from "./write-lock";

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
  keywords?: string[]; // custom target keywords; empty/absent = tech filter
}

// Build the bio filter for a chain: custom keywords if given, else the tech filter.
function chainBioFilter(keywords: string[]): (bio: string) => boolean {
  if (keywords.length === 0) return matchesTechKeywords;
  return (bio: string) => matchCriteria(bio, keywords, []).matched;
}
function filterLabel(keywords: string[]): string {
  return keywords.length === 0 ? "tech accounts" : `accounts matching: ${keywords.join(", ")}`;
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

function initChainState(seedTarget: string, keywords: string[]): ChainState {
  return {
    seedTarget,
    currentTarget: seedTarget,
    chainDepth: 0,
    chainHistory: [seedTarget],
    candidatePool: [],
    totalFollowed: 0,
    lastHeartbeat: new Date().toISOString(),
    status: "running",
    keywords,
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
  const keywords = state.keywords ?? [];
  const bioFilter = chainBioFilter(keywords);
  const label = filterLabel(keywords);

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

  const { context, release } = await acquireBrowser();
  const heartbeat = startHeartbeat(state);

  try {
    while (true) {
      const target = state.currentTarget;
      const pageUrl = `https://x.com/${target}/following`;

      // Fresh page per hop to avoid memory accumulation over long runs
      const page = await context.newPage();

      chainLog(`Chain depth ${state.chainDepth}: following ${label} from @${target}'s following`);
      state.status = "running";
      saveChainState(state);

      let result: FollowResult;
      try {
        result = await followFromPage({
          page,
          target,
          pageUrl,
          source: "following",
          bioFilter,
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
    await release();
  }
}

// ── CLI ───────────────────────────────────────────────────────
function parsePacing(args: string[]): PacingOptions {
  // Burst: no daily cap + small fast clusters. Deliberate manual runs only.
  if (args.includes("--burst")) {
    return {
      maxFollowsPerDay: Infinity,
      clusterMin: BURST_CLUSTER_MIN,
      clusterMax: BURST_CLUSTER_MAX,
      intraDelayMinSec: BURST_INTRA_DELAY_MIN_SEC,
      intraDelayMaxSec: BURST_INTRA_DELAY_MAX_SEC,
      restDelayMinSec: BURST_REST_DELAY_MIN_SEC,
      restDelayMaxSec: BURST_REST_DELAY_MAX_SEC,
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
  return {
    maxFollowsPerDay,
    clusterMin: CLUSTER_MIN,
    clusterMax: CLUSTER_MAX,
    intraDelayMinSec: INTRA_DELAY_MIN_SEC,
    intraDelayMaxSec: INTRA_DELAY_MAX_SEC,
    restDelayMinSec: REST_DELAY_MIN_SEC,
    restDelayMaxSec: REST_DELAY_MAX_SEC,
  };
}

// Custom target keywords from `--keywords "law, attorney, barrister"` (comma-separated).
function parseKeywords(args: string[]): string[] {
  const i = args.indexOf("--keywords");
  if (i === -1) return [];
  return (args[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resume = args.includes("--resume");
  const pacing = parsePacing(args);
  const keywords = parseKeywords(args);

  const force = args.includes("--force");
  const releaseLock = acquireWriteLock("follow", "chain", force);

  const burstDesc =
    `bursts of ${pacing.clusterMin}-${pacing.clusterMax}, ` +
    `${pacing.intraDelayMinSec}-${pacing.intraDelayMaxSec}s within / ` +
    `${pacing.restDelayMinSec / 60}-${pacing.restDelayMaxSec / 60}min rest`;
  if (pacing.maxFollowsPerDay === Infinity) {
    chainLog(`⚠ Burst mode: daily cap OFF, ${burstDesc}. Higher ban risk — manual runs only.`);
  } else {
    chainLog(`Pacing: ${pacing.maxFollowsPerDay}/day, ${burstDesc}.`);
  }

  let state: ChainState;

  if (resume) {
    const loaded = loadChainState();
    if (!loaded) {
      console.error("No chain-state.json found. Start a new chain with: npm run chain -- @handle");
      process.exit(1);
    }
    // Re-applying --keywords on resume overrides the saved set; otherwise keep it.
    if (keywords.length > 0) loaded.keywords = keywords;
    chainLog(`Resuming chain from @${loaded.currentTarget} (depth ${loaded.chainDepth}, total followed: ${loaded.totalFollowed}). Filtering ${filterLabel(loaded.keywords ?? [])}.`);
    state = loaded;
  } else {
    // Seed = first non-flag arg (skip values consumed by --max-per-day / --keywords).
    const valueIdxs = new Set(
      ["--max-per-day", "--keywords"].map((f) => args.indexOf(f)).filter((i) => i !== -1).map((i) => i + 1)
    );
    const targetArg = args.find(
      (a, idx) => !a.startsWith("-") && a.length > 0 && !valueIdxs.has(idx)
    );
    if (!targetArg) {
      console.error(
        "Usage:\n" +
          "  npm run chain -- @handle                      Start a new chain (safe paced)\n" +
          "  npm run chain -- @handle --keywords \"law, attorney\"  Custom target audience (default: tech)\n" +
          "  npm run chain -- @handle --burst              Ignore daily cap, fast (manual only)\n" +
          "  npm run chain -- @handle --max-per-day N       Override the daily cap\n" +
          "  npm run chain -- --resume                     Resume after crash/cron restart"
      );
      process.exit(1);
    }
    const target = targetArg.replace(/^@/, "");
    state = initChainState(target, keywords);
    chainLog(`Starting new chain from seed @${target}. Filtering ${filterLabel(keywords)}.`);
  }

  try {
    await runChain(state, pacing);
  } finally {
    releaseLock();
  }
}

main().catch((err) => {
  console.error("Chain runner crashed:", err);
  process.exit(1);
});
