import type { Page } from "playwright";
import * as fs from "fs";
import { matchedTechKeywords } from "./tech-filter";
import { parseKeywordsArg, matchCriteria } from "./criteria-filter";
import { acquireBrowser } from "./browser";
import { acquireWriteLock } from "./write-lock";
import {
  UNFOLLOW_CANDIDATES_FILE as CANDIDATES_FILE,
  UNFOLLOW_LOG_FILE,
} from "./config";

// ── Configuration ──────────────────────────────────────────────
const MIN_DELAY_SEC = 15;
const MAX_DELAY_SEC = 45;
const SCROLL_WAIT_MS = 5000;

// Keyword list and matcher live in ./tech-filter (shared with follow-bot)
// so the two bots never drift — otherwise a freshly-followed crypto account
// could be flagged "not tech" and unfollowed.

// ── Types ──────────────────────────────────────────────────────
interface ScanResult {
  username: string;
  displayName: string;
  bio: string;
  isTech: boolean;
  matchedKeywords: string[];
  markedForUnfollow: boolean;
}

interface UnfollowRecord {
  username: string;
  timestamp: string;
}

// ── Helpers ────────────────────────────────────────────────────
function randomDelay(minSec: number, maxSec: number): Promise<void> {
  const ms = (Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec) * 1000;
  console.log(`  Waiting ${ms / 1000}s before next unfollow...`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Classify a bio against the target audience: custom keywords if given, else tech/crypto.
// `isMatch` true = an account to KEEP; false = an unfollow candidate.
function classifyBio(bio: string, keywords: string[]): { isMatch: boolean; matchedKeywords: string[] } {
  if (keywords.length > 0) {
    const m = matchCriteria(bio, keywords, []);
    return { isMatch: m.matched, matchedKeywords: m.matchedKeywords };
  }
  const matched = matchedTechKeywords(bio);
  return { isMatch: matched.length > 0, matchedKeywords: matched };
}

function loadUnfollowLog(): UnfollowRecord[] {
  if (!fs.existsSync(UNFOLLOW_LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(UNFOLLOW_LOG_FILE, "utf-8"));
  } catch {
    return [];
  }
}

// ── Scan Command ───────────────────────────────────────────────
// Scrolls through your Following list, reads each bio, classifies
// as tech/non-tech, and writes candidates to unfollow-candidates.json
async function scan(): Promise<void> {
  const keywords = parseKeywordsArg(process.argv.slice(3));
  const audience = keywords.length > 0 ? `bios matching: ${keywords.join(", ")}` : "tech/crypto bios";
  console.log(`Keeping ${audience}; everyone else becomes an unfollow candidate.`);

  const { context, release } = await acquireBrowser();
  const page = await context.newPage();

  // Navigate to your own following page
  // First go to home to figure out our own username
  console.log("Navigating to your profile...");
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
    console.error("Not logged in. Run `npm run login` first.");
    await release();
    process.exit(1);
  }

  // Get our username from the profile link in the sidebar
  const profileLink = await page.$('a[data-testid="AppTabBar_Profile_Link"]');
  if (!profileLink) {
    console.error("Could not find profile link. Try running `npm run login` first.");
    await release();
    process.exit(1);
  }
  const profileHref = await profileLink.getAttribute("href");
  const myUsername = profileHref?.replace(/^\//, "") ?? "";
  console.log(`Logged in as @${myUsername}`);

  // Navigate to our following page
  console.log(`Navigating to https://x.com/${myUsername}/following ...`);
  await page.goto(`https://x.com/${myUsername}/following`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const initialCards = await page.waitForSelector('[data-testid="cellInnerDiv"]', { timeout: 10000 }).catch(() => null);
  if (!initialCards) {
    console.error("No accounts found on your following page.");
    await release();
    process.exit(1);
  }

  const results: ScanResult[] = [];
  const processedUsernames = new Set<string>();
  let techCount = 0;
  let nonTechCount = 0;

  console.log("\nScanning accounts you follow...\n");

  while (true) {
    const cells = await page.$$('[data-testid="cellInnerDiv"]');
    let foundNew = false;

    for (const cell of cells) {
      // Extract username
      const userLink = await cell.$('a[href^="/"][role="link"]');
      if (!userLink) continue;

      const href = await userLink.getAttribute("href");
      if (!href || href.startsWith("/i/")) continue;

      const username = href.replace(/^\//, "").split("/")[0];
      if (!username || processedUsernames.has(username)) continue;

      processedUsernames.add(username);
      foundNew = true;

      // Extract display name
      const nameEl = await cell.$('a[href^="/"][role="link"] span');
      const displayName = await nameEl?.innerText().catch(() => "") ?? "";

      // Extract bio text from the cell
      const bioEl = await cell.$('[data-testid="UserCell"] > div > div:last-child');
      let bio = "";
      if (bioEl) {
        bio = await bioEl.innerText().catch(() => "");
        // The bio element might include the name/username, strip those
        bio = bio.replace(displayName, "").replace(`@${username}`, "").trim();
      }

      // If we couldn't get bio from the cell, try the full text
      if (!bio) {
        const allText = await cell.innerText().catch(() => "");
        // Remove the username and display name lines
        bio = allText
          .split("\n")
          .filter((line) => !line.startsWith("@") && line !== displayName && line !== "Following")
          .join(" ")
          .trim();
      }

      const { isMatch, matchedKeywords } = classifyBio(bio, keywords);

      const result: ScanResult = {
        username,
        displayName,
        bio: bio.substring(0, 200),
        isTech: isMatch,
        matchedKeywords,
        markedForUnfollow: !isMatch,
      };
      results.push(result);

      if (isMatch) {
        techCount++;
        console.log(`  KEEP  @${username} — ${matchedKeywords.slice(0, 3).join(", ")}`);
      } else {
        nonTechCount++;
        console.log(`  DROP  @${username} — "${bio.substring(0, 60)}${bio.length > 60 ? "..." : ""}"`);
      }
    }

    if (!foundNew) {
      // Scroll for more
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
      await page.waitForTimeout(SCROLL_WAIT_MS);

      const newCells = await page.$$('[data-testid="cellInnerDiv"]');
      let hasNew = false;
      for (const cell of newCells) {
        const link = await cell.$('a[href^="/"][role="link"]');
        if (!link) continue;
        const h = await link.getAttribute("href");
        if (!h || h.startsWith("/i/")) continue;
        const u = h.replace(/^\//, "").split("/")[0];
        if (u && !processedUsernames.has(u)) {
          hasNew = true;
          break;
        }
      }

      if (!hasNew) {
        console.log("\n  No more accounts to scan.");
        break;
      }
    }
  }

  // Write results
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(results, null, 2));

  console.log(`\n--- Scan Complete ---`);
  console.log(`  Total scanned: ${results.length}`);
  console.log(`  Matched (keeping): ${techCount}`);
  console.log(`  Unmatched (unfollow candidates): ${nonTechCount}`);
  console.log(`\nResults saved to ${CANDIDATES_FILE}`);
  console.log(`\nReview the file and set "markedForUnfollow": false for anyone you want to KEEP.`);
  console.log(`Then run: npm run unfollow`);

  await release();
}

// ── Unfollow Command ───────────────────────────────────────────
// Reads unfollow-candidates.json, unfollows accounts marked for removal
async function unfollow(): Promise<void> {
  const force = process.argv.slice(3).includes("--force");
  const releaseLock = acquireWriteLock("follow", "unfollow", force);

  if (!fs.existsSync(CANDIDATES_FILE)) {
    console.error(`No candidates file found. Run "npm run scan" first.`);
    releaseLock();
    process.exit(1);
  }

  const candidates: ScanResult[] = JSON.parse(fs.readFileSync(CANDIDATES_FILE, "utf-8"));
  const toUnfollow = candidates.filter((c) => c.markedForUnfollow);

  if (toUnfollow.length === 0) {
    console.log("No accounts marked for unfollow. Nothing to do.");
    releaseLock();
    process.exit(0);
  }

  console.log(`Found ${toUnfollow.length} accounts to unfollow.\n`);

  const { context, release } = await acquireBrowser();
  try {
    const page = await context.newPage();

    // Verify we're logged in
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
      console.error("Not logged in. Run `npm run login` first.");
      await release();
      releaseLock();
      process.exit(1);
    }

    const logRecords = loadUnfollowLog();
    const alreadyUnfollowed = new Set(logRecords.map((r) => r.username));
    let unfollowCount = 0;

    for (const candidate of toUnfollow) {
      if (alreadyUnfollowed.has(candidate.username)) {
        console.log(`  SKIP @${candidate.username} — already unfollowed`);
        continue;
      }

      try {
        // Navigate to the user's profile
        console.log(`  Unfollowing @${candidate.username}...`);
        await page.goto(`https://x.com/${candidate.username}`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);

        // Find the Following/Unfollow button
        const followingBtn = await page.$('[data-testid$="-unfollow"]');
        if (!followingBtn) {
          console.warn(`  Not following @${candidate.username} (no unfollow button). Skipping.`);
          continue;
        }

        // Click the Following button (triggers confirmation dialog)
        await followingBtn.click();
        await page.waitForTimeout(1000);

        // Confirm the unfollow in the dialog
        const confirmBtn = await page.$('[data-testid="confirmationSheetConfirm"]');
        if (confirmBtn) {
          await confirmBtn.click();
          await page.waitForTimeout(2000);
        }

        // Verify unfollow succeeded (button should now be "Follow")
        const followBtn = await page.$('[data-testid$="-follow"]');
        if (!followBtn) {
          const btnText = await page.$('[data-testid$="-unfollow"]');
          if (btnText) {
            console.warn(`  Unfollow may have failed for @${candidate.username}, skipping.`);
            continue;
          }
        }

        unfollowCount++;
        const record: UnfollowRecord = {
          username: candidate.username,
          timestamp: new Date().toISOString(),
        };
        logRecords.push(record);
        fs.writeFileSync(UNFOLLOW_LOG_FILE, JSON.stringify(logRecords, null, 2));
        alreadyUnfollowed.add(candidate.username);

        console.log(`  ✓ Unfollowed @${candidate.username} (${unfollowCount}/${toUnfollow.length})`);

        if (unfollowCount < toUnfollow.length) {
          await randomDelay(MIN_DELAY_SEC, MAX_DELAY_SEC);
        }
      } catch (err) {
        console.warn(`  ⚠ Failed to unfollow @${candidate.username}: ${err}`);
        continue;
      }
    }

    console.log(`\nSession complete. Unfollowed ${unfollowCount} accounts.`);
  } finally {
    await release();
    releaseLock();
  }
}

// ── Main ───────────────────────────────────────────────────────
const command = process.argv[2];

if (command === "scan") {
  scan().catch((err) => {
    console.error("Scan failed:", err);
    process.exit(1);
  });
} else if (command === "unfollow") {
  unfollow().catch((err) => {
    console.error("Unfollow failed:", err);
    process.exit(1);
  });
} else {
  console.error(
    "Usage:\n" +
    "  npm run scan       — Scan your following list, classify tech vs non-tech\n" +
    "  npm run unfollow   — Unfollow accounts marked in unfollow-candidates.json"
  );
  process.exit(1);
}
