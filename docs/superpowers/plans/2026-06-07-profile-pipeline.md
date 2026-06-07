# Profile Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `prospect.ts` — a tool that syncs the canonical list of who you follow on X, enriches handles into deep profiles, and filters them down to a decision-maker shortlist (`candidates.json`) for a separate AI to draft DMs from.

**Architecture:** A CLI tool (`prospect.ts`) with `sync`/`enrich`/`filter`/`prepare` subcommands, backed by small focused modules: `pacing.ts` (burst delays + daily-count helpers, shared with the existing follow bot), `role-filter.ts` (decision-maker keyword matcher), `following-store.ts` (canonical following set + merge), and `profile-parse.ts` (pure field parsers). Each stage reads one JSON file and writes another, so stages run and resume independently. Browser scraping reuses the existing `launchBrowser` (persistent Chrome profile).

**Tech Stack:** TypeScript, Playwright (Chrome), `tsx` runner, Node's built-in `node:test` runner. No new dependencies.

**Scope note:** This is Plan 1 of 2. The DM-sending tool (`dm-bot.ts`) is a separate plan; it depends on `pacing.ts` and `candidates.json` produced here.

---

## File Structure

| File | Responsibility |
|---|---|
| `pacing.ts` (new) | `randInt`, `randomDelay`, `BurstScheduler` (cluster/rest delay sequencing), `todayCountUTC`. Shared with follow bot. |
| `role-filter.ts` (new) | `matchRole(bio)` → strong / review / no match, with matched keywords. |
| `following-store.ts` (new) | `FollowingRecord` type, `loadFollowing`/`saveFollowing`, pure `mergeFollowing`. |
| `profile-parse.ts` (new) | Pure parsers: `parseCount` ("12.3K"→12300), `parseCompany`. |
| `prospect.ts` (new) | CLI: `sync`, `enrich`, `filter`, `prepare`. Browser scraping + wiring. |
| `pacing.test.ts`, `role-filter.test.ts`, `following-store.test.ts`, `profile-parse.test.ts` (new) | Unit tests for the pure logic. |
| `follow-bot.ts` (modify) | Import `randInt`/`randomDelay` from `pacing.ts` instead of defining locally. |
| `package.json` (modify) | Add `test`, `prospect:*` scripts. |

Generated data files (gitignored, not created by tasks): `following.json`, `profiles.json`, `candidates.json`.

---

## Task 1: `pacing.ts` — shared burst/delay helpers

**Files:**
- Create: `pacing.ts`
- Test: `pacing.test.ts`
- Modify: `follow-bot.ts` (import `randInt`/`randomDelay` from `pacing.ts`, remove local copies)

- [ ] **Step 1: Write the failing test**

Create `pacing.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { BurstScheduler, todayCountUTC } from "./pacing";

// rng = () => 0 makes randInt always return its min, so cluster size = clusterMin.
const PACING = {
  clusterMin: 2,
  clusterMax: 5,
  intraDelayMinSec: 5,
  intraDelayMaxSec: 20,
  restDelayMinSec: 180,
  restDelayMaxSec: 480,
};

test("BurstScheduler: intra delays within a cluster, rest at the boundary", () => {
  const s = new BurstScheduler(PACING, () => 0); // cluster size = 2
  const d1 = s.next(); // 2 -> 1, still in burst
  const d2 = s.next(); // 1 -> 0, burst done -> rest, reset to 2
  const d3 = s.next(); // 2 -> 1, new burst
  assert.deepEqual(
    [d1.kind, d2.kind, d3.kind],
    ["intra", "rest", "intra"]
  );
  assert.equal(d1.sec, 5); // intraDelayMinSec
  assert.equal(d2.sec, 180); // restDelayMinSec
});

test("todayCountUTC counts only same-UTC-day timestamps", () => {
  const ts = [
    "2026-06-07T01:00:00.000Z",
    "2026-06-07T23:00:00.000Z",
    "2020-01-01T00:00:00.000Z",
  ];
  assert.equal(todayCountUTC(ts, "2026-06-07T12:00:00.000Z"), 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test pacing.test.ts`
