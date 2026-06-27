# Fast Unfollow Scan (GraphQL feed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unfollow scan's DOM scroll-scan with a direct read of X's `Following` GraphQL feed so a 100k-follow account scans in ~20-40 min instead of 10-14 hours.

**Architecture:** A new pure-ish module `x-graph.ts` (at repo root, beside the other engine files) owns talking to the feed: capture the real request live, paginate by cursor, parse the JSON. `unfollow-bot.ts` keeps owning classification, checkpoint state, and output. The existing scroll-scan stays as a `--dom` fallback. Follow/chain are untouched.

**Tech Stack:** TypeScript run via `tsx` (no build step for the engine), Playwright (`BrowserContext`, `Page`, `APIRequestContext` via `context.request`), `node:test` for pure-logic tests.

## Global Constraints

- Engine files live at the **repo root** (e.g. `/x-graph.ts`), run via `tsx`. There is no engine `tsconfig`/compile step; tests are the gate.
- Tests are `*.test.ts` at the repo root, run by `npm test` (`tsx --test *.test.ts`). Use `node:test` + `node:assert/strict`, matching `criteria-filter.test.ts`.
- **No new npm dependencies.** Playwright and tsx are already present.
- **Backward-compatible CLI:** `npm run scan` with no flags must still produce `output/unfollow-candidates.json` in the same shape (`ScanResult[]`). Blank `--keywords` keeps the tech/crypto default. `--dom` runs the old scroll-scan.
- **Output shape unchanged:** `ScanResult = { username, displayName, bio, isTech, matchedKeywords, markedForUnfollow }`. The GUI and the `unfollow` command read this; do not change it.
- **Classification rule unchanged** (from the keywords feature): with custom keywords, matching bios are flagged (`markedForUnfollow = isMatch`); blank flags non-tech (`markedForUnfollow = !isMatch`). Reuse the existing `classifyBio(bio, keywords)`.
- **Copy has no em dashes** (project just ran a humanizer pass). Use periods/commas in any user-facing log line.
- Read-only scan: no follow-pacing delay, but honor X's read rate limit (`x-rate-limit-remaining` / `x-rate-limit-reset`) and back off on HTTP 429.
- Decisions and rationale: `docs/adr/0003-graphql-feed-for-scans.md`; full design: `docs/superpowers/specs/2026-06-21-fast-unfollow-scan-design.md`.

---

### Task 1: Feed response parser + types (`x-graph.ts`)

**Files:**
- Create: `x-graph.ts`
- Test: `x-graph.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface XUser { username: string; displayName: string; bio: string; }`
  - `interface FollowingPage { users: XUser[]; nextCursor: string | null; }`
  - `class FeedParseError extends Error {}`
  - `function parseFollowingPage(json: unknown): FollowingPage`

X serves the Following list as a GraphQL response. Users sit in a `TimelineAddEntries` instruction; each user entry carries `legacy.screen_name`, `legacy.name`, `legacy.description`. The page's "Bottom" cursor is the pagination token. When a page has no users, the feed is exhausted (`nextCursor: null`).

- [ ] **Step 1: Write the failing test**

Create `x-graph.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFollowingPage, FeedParseError } from "./x-graph";

// Minimal shape mirroring X's Following GraphQL response.
function page(entries: unknown[]) {
  return {
    data: { user: { result: { timeline: { timeline: { instructions: [
      { type: "TimelineClearCache" },
      { type: "TimelineAddEntries", entries },
    ] } } } } },
  };
}
function userEntry(id: string, screen: string, name: string, desc: string) {
  return {
    entryId: `user-${id}`,
    content: { entryType: "TimelineTimelineItem", itemContent: {
      itemType: "TimelineUser",
      user_results: { result: { __typename: "User", rest_id: id,
        legacy: { screen_name: screen, name, description: desc } } },
    } },
  };
}
function cursorEntry(type: "Bottom" | "Top", value: string) {
  return { entryId: `cursor-${type.toLowerCase()}-x`,
    content: { entryType: "TimelineTimelineCursor", cursorType: type, value } };
}

test("parseFollowingPage: extracts users and the bottom cursor", () => {
  const r = parseFollowingPage(page([
    userEntry("1", "alice", "Alice", "Corporate lawyer in Lagos"),
    userEntry("2", "bob", "Bob", "crypto degen"),
    cursorEntry("Top", "TOP"),
    cursorEntry("Bottom", "NEXT123"),
  ]));
  assert.deepEqual(r.users, [
    { username: "alice", displayName: "Alice", bio: "Corporate lawyer in Lagos" },
    { username: "bob", displayName: "Bob", bio: "crypto degen" },
  ]);
  assert.equal(r.nextCursor, "NEXT123");
});

test("parseFollowingPage: no users -> nextCursor null (exhausted)", () => {
  const r = parseFollowingPage(page([cursorEntry("Bottom", "NEXT123")]));
  assert.deepEqual(r.users, []);
  assert.equal(r.nextCursor, null);
});

test("parseFollowingPage: skips unavailable (non-User) results", () => {
  const bad = { entryId: "user-9", content: { itemContent: {
    user_results: { result: { __typename: "UserUnavailable" } } } } };
  const r = parseFollowingPage(page([bad, userEntry("1", "alice", "Alice", "bio"), cursorEntry("Bottom", "C")]));
  assert.deepEqual(r.users.map((u) => u.username), ["alice"]);
});

test("parseFollowingPage: missing instructions -> FeedParseError", () => {
  assert.throws(() => parseFollowingPage({ data: {} }), FeedParseError);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test`
