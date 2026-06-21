# Fast Unfollow Scan (GraphQL feed) — Design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan
**Builds on:** the unfollow bot (`unfollow-bot.ts`), the shared browser
(`browser.ts`), and the criteria/tech filters. Decision recorded in
[ADR 0003](../../adr/0003-graphql-feed-for-scans.md). Glossary in `CONTEXT.md`.

## Purpose

Make the unfollow scan scale to accounts that follow hundreds of thousands.
Today the scan scrolls the virtualized Following list and waits a fixed 5s per
scroll, so a 100k account spends 10-14 hours just waiting. Replace the DOM
scroll-scan with a direct read of X's `Following` GraphQL feed (JSON, cursor
paged), bringing a 100k scan down to roughly 20-40 min. Behavior, output format,
and the review/unfollow step are unchanged; only the scan's data source changes.

## Decisions (from grilling)

| Area | Decision |
|---|---|
| Data source | Read X's **Following GraphQL feed** (JSON + cursor), not the DOM |
| Auth | **Capture the real request live** from the logged-in browser; replay with the cursor swapped. Nothing hardcoded. |
| Pacing | **Header-aware**: ~0.3-0.8s jitter/page; sleep to `x-rate-limit-reset` when `remaining` is low; backoff on 429 |
| Resume | **Checkpoint** cursor + collected candidates; resume an interrupted run |
| Fallback | **Fail fast** with a clear message; keep a `--dom` flag for the old scroll-scan (left unoptimized) |
| Scope | Reusable **`x-graph.ts`** module, wired into unfollow scan only. Follow/chain unchanged (write-paced, not scan-bound). |

## Architecture

A new module owns talking to the feed; `unfollow-bot.ts` owns classification,
state, and output (as it does now).

```
x-graph.ts            read a user's Following feed as JSON
  captureFollowing()    open /following once, intercept the real request
  fetchFollowingPage()  replay with a cursor, parse one page, read rate-limit
  (types: CapturedReq, XUser, FollowingPage)
unfollow-bot.ts       scan(): drive the feed, classify, checkpoint, write
output/
  unfollow-scan-state.json   { capturedAt, cursor, scanned, done }   (new)
  unfollow-candidates.json   unchanged shape (GUI + unfollow read it)
```

### Capture (once per scan)

We already drive a persistent, logged-in browser via `acquireBrowser()`. Open
the signed-in user's `/following` page (reuse the existing profile-link logic to
find our own handle). Attach `page.on("request")` and wait for the request whose
URL contains the `Following` GraphQL operation. From it capture:

- `url` (carries the current rotating queryId),
- request `headers` (the web `authorization` bearer + `x-csrf-token`),
- the `variables` and `features` JSON from the query string.

`CapturedReq = { url, headers, variables, features }`. If no such request is
seen within a timeout (~15s), throw a typed capture error (the caller turns this
into the fail-fast message).

### Paginate (the loop)

`fetchFollowingPage(context, captured, cursor)` issues the request via
`context.request.get(...)` (BrowserContext.request reuses the context's cookie
jar; the captured headers supply the bearer + csrf), with
`variables.cursor = cursor`. It parses the response into:

```
XUser = { username, displayName, bio }
FollowingPage = {
  users: XUser[],
  nextCursor: string | null,     // null when the feed is exhausted
  rateLimit: { remaining: number, reset: number }   // from x-rate-limit-* headers
}
```

