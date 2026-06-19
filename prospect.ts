import * as fs from "fs";
import type { Page } from "playwright";
import { acquireBrowser } from "./browser";
import { loadLog } from "./follow-bot";
import { BurstScheduler, applyDelay, todayCountUTC } from "./pacing";
import {
  loadFollowing,
  saveFollowing,
  mergeFollowing,
  type ScrapedFollowing,
} from "./following-store";
import { matchRole, roleLabel } from "./role-filter";
import { matchCriteria } from "./criteria-filter";
import { parseCount, parseCompany } from "./profile-parse";
import {
  SCROLL_WAIT_MS,
  ENRICH_MAX_PER_DAY,
  ENRICH_CLUSTER_MIN,
  ENRICH_CLUSTER_MAX,
  ENRICH_INTRA_DELAY_MIN_SEC,
  ENRICH_INTRA_DELAY_MAX_SEC,
  ENRICH_REST_DELAY_MIN_SEC,
  ENRICH_REST_DELAY_MAX_SEC,
  RECENT_TWEETS_COUNT,
  PROFILES_FILE,
  CANDIDATES_FILE,
} from "./config";

// Scrape every UserCell currently on the page into ScrapedFollowing rows.
async function scrapeVisibleCells(page: Page): Promise<ScrapedFollowing[]> {
  const cells = await page.$$('[data-testid="cellInnerDiv"]');
  const rows: ScrapedFollowing[] = [];
  for (const cell of cells) {
    const link = await cell.$('a[href^="/"][role="link"]');
    if (!link) continue;
    const href = await link.getAttribute("href");
    if (!href || href.startsWith("/i/")) continue;
    const handle = href.replace(/^\//, "").split("/")[0];
    if (!handle) continue;
    const nameEl = await cell.$('[data-testid="UserCell"] span');
    const name = (await nameEl?.innerText().catch(() => "")) ?? "";
    const bioEl = await cell.$('[data-testid="UserCell"] > div > div:last-child');
    const bioSnippet = ((await bioEl?.innerText().catch(() => "")) ?? "").slice(0, 200);
    rows.push({ handle, name: name.trim(), bioSnippet: bioSnippet.trim() });
  }
  return rows;
}

async function sync(): Promise<void> {
  const args = process.argv.slice(3);
  const meArg = args.find((a) => !a.startsWith("-"));
  if (!meArg) {
    console.error("Usage: npm run prospect:sync -- @yourhandle");
    process.exit(1);
  }
  const me = meArg.replace(/^@/, "");
  const pageUrl = `https://x.com/${me}/following`;

  const { context, release } = await acquireBrowser();
  const page = await context.newPage();
  try {
    console.log(`Navigating to ${pageUrl} ...`);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
      throw new Error("Not logged in. Run `npm run login` first.");
    }

    const seen = new Map<string, ScrapedFollowing>();
    let idleScrolls = 0;
    while (idleScrolls < 3) {
      const before = seen.size;
      for (const row of await scrapeVisibleCells(page)) {
        if (!seen.has(row.handle)) seen.set(row.handle, row);
      }
      console.log(`  Collected ${seen.size} so far...`);
      if (seen.size === before) idleScrolls++;
      else idleScrolls = 0;
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(SCROLL_WAIT_MS);
    }

    const botHandles = new Set(loadLog().map((r) => r.username));
    const merged = mergeFollowing(
      loadFollowing(),
      [...seen.values()],
      botHandles,
      new Date().toISOString()
    );
    saveFollowing(merged);
    console.log(`\nSynced. ${seen.size} scraped, ${merged.length} total in following.json.`);
  } finally {
    await release();
  }
}

