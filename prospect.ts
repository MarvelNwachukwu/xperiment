import type { Page } from "playwright";
import { launchBrowser } from "./follow-bot";
import { loadLog } from "./follow-bot";
import { randomDelay } from "./pacing";
import {
  loadFollowing,
  saveFollowing,
  mergeFollowing,
  type ScrapedFollowing,
} from "./following-store";
import { SCROLL_WAIT_MS } from "./config";

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

  const context = await launchBrowser();
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
    await context.close();
  }
}

if (require.main === module) {
  const command = process.argv[2];
  if (command === "sync") {
    sync().catch((err) => {
      console.error("Sync failed:", err);
      process.exit(1);
    });
  } else {
    console.error("Usage: tsx prospect.ts <sync|enrich|filter|prepare>");
    process.exit(1);
  }
}