Parsing walks the documented-by-inspection shape:
`data.user.result.timeline.timeline.instructions[]` →
`TimelineAddEntries.entries[]`; user entries at
`content.itemContent.user_results.result.legacy.{screen_name, name, description}`;
the bottom cursor at the `TimelineTimelineCursor` entry with
`cursorType === "Bottom"`. Exact paths are verified against a real response
during implementation and pinned behind the parse function (the only place that
knows X's shape).

The scan loop:

```
state = loadScanState() ?? { cursor: null, scanned: [], done: false }
captured = await captureFollowing(page, selfHandle)   // fail-fast on error
while (!state.done) {
  page = await fetchFollowingPage(context, captured, state.cursor)
  for (u of page.users) classify(u) -> ScanResult, push to state.scanned
  state.cursor = page.nextCursor
  if (page.nextCursor === null) state.done = true
  saveScanState(state)                                 // checkpoint each page
  await pace(page.rateLimit)                            // see below
}
writeCandidates(state.scanned)                          // existing format
```

Classification reuses the current `classifyBio(bio, keywords)` and the
`--keywords` / blank-default rules (ADR-free, unchanged from today): with custom
keywords, matching bios are flagged; blank flags non-tech.

### Pacing and rate limits

`pace(rateLimit)`:
- Always sleep a small jittered delay (~0.3-0.8s) between pages.
- If `rateLimit.remaining` is low (e.g. `< 5`), sleep until
  `rateLimit.reset` (epoch seconds), plus a small margin.
- On HTTP 429, exponential backoff (e.g. 2s, 4s, 8s, capped) honoring `reset`
  when present, then retry the same cursor.

This keeps the scan inside X's read window without a 5s-per-page tax. A 100k
scan is bounded by the rate limit (~minutes), not by waiting.

### Checkpoint and resume

`unfollow-scan-state.json` holds `{ capturedAt, cursor, scanned, done }`, written
after every page. On restart, if the file exists and `done` is false, resume from
`cursor` and keep `scanned` (re-capture the request fresh, since headers/queryId
may have rotated). On `done`, write `unfollow-candidates.json` and clear the
state file. The GUI Stop button kills the process mid-loop; the next Scan resumes.

### Fallback

A `--dom` flag (and the in-process auto-path on a typed capture/parse failure is
**not** taken; we fail fast instead) runs the existing scroll-scan unchanged.
When the GraphQL path throws a capture/parse error, the scan stops and prints a
clear line: `Couldn't read X's Following feed (it may have changed). Retry, or
run with --dom for the slower scroll scan.` The DOM scan is intentionally left
as-is (a rarely-hit emergency route, not worth optimizing).

## GUI impact

Minimal. The Unfollow panel's **Scan following** button and the keep/flag review
table are unchanged; they still read `unfollow-candidates.json` after the run.
The live log gains the feed's running count and any rate-limit sleep notices
(e.g. `scanned 4,300 … rate limit low, sleeping 38s`). No new controls. The
`--keywords` field already added is unaffected. (`--dom` is CLI-only; not exposed
in the GUI, consistent with keeping footguns out of the UI.)

## Error handling

- **Not logged in / capture timeout:** fail fast with the message above; suggest
  `--dom`. (Reuses the existing not-logged-in check before capture.)
- **429 / rate limited:** backoff and retry the same cursor (not an error).
- **Malformed page (shape changed):** typed parse error, treated like capture
  failure (fail fast + `--dom`).
- **Stop mid-scan:** state is checkpointed per page, so nothing is lost.

## Testing

- **Unit (pure):** the response parser against a saved sample JSON page
  (users extracted, bottom cursor found, empty/last-page returns `nextCursor:
  null`). The pacing decision (`pace`) against synthetic rate-limit inputs
  (low-remaining sleeps to reset; normal applies jitter only). `classifyBio`
  is already covered.
- **Smoke (operator, at a logged-in session):** scan a real account, confirm the
  candidate list matches expectation and the run finishes in minutes; kill
  mid-scan and confirm resume; force a parse failure and confirm the fail-fast
  message and `--dom` path.

## Out of scope

- Optimizing the `--dom` fallback scroll-scan.
- Reworking follow/chain to read via the API (write-paced, not scan-bound).
- Exposing `--dom` or any raw API control in the GUI.
- Any new login or access scope (same session entitlement as today, per
  ADR 0001).
