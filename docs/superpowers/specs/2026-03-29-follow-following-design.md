# Follow-Following Feature Design

**Date**: 2026-03-29
**Status**: Approved

## Overview

Add the ability to follow people from a target account's "following" page (who they follow), extending the existing follow bot which currently only works with a target's "followers" page. This enables both feed curation (mirroring a curator's taste) and growth (mutual follow potential).

## CLI Interface

```
npm run follow -- @target                         # Existing: follow from followers page
npm run follow -- @target --following             # New: follow from following page
npm run follow -- @target --tech-only             # New: follow only tech accounts (followers page)
npm run follow -- @target --following --tech-only # New: follow only tech accounts (following page)
```

Flag parsing extracts `--following` and `--tech-only` from `process.argv`, applied to either mode.

## Architecture: Refactored Follow Engine

### Current State

The `follow()` function in `follow-bot.ts` contains a ~140-line follow loop (lines 163-301) that handles card extraction, skip checks, clicking, rate limiting, scrolling, and logging. This loop is tightly coupled to the "followers" URL.

### Target State

Extract the follow loop into a reusable `followFromPage(options)` function. The existing `follow()` and new follow-following mode become thin wrappers that configure and call the engine.

### New Types

```typescript
interface FollowEngineOptions {
  page: Page;
  target: string;
  pageUrl: string;         // "https://x.com/{target}/followers" or "/following"
  cardLabel: string;       // "followers" or "following" — for log messages
  bioFilter?: (bio: string) => boolean;  // optional filter function
  source: "followers" | "following";     // for FollowRecord logging
}
```

### Updated FollowRecord

```typescript
interface FollowRecord {
  username: string;
  target: string;
  source: "followers" | "following";  // NEW: tracks which page sourced the follow
  timestamp: string;
}
```

Backwards-compatible — existing records without `source` still parse correctly. The `followedSet` skip check only uses `username`, so deduplication is unaffected.

### File Structure (follow-bot.ts)

```
Configuration constants      (unchanged)
Types                         (FollowRecord updated, FollowEngineOptions added)
Helpers                       (unchanged: waitForEnter, randomDelay, loadLog, saveLog, dismissPopups)
launchBrowser()               (unchanged)
login()                       (unchanged)
extractBio(cell)              (NEW: extracts bio text from a user card)
matchesTechKeywords(bio)      (NEW: checks bio against ~70 keyword list)
TECH_KEYWORDS                 (NEW: keyword array, copied from unfollow-bot.ts)
followFromPage(options)       (NEW: extracted follow engine — contains the full loop)
follow()                      (refactored: parses CLI flags, builds options, calls followFromPage)
Main CLI parser               (updated: routes to follow() which handles both modes)
```

## Bio Extraction & Tech Filtering

### extractBio(cell)

Extracts bio text from a user card element. Uses the same approach as `unfollow-bot.ts`:

1. Try structured selector: `[data-testid="UserCell"] > div > div:last-child`
2. Fallback: parse full cell text
3. Truncate to 200 characters

### matchesTechKeywords(bio)

Checks bio against ~70 tech keywords (same list used in `unfollow-bot.ts`):
- Roles: developer, engineer, programmer, coder, software, devrel, devops
- Domains: web3, crypto, blockchain, AI, ML, cybersecurity, data science
- Tech: JavaScript, Python, React, Docker, Kubernetes, AWS, etc.
- Startup: founder, startup, SAAS, YC, indie hacker

Returns `true` if any keyword matches (case-insensitive substring match).

### Integration

When `--tech-only` is passed, the engine wraps `matchesTechKeywords` as the `bioFilter` option. Inside the follow loop, after existing skip checks (already-followed, already-following button state), the engine calls:

```typescript
if (options.bioFilter) {
  const bio = await extractBio(cell);
  if (!options.bioFilter(bio)) {
    console.log(`  Skipping @${username} (bio doesn't match filter)`);
    continue;
  }
}
```

## Shared State

All state is shared between both modes:
- **follow-log.json**: Single log file, both modes write to it
- **Rate limit tracking**: Same thresholds, same counters
- **MAX_FOLLOWS**: Same 150 cap per session regardless of mode
- **followedSet**: Same deduplication set — if you followed someone via "followers" mode, they won't be re-followed via "following" mode

## Rate Limit Handling

Unchanged behavior, with one fix: after a rate-limit cooldown, the page reload URL uses `options.pageUrl` instead of the hardcoded followers URL. This ensures the engine reloads whichever page it was operating on.

## Edge Cases

1. **Empty following list**: Engine detects no cards via `waitForSelector` timeout, exits with clear message.
2. **Private accounts**: X shows a message instead of cards. Same timeout handling as above.
3. **--tech-only with no matches**: Engine scrolls through entire list, follows nobody. Final message: "No accounts matched the tech filter. 0 follows."
4. **Stale handles after reload**: Existing fix (break inner loop after reload) carries over via the engine.

## Scope

- **Modified file**: `follow-bot.ts` only
- **No new npm scripts**: The `--following` flag is parsed from existing `npm run follow` args
- **No new dependencies**: Uses existing Playwright and fs/path modules
- **Backwards compatible**: Existing `npm run follow -- @target` works identically
