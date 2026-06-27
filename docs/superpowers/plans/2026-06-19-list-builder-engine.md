# List-Builder Engine (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the read-only list-building backend the desktop app needs — crawl a Seed's follow graph, filter by free-text Target Criteria, export CSV — all in the existing Node repo, drivable from the CLI today.

**Architecture:** Two new pure modules (`criteria-filter.ts`, `csv.ts`) plus three new `prospect.ts` subcommands (`crawl`, criteria-aware `filter`, `export-csv`) that reuse the existing scrape/enrich/merge machinery. No Tauri here — this is the engine the Tauri app (separate plan) will spawn.

**Tech Stack:** TypeScript via `tsx`, Playwright (existing), Node's built-in `node:test`. No new dependencies.

## Global Constraints

- No new npm dependencies (stdlib + existing Playwright/tsx only).
- Tests: `npx tsx --test <file>.test.ts`. Type-check: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck <files> 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"` → expect empty.
- Output files live under `output/` (paths come from `config.ts`).
- Reuse the existing word-boundary matcher pattern from `role-filter.ts`/`tech-filter.ts` (`escapeRegExp` + lookbehind/lookahead) — do not invent a new matching engine.
- Scope: read-only. No follow/DM. (DM is a later plan.)

## Spec reference

`docs/superpowers/specs/2026-06-19-desktop-app-design.md` (Phase 1) and `CONTEXT.md` (`Seed`, `Target Criteria`).

## File Structure

| File | Responsibility |
|---|---|
| `criteria-filter.ts` (new) | `matchCriteria(text, who[], where[])` — free-text Target Criteria matcher. |
| `criteria-filter.test.ts` (new) | Unit tests for `matchCriteria`. |
| `csv.ts` (new) | `toCsv(rows, columns)` — RFC-ish CSV with quoting. |
| `csv.test.ts` (new) | Unit tests for `toCsv`. |
| `prospect.ts` (modify) | Add `crawl` (Seed graph → following.json), criteria-aware `filter`, `export-csv`; wire CLI. |
| `README.md` (modify) | Document the list-builder commands. |

---

## Task 1: `criteria-filter.ts` — free-text Target Criteria matcher

**Files:** Create `criteria-filter.ts`, `criteria-filter.test.ts`.

**Interfaces:**
- Produces: `matchCriteria(text: string, who: string[], where: string[]): { matched: boolean; matchedKeywords: string[] }`. Match rule: text matches at least one `who` keyword AND (if `where` is non-empty) at least one `where` keyword. Matching is word-boundary, case-insensitive. `matchedKeywords` = the `who` keywords that hit.

- [ ] **Step 1: Write the failing test — create `criteria-filter.test.ts`:**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCriteria } from "./criteria-filter";

const who = ["lawyer", "attorney", "barrister", "SAN"];
const where = ["nigeria", "lagos", "abuja"];

test("who + where both present -> matched", () => {
  const r = matchCriteria("Corporate lawyer based in Lagos.", who, where);
  assert.equal(r.matched, true);
  assert.deepEqual(r.matchedKeywords, ["lawyer"]);
});

test("who present, where required but missing -> not matched", () => {
  assert.equal(matchCriteria("Corporate lawyer in London.", who, where).matched, false);
});

test("no who keyword -> not matched", () => {
  const r = matchCriteria("Lagos-based chef and foodie.", who, where);
  assert.equal(r.matched, false);
  assert.deepEqual(r.matchedKeywords, []);
});

test("empty where -> location not required", () => {
  assert.equal(matchCriteria("Barrister. Opinions mine.", who, []).matched, true);
});

