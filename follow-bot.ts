import type { Page, ElementHandle } from "playwright";
import { acquireBrowser } from "./browser";
import * as fs from "fs";
import * as readline from "readline";
import {
  LOG_FILE,
  FOLLOW_TIMEOUT_MS,
  SCROLL_WAIT_MS,
  RATE_LIMIT_THRESHOLD,
  RATE_LIMIT_COOLDOWN_MIN,
  MAX_RATE_LIMIT_WAITS,
  MAX_FOLLOWS_PER_DAY,
  CLUSTER_MIN,
  CLUSTER_MAX,
  INTRA_DELAY_MIN_SEC,
  INTRA_DELAY_MAX_SEC,
  REST_DELAY_MIN_SEC,
  REST_DELAY_MAX_SEC,
} from "./config";
import { matchesTechKeywords } from "./tech-filter";
import { randInt, randomDelay } from "./pacing";

// ── Types ──────────────────────────────────────────────────────
export interface FollowRecord {
  username: string;
  target: string;
  source: "followers" | "following";
  timestamp: string;
}

export interface FollowResult {
  followCount: number;
  followedUsers: string[];
  reason: "exhausted" | "dry_streak" | "rate_limited" | "daily_cap";
}

// Pacing controls how aggressively the engine follows. The engine follows in
// bursts: a cluster of clusterMin..clusterMax follows spaced intraDelay apart,
// then a longer restDelay before the next cluster. Defaults (when omitted)
// come from config and are the safe long-running values.
export interface PacingOptions {
  maxFollowsPerDay: number; // Infinity disables the daily cap (burst mode)
  clusterMin: number; // min follows per burst
  clusterMax: number; // max follows per burst
  intraDelayMinSec: number; // delay between follows within a burst
  intraDelayMaxSec: number;
  restDelayMinSec: number; // rest between bursts
  restDelayMaxSec: number;
}

export interface FollowEngineOptions {
  page: Page;
  target: string;
  pageUrl: string;
  bioFilter?: (bio: string) => boolean;
  source: "followers" | "following";
  dryStreakThreshold?: number;
  pacing?: PacingOptions;
}

// ── Helpers ────────────────────────────────────────────────────
function waitForEnter(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("Log in manually (including 2FA if needed). Press Enter when done...\n", () => {
      rl.close();
      resolve();
    });
  });
}

export function loadLog(): FollowRecord[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function saveLog(records: FollowRecord[]): void {
  fs.writeFileSync(LOG_FILE, JSON.stringify(records, null, 2));
}

// Count follows recorded so far on the current UTC calendar day. The daily
// cap resets at UTC midnight. Derived from the log so it survives process
// restarts (cron resumes) without a separate counter file.
export function followsToday(records: FollowRecord[]): number {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return records.filter((r) => r.timestamp.slice(0, 10) === today).length;
}

export async function dismissPopups(page: Page): Promise<void> {
  const hasDialog = await page.$('div[role="dialog"], [data-testid="sheetDialog"]');
  if (!hasDialog) return;

  const dismissSelectors = [
    '[data-testid="confirmationSheetConfirm"]',
    '[data-testid="confirmationSheetCancel"]',
    'div[role="dialog"] button[aria-label="Close"]',
    '[data-testid="sheetDialog"] button',
  ];
  for (const sel of dismissSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      try {
        await btn.click();
        await page.waitForTimeout(500);
        console.log("  Dismissed a popup dialog.");
      } catch {
        // Ignore click failures on popups
      }
    }
  }
}

// ── Tech Filtering ────────────────────────────────────────────
// Keyword list and matcher live in ./tech-filter (shared with unfollow-bot).
// Re-exported here so existing importers (chain-runner) keep working.
export { matchesTechKeywords } from "./tech-filter";

async function extractBio(cell: ElementHandle): Promise<string> {
  const bioEl = await cell.$('[data-testid="UserCell"] > div > div:last-child');
  if (bioEl) {
    return (await bioEl.innerText().catch(() => "")).slice(0, 200);
  }
  return (await cell.innerText().catch(() => "")).slice(0, 200);
}

// ── Login Command ──────────────────────────────────────────────
async function login(): Promise<void> {
  console.log("Launching Chrome for manual login...");
  console.log("(Using persistent profile — cookies are saved automatically)\n");
  const { context, release } = await acquireBrowser();
  const page = await context.newPage();

  await page.goto("https://x.com/login");
  await waitForEnter();

  console.log("Login session saved to persistent profile. You can close this now.");
  await release();
}

