import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// Apply stealth patches to avoid bot detection
chromium.use(StealthPlugin());

// ── Configuration ──────────────────────────────────────────────
const MAX_FOLLOWS = 150;
const MIN_DELAY_SEC = 30;
const MAX_DELAY_SEC = 90;
const COOKIES_FILE = path.join(__dirname, "cookies.json");
const LOG_FILE = path.join(__dirname, "follow-log.json");
const FOLLOW_TIMEOUT_MS = 5000;
const SCROLL_WAIT_MS = 5000;

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
  // Quick check: skip if no dialog/overlay is visible
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

// ── Login Command ──────────────────────────────────────────────
async function login(): Promise<void> {
  console.log("Launching browser for manual login...");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  await page.goto("https://x.com/login");
  await waitForEnter();

  const cookies = await context.cookies();
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  console.log(`Cookies saved to ${COOKIES_FILE} (${cookies.length} cookies)`);

  await browser.close();
}

// ── Follow Command ─────────────────────────────────────────────
async function follow(): Promise<void> {
  // Parse target from CLI args
  let target = process.argv[3];
  if (!target) {
    console.error("Usage: tsx follow-bot.ts follow @targethandle");
    process.exit(1);
  }
  target = target.replace(/^@/, "");

  // Load cookies
  if (!fs.existsSync(COOKIES_FILE)) {
    console.error(`No cookies file found at ${COOKIES_FILE}. Run "npm run login" first.`);
    process.exit(1);
  }
  const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf-8"));

  // Launch visible browser with stealth to avoid bot detection
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await context.addCookies(cookies);
  const page = await context.newPage();

  // Navigate to followers page
  console.log(`Navigating to https://x.com/${target}/followers ...`);
  await page.goto(`https://x.com/${target}/followers`, { waitUntil: "domcontentloaded" });

  // Check if redirected to login (cookies expired)
  if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
    console.error("Cookies expired. Run `npm run login` again.");
    await browser.close();
    process.exit(1);
  }

  console.log(`Loaded followers page for @${target}`);

  // Load follow log (kept in memory for the session to avoid re-reading)
  const logRecords = loadLog();
  const followedSet = new Set(logRecords.map((r) => r.username));
  let followCount = 0;

  // Wait for follower cards to appear
  const initialCards = await page.waitForSelector('[data-testid="cellInnerDiv"]', { timeout: 10000 }).catch(() => null);
  if (!initialCards) {
    console.error("No follower cards found. The page may not have loaded correctly.");
    await browser.close();
    process.exit(1);
  }

  const processedUsernames = new Set<string>();

  while (followCount < MAX_FOLLOWS) {
    // Collect all visible follower cells
    const cells = await page.$$('[data-testid="cellInnerDiv"]');

    let foundNew = false;

    for (const cell of cells) {
      if (followCount >= MAX_FOLLOWS) break;

      // Extract username from the user link within this cell
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
        // Already following this user
        continue;
      }

      const buttonText = await followButton.innerText().catch(() => "");
      if (buttonText === "Following" || buttonText === "Pending") {
        continue;
      }

      // Click Follow
      try {
        // Dismiss any popup that might be blocking
        await dismissPopups(page);
        console.log(`  Following @${username}...`);
        await followButton.click();

        // Wait for the follow to be confirmed (button changes to unfollow state)
        await page.waitForTimeout(FOLLOW_TIMEOUT_MS);
        const unfollowBtn = await cell.$('[data-testid$="-unfollow"]');
        if (!unfollowBtn) {
          const newText = await followButton.innerText().catch(() => "");
          if (newText !== "Following" && newText !== "Pending") {
            console.warn(`  Follow confirmation timed out for @${username}, skipping.`);
            continue;
          }
        }

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

        // Random delay before next follow
        if (followCount < MAX_FOLLOWS) {
          await randomDelay(MIN_DELAY_SEC, MAX_DELAY_SEC);
        }
      } catch (err) {
        console.warn(`  ⚠ Failed to follow @${username}: ${err}`);
        continue;
      }
    }

    // If no new usernames were found in this pass, scroll for more
    if (!foundNew) {
      console.log("  Scrolling for more followers...");
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));

      await page.waitForTimeout(SCROLL_WAIT_MS);

      // Check if new cells appeared
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
  await browser.close();
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