async function crawl(): Promise<void> {
  const args = process.argv.slice(3);
  const seedArg = args.find((a) => !a.startsWith("-"));
  if (!seedArg) {
    console.error("Usage: tsx prospect.ts crawl @seed [--side following|followers]");
    process.exit(1);
  }
  const seed = seedArg.replace(/^@/, "");
  const si = args.indexOf("--side");
  const side = si !== -1 && args[si + 1] === "followers" ? "followers" : "following";
  const pageUrl = `https://x.com/${seed}/${side}`;

  const { context, release } = await acquireBrowser();
  const page = await context.newPage();
  try {
    console.log(`Crawling ${pageUrl} ...`);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
      throw new Error("Not logged in. Run `npm run login` first.");
    }

    const seen = new Map<string, ScrapedFollowing>();
    let idleScrolls = 0;
    while (idleScrolls < 3) {
      const before = seen.size;
      for (const row of await scrapeVisibleCells(page)) {
        if (!seen.has(row.handle)) seen.set(row.handle, row);
      }
      console.log(`  Collected ${seen.size} so far...`);
      if (seen.size === before) idleScrolls++;
      else idleScrolls = 0;
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(SCROLL_WAIT_MS);
    }

    // Discovered handles are NOT bot-followed, so botHandles is empty.
    const merged = mergeFollowing(loadFollowing(), [...seen.values()], new Set(), new Date().toISOString());
    saveFollowing(merged);
    console.log(`\nCrawled @${seed}/${side}: ${seen.size} discovered, ${merged.length} total in following.json.`);
  } finally {
    await release();
  }
}

export interface Profile {
  handle: string;
  name: string;
  bio: string;
  followers: number | null;
  following: number | null;
  location: string | null;
  website: string | null;
  joined: string | null;
  verified: boolean;
  roleConfidence: "strong" | "review" | null;
  matchedKeywords: string[];
  company: string | null;
  pinnedTweet: string | null;
  recentTweets: string[];
  enrichedAt: string;
}

