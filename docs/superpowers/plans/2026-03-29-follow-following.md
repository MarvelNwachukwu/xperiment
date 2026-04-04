# Follow-Following Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--following` and `--tech-only` flags to the follow bot by refactoring the follow loop into a reusable engine.

**Architecture:** Extract the ~140-line follow loop from `follow()` into a standalone `followFromPage(options)` function. The existing `follow()` becomes a thin wrapper that parses CLI flags, determines the URL and filter, and delegates to the engine. Bio extraction and tech-keyword filtering are added as new helpers.

**Tech Stack:** TypeScript, Playwright, tsx runner

---

### Task 1: Update types and add `FollowEngineOptions`

**Files:**
- Modify: `follow-bot.ts:19-24` (Types section)

- [ ] **Step 1: Update imports, `FollowRecord`, and add `FollowEngineOptions`**

First, update the import on line 2 to include `ElementHandle`:

```typescript
import type { Page, BrowserContext, ElementHandle } from "playwright";
```

Then replace the existing types section (lines 19-24) with:

```typescript
// ── Types ──────────────────────────────────────────────────────
interface FollowRecord {
  username: string;
  target: string;
  source: "followers" | "following";
  timestamp: string;
}

interface FollowEngineOptions {
  page: Page;
  target: string;
  pageUrl: string;
  cardLabel: string;
  bioFilter?: (bio: string) => boolean;
  source: "followers" | "following";
}
```

- [ ] **Step 2: Verify the file still compiles**

Run: `npx tsc --noEmit follow-bot.ts`

Expected: Compilation errors about `source` missing from FollowRecord construction in `follow()` — this is expected and will be fixed in Task 3.

- [ ] **Step 3: Commit**

```bash
git add follow-bot.ts
git commit -m "refactor: add FollowEngineOptions type and source field to FollowRecord"
```

---

### Task 2: Add TECH_KEYWORDS, extractBio, and matchesTechKeywords

**Files:**
- Modify: `follow-bot.ts` (add after `dismissPopups` function, before `launchBrowser`)

- [ ] **Step 1: Add the tech keywords array and helper functions**

Insert the following after the closing `}` of `dismissPopups` (after line 78) and before the `// ── Browser Launch` comment (line 80):

```typescript

// ── Tech Filtering ────────────────────────────────────────────
const TECH_KEYWORDS = [
  // Roles
  "developer", "dev", "engineer", "programmer", "coder", "hacker",
  "founder", "cto", "ceo", "co-founder", "cofounder",
  "designer", "ux", "ui",
  // Domains
  "software", "web3", "crypto", "blockchain", "bitcoin", "btc", "eth",
  "ethereum", "defi", "nft", "ai", "ml", "machine learning",
  "artificial intelligence", "data science", "data engineer",
  "devops", "sre", "cloud", "aws", "gcp", "azure",
  "cybersecurity", "infosec", "security",
  "frontend", "backend", "fullstack", "full-stack", "full stack",
  "mobile", "ios", "android", "flutter", "react native",
  // Technologies
  "javascript", "typescript", "python", "rust", "golang", "solidity",
  "react", "nextjs", "next.js", "vue", "angular", "svelte",
  "node", "nodejs", "deno", "bun",
  "docker", "kubernetes", "k8s", "terraform",
  "postgres", "mongodb", "redis", "graphql",
  "open source", "oss", "github", "api",
  // Startup / VC
  "startup", "saas", "b2b", "yc", "ycombinator", "techstars",
  "venture", "investor", "angel",
  // Tech media / community
  "tech", "hackathon", "buildinpublic", "building in public",
  "indie hacker", "indiehacker", "shipfast",
];

async function extractBio(cell: ElementHandle): Promise<string> {
  const bioEl = await cell.$('[data-testid="UserCell"] > div > div:last-child');
  if (bioEl) {
    return (await bioEl.innerText().catch(() => "")).slice(0, 200);
  }
  return (await cell.innerText().catch(() => "")).slice(0, 200);
}

function matchesTechKeywords(bio: string): boolean {
  const lower = bio.toLowerCase();
  return TECH_KEYWORDS.some((kw) => lower.includes(kw));
}
```

- [ ] **Step 2: Verify the file still compiles (ignoring the FollowRecord error from Task 1)**

Run: `npx tsc --noEmit follow-bot.ts 2>&1 | head -20`

Expected: Only errors related to `source` missing from the FollowRecord literal in `follow()`. No errors related to the new functions.

- [ ] **Step 3: Commit**

```bash
git add follow-bot.ts
git commit -m "feat: add TECH_KEYWORDS, extractBio, and matchesTechKeywords helpers"
```

---

### Task 3: Extract `followFromPage` engine function

**Files:**
- Modify: `follow-bot.ts` (add new function after `login()`, replace body of `follow()`)

- [ ] **Step 1: Add the `followFromPage` function**

Insert the following after the closing `}` of `login()` and before the `// ── Follow Command` comment:

```typescript

// ── Follow Engine ─────────────────────────────────────────────
async function followFromPage(options: FollowEngineOptions): Promise<number> {
  const { page, target, pageUrl, cardLabel, bioFilter, source } = options;

  // Navigate to target page
  console.log(`Navigating to ${pageUrl} ...`);
  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

  // Wait for page to settle
  await page.waitForTimeout(3000);

  // Check if redirected to login (not logged in)
  if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
    console.error("Not logged in. Run `npm run login` first.");
    return 0;
  }

  console.log(`Loaded ${cardLabel} page for @${target}`);

  // Load follow log (kept in memory for the session)
  const logRecords = loadLog();
  const followedSet = new Set(logRecords.map((r) => r.username));
  let followCount = 0;

  // Wait for user cards to appear
  const initialCards = await page
    .waitForSelector('[data-testid="cellInnerDiv"]', { timeout: 10000 })
    .catch(() => null);
  if (!initialCards) {
    console.error(`No ${cardLabel} cards found. The page may not have loaded correctly.`);
    return 0;
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

      // Skip check 3: bio filter (--tech-only)
      if (bioFilter) {
        const bio = await extractBio(cell);
        if (!bioFilter(bio)) {
          console.log(`  Skipping @${username} (bio doesn't match filter)`);
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
              break;
            }
            console.log(`\n  Looks like we're rate-limited. Waiting ${RATE_LIMIT_COOLDOWN_MIN} minutes...`);
            console.log(`  (${rateLimitWaits}/${MAX_RATE_LIMIT_WAITS} cooldowns used this session)`);
            await page.waitForTimeout(RATE_LIMIT_COOLDOWN_MIN * 60 * 1000);
            consecutiveFailures = 0;

            // Reload the page to get fresh state
            console.log(`  Reloading ${cardLabel} page...`);
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

    // Scroll for more users
    if (!foundNew) {
      console.log(`  Scrolling for more ${cardLabel}...`);
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
        console.log(`  No more ${cardLabel} to load. Ending session.`);
        break;
      }
    }
  }

  return followCount;
}
```

- [ ] **Step 2: Replace `follow()` with thin wrapper that parses flags and delegates**

Replace the entire `follow()` function (from `// ── Follow Command` comment through its closing `}`) with:

```typescript
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
  const cardLabel = source;

  const context = await launchBrowser();
  const page = await context.newPage();

  const followCount = await followFromPage({
    page,
    target,
    pageUrl,
    cardLabel,
    source,
    bioFilter: techOnly ? matchesTechKeywords : undefined,
  });

  console.log(`\nSession complete. Followed ${followCount} users.`);
  await context.close();
}
```

- [ ] **Step 3: Verify the file compiles cleanly**

Run: `npx tsc --noEmit follow-bot.ts`

Expected: No errors. The `source` field is now included in the FollowRecord literal inside `followFromPage`, and all types align.

- [ ] **Step 4: Commit**

```bash
git add follow-bot.ts
git commit -m "refactor: extract followFromPage engine, follow() delegates via CLI flags"
```

---

### Task 4: Update CLI parser and usage message

**Files:**
- Modify: `follow-bot.ts` (Main section, lines 307-327)

- [ ] **Step 1: Update the usage message in the else branch**

Replace the main CLI section (from `// ── Main` to end of file) with:

```typescript
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
    "  npm run login                                — Log in to X and save cookies\n" +
    "  npm run follow -- @handle                    — Follow users from @handle's followers\n" +
    "  npm run follow -- @handle --following         — Follow from @handle's following list\n" +
    "  npm run follow -- @handle --tech-only         — Only follow tech accounts\n" +
    "  npm run follow -- @handle --following --tech-only — Tech accounts from following list"
  );
  process.exit(1);
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit follow-bot.ts`

Expected: No errors.

- [ ] **Step 3: Test the usage output**

Run: `npx tsx follow-bot.ts`

Expected output:
```
Usage:
  npm run login                                — Log in to X and save cookies
  npm run follow -- @handle                    — Follow users from @handle's followers
  npm run follow -- @handle --following         — Follow from @handle's following list
  npm run follow -- @handle --tech-only         — Only follow tech accounts
  npm run follow -- @handle --following --tech-only — Tech accounts from following list
```

- [ ] **Step 4: Commit**

```bash
git add follow-bot.ts
git commit -m "feat: update CLI usage to show --following and --tech-only flags"
```

---

### Task 5: Manual smoke test

This is a browser automation project — there are no unit tests. Verification is manual.

- [ ] **Step 1: Verify existing behavior is unchanged (followers mode)**

Run: `npx tsx follow-bot.ts follow @someTestAccount`

Expected: Bot navigates to `https://x.com/someTestAccount/followers`, processes cards, follows users. Same behavior as before the refactor. Check that `follow-log.json` entries now include `"source": "followers"`.

- [ ] **Step 2: Test new --following mode**

Run: `npx tsx follow-bot.ts follow @someTestAccount --following`

Expected: Bot navigates to `https://x.com/someTestAccount/following` (not followers). Processes the following list, follows users. Log entries show `"source": "following"`.

- [ ] **Step 3: Test --tech-only flag**

Run: `npx tsx follow-bot.ts follow @someTestAccount --following --tech-only`

Expected: Bot navigates to following page. For each user card, extracts bio and checks against tech keywords. Skips non-matching accounts with message `Skipping @username (bio doesn't match filter)`. Only follows accounts with tech bios.

- [ ] **Step 4: Test --tech-only with followers mode**

Run: `npx tsx follow-bot.ts follow @someTestAccount --tech-only`

Expected: Bot navigates to followers page. Applies tech filter. Same skip behavior as Step 3.

---

### Task 6: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add documentation for new flags**

Find the section documenting the follow command in `README.md` and add the new flag documentation. Add a new subsection covering:

- `--following` flag: follows from target's following list instead of followers
- `--tech-only` flag: filters accounts by tech keywords in bio
- Both flags can be combined
- Examples of all 4 command variations

Also update the "Configuration" section to mention `TECH_KEYWORDS` is now shared between follow-bot and unfollow-bot.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add --following and --tech-only flag documentation to README"
```