test("word-boundary: 'law' does not match inside 'lawnmower'", () => {
  assert.equal(matchCriteria("I sell a lawnmower in Lagos.", ["law"], where).matched, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test criteria-filter.test.ts`
Expected: FAIL — `Cannot find module './criteria-filter'`.

- [ ] **Step 3: Write minimal implementation — create `criteria-filter.ts`:**

```typescript
// Free-text Target Criteria matcher. Same word-boundary approach as
// role-filter.ts / tech-filter.ts, but the keyword lists come from the User.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns the subset of `words` that appear in `text` as whole words.
function hits(text: string, words: string[]): string[] {
  return words
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .filter((w) => new RegExp(`(?<![\\w])${escapeRegExp(w)}(?![\\w])`, "i").test(text));
}

export interface CriteriaMatch {
  matched: boolean;
  matchedKeywords: string[];
}

// text matches if it contains a `who` keyword AND (when `where` is non-empty)
// a `where` keyword. matchedKeywords = the who-keywords that hit.
export function matchCriteria(text: string, who: string[], where: string[]): CriteriaMatch {
  const whoHits = hits(text, who);
  if (whoHits.length === 0) return { matched: false, matchedKeywords: [] };
  if (where.filter((w) => w.trim()).length > 0 && hits(text, where).length === 0) {
    return { matched: false, matchedKeywords: [] };
  }
  return { matched: true, matchedKeywords: whoHits };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test criteria-filter.test.ts`
Expected: PASS — `pass 5`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add criteria-filter.ts criteria-filter.test.ts
git commit -m "feat: criteria-filter — free-text who/where Target Criteria matcher"
```

---

## Task 2: `csv.ts` — CSV serializer

**Files:** Create `csv.ts`, `csv.test.ts`.

**Interfaces:**
- Produces: `toCsv(rows: Record<string, unknown>[], columns: string[]): string`. Header row = columns; one row per record; cells quoted when they contain `"`, `,`, or newline; `"` doubled; `null`/`undefined` → empty. Arrays stringify via `String()` (comma-joined → therefore quoted).

- [ ] **Step 1: Write the failing test — create `csv.test.ts`:**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "./csv";

test("header only when no rows", () => {
  assert.equal(toCsv([], ["handle", "name"]), "handle,name");
});

test("quotes cells with comma, quote, or newline", () => {
  const rows = [{ a: "plain", b: "has,comma", c: 'has"quote', d: "line\nbreak" }];
  assert.equal(
    toCsv(rows, ["a", "b", "c", "d"]),
    'a,b,c,d\nplain,"has,comma","has""quote","line\nbreak"'
  );
});

test("null/undefined become empty; arrays stringify (and get quoted)", () => {
  const rows = [{ handle: "x", kw: ["lawyer", "SAN"], loc: null }];
  assert.equal(toCsv(rows, ["handle", "kw", "loc"]), 'handle,kw,loc\nx,"lawyer,SAN",');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test csv.test.ts`
Expected: FAIL — `Cannot find module './csv'`.

- [ ] **Step 3: Write minimal implementation — create `csv.ts`:**

```typescript
// Minimal CSV serializer. ponytail: no library — quoting is the only real rule.

function cell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map(cell).join(",");
  const body = rows.map((r) => columns.map((c) => cell(r[c])).join(",")).join("\n");
  return body ? `${header}\n${body}` : header;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test csv.test.ts`
Expected: PASS — `pass 3`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add csv.ts csv.test.ts
git commit -m "feat: csv — minimal CSV serializer with quoting"
```

---

## Task 3: `prospect crawl` — discover candidates from a Seed's graph

**Files:** Modify `prospect.ts`. Browser-driven — type-check + smoke (no unit test).

**Interfaces:**
- Consumes: existing `scrapeVisibleCells(page)`, `acquireBrowser()`, `loadFollowing`/`saveFollowing`/`mergeFollowing`, `SCROLL_WAIT_MS`.
- Produces: `crawl()` writing discovered handles into `following.json` (so the existing `enrich` picks them up). CLI: `prospect crawl @seed [--side following|followers]`.

This is `sync()` pointed at a Seed's followers/following instead of your own, with `viaBot=false` (empty bot set). Everything downstream (`enrich`, `filter`) is unchanged.

- [ ] **Step 1: Add the `crawl` function to `prospect.ts`** (place after `sync`):

```typescript
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
```

- [ ] **Step 2: Wire it into the CLI** — change the dispatch block:

```typescript
  if (command === "sync") run(sync);
  else if (command === "crawl") run(crawl);
  else if (command === "enrich") run(enrich);
  else if (command === "filter") run(filter);
  else if (command === "prepare") run(prepare);
  else {
    console.error("Usage: tsx prospect.ts <sync|crawl|enrich|filter|prepare|export-csv>");
    process.exit(1);
  }
```
(Leave room for `export-csv` added in Task 5; this usage string mentions it.)

- [ ] **Step 3: Verify type-check**

Run: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck prospect.ts config.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"`
Expected: no output.

- [ ] **Step 4: Smoke test — SKIP here (deferred to user; needs a logged-in browser).** Note in your report it's deferred.

- [ ] **Step 5: Commit**

```bash
git add prospect.ts
git commit -m "feat: prospect crawl — discover candidates from a seed's follow graph"
```

---

## Task 4: criteria-aware `filter`

**Files:** Modify `prospect.ts`.

**Interfaces:**
- Consumes: `matchCriteria` (Task 1), existing `matchRole`, `loadProfiles`, `CANDIDATES_FILE`, `Candidate`.
- Produces: `filter()` that, when given `--who`/`--where`, filters by Target Criteria; with no `--who`, keeps the existing `matchRole` behavior. CLI: `prospect filter [--who "a,b" --where "x,y"]`.

- [ ] **Step 1: Add the import** at the top of `prospect.ts`:

```typescript
import { matchCriteria } from "./criteria-filter";
```

- [ ] **Step 2: Replace the `filter` function** with:

```typescript
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
```

- [ ] **Step 3: Verify type-check**

Run: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck prospect.ts criteria-filter.ts config.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"`
Expected: no output.

- [ ] **Step 4: Smoke-check the logic without a browser** — `filter` reads `output/profiles.json`, so it runs offline. Create a tiny fixture and run it:

```bash
mkdir -p output && cat > output/profiles.json <<'JSON'
[{"handle":"a","name":"A","bio":"Corporate lawyer in Lagos","followers":10,"following":1,"location":"Lagos, Nigeria","website":null,"joined":null,"verified":false,"roleConfidence":null,"matchedKeywords":[],"company":null,"pinnedTweet":null,"recentTweets":[],"enrichedAt":"2026-06-19T00:00:00.000Z"},
{"handle":"b","name":"B","bio":"Chef and foodie","followers":5,"following":1,"location":"Lagos","website":null,"joined":null,"verified":false,"roleConfidence":null,"matchedKeywords":[],"company":null,"pinnedTweet":null,"recentTweets":[],"enrichedAt":"2026-06-19T00:00:00.000Z"}]
JSON
npx tsx prospect.ts filter --who "lawyer,attorney,SAN" --where "nigeria,lagos"
python3 -c "import json;d=json.load(open('output/candidates.json'));print([c['handle'] for c in d])"
```
Expected: `Filtered 2 profiles -> 1 candidates [criteria(...)]` and `['a']`. Then clean up: `rm output/profiles.json output/candidates.json`.

- [ ] **Step 5: Commit**

```bash
git add prospect.ts
git commit -m "feat: prospect filter accepts free-text --who/--where Target Criteria"
```

---

## Task 5: `export-csv`

**Files:** Modify `prospect.ts`.

**Interfaces:**
- Consumes: `toCsv` (Task 2), `CANDIDATES_FILE`.
- Produces: `exportCsv()` writing `candidates.csv` next to `candidates.json`. CLI: `prospect export-csv`.

- [ ] **Step 1: Add the import** at the top of `prospect.ts`:

```typescript
import { toCsv } from "./csv";
```

- [ ] **Step 2: Add the `exportCsv` function** (after `filter`):

```typescript
async function exportCsv(): Promise<void> {
  if (!fs.existsSync(CANDIDATES_FILE)) {
    console.error("No candidates.json — run `filter` first.");
    process.exit(1);
  }
  const candidates = JSON.parse(fs.readFileSync(CANDIDATES_FILE, "utf-8"));
  const columns = ["handle", "name", "location", "followers", "website", "matchedKeywords", "bio"];
  const csv = toCsv(candidates, columns);
  const outFile = CANDIDATES_FILE.replace(/\.json$/, ".csv");
  fs.writeFileSync(outFile, csv);
  console.log(`Wrote ${candidates.length} rows to ${outFile}`);
}
```

- [ ] **Step 3: Wire into the CLI** — add the branch:

```typescript
  else if (command === "export-csv") run(exportCsv);
```
(immediately before the final `else { console.error(...) }`.)

- [ ] **Step 4: Verify type-check + offline smoke**

Type-check: `npx tsc --noEmit --lib es2022 --target es2022 --module esnext --moduleResolution bundler --skipLibCheck prospect.ts csv.ts config.ts 2>&1 | grep -viE "Cannot find (module|name)|namespace 'NodeJS'|requires the 'Promise'|does not exist on type 'string|change your target library|'Promise' only refers"` → expect empty.

Offline smoke:
```bash
mkdir -p output && cat > output/candidates.json <<'JSON'
[{"handle":"a","name":"A, Esq","location":"Lagos","followers":10,"website":null,"matchedKeywords":["lawyer"],"bio":"Corporate lawyer"}]
JSON
npx tsx prospect.ts export-csv && cat output/candidates.csv
rm output/candidates.json output/candidates.csv
```
Expected: a CSV with a header and one row; `"A, Esq"` quoted.

- [ ] **Step 5: Commit**

```bash
git add prospect.ts
git commit -m "feat: prospect export-csv — write candidates.csv"
```

---

## Task 6: README + full test run

**Files:** Modify `README.md`.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all `*.test.ts` pass, `fail 0` (now includes `criteria-filter.test.ts` + `csv.test.ts`). Paste counts. If anything fails, STOP and report.

- [ ] **Step 2: Add a README subsection** under the Outreach Profiles section titled `### Building a niche list (any topic)`, documenting the read-only flow in the existing plain tone:
- `npm run login` once.
- `npx tsx prospect.ts crawl @SeedAccount --side followers` (repeat for a few seeds) → fills `output/following.json`.
- `npm run prospect:enrich` → deep profiles.
- `npx tsx prospect.ts filter --who "lawyer,attorney,barrister,SAN" --where "nigeria,lagos,abuja"` → `output/candidates.json`.
- `npx tsx prospect.ts export-csv` → `output/candidates.csv`.
- Note: `--who` is required for Target Criteria mode; omitting it falls back to the built-in decision-maker role filter. `--where` is optional.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: niche list-building flow (crawl/filter/export-csv)"
```

---

## Self-Review

- **Spec coverage (Phase 1):** Seed-graph discovery → Task 3 (`crawl`); Target Criteria free-text filter → Tasks 1 + 4; CSV export → Tasks 2 + 5. Enrich/sync reused unchanged. The Tauri app, bundled-Chromium packaging, Connect-X UI, and DM (Phase 2) are explicitly **out of this plan** (separate plans). No Phase-1 engine requirement is uncovered.
- **Placeholder scan:** none — new files have complete code; `prospect.ts` edits give exact functions and the exact CLI dispatch block.
- **Type consistency:** `matchCriteria(text, who[], where[]) -> {matched, matchedKeywords}` defined in Task 1, consumed in Task 4; `toCsv(rows, columns)` defined in Task 2, consumed in Task 5; `Candidate`/`CANDIDATES_FILE`/`loadProfiles`/`scrapeVisibleCells`/`mergeFollowing` are existing symbols used as-is. `roleConfidence:"strong"` in criteria mode is a documented (ponytail-commented) reuse of the existing union, not a new type.

## Next plans (not in scope here)

- **Plan 2 — Tauri app (Phase 1 UI):** scaffold Tauri, bundle Node+Playwright Chromium as sidecar (ADR 0002), Connect-X login (ADR 0001), screens (Connect → Define seeds+criteria → Run/progress from sidecar stdout → Results table + Export CSV).
- **Plan 3 — DM (Phase 2):** Message Template fill → `messages.json` → existing `dm-bot` with dry-run/cap/closed-DM guards, surfaced in the UI.