function loadProfiles(): Profile[] {
  if (!fs.existsSync(PROFILES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveProfiles(rows: Profile[]): void {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(rows, null, 2));
}

async function scrapeProfile(page: Page, handle: string): Promise<Profile> {
  await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const text = async (sel: string) =>
    (await page.$(sel).then((el) => el?.innerText().catch(() => "")))?.trim() ?? "";

  const name = await text('[data-testid="UserName"] span');
  const bio = await text('[data-testid="UserDescription"]');
  const location = (await text('[data-testid="UserLocation"]')) || null;
  const website = (await text('[data-testid="UserUrl"]')) || null;
  const joined = (await text('[data-testid="UserJoinDate"]')) || null;

  const followingRaw = await text(`a[href="/${handle}/following"] span`);
  const followersRaw = await text(`a[href="/${handle}/verified_followers"] span`);
  const verified = !!(await page.$('[data-testid="UserName"] svg[aria-label*="erified"]'));

  const articles = await page.$$('article[data-testid="tweet"]');
  const tweetTexts: string[] = [];
  for (const a of articles.slice(0, RECENT_TWEETS_COUNT + 1)) {
    const t = await a.$('[data-testid="tweetText"]');
    const tt = (await t?.innerText().catch(() => "")) ?? "";
    if (tt.trim()) tweetTexts.push(tt.trim());
  }
  const isPinned = articles.length
    ? !!(await articles[0].$('[data-testid="socialContext"]'))
    : false;

  const role = matchRole(bio);

  return {
    handle,
    name,
    bio,
    followers: parseCount(followersRaw),
    following: parseCount(followingRaw),
    location,
    website,
    joined,
    verified,
    roleConfidence: role.confidence,
    matchedKeywords: role.matchedKeywords,
    company: parseCompany(bio),
    pinnedTweet: isPinned ? tweetTexts[0] ?? null : null,
    recentTweets: tweetTexts.slice(isPinned ? 1 : 0, RECENT_TWEETS_COUNT + (isPinned ? 1 : 0)),
    enrichedAt: new Date().toISOString(),
  };
}

async function enrich(): Promise<void> {
  const args = process.argv.slice(3);
  let handles: string[];
  const hi = args.indexOf("--handles");
  if (hi !== -1 && args[hi + 1]) {
    handles = args[hi + 1].split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);
  } else {
    handles = loadFollowing().map((r) => r.handle);
  }

  const profiles = loadProfiles();
  const done = new Set(profiles.map((p) => p.handle));
  const todo = handles.filter((h) => !done.has(h));

  let dailyCount = todayCountUTC(profiles.map((p) => p.enrichedAt), new Date().toISOString());
  if (dailyCount >= ENRICH_MAX_PER_DAY) {
    console.log(`Daily enrich cap reached (${dailyCount}/${ENRICH_MAX_PER_DAY}). Stopping until UTC midnight.`);
    return;
  }

  const pacing = {
    clusterMin: ENRICH_CLUSTER_MIN,
    clusterMax: ENRICH_CLUSTER_MAX,
    intraDelayMinSec: ENRICH_INTRA_DELAY_MIN_SEC,
    intraDelayMaxSec: ENRICH_INTRA_DELAY_MAX_SEC,
    restDelayMinSec: ENRICH_REST_DELAY_MIN_SEC,
    restDelayMaxSec: ENRICH_REST_DELAY_MAX_SEC,
  };
  const scheduler = new BurstScheduler(pacing);

  const { context, release } = await acquireBrowser();
  const page = await context.newPage();
  try {
    console.log(`Enriching ${todo.length} profiles (${dailyCount}/${ENRICH_MAX_PER_DAY} done today).`);
    for (const handle of todo) {
      try {
        const profile = await scrapeProfile(page, handle);
        profiles.push(profile);
        saveProfiles(profiles);
        dailyCount++;
        console.log(`  ✓ @${handle} (role=${roleLabel(profile.roleConfidence, profile.matchedKeywords)}, followers=${profile.followers ?? "?"}) [${dailyCount}/${ENRICH_MAX_PER_DAY}]`);
      } catch (err) {
        console.warn(`  ⚠ Failed to enrich @${handle}: ${err}`);
        continue;
      }
      if (dailyCount >= ENRICH_MAX_PER_DAY) {
        console.log(`\n  Daily enrich cap reached. Stopping until UTC midnight.`);
        break;
      }
      await applyDelay(scheduler.next());
    }
  } finally {
    await release();
  }
  console.log(`\nDone. ${profiles.length} profiles total in profiles.json.`);
}

export interface Candidate extends Profile {
  // Narrows roleConfidence: candidates always matched (never null).
  // matchedKeywords is inherited from Profile.
  roleConfidence: "strong" | "review";
}

function readListFlag(args: string[], flag: string): string[] {
  const i = args.indexOf(flag);
  if (i === -1 || !args[i + 1]) return [];
  return args[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
}

async function filter(): Promise<void> {
  const args = process.argv.slice(3);
  const who = readListFlag(args, "--who");
  const where = readListFlag(args, "--where");
  const profiles = loadProfiles();
  const candidates: Candidate[] = [];

  for (const p of profiles) {
    if (who.length > 0) {
      // Target Criteria mode: match the User's free-text keywords against bio + location.
      const text = `${p.bio} ${p.location ?? ""}`;
      const m = matchCriteria(text, who, where);
      if (!m.matched) continue;
      // ponytail: criteria mode has no strong/review split — "strong" just means "kept".
      candidates.push({ ...p, roleConfidence: "strong", matchedKeywords: m.matchedKeywords });
    } else {
      // Default mode: the built-in decision-maker role filter.
      const m = matchRole(p.bio);
      if (m.confidence === null) continue;
      candidates.push({ ...p, roleConfidence: m.confidence, matchedKeywords: m.matchedKeywords });
    }
  }

  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(candidates, null, 2));
  const mode = who.length > 0 ? `criteria(who=${who.length},where=${where.length})` : "role";
  console.log(`Filtered ${profiles.length} profiles -> ${candidates.length} candidates [${mode}].`);
}

async function prepare(): Promise<void> {
  await sync();
  await enrich();
  await filter();
}

if (require.main === module) {
  const command = process.argv[2];
  const run = (fn: () => Promise<void>) =>
    fn().catch((err) => {
      console.error(`${command} failed:`, err);
      process.exit(1);
    });
  if (command === "sync") run(sync);
  else if (command === "crawl") run(crawl);
  else if (command === "enrich") run(enrich);
  else if (command === "filter") run(filter);
  else if (command === "prepare") run(prepare);
  else {
    console.error("Usage: tsx prospect.ts <sync|crawl|enrich|filter|prepare|export-csv>");
    process.exit(1);
  }
}
