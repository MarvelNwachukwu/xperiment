# 3. Read X's GraphQL feed for the unfollow scan (not the DOM)

Date: 2026-06-21
Status: Accepted

## Context

The unfollow scan reads every account you follow, classifies each bio, and
marks unfollow candidates. It does no writes, so it carries no follow-pacing
delay. Yet it is the slowest operation in the toolkit, and it gets worse the
more you follow.

The cause is how it reads. X virtualizes the Following list: only ~10-15 rows
sit in the DOM at any moment. To read the whole list the scan scrolls, waits a
fixed 5s for new rows (`SCROLL_WAIT_MS`), re-queries, and extracts each row with
~5-6 separate CDP round-trips. For an account that follows 100k, that is roughly
7,000-10,000 scroll batches. At 5s of waiting each, the scan spends 10-14 hours
just waiting before any per-row work. That does not scale to the "hundreds of
thousands" case the tool is meant to serve.

The rest of the toolkit scrapes the DOM (follow-bot, chain, prospect), so DOM
scraping is the house style. But for a read-only, list-the-whole-graph scan,
the DOM is the wrong source. The same data the page renders arrives first as
JSON from X's `Following` GraphQL endpoint: ~50-100 users per page, bio
(`description`) included, paged by a cursor. Reading that feed directly skips
the browser render, the virtualization, and the scroll wait entirely.

The trade-off is brittleness and exposure. The endpoint is internal and
undocumented: X rotates its query IDs and can change the response shape or the
required `features` blob without notice. It is the same data the logged-in
session is already entitled to (no new access, no second login, consistent with
ADR 0001), but calling it directly is a step beyond "render the page X gave
me." If X changes the feed, a DOM scan still works while an API scan breaks.

## Decision

Read the **Following GraphQL feed** for the unfollow scan, paginating by cursor,
instead of scrolling the DOM. To stay robust against X's rotations, **capture
the real request live** rather than hardcoding it: open the Following page once
in the existing logged-in browser, intercept the actual `Following` request to
grab its URL (current queryId), headers (bearer + `x-csrf-token`), and
variables/features, then loop with `context.request`, swapping only
`variables.cursor`.

Guardrails:
- **Header-aware pacing.** ~0.3-0.8s jitter between pages; read
  `x-rate-limit-remaining` and sleep until `x-rate-limit-reset` when it runs
  low; exponential backoff on 429.
- **Checkpoint + resume.** Persist the cursor and collected candidates so an
  interrupted run resumes instead of restarting.
- **Fail fast with an escape hatch.** If capture or parsing fails, stop with a
  clear message and point to a `--dom` flag that runs the existing scroll-scan.

Build it as a reusable module (`x-graph.ts`) and wire it into the unfollow scan
only. Follow and chain keep scrolling: they interleave writes and are gated by
the deliberate follow pacing, not scan speed, so an API read would not move
their wall-clock.

## Consequences

- **Minutes, not hours.** A 100k scan drops from 10-14 hours to roughly
  20-40 min, bounded by X's read rate limit rather than scroll waits.
- **Cleaner data.** Bios come straight from JSON, ending the brittle per-row DOM
  extraction (and its name/handle-stripping guesswork).
- **A new brittleness surface.** When X changes the feed, the scan breaks until
  the capture logic is updated. The `--dom` fallback keeps the feature usable
  (slowly) in the meantime; the fail-fast message makes the cause obvious.
- **Two read paths to maintain** (GraphQL primary, DOM fallback). The DOM path
  is deliberately left unoptimized: it is a rarely-hit emergency route, not
  worth tuning.
- **A precedent.** This is the first use of X's internal API in the codebase. A
  future contributor may extend it to follower/following crawls elsewhere; this
  ADR records that it was adopted narrowly, for a read-only scan where DOM
  scrolling could not scale, and not as a general replacement for DOM scraping.