Expected: FAIL — `Cannot find module './pacing'`.

- [ ] **Step 3: Write minimal implementation**

Create `pacing.ts`:

```typescript
// Shared follow/scrape pacing helpers. Used by follow-bot and prospect/dm tools.

export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomDelay(minSec: number, maxSec: number, label = "before next action"): Promise<void> {
  const sec = randInt(minSec, maxSec);
  const human = sec >= 90 ? `${(sec / 60).toFixed(1)}min` : `${sec}s`;
  console.log(`  Waiting ${human} ${label}...`);
  return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}

export interface BurstPacing {
  clusterMin: number;
  clusterMax: number;
  intraDelayMinSec: number;
  intraDelayMaxSec: number;
  restDelayMinSec: number;
  restDelayMaxSec: number;
}

export type DelayKind = "intra" | "rest";
export interface DelayDecision {
  kind: DelayKind;
  sec: number;
}

// Sequences burst pacing: after each action, returns a short intra-burst delay
// or, when the cluster is exhausted, a long rest and starts a fresh cluster.
// rng is injectable for deterministic tests (defaults to Math.random).
export class BurstScheduler {
  private remaining: number;
  constructor(
    private readonly p: BurstPacing,
    private readonly rng: () => number = Math.random
  ) {
    this.remaining = this.pick(p.clusterMin, p.clusterMax);
  }

  private pick(min: number, max: number): number {
    return Math.floor(this.rng() * (max - min + 1)) + min;
  }

  next(): DelayDecision {
    this.remaining--;
    if (this.remaining > 0) {
      return { kind: "intra", sec: this.pick(this.p.intraDelayMinSec, this.p.intraDelayMaxSec) };
    }
    this.remaining = this.pick(this.p.clusterMin, this.p.clusterMax);
    return { kind: "rest", sec: this.pick(this.p.restDelayMinSec, this.p.restDelayMaxSec) };
  }
}

// Counts timestamps falling on the same UTC calendar day as `now`.
// `now` is passed in (ISO string) so callers control "today" and tests stay pure.
export function todayCountUTC(timestamps: string[], now: string): number {
  const day = now.slice(0, 10); // YYYY-MM-DD
  return timestamps.filter((t) => t.slice(0, 10) === day).length;
}

// Awaits a BurstScheduler decision (convenience for callers).
export async function applyDelay(d: DelayDecision): Promise<void> {
  const label = d.kind === "rest" ? "to rest between bursts" : "in this burst";
  await randomDelay(d.sec, d.sec, label);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test pacing.test.ts`
Expected: PASS — `pass 2`, `fail 0`.

- [ ] **Step 5: Point follow-bot.ts at the shared helpers**

In `follow-bot.ts`, delete the local `randInt` and `randomDelay` definitions (the block starting `function randInt(min: number, max: number): number {` through the end of `randomDelay`), and add to the imports from `./pacing`:

```typescript
import { randInt, randomDelay } from "./pacing";
```

(Leave follow-bot's inline cluster logic as-is — it already works. Only the two helper functions move.)

- [ ] **Step 6: Verify follow-bot still type-checks**

Run: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck follow-bot.ts pacing.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"`
Expected: no output (only pre-existing `@types/node` noise is filtered out).

- [ ] **Step 7: Commit**

```bash
git add pacing.ts pacing.test.ts follow-bot.ts
git commit -m "feat: extract shared pacing helpers (BurstScheduler, todayCountUTC)"
```

---

## Task 2: `role-filter.ts` — decision-maker matcher

**Files:**
- Create: `role-filter.ts`
- Test: `role-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `role-filter.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRole } from "./role-filter";

test("strong title -> strong confidence", () => {
  const r = matchRole("Co-founder & CEO at Acme. Building the future.");
  assert.equal(r.confidence, "strong");
  assert.ok(r.matchedKeywords.includes("ceo"));
});