Expected: FAIL (`Cannot find module './x-graph'` / `parseFollowingPage is not a function`).

- [ ] **Step 3: Implement the parser**

Create `x-graph.ts`:

```typescript
// Read a logged-in user's Following list from X's GraphQL feed.
// Parsing lives here so it is the single place that knows X's response shape.

export interface XUser {
  username: string;
  displayName: string;
  bio: string;
}

export interface FollowingPage {
  users: XUser[];
  nextCursor: string | null; // null when the feed is exhausted
}

// Thrown when the feed can't be read/parsed (X likely changed its shape).
export class FeedParseError extends Error {}

interface AnyObj { [k: string]: any }

function getInstructions(json: any): AnyObj[] {
  const tl = json?.data?.user?.result?.timeline?.timeline
    ?? json?.data?.user?.result?.timeline_v2?.timeline;
  const instructions = tl?.instructions;
  if (!Array.isArray(instructions)) {
    throw new FeedParseError("Following feed: instructions not found (shape changed?)");
  }
  return instructions;
}

export function parseFollowingPage(json: unknown): FollowingPage {
  const instructions = getInstructions(json);
  const entries: AnyObj[] = [];
  for (const ins of instructions) {
    if (ins?.type === "TimelineAddEntries" && Array.isArray(ins.entries)) {
      entries.push(...ins.entries);
    }
  }

  const users: XUser[] = [];
  let bottomCursor: string | null = null;

  for (const entry of entries) {
    const content = entry?.content;
    if (content?.cursorType === "Bottom" && typeof content.value === "string") {
      bottomCursor = content.value;
      continue;
    }
    const result = content?.itemContent?.user_results?.result;
    if (!result || result.__typename !== "User") continue;
    const legacy = result.legacy ?? {};
    if (typeof legacy.screen_name !== "string") continue;
    users.push({
      username: legacy.screen_name,
      displayName: typeof legacy.name === "string" ? legacy.name : "",
      bio: typeof legacy.description === "string" ? legacy.description : "",
    });
  }

  return { users, nextCursor: users.length > 0 ? bottomCursor : null };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test`