// ── Follow Engine ─────────────────────────────────────────────
export async function followFromPage(options: FollowEngineOptions): Promise<FollowResult> {
  const { page, target, pageUrl, bioFilter, source, dryStreakThreshold } = options;
  const pacing: PacingOptions = options.pacing ?? {
    maxFollowsPerDay: MAX_FOLLOWS_PER_DAY,
    clusterMin: CLUSTER_MIN,
    clusterMax: CLUSTER_MAX,
    intraDelayMinSec: INTRA_DELAY_MIN_SEC,
    intraDelayMaxSec: INTRA_DELAY_MAX_SEC,
    restDelayMinSec: REST_DELAY_MIN_SEC,
    restDelayMaxSec: REST_DELAY_MAX_SEC,
  };
  const capLabel = Number.isFinite(pacing.maxFollowsPerDay)
    ? String(pacing.maxFollowsPerDay)
    : "∞ (burst)";

  // Navigate to target page
  console.log(`Navigating to ${pageUrl} ...`);
  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

  // Wait for page to settle
  await page.waitForTimeout(3000);

  // Check if redirected to login (not logged in)
  if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
    throw new Error("Not logged in. Run `npm run login` first.");
  }

  console.log(`Loaded ${source} page for @${target}`);

  // Load follow log (kept in memory for the session)
  const logRecords = loadLog();
  const followedSet = new Set(logRecords.map((r) => r.username));
  let followCount = 0;
  const followedUsers: string[] = [];
  let dryStreak = 0;

  // Proactive daily cap: count what's already been followed today (across
  // prior sessions/restarts) so we resume mid-budget instead of restarting it.
  let dailyCount = followsToday(logRecords);
  if (dailyCount >= pacing.maxFollowsPerDay) {
    console.log(`\n  Daily follow cap already reached (${dailyCount}/${capLabel}). Stopping until UTC midnight.`);
    return { followCount, followedUsers, reason: "daily_cap" };
  }
  console.log(`  Daily budget: ${dailyCount}/${capLabel} used today.`);

  // Wait for user cards to appear
  const initialCards = await page
    .waitForSelector('[data-testid="cellInnerDiv"]', { timeout: 10000 })
    .catch(() => null);
  if (!initialCards) {
    throw new Error(`No ${source} cards found. The page may not have loaded correctly.`);
  }

  const processedUsernames = new Set<string>();
  let consecutiveFailures = 0;
  let rateLimitWaits = 0;

  // Burst scheduler: follow `clusterRemaining` accounts close together, then
  // rest. Reset to a new random cluster size each time a burst completes.
  let clusterRemaining = randInt(pacing.clusterMin, pacing.clusterMax);

  while (true) {
    const cells = await page.$$('[data-testid="cellInnerDiv"]');

    let foundNew = false;

    for (const cell of cells) {
      const userLink = await cell.$('a[href^="/"][role="link"]');
      if (!userLink) continue;

      const href = await userLink.getAttribute("href");
      if (!href || href.startsWith("/i/")) continue;

      const username = href.replace(/^\//, "").split("/")[0];
      if (!username || processedUsernames.has(username)) continue;

      processedUsernames.add(username);
      foundNew = true;

      // Skip check 1: already in log
      if (followedSet.has(username)) {
        continue;
      }

      // Skip check 2: already following (check button state)
      const followButton = await cell.$('[data-testid$="-unfollow"], [data-testid$="-follow"]');
      if (!followButton) continue;

      const testId = await followButton.getAttribute("data-testid");
      if (testId && testId.includes("unfollow")) {
        continue;
      }

      const buttonText = await followButton.innerText().catch(() => "");
      if (buttonText === "Following" || buttonText === "Pending") {
        continue;
      }

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

      // Click Follow
      try {
        await dismissPopups(page);
        console.log(`  Following @${username}...`);
        await followButton.click();

        // Wait for confirmation
        await page.waitForTimeout(FOLLOW_TIMEOUT_MS);
        const unfollowBtn = await cell.$('[data-testid$="-unfollow"]');
        let confirmed = !!unfollowBtn;
        if (!confirmed) {
          const newText = await followButton.innerText().catch(() => "");
          confirmed = newText === "Following" || newText === "Pending";
        }

        if (!confirmed) {
          consecutiveFailures++;
          console.warn(`  Follow failed for @${username} (${consecutiveFailures} in a row)`);

          // Detect rate limiting: multiple consecutive failures
          if (consecutiveFailures >= RATE_LIMIT_THRESHOLD) {
            rateLimitWaits++;
            if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
              console.log(`\n  Hit rate limit ${MAX_RATE_LIMIT_WAITS} times this session. Stopping to be safe.`);
              return { followCount, followedUsers, reason: "rate_limited" };
            }
            console.log(`\n  Looks like we're rate-limited. Waiting ${RATE_LIMIT_COOLDOWN_MIN} minutes...`);
            console.log(`  (${rateLimitWaits}/${MAX_RATE_LIMIT_WAITS} cooldowns used this session)`);
            await page.waitForTimeout(RATE_LIMIT_COOLDOWN_MIN * 60 * 1000);
            consecutiveFailures = 0;

            // Reload the page to get fresh state
            console.log(`  Reloading ${source} page...`);
            await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(3000);
            processedUsernames.clear();
            // Re-add already-followed users so we still skip them
            for (const u of followedSet) processedUsernames.add(u);
            // Break inner loop — old cell handles are stale after navigation
            break;
          }
          continue;
        }

        // Success — reset failure counter
        consecutiveFailures = 0;
        dryStreak = 0;

        // Log the follow
        followCount++;
        const record: FollowRecord = {
          username,
          target,
          source,
          timestamp: new Date().toISOString(),
        };
        logRecords.push(record);
        saveLog(logRecords);
        followedSet.add(username);
        followedUsers.push(username);
        dailyCount++;

        console.log(`  ✓ Followed @${username} (${followCount} this session, ${dailyCount}/${capLabel} today)`);

        // Stop once the daily budget is spent — before X rate-limits us.
        if (dailyCount >= pacing.maxFollowsPerDay) {
          console.log(`\n  Daily follow cap reached (${dailyCount}/${capLabel}). Stopping until UTC midnight.`);
          return { followCount, followedUsers, reason: "daily_cap" };
        }

        // Burst pacing: short delay within a cluster, longer rest after it.
        clusterRemaining--;
        if (clusterRemaining > 0) {
          await randomDelay(pacing.intraDelayMinSec, pacing.intraDelayMaxSec, `(${clusterRemaining} more in this burst)`);
        } else {
          await randomDelay(pacing.restDelayMinSec, pacing.restDelayMaxSec, "to rest between bursts");
          clusterRemaining = randInt(pacing.clusterMin, pacing.clusterMax);
          console.log(`  Starting a new burst of ${clusterRemaining} follow(s).`);
        }
      } catch (err) {
        console.warn(`  ⚠ Failed to follow @${username}: ${err}`);
        consecutiveFailures++;
        continue;
      }
    }

    // Scroll for more users
    if (!foundNew) {
      console.log(`  Scrolling for more ${source}...`);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));

      await page.waitForTimeout(SCROLL_WAIT_MS);

      const newCells = await page.$$('[data-testid="cellInnerDiv"]');
      let hasNewUsers = false;
      for (const cell of newCells) {
        const link = await cell.$('a[href^="/"][role="link"]');
        if (!link) continue;
        const h = await link.getAttribute("href");
        if (!h || h.startsWith("/i/")) continue;
        const u = h.replace(/^\//, "").split("/")[0];
        if (u && !processedUsernames.has(u)) {
          hasNewUsers = true;
          break;
        }
      }

      if (!hasNewUsers) {
        console.log(`  No more ${source} to load. Ending session.`);
        return { followCount, followedUsers, reason: "exhausted" };
      }
    }
  }

  return { followCount, followedUsers, reason: "exhausted" };
}