test("hiring language -> strong", () => {
  assert.equal(matchRole("We're hiring senior engineers!").confidence, "strong");
});

test("ambiguous leadership word -> review", () => {
  assert.equal(matchRole("Engineering lead. Opinions my own.").confidence, "review");
});

test("no signal -> null", () => {
  const r = matchRole("Coffee lover, dog dad, runner.");
  assert.equal(r.confidence, null);
  assert.deepEqual(r.matchedKeywords, []);
});

test("word boundary: 'lead' does not match inside 'leadership' only as a word", () => {
  // "leaderboard" should NOT trigger the bare 'lead' review keyword
  assert.equal(matchRole("I love the leaderboard rankings.").confidence, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test role-filter.test.ts`
Expected: FAIL — `Cannot find module './role-filter'`.

- [ ] **Step 3: Write minimal implementation**

Create `role-filter.ts`:

```typescript
// Decision-maker bio matcher. Mirrors the tech-filter.ts word-boundary approach.
// Two-stage: STRONG titles -> "strong"; weaker leadership signals -> "review";
// otherwise no match.

const STRONG_TITLES = [
  "founder", "co-founder", "cofounder", "ceo", "cto", "coo", "cfo", "cmo",
  "cpo", "chief", "president", "vice president", "vp", "head of", "director of",
  "managing director", "general partner", "partner", "hiring", "we're hiring",
  "we are hiring", "recruiter", "talent", "people ops", "hiring manager",
  "owner", "principal",
];

const REVIEW_SIGNALS = [
  "lead", "manager", "director", "advisor", "investor", "growth",
  "operations", "biz dev", "business development", "founding",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeMatchers(words: string[]) {
  return words.map((kw) => ({
    kw,
    re: new RegExp(`(?<![\\w])${escapeRegExp(kw)}(?![\\w])`, "i"),
  }));
}

const STRONG_MATCHERS = makeMatchers(STRONG_TITLES);
const REVIEW_MATCHERS = makeMatchers(REVIEW_SIGNALS);

export type RoleConfidence = "strong" | "review";

export interface RoleMatch {
  confidence: RoleConfidence | null;
  matchedKeywords: string[];
}

export function matchRole(bio: string): RoleMatch {
  const strong = STRONG_MATCHERS.filter(({ re }) => re.test(bio)).map((m) => m.kw);
  if (strong.length > 0) return { confidence: "strong", matchedKeywords: strong };

  const review = REVIEW_MATCHERS.filter(({ re }) => re.test(bio)).map((m) => m.kw);
  if (review.length > 0) return { confidence: "review", matchedKeywords: review };

  return { confidence: null, matchedKeywords: [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test role-filter.test.ts`
Expected: PASS — `pass 5`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add role-filter.ts role-filter.test.ts
git commit -m "feat: add role-filter for decision-maker matching"
```

---

## Task 3: `profile-parse.ts` — pure field parsers

**Files:**
- Create: `profile-parse.ts`
- Test: `profile-parse.test.ts`

- [ ] **Step 1: Write the failing test**

Create `profile-parse.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCount, parseCompany } from "./profile-parse";

test("parseCount handles plain, comma, K, M", () => {
  assert.equal(parseCount("567"), 567);
  assert.equal(parseCount("1,234"), 1234);
  assert.equal(parseCount("12.3K"), 12300);
  assert.equal(parseCount("1.2M"), 1200000);
  assert.equal(parseCount(""), null);
  assert.equal(parseCount("garbage"), null);
});

test("parseCompany extracts an @mention or 'at X'", () => {
  assert.equal(parseCompany("CTO @Stripe. building payments"), "Stripe");
  assert.equal(parseCompany("Engineer at Vercel"), "Vercel");
  assert.equal(parseCompany("just a person"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test profile-parse.test.ts`
Expected: FAIL — `Cannot find module './profile-parse'`.

- [ ] **Step 3: Write minimal implementation**

Create `profile-parse.ts`:

```typescript
// Pure parsers for scraped profile fields.

// Parses X follower/following count strings: "567", "1,234", "12.3K", "1.2M".
export function parseCount(raw: string): number | null {
  const s = raw.trim().replace(/,/g, "");
  const m = s.match(/^([\d.]+)\s*([KM]?)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2].toUpperCase() === "M" ? 1_000_000 : m[2].toUpperCase() === "K" ? 1_000 : 1;
  return Math.round(n * mult);
}

// Best-effort company extraction from a bio: first "@handle" mention, else
// the word(s) after " at ". Returns null when nothing matches.
export function parseCompany(bio: string): string | null {
  const at = bio.match(/(?<![\w])@([A-Za-z0-9_]{2,})/);
  if (at) return at[1];
  const phrase = bio.match(/\bat\s+([A-Z][A-Za-z0-9_.&-]+)/);
  if (phrase) return phrase[1];
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test profile-parse.test.ts`
Expected: PASS — `pass 2`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add profile-parse.ts profile-parse.test.ts
git commit -m "feat: add pure profile field parsers (count, company)"
```

---

## Task 4: `following-store.ts` — canonical following set + merge

**Files:**
- Create: `following-store.ts`
- Test: `following-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `following-store.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFollowing, type FollowingRecord } from "./following-store";

test("mergeFollowing preserves firstSeen, refreshes lastSynced, sets viaBot", () => {
  const existing: FollowingRecord[] = [
    { handle: "alice", name: "Alice", bioSnippet: "old bio", firstSeen: "2026-01-01T00:00:00.000Z", lastSynced: "2026-01-01T00:00:00.000Z", viaBot: false },
  ];
  const scraped = [
    { handle: "alice", name: "Alice A", bioSnippet: "new bio" },
    { handle: "bob", name: "Bob", bioSnippet: "bob bio" },
  ];
  const now = "2026-06-07T12:00:00.000Z";
  const out = mergeFollowing(existing, scraped, new Set(["bob"]), now);

  const alice = out.find((r) => r.handle === "alice")!;
  const bob = out.find((r) => r.handle === "bob")!;

  assert.equal(alice.firstSeen, "2026-01-01T00:00:00.000Z"); // preserved
  assert.equal(alice.lastSynced, now); // refreshed
  assert.equal(alice.name, "Alice A"); // updated
  assert.equal(bob.firstSeen, now); // new
  assert.equal(bob.viaBot, true); // in botHandles
  assert.equal(alice.viaBot, false);
});

test("mergeFollowing keeps records not present in the latest scrape (stale, not deleted)", () => {
  const existing: FollowingRecord[] = [
    { handle: "carol", name: "Carol", bioSnippet: "", firstSeen: "2026-01-01T00:00:00.000Z", lastSynced: "2026-01-01T00:00:00.000Z", viaBot: false },
  ];
  const out = mergeFollowing(existing, [], new Set(), "2026-06-07T12:00:00.000Z");
  assert.equal(out.length, 1);
  assert.equal(out[0].lastSynced, "2026-01-01T00:00:00.000Z"); // unchanged -> stale signal
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test following-store.test.ts`
Expected: FAIL — `Cannot find module './following-store'`.

- [ ] **Step 3: Write minimal implementation**

Create `following-store.ts`:

```typescript
import * as fs from "fs";
import * as path from "path";

const FOLLOWING_FILE = path.join(__dirname, "following.json");

export interface FollowingRecord {
  handle: string;
  name: string;
  bioSnippet: string;
  firstSeen: string;
  lastSynced: string;
  viaBot: boolean;
}

export interface ScrapedFollowing {
  handle: string;
  name: string;
  bioSnippet: string;
}

export function loadFollowing(): FollowingRecord[] {
  if (!fs.existsSync(FOLLOWING_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FOLLOWING_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function saveFollowing(records: FollowingRecord[]): void {
  fs.writeFileSync(FOLLOWING_FILE, JSON.stringify(records, null, 2));
}

// Merge a fresh scrape into the canonical set. New handles get firstSeen;
// matched handles get lastSynced refreshed and name/bio updated. Records absent
// from the scrape are kept untouched (stale lastSynced = likely unfollowed).
export function mergeFollowing(
  existing: FollowingRecord[],
  scraped: ScrapedFollowing[],
  botHandles: Set<string>,
  now: string
): FollowingRecord[] {
  const byHandle = new Map<string, FollowingRecord>();
  for (const r of existing) byHandle.set(r.handle, { ...r });

  for (const s of scraped) {
    const prev = byHandle.get(s.handle);
    if (prev) {
      prev.name = s.name || prev.name;
      prev.bioSnippet = s.bioSnippet;
      prev.lastSynced = now;
      prev.viaBot = prev.viaBot || botHandles.has(s.handle);
    } else {
      byHandle.set(s.handle, {
        handle: s.handle,
        name: s.name,
        bioSnippet: s.bioSnippet,
        firstSeen: now,
        lastSynced: now,
        viaBot: botHandles.has(s.handle),
      });
    }
  }

  return [...byHandle.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test following-store.test.ts`
Expected: PASS — `pass 2`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add following-store.ts following-store.test.ts
git commit -m "feat: add following-store with canonical merge"
```

---

## Task 5: `prospect.ts sync` — scrape the following list

**Files:**
- Create: `prospect.ts`
- Modify: `.gitignore` (add `following.json`, `profiles.json`, `candidates.json`)

This task is browser-driven and verified by a smoke run (no unit test), per the spec's testing approach.

- [ ] **Step 1: Add generated data files to .gitignore**

Append to `.gitignore`:

```
following.json
profiles.json
candidates.json
```

- [ ] **Step 2: Create `prospect.ts` with the `sync` command**

Create `prospect.ts`:

```typescript
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
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck prospect.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"`
Expected: no output.

- [ ] **Step 4: Smoke test (manual)**

Run: `npx tsx prospect.ts sync @yourhandle` (replace with your real handle).
Expected: Chrome opens, scrolls your following page, prints rising "Collected N" counts, and writes `following.json`. Verify with:
`python3 -c "import json;d=json.load(open('following.json'));print(len(d));print(d[0])"`
Expected: a count and a record with `handle`, `firstSeen`, `lastSynced`, `viaBot`.

- [ ] **Step 5: Commit**

```bash
git add prospect.ts .gitignore
git commit -m "feat: prospect.ts sync — scrape canonical following list"
```

---

## Task 6: `prospect.ts enrich` — deep profile scraping

**Files:**
- Modify: `prospect.ts`
- Modify: `config.ts` (add scrape pacing constants)

Browser-driven; verified by smoke run.

- [ ] **Step 1: Add scrape pacing + profile types to config.ts**

Append to `config.ts`:

```typescript
// ── Profile Enrichment ────────────────────────────────────────
// Visiting profiles + reading tweets is heavy; pace it like following.
export const ENRICH_MAX_PER_DAY = 300;
export const ENRICH_CLUSTER_MIN = 2;
export const ENRICH_CLUSTER_MAX = 4;
export const ENRICH_INTRA_DELAY_MIN_SEC = 8;
export const ENRICH_INTRA_DELAY_MAX_SEC = 25;
export const ENRICH_REST_DELAY_MIN_SEC = 120;
export const ENRICH_REST_DELAY_MAX_SEC = 360;
export const RECENT_TWEETS_COUNT = 5;
```

- [ ] **Step 2: Add the Profile type and enrich command to prospect.ts**

Add to `prospect.ts` (imports at top, then the function, then a branch in the CLI):

```typescript
// add to imports
import * as fs from "fs";
import * as path from "path";
import { BurstScheduler, applyDelay, todayCountUTC } from "./pacing";
import { matchRole } from "./role-filter";
import { parseCount, parseCompany } from "./profile-parse";
import {
  ENRICH_MAX_PER_DAY,
  ENRICH_CLUSTER_MIN,
  ENRICH_CLUSTER_MAX,
  ENRICH_INTRA_DELAY_MIN_SEC,
  ENRICH_INTRA_DELAY_MAX_SEC,
  ENRICH_REST_DELAY_MIN_SEC,
  ENRICH_REST_DELAY_MAX_SEC,
  RECENT_TWEETS_COUNT,
} from "./config";

const PROFILES_FILE = path.join(__dirname, "profiles.json");

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
  role: string | null;
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

  // Follower / following counts live in links ending in /verified_followers and /following.
  const followingRaw = await text(`a[href="/${handle}/following"] span`);
  const followersRaw = await text(`a[href="/${handle}/verified_followers"] span`);
  const verified = !!(await page.$('[data-testid="UserName"] svg[aria-label*="erified"]'));

  // Tweets: first N article texts on the timeline; the pinned one (if any) is first.
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
    role: matchRole(bio).confidence,
    company: parseCompany(bio),
    pinnedTweet: isPinned ? tweetTexts[0] ?? null : null,
    recentTweets: tweetTexts.slice(isPinned ? 1 : 0, RECENT_TWEETS_COUNT + (isPinned ? 1 : 0)),
    enrichedAt: new Date().toISOString(),
  };
}

async function enrich(): Promise<void> {
  const args = process.argv.slice(3);
  // Source: default following.json, or --handles @a,@b
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

  const context = await launchBrowser();
  const page = await context.newPage();
  try {
    console.log(`Enriching ${todo.length} profiles (${dailyCount}/${ENRICH_MAX_PER_DAY} done today).`);
    for (const handle of todo) {
      try {
        const profile = await scrapeProfile(page, handle);
        profiles.push(profile);
        saveProfiles(profiles);
        dailyCount++;
        console.log(`  ✓ @${handle} (role=${profile.role ?? "-"}, followers=${profile.followers ?? "?"}) [${dailyCount}/${ENRICH_MAX_PER_DAY}]`);
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
    await context.close();
  }
  console.log(`\nDone. ${profiles.length} profiles total in profiles.json.`);
}
```

Update the CLI branch at the bottom:

```typescript
if (require.main === module) {
  const command = process.argv[2];
  const run = (fn: () => Promise<void>) =>
    fn().catch((err) => {
      console.error(`${command} failed:`, err);
      process.exit(1);
    });
  if (command === "sync") run(sync);
  else if (command === "enrich") run(enrich);
  else {
    console.error("Usage: tsx prospect.ts <sync|enrich|filter|prepare>");
    process.exit(1);
  }
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck prospect.ts config.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"`
Expected: no output.

- [ ] **Step 4: Smoke test (manual, small)**

Run: `npx tsx prospect.ts enrich --handles @toly`
Expected: Chrome visits the profile, prints `✓ @toly (role=..., followers=...)`, writes `profiles.json`. Verify:
`python3 -c "import json;d=json.load(open('profiles.json'));print(json.dumps(d[0],indent=2))"`
Expected: a profile object with bio, counts, recentTweets. Some fields may be null if a selector missed — that's acceptable (logged, not fatal). Note any selector that consistently returns empty for a follow-up fix.

- [ ] **Step 5: Commit**

```bash
git add prospect.ts config.ts
git commit -m "feat: prospect.ts enrich — deep profile scraping (burst-paced, resumable)"
```

---

## Task 7: `prospect.ts filter` and `prepare`

**Files:**
- Modify: `prospect.ts`

The filter selection logic is exercised through `role-filter`'s unit tests; this task wires it to files and is smoke-verified.

- [ ] **Step 1: Add filter + prepare to prospect.ts**

Add to `prospect.ts`:

```typescript
const CANDIDATES_FILE = path.join(__dirname, "candidates.json");

export interface Candidate extends Profile {
  roleConfidence: "strong" | "review";
  matchedKeywords: string[];
}

async function filter(): Promise<void> {
  const profiles = loadProfiles();
  const candidates: Candidate[] = [];
  for (const p of profiles) {
    const m = matchRole(p.bio);
    if (m.confidence === null) continue;
    candidates.push({ ...p, roleConfidence: m.confidence, matchedKeywords: m.matchedKeywords });
  }
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(candidates, null, 2));
  const strong = candidates.filter((c) => c.roleConfidence === "strong").length;
  console.log(`Filtered ${profiles.length} profiles -> ${candidates.length} candidates (${strong} strong, ${candidates.length - strong} review).`);
}

async function prepare(): Promise<void> {
  await sync();
  await enrich();
  await filter();
}
```

Update the CLI branch:

```typescript
  if (command === "sync") run(sync);
  else if (command === "enrich") run(enrich);
  else if (command === "filter") run(filter);
  else if (command === "prepare") run(prepare);
  else {
    console.error("Usage: tsx prospect.ts <sync|enrich|filter|prepare>");
    process.exit(1);
  }
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck prospect.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"`
Expected: no output.

- [ ] **Step 3: Smoke test (manual)**

Run: `npx tsx prospect.ts filter` (after enrich has produced some profiles).
Expected: prints `Filtered N profiles -> M candidates (...)` and writes `candidates.json`. Verify:
`python3 -c "import json;d=json.load(open('candidates.json'));print(len(d));print([c['handle'] for c in d[:5]])"`

- [ ] **Step 4: Commit**

```bash
git add prospect.ts
git commit -m "feat: prospect.ts filter + prepare — decision-maker shortlist"
```

---

## Task 8: npm scripts + README

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add scripts to package.json**

In `package.json` `"scripts"`, add:

```json
    "test": "tsx --test *.test.ts",
    "prospect:sync": "tsx prospect.ts sync",
    "prospect:enrich": "tsx prospect.ts enrich",
    "prospect:filter": "tsx prospect.ts filter",
    "prospect:prepare": "tsx prospect.ts prepare"
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS — all `*.test.ts` pass (`fail 0`).

- [ ] **Step 3: Add a README section**

Add a `## Outreach Profiles (prospect.ts)` section to `README.md` documenting: the pipeline (`sync` → `enrich` → `filter` → writer AI → `dm-bot`), the file contracts, the source flags (`--handles`), the daily enrich cap, and that scraping reuses burst pacing. Keep it consistent in tone with the existing Chain Mode section.

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "docs: add prospect.ts scripts and README section"
```

---

## Self-Review

- **Spec coverage:** sync (Task 5), enrich/deep (Task 6), filter/two-stage (Task 7 + role-filter Task 2), source flexibility via `--handles` (Task 6; `--from companies.txt --side` is noted as a follow-up — see Deferred), file contracts (Tasks 4–7), separate `following.json` (Task 4), reuse of pacing/daily-cap (Tasks 1, 6), error handling: skip-on-failure + resumable + not-logged-in (Tasks 5–6), testing of pure logic (Tasks 1–4). Covered.
- **Deferred from spec (intentional, low-risk):** `enrich --from companies.txt --side following|followers` company-graph sourcing is not in these tasks — `--handles` and `following.json` sources are. Add as a follow-up task before first real company run; it reuses the same `scrapeVisibleCells` + enrich loop pointed at `https://x.com/<company>/following`.
- **Type consistency:** `Profile` (Task 6) is extended by `Candidate` (Task 7); `matchRole` returns `{confidence, matchedKeywords}` used identically in enrich and filter; `BurstScheduler`/`applyDelay` signatures match between `pacing.ts` (Task 1) and enrich (Task 6). Consistent.

## Deferred / Follow-ups (not in this plan)

- `enrich --from companies.txt --side following|followers` (company-graph sourcing).
- `dm-bot.ts` (Plan 2) — sends `messages.json`, depends on `pacing.ts` and `candidates.json`.