Expected: PASS (the 4 new `parseFollowingPage` tests, plus all existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add x-graph.ts x-graph.test.ts
git commit -m "feat(x-graph): parse X Following GraphQL feed pages"
```

---

### Task 2: Rate-limit pacing decision (`x-graph.ts`)

**Files:**
- Modify: `x-graph.ts`
- Test: `x-graph.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RateLimit { remaining: number; reset: number; }` (`reset` = epoch seconds)
  - `function rateLimitSleepMs(rl: RateLimit, nowSec: number, threshold?: number, marginMs?: number): number`
  - `function jitterMs(minMs?: number, maxMs?: number): number` (randomized, not unit-tested)

`rateLimitSleepMs` is the pure, testable pacing decision: when the window is nearly exhausted, sleep until it resets; otherwise don't. The small inter-page jitter is a separate randomized helper.

- [ ] **Step 1: Write the failing test**

Append to `x-graph.test.ts`:

```typescript
import { rateLimitSleepMs } from "./x-graph";

test("rateLimitSleepMs: plenty remaining -> 0", () => {
  assert.equal(rateLimitSleepMs({ remaining: 50, reset: 9999 }, 1000), 0);
});

test("rateLimitSleepMs: low remaining -> sleep until reset + margin", () => {
  // reset 30s from now, default margin 2000ms
  assert.equal(rateLimitSleepMs({ remaining: 2, reset: 1030 }, 1000), 30_000 + 2000);
});

test("rateLimitSleepMs: low remaining but reset in the past -> just the margin", () => {
  assert.equal(rateLimitSleepMs({ remaining: 0, reset: 900 }, 1000), 2000);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test`
Expected: FAIL (`rateLimitSleepMs is not a function`).

- [ ] **Step 3: Implement**

Append to `x-graph.ts`:

```typescript
export interface RateLimit {
  remaining: number;
  reset: number; // epoch seconds
}

// Sleep before the next request only when the window is nearly spent.
// Returns ms to wait (0 if there is headroom).
export function rateLimitSleepMs(
  rl: RateLimit,
  nowSec: number,
  threshold = 5,
  marginMs = 2000,
): number {
  if (rl.remaining > threshold) return 0;
  const untilResetMs = (rl.reset - nowSec) * 1000;
  return Math.max(0, untilResetMs) + marginMs;
}

// Small polite delay between pages so the read loop is not a tight burst.
export function jitterMs(minMs = 300, maxMs = 800): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test`
Expected: PASS (3 new tests green, all existing green).

- [ ] **Step 5: Commit**

```bash
git add x-graph.ts x-graph.test.ts
git commit -m "feat(x-graph): rate-limit pacing decision + jitter"
```

---

### Task 3: Live capture + page fetch (`x-graph.ts`)

**Files:**
- Modify: `x-graph.ts`

**Interfaces:**
- Consumes: `parseFollowingPage`, `FollowingPage`, `RateLimit`, `FeedParseError` (Task 1/2); Playwright `Page`, `BrowserContext`.
- Produces:
  - `interface CapturedReq { url: string; headers: Record<string, string>; }`
  - `class RateLimitedError extends Error { resetSec: number }`
  - `function captureFollowing(page: Page, selfHandle: string, timeoutMs?: number): Promise<CapturedReq>`
  - `function fetchFollowingPage(context: BrowserContext, captured: CapturedReq, cursor: string | null): Promise<{ page: FollowingPage; rateLimit: RateLimit }>`

These do network I/O, so they are verified by compile + the operator smoke test, not a unit test. `captureFollowing` navigates to the signed-in user's `/following` and grabs the real Following GraphQL request (URL with the current queryId, plus auth headers). `fetchFollowingPage` replays it, swapping only `variables.cursor`; `context.request` reuses the logged-in cookie jar and the captured headers supply the bearer + csrf.

- [ ] **Step 1: Implement capture + fetch**

Append to `x-graph.ts`:

```typescript
import type { Page, BrowserContext } from "playwright";

export interface CapturedReq {
  url: string;
  headers: Record<string, string>;
}

// Thrown on HTTP 429 so the caller can back off and retry the same cursor.
export class RateLimitedError extends Error {
  constructor(public resetSec: number) {
    super("rate limited");
  }
}

const FOLLOWING_RE = /\/graphql\/[^/]+\/Following\?/;

// Open the signed-in user's Following page and capture the real GraphQL request.
export async function captureFollowing(
  page: Page,
  selfHandle: string,
  timeoutMs = 15000,
): Promise<CapturedReq> {
  const reqP = page.waitForRequest((r) => FOLLOWING_RE.test(r.url()), { timeout: timeoutMs });
  await page.goto(`https://x.com/${selfHandle}/following`, { waitUntil: "domcontentloaded" });
  const req = await reqP.catch(() => {
    throw new FeedParseError("Did not see X's Following request (the page may have changed).");
  });
  return { url: req.url(), headers: req.headers() };
}

// Replay the captured request with a new cursor and parse one page.
export async function fetchFollowingPage(
  context: BrowserContext,
  captured: CapturedReq,
  cursor: string | null,
): Promise<{ page: FollowingPage; rateLimit: RateLimit }> {
  let url = captured.url;
  if (cursor) {
    const u = new URL(captured.url);
    const vars = JSON.parse(u.searchParams.get("variables") ?? "{}");
    vars.cursor = cursor;
    u.searchParams.set("variables", JSON.stringify(vars));
    url = u.toString();
  }

  const resp = await context.request.get(url, { headers: captured.headers });
  const h = resp.headers();
  const rateLimit: RateLimit = {
    remaining: Number(h["x-rate-limit-remaining"] ?? "999"),
    reset: Number(h["x-rate-limit-reset"] ?? "0"),
  };

  if (resp.status() === 429) throw new RateLimitedError(rateLimit.reset);
  if (!resp.ok()) throw new FeedParseError(`Following feed HTTP ${resp.status()}`);

  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    throw new FeedParseError("Following feed did not return JSON.");
  }
  return { page: parseFollowingPage(json), rateLimit };
}
```

- [ ] **Step 2: Verify it compiles / imports cleanly**

Run: `npx tsx -e "import('./x-graph.ts').then(() => console.log('x-graph ok'))"`
Expected: prints `x-graph ok` (module loads, types resolve, no syntax/import errors). The existing `npm test` must still pass.

- [ ] **Step 3: Commit**

```bash
git add x-graph.ts
git commit -m "feat(x-graph): capture the Following request live and fetch pages by cursor"
```

---

### Task 4: Extract the scroll-scan behind `--dom` (no behavior change)

**Files:**
- Modify: `unfollow-bot.ts`

**Interfaces:**
- Consumes: existing `classifyBio`, `ScanResult`, the existing scroll loop, `parseKeywordsArg`.
- Produces (internal to `unfollow-bot.ts`):
  - `async function scanViaDom(keywords: string[]): Promise<ScanResult[]>`
  - `function writeResults(results: ScanResult[]): void`

Pure refactor: pull the current scroll-and-classify loop out of `scan()` into `scanViaDom`, and the file-write + summary into `writeResults`. `scan()` becomes a router. No behavior change yet; the GraphQL path arrives in Task 5. This is its own task so a reviewer can confirm the refactor is behavior-preserving before new logic lands.

- [ ] **Step 1: Refactor `scan()` into `scanViaDom` + `writeResults` + a router**

In `unfollow-bot.ts`, restructure the existing `scan()` so that:

`scanViaDom(keywords)` contains everything the current `scan()` does between acquiring the browser and building `results` (the login check, finding `myUsername`, the scroll loop, per-cell extraction, `classifyBio`, building each `ScanResult` with `markedForUnfollow = keywords.length > 0 ? isMatch : !isMatch`, and the KEEP/DROP logging). It returns `results` and releases the browser. It must NOT write files or print the final summary.

`writeResults(results)` does the file write + summary that currently lives at the end of `scan()`:

```typescript
function writeResults(results: ScanResult[]): void {
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(results, null, 2));
  const marked = results.filter((r) => r.markedForUnfollow).length;
  console.log(`\n--- Scan Complete ---`);
  console.log(`  Total scanned: ${results.length}`);
  console.log(`  Keeping: ${results.length - marked}`);
  console.log(`  Marked for unfollow: ${marked}`);
  console.log(`\nResults saved to ${CANDIDATES_FILE}`);
  console.log(`Review in the app (or edit the file), then run: npm run unfollow`);
}
```

(Note: `CANDIDATES_FILE` is the existing import alias for `UNFOLLOW_CANDIDATES_FILE`.)

`scan()` becomes the router:

```typescript
async function scan(): Promise<void> {
  const args = process.argv.slice(3);
  const keywords = parseKeywordsArg(args);
  const useDom = args.includes("--dom");

  if (keywords.length > 0) {
    console.log(`Flagging bios matching: ${keywords.join(", ")} for unfollow; keeping everyone else.`);
  } else {
    console.log(`Keeping tech/crypto bios; everyone else becomes an unfollow candidate.`);
  }

  const results = await scanViaDom(keywords); // Task 5 adds the feed path + routing
  writeResults(results);
}
```

- [ ] **Step 2: Verify the existing tests pass and the module loads**

Run: `npm test`
Expected: PASS (no test references the internal scan functions; this confirms nothing else broke).

Run: `npx tsx -e "import('./unfollow-bot.ts').then(() => console.log('unfollow-bot ok'))"`
Expected: prints `unfollow-bot ok`. Importing the module runs its existing top-level command dispatch with no args, so it also prints the usage text. That is fine. Do NOT change the dispatch; we are only confirming there are no syntax/type errors.

- [ ] **Step 3: Commit**

```bash
git add unfollow-bot.ts
git commit -m "refactor(unfollow): extract scroll-scan into scanViaDom + writeResults"
```

---

### Task 5: GraphQL scan path + checkpoint/resume + fail-fast routing

**Files:**
- Modify: `config.ts` (add the scan-state path)
- Modify: `unfollow-bot.ts`

**Interfaces:**
- Consumes: `captureFollowing`, `fetchFollowingPage`, `rateLimitSleepMs`, `jitterMs`, `RateLimitedError`, `FeedParseError`, `XUser` (Task 1-3); `classifyBio`, `ScanResult`, `writeResults`, `scanViaDom` (Task 4); `acquireBrowser` (`browser.ts`).
- Produces:
  - `config.ts`: `export const UNFOLLOW_SCAN_STATE_FILE = path.join(OUTPUT_DIR, "unfollow-scan-state.json");`
  - `unfollow-bot.ts`: `async function scanViaFeed(keywords: string[]): Promise<ScanResult[]>` and the routing that makes the feed the default with `--dom` as fallback.

`scanViaFeed` paginates the feed, classifies each user, checkpoints `{ cursor, scanned, done }` after every page, and resumes if interrupted. On `FeedParseError` it prints the fail-fast line and the caller exits non-zero. On `RateLimitedError` it backs off and retries the same cursor.

- [ ] **Step 1: Add the scan-state path constant**

In `config.ts`, after the `UNFOLLOW_LOG_FILE` line:

```typescript
export const UNFOLLOW_SCAN_STATE_FILE = path.join(OUTPUT_DIR, "unfollow-scan-state.json");
```

- [ ] **Step 2: Add imports and the scan-state helpers to `unfollow-bot.ts`**

Add imports (merge with existing import blocks):

```typescript
import { acquireBrowser } from "./browser";
import {
  captureFollowing,
  fetchFollowingPage,
  rateLimitSleepMs,
  jitterMs,
  RateLimitedError,
  FeedParseError,
} from "./x-graph";
import { UNFOLLOW_SCAN_STATE_FILE } from "./config";
```

(`acquireBrowser` is already imported in `unfollow-bot.ts`; do not duplicate it. `classifyBio`, `parseKeywordsArg`, `CANDIDATES_FILE` are already imported.)

Add the state type + helpers near the top of the file:

```typescript
interface ScanState {
  cursor: string | null;
  scanned: ScanResult[];
  done: boolean;
}

function loadScanState(): ScanState | null {
  if (!fs.existsSync(UNFOLLOW_SCAN_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(UNFOLLOW_SCAN_STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}
function saveScanState(s: ScanState): void {
  fs.writeFileSync(UNFOLLOW_SCAN_STATE_FILE, JSON.stringify(s, null, 2));
}
function clearScanState(): void {
  if (fs.existsSync(UNFOLLOW_SCAN_STATE_FILE)) fs.unlinkSync(UNFOLLOW_SCAN_STATE_FILE);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

- [ ] **Step 3: Implement `scanViaFeed`**

`scanViaFeed` needs the signed-in user's handle. Reuse the existing approach already present in `scanViaDom` (navigate to `https://x.com/home`, check for `/login`, read `a[data-testid="AppTabBar_Profile_Link"]` href). Extract that into a shared helper so both paths use it:

```typescript
// Resolve the signed-in user's @handle from the home sidebar; exits if not logged in.
async function resolveSelfHandle(page: import("playwright").Page): Promise<string> {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  if (page.url().includes("/login") || page.url().includes("/i/flow/login")) {
    console.error("Not logged in. Run `npm run login` first.");
    process.exit(1);
  }
  const link = await page.$('a[data-testid="AppTabBar_Profile_Link"]');
  const href = await link?.getAttribute("href");
  const handle = href?.replace(/^\//, "") ?? "";
  if (!handle) {
    console.error("Could not find your profile link. Run `npm run login` first.");
    process.exit(1);
  }
  console.log(`Logged in as @${handle}`);
  return handle;
}
```

(Update `scanViaDom` to call `resolveSelfHandle(page)` instead of its inline copy, so there is one source of truth.)

Then:

```typescript
async function scanViaFeed(keywords: string[]): Promise<ScanResult[]> {
  const { context, release } = await acquireBrowser();
  const page = await context.newPage();
  try {
    const selfHandle = await resolveSelfHandle(page);

    const prior = loadScanState();
    const state: ScanState = prior && !prior.done
      ? prior
      : { cursor: null, scanned: [], done: false };
    if (prior && !prior.done) {
      console.log(`Resuming scan: ${state.scanned.length} already scanned.`);
    }

    const captured = await captureFollowing(page, selfHandle); // throws FeedParseError

    let backoffMs = 2000;
    while (!state.done) {
      let result;
      try {
        result = await fetchFollowingPage(context, captured, state.cursor);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          const waitMs = rateLimitSleepMs({ remaining: 0, reset: err.resetSec }, Math.floor(Date.now() / 1000));
          const ms = Math.max(waitMs, backoffMs);
          console.log(`Rate limited. Waiting ${Math.round(ms / 1000)}s, then retrying.`);
          await sleep(ms);
          backoffMs = Math.min(backoffMs * 2, 60000);
          continue; // retry same cursor
        }
        throw err; // FeedParseError -> bubble to caller (fail fast)
      }
      backoffMs = 2000;

      for (const u of result.page.users) {
        const { isMatch, matchedKeywords } = classifyBio(u.bio, keywords);
        state.scanned.push({
          username: u.username,
          displayName: u.displayName,
          bio: u.bio.substring(0, 200),
          isTech: isMatch,
          matchedKeywords,
          markedForUnfollow: keywords.length > 0 ? isMatch : !isMatch,
        });
      }

      state.cursor = result.page.nextCursor;
      if (result.page.nextCursor === null) state.done = true;
      saveScanState(state);
      console.log(`  scanned ${state.scanned.length}`);

      if (!state.done) {
        const rlSleep = rateLimitSleepMs(result.rateLimit, Math.floor(Date.now() / 1000));
        if (rlSleep > 0) console.log(`  rate limit low, sleeping ${Math.round(rlSleep / 1000)}s`);
        await sleep(rlSleep > 0 ? rlSleep : jitterMs());
      }
    }

    clearScanState();
    return state.scanned;
  } finally {
    await release();
  }
}
```

- [ ] **Step 4: Route `scan()` to the feed by default, `--dom` to the scroll-scan**

Update the router from Task 4:

```typescript
async function scan(): Promise<void> {
  const args = process.argv.slice(3);
  const keywords = parseKeywordsArg(args);
  const useDom = args.includes("--dom");

  if (keywords.length > 0) {
    console.log(`Flagging bios matching: ${keywords.join(", ")} for unfollow; keeping everyone else.`);
  } else {
    console.log(`Keeping tech/crypto bios; everyone else becomes an unfollow candidate.`);
  }

  let results: ScanResult[];
  if (useDom) {
    results = await scanViaDom(keywords);
  } else {
    try {
      results = await scanViaFeed(keywords);
    } catch (err) {
      if (err instanceof FeedParseError) {
        console.error(`\nCouldn't read X's Following feed (${err.message}).`);
        console.error(`Retry, or run the slower scroll scan with: npm run scan -- --dom`);
        process.exit(1);
      }
      throw err;
    }
  }
  writeResults(results);
}
```

- [ ] **Step 5: Verify it compiles, loads, and existing tests pass**

Run: `npm test`
Expected: PASS (all existing pure tests green; no regressions).

Run: `npx tsx -e "import('./unfollow-bot.ts').then(() => console.log('unfollow-bot ok')).catch(e => { console.error(e); process.exit(1) })"`
Expected: prints `unfollow-bot ok`.

- [ ] **Step 6: Commit**

```bash
git add config.ts unfollow-bot.ts
git commit -m "feat(unfollow): GraphQL feed scan with checkpoint/resume and --dom fallback"
```

---

## Notes for the operator (smoke test, after the plan)

These need a display + a logged-in X session, so they are not part of the automated gate:

- `npm run scan` on a real account: confirm it finishes fast, `output/unfollow-candidates.json` looks right, and the live log shows a rising `scanned N` count.
- `npm run scan -- --keywords "crypto, nft"`: confirm matching bios are flagged.
- Kill the process mid-scan, re-run `npm run scan`: confirm it prints `Resuming scan: N already scanned.` and continues.
- `npm run scan -- --dom`: confirm the old scroll-scan still works.
- The GUI Unfollow panel: unchanged controls, faster scan, same review/unfollow flow.