// ── Follow Command ─────────────────────────────────────────────
async function follow(): Promise<void> {
  const args = process.argv.slice(3);
  const targetArg = args.find((a) => a.startsWith("@") || (!a.startsWith("-") && a !== "follow"));
  if (!targetArg) {
    console.error("Usage: tsx follow-bot.ts follow @targethandle [--following] [--tech-only]");
    process.exit(1);
  }
  const target = targetArg.replace(/^@/, "");

  const useFollowing = args.includes("--following");
  const techOnly = args.includes("--tech-only");

  const source: "followers" | "following" = useFollowing ? "following" : "followers";
  const pageUrl = `https://x.com/${target}/${source}`;

  const { context, release } = await acquireBrowser();
  const page = await context.newPage();

  const result = await followFromPage({
    page,
    target,
    pageUrl,
    source,
    bioFilter: techOnly ? matchesTechKeywords : undefined,
  });

  console.log(`\nSession complete. Followed ${result.followCount} users. (${result.reason})`);
  await release();
}

// ── Main (only runs when invoked directly) ────────────────────
if (require.main === module) {
  const command = process.argv[2];

  if (command === "login") {
    login().catch((err) => {
      console.error("Login failed:", err);
      process.exit(1);
    });
  } else if (command === "follow") {
    follow().catch((err) => {
      console.error("Follow failed:", err);
      process.exit(1);
    });
  } else {
    console.error(
      "Usage:\n" +
      "  npm run login                                — Log in to X and save cookies\n" +
      "  npm run follow -- @handle                    — Follow users from @handle's followers\n" +
      "  npm run follow -- @handle --following         — Follow from @handle's following list\n" +
      "  npm run follow -- @handle --tech-only         — Only follow tech accounts\n" +
      "  npm run follow -- @handle --following --tech-only — Tech accounts from following list"
    );
    process.exit(1);
  }
}
