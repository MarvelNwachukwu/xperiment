# X Follow Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Playwright script that logs into X via saved cookies and auto-follows users from a target account's followers page with random delays, session caps, and JSON logging.

**Architecture:** Single TypeScript file (`follow-bot.ts`) with two CLI commands: `login` (headed browser for manual auth + cookie capture) and `follow` (headless bot that scrolls through followers and clicks Follow). State is persisted via `cookies.json` (auth) and `follow-log.json` (follow history).

**Tech Stack:** Node.js, TypeScript, Playwright (Chromium), tsx

---

## File Structure

| File | Purpose |
|---|---|
| `package.json` | Dependencies (`playwright`, `tsx`), npm scripts (`login`, `follow`) |
| `.gitignore` | Excludes `node_modules/`, `cookies.json`, `follow-log.json` |
| `follow-bot.ts` | Main script — login command + follow command + all helper functions |

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "x-follow-bot",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "login": "tsx follow-bot.ts login",
    "follow": "tsx follow-bot.ts follow"
  },
  "devDependencies": {
    "playwright": "^1.51.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
cookies.json
follow-log.json
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 4: Install Playwright Chromium browser**

Run: `npx playwright install chromium`
Expected: Chromium browser binary downloaded.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: scaffold project with playwright and tsx"
```

---

### Task 2: Login command — capture cookies via manual login

**Files:**
- Create: `follow-bot.ts`

This task creates the full `follow-bot.ts` file with the login command. The follow command will be added in a later task.

- [ ] **Step 1: Create `follow-bot.ts` with constants, imports, and login command**

```typescript
import { chromium, type BrowserContext } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

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

// ── Login Command ──────────────────────────────────────────────
async function login(): Promise<void> {
  console.log("Launching browser for manual login...");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://x.com/login");
  await waitForEnter();

  const cookies = await context.cookies();
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  console.log(`Cookies saved to ${COOKIES_FILE} (${cookies.length} cookies)`);

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
  console.log("Follow command not yet implemented.");
  process.exit(1);
} else {
  console.error("Usage: tsx follow-bot.ts <login|follow> [@target]");
  process.exit(1);
}
```

- [ ] **Step 2: Verify login command runs**

Run: `npx tsx follow-bot.ts login`
Expected: Browser opens to `https://x.com/login`. Terminal shows the "Log in manually" prompt. After pressing Enter, `cookies.json` is created with the cookies array. Browser closes.

Note: This is a manual verification step — you need to actually log in to X.

- [ ] **Step 3: Commit**

```bash
git add follow-bot.ts
git commit -m "feat: add login command with cookie capture"
```

---

### Task 3: Follow command — cookie loading, auth verification, and argument parsing

**Files:**
- Modify: `follow-bot.ts`

This task adds the follow command skeleton: parsing the target username, launching headless Chromium with saved cookies, navigating to the followers page, and verifying the session is still valid.

- [ ] **Step 1: Add the `follow` function skeleton after the `login` function**

Replace the `follow` placeholder in the main block. Add this function before the `// ── Main ──` section:

```typescript
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

  // Launch headless browser with cookies
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
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

  // Load follow log
  const existingLog = loadLog();
  const followedSet = new Set(existingLog.map((r) => r.username));
  let followCount = 0;

  // ── Follow loop will go here (Task 4) ──

  console.log(`\nSession complete. Followed ${followCount} users.`);
  await browser.close();
}
```

- [ ] **Step 2: Update the main block to wire up the follow command**

Replace:
```typescript
} else if (command === "follow") {
  console.log("Follow command not yet implemented.");
  process.exit(1);
}
```

With:
```typescript
} else if (command === "follow") {
  follow().catch((err) => {
    console.error("Follow failed:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Verify the follow command loads the followers page**

Run: `npx tsx follow-bot.ts follow @elonmusk`
Expected: If cookies are valid, prints `"Loaded followers page for @elonmusk"` then `"Session complete. Followed 0 users."`. If cookies expired, prints the re-login message.

Note: Requires valid `cookies.json` from Task 2.

- [ ] **Step 4: Commit**

```bash
git add follow-bot.ts
git commit -m "feat: add follow command with cookie loading and auth check"
```

---

### Task 4: Follow loop — scroll, extract users, click Follow, log results

**Files:**
- Modify: `follow-bot.ts`

This is the core logic. Replace the `// ── Follow loop will go here (Task 4) ──` comment with the full follow loop.

- [ ] **Step 1: Add the follow loop logic**

Replace the line `// ── Follow loop will go here (Task 4) ──` inside the `follow()` function with:

```typescript
  // Wait for follower cards to appear
  await page.waitForSelector('[data-testid="cellInnerDiv"]', { timeout: 10000 }).catch(() => {
    console.error("No follower cards found. The page may not have loaded correctly.");
  });

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
        console.log(`  Following @${username}...`);
        await followButton.click();

        // Wait briefly for the button state to change
        await page.waitForTimeout(2000);

        // Log the follow
        followCount++;
        const record: FollowRecord = {
          username,
          target,
          timestamp: new Date().toISOString(),
        };
        const currentLog = loadLog();
        currentLog.push(record);
        saveLog(currentLog);
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

      const previousCount = processedUsernames.size;
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
```

- [ ] **Step 2: Verify the follow loop works end-to-end**

Run: `npx tsx follow-bot.ts follow @sometarget`
Expected:
- Script loads cookies, navigates to followers page
- Processes visible followers, skipping already-followed
- Clicks Follow on eligible users with status messages
- Waits 30-90s between each follow
- Scrolls for more when visible cards exhausted
- `follow-log.json` is populated with follow records
- Stops at 150 follows or when no more followers load

Note: Manual verification. Use a small account first to test. You can temporarily change `MAX_FOLLOWS` to a small number (e.g., 3) for testing.

- [ ] **Step 3: Commit**

```bash
git add follow-bot.ts
git commit -m "feat: add follow loop with scrolling, skip logic, and JSON logging"
```

---

### Task 5: Handle dismiss popups and edge cases

**Files:**
- Modify: `follow-bot.ts`

X sometimes shows popups (rate limit warnings, "are you sure" dialogs, cookie consent). This task adds a popup dismissal helper that runs before each follow attempt.

- [ ] **Step 1: Add popup dismissal helper after the `saveLog` function**

```typescript
async function dismissPopups(page: import("playwright").Page): Promise<void> {
  // Dismiss any modal overlay by clicking common dismiss buttons
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
```

- [ ] **Step 2: Call `dismissPopups` inside the follow loop, before each follow click**

In the follow loop, right before the `console.log(\`  Following @${username}...\`);` line, add:

```typescript
        // Dismiss any popup that might be blocking
        await dismissPopups(page);
```

- [ ] **Step 3: Commit**

```bash
git add follow-bot.ts
git commit -m "feat: add popup dismissal for rate-limit and confirmation dialogs"
```

---

### Task 6: Final polish — summary, usage message, and import cleanup

**Files:**
- Modify: `follow-bot.ts`

- [ ] **Step 1: Add `Page` to the import from playwright**

Replace:
```typescript
import { chromium, type BrowserContext } from "playwright";
```

With:
```typescript
import { chromium, type BrowserContext, type Page } from "playwright";
```

And update the `dismissPopups` signature from `page: import("playwright").Page` to `page: Page`.

- [ ] **Step 2: Update the usage message to be more helpful**

Replace:
```typescript
  console.error("Usage: tsx follow-bot.ts <login|follow> [@target]");
```

With:
```typescript
  console.error(
    "Usage:\n" +
    "  npm run login              — Log in to X and save cookies\n" +
    "  npm run follow -- @handle  — Follow users from @handle's followers page"
  );
```

- [ ] **Step 3: Verify the complete script runs**

Run: `npx tsx follow-bot.ts`
Expected: Shows the usage message with both commands.

Run: `npx tsx follow-bot.ts login`
Expected: Opens browser for login.

Run: `npx tsx follow-bot.ts follow @sometarget`
Expected: Runs the full follow loop (with valid cookies).

- [ ] **Step 4: Commit**

```bash
git add follow-bot.ts
git commit -m "feat: polish usage message and clean up imports"
```
