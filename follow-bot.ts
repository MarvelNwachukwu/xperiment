import { chromium } from "playwright";
import type { Page, BrowserContext } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

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

// ── Types ──────────────────────────────────────────────────────
interface FollowRecord {
  username: string;
  target: string;
  timestamp: string;
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

function randomDelay(minSec: number, maxSec: number): Promise<void> {
  const ms = (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
  console.log(`  Waiting ${ms / 1000}s before next follow...`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadLog(): FollowRecord[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveLog(records: FollowRecord[]): void {
  fs.writeFileSync(LOG_FILE, JSON.stringify(records, null, 2));
}

async function dismissPopups(page: Page): Promise<void> {
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

// ── Browser Launch ─────────────────────────────────────────────
// Uses a persistent Chrome profile so cookies, sessions, and browser
// state survive across runs — no separate cookies.json needed.
// Also hides automation flags that X detects.
async function launchBrowser(): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    viewport: { width: 1280, height: 800 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  // Remove navigator.webdriver flag on every new page before site JS runs
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  return context;
}

// ── Login Command ──────────────────────────────────────────────
async function login(): Promise<void> {
  console.log("Launching Chrome for manual login...");
  console.log("(Using persistent profile — cookies are saved automatically)\n");
  const context = await launchBrowser();
  const page = await context.newPage();

  await page.goto("https://x.com/login");
  await waitForEnter();

  console.log("Login session saved to persistent profile. You can close this now.");
  await context.close();
}

// ── Follow Command ─────────────────────────────────────────────
async function follow(): Promise<void> {
  let target = process.argv[3];
  if (!target) {
    console.error("Usage: tsx follow-bot.ts follow @targethandle");
    process.exit(1);
  }
  target = target.replace(/^@/, "");

  const context = await launchBrowser();
  const page = await context.newPage();

  // Navigate to followers page
  console.log(`Navigating to https://x.com/${target}/followers ...`);
  await page.goto(`https://x.com/${target}/followers`, { waitUntil: "domcontentloaded" });

  // Wait for page to settle
  await page.waitForTimeout(3000);

  // Check if redirected to login (not logged in)
  if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
    console.error("Not logged in. Run `npm run login` first.");
    await context.close();
    process.exit(1);
  }

  console.log(`Loaded followers page for @${target}`);

  // Load follow log (kept in memory for the session)
  const logRecords = loadLog();
  const followedSet = new Set(logRecords.map((r) => r.username));
  let followCount = 0;

  // Wait for follower cards to appear
  const initialCards = await page.waitForSelector('[data-testid="cellInnerDiv"]', { timeout: 10000 }).catch(() => null);
  if (!initialCards) {
    console.error("No follower cards found. The page may not have loaded correctly.");
    await context.close();
    process.exit(1);
  }

  const processedUsernames = new Set<string>();
  let consecutiveFailures = 0;
  let rateLimitWaits = 0;

  while (followCount < MAX_FOLLOWS) {
    const cells = await page.$$('[data-testid="cellInnerDiv"]');

    let foundNew = false;

    for (const cell of cells) {
      if (followCount >= MAX_FOLLOWS) break;

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
              break;
            }
            console.log(`\n  Looks like we're rate-limited. Waiting ${RATE_LIMIT_COOLDOWN_MIN} minutes...`);
            console.log(`  (${rateLimitWaits}/${MAX_RATE_LIMIT_WAITS} cooldowns used this session)`);
            await page.waitForTimeout(RATE_LIMIT_COOLDOWN_MIN * 60 * 1000);
            consecutiveFailures = 0;

            // Reload the page to get fresh state
            console.log("  Reloading followers page...");
            await page.goto(`https://x.com/${target}/followers`, { waitUntil: "domcontentloaded" });
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

        // Log the follow
        followCount++;
        const record: FollowRecord = {
          username,
          target,
          timestamp: new Date().toISOString(),
        };
        logRecords.push(record);
        saveLog(logRecords);
        followedSet.add(username);

        console.log(`  ✓ Followed @${username} (${followCount}/${MAX_FOLLOWS})`);

        if (followCount < MAX_FOLLOWS) {
          await randomDelay(MIN_DELAY_SEC, MAX_DELAY_SEC);
        }
      } catch (err) {
        console.warn(`  ⚠ Failed to follow @${username}: ${err}`);
        consecutiveFailures++;
        continue;
      }
    }

    // If we broke out of the inner loop due to rate limit max, break outer too
    if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) break;

    // Scroll for more followers
    if (!foundNew) {
      console.log("  Scrolling for more followers...");
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
        console.log("  No more followers to load. Ending session.");
        break;
      }
    }
  }

  console.log(`\nSession complete. Followed ${followCount} users.`);
  await context.close();
}

// ── Main ───────────────────────────────────────────────────────
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
    "  npm run login              — Log in to X and save cookies\n" +
    "  npm run follow -- @handle  — Follow users from @handle's followers page"
  );
  process.exit(1);
}
