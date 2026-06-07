# Outreach Profiles & DM Pipeline — Design

**Date:** 2026-06-07
**Status:** Approved (design); pending implementation plan

## Purpose

Extend the X automation toolkit to support job-hunting outreach. We need to:

1. Keep a current, canonical list of who we follow on X (the existing
   `follow-log.json` only records accounts the *bot* followed, not manual or
   pre-bot follows).
2. Build deep profiles of candidate people — decision makers at companies —
   rich enough for a separate AI to draft personalized cold/warm DMs.
3. Send those AI-drafted DMs safely, respecting X's constraints and our own
   guardrails.

A separate AI (Claude) is responsible for drafting the DMs. Our scripts produce
the candidate data it needs and send the messages it returns. The DM-writing
step is out of scope for these scripts — it is a file handoff.

## Architecture

Two new command-line tools, plus one new shared module. Both tools reuse the
existing infrastructure: `launchBrowser` (persistent Chrome profile), the burst
scheduler, the daily cap, and the rate-limit cooldown/exit logic.

```
prospect.ts                              dm-bot.ts
 ├─ sync    → following.json              └─ send  → reads messages.json
 ├─ enrich  → profiles.json                          writes dm-log.json
 ├─ filter  → candidates.json
 └─ prepare → runs sync→enrich→filter
                    │
         (writer AI reads candidates.json,
          writes messages.json)
```

- `prospect.ts` — read-only scraping: fetch/sync, enrich, and filter. Produces
  `candidates.json`, the decision-maker shortlist.
- `dm-bot.ts` — the only tool that performs irreversible actions (sending DMs).
  Kept deliberately separate from the scraper.
- `role-filter.ts` — new shared module (sibling to `tech-filter.ts`) holding the
  decision-maker keyword sets and matcher.

Each stage reads one file and writes another, so every stage is independently
runnable and resumable, and the writer AI slots in as just another file
producer between `filter` and `send`.

### Reused existing code

- `launchBrowser` and the persistent `.chrome-profile` (no new auth).
- Burst scheduler + `MAX_FOLLOWS_PER_DAY`-style daily cap + rate-limit
  cooldown/`daily_cap`/`rate_limited` exit, so heavy scraping and DM sending
  stop cleanly and resume via the cron watchdog.
- Cell-parsing approach used by the follow bot for reading list rows.
- `tech-filter.ts` pattern for keyword matching (mirrored in `role-filter.ts`).

## Data Model / File Contracts

These files are the interfaces between stages. All are JSON, keyed/deduped by
handle.

| File | Written by | Shape |
|---|---|---|
| `following.json` | `sync` | `[{handle, name, bioSnippet, firstSeen, lastSynced, viaBot}]` — canonical set you follow |
| `profiles.json` | `enrich` | `[{handle, name, bio, followers, following, location, website, joined, verified, role, company, pinnedTweet, recentTweets[], enrichedAt}]` |
| `candidates.json` | `filter` | profile fields + `{roleConfidence: "strong" \| "review", matchedKeywords[]}` |
| `messages.json` | **writer AI** | `{ "handle": {tone: "cold" \| "warm", text} }` |
| `dm-log.json` | `send` | `[{handle, status, reason, timestamp, textHash}]` |

`dm-log.json` `status` is one of: `sent`, `skipped_no_open_dm`, `failed`,
`dry_run`.

Properties:

- `following.json` is keyed by handle and merged on each sync: new handles get
  `firstSeen`; matched handles get `lastSynced` refreshed; `viaBot` is true if
  the handle also appears in `follow-log.json`. Accounts since unfollowed are
  flagged by a stale `lastSynced`, not deleted.
- `dm-log.json` dedupes by handle so a re-run never double-DMs (idempotent, like
  `follow-log.json`). A `textHash` records which message was sent.
- `follow-log.json` is unchanged — it remains the bot's action log.

## Component: `prospect.ts`

### `prospect.ts sync`

Bring `following.json` up to date with who you actually follow on X.

- Navigate to `https://x.com/<you>/following`, scroll to the end, collect every
  handle, name, bio snippet, and verified badge from the list cells.
- Merge into `following.json` per the rules above.
- Pure scrolling/reading — no follow/unfollow actions — so low risk; still gated
  by burst-style scroll pacing.

### `prospect.ts enrich`

Turn handles into deep profiles.

- Input source (the "both/either" flexibility):
  - default: `following.json`
  - `--from companies.txt`: a list of company handles → pull *their* graph as
    candidates. `--side following|followers` (default `following`) selects which
    side to pull. This is a heuristic: companies often follow their own team and
    execs, so `following` tends to surface insiders, while `followers` is a much
    larger, noisier pool. The two-stage role filter does the actual
    decision-maker narrowing afterward.
  - `--handles @a,@b`: an explicit handle list
- For each not-yet-enriched handle: visit `x.com/<handle>` and scrape full bio,
  follower/following counts, location, website, join date, verified, pinned
  tweet, and ~5 recent tweets; parse `role` + `company` from the bio.
- Heavy scraping → reuses the burst scheduler + daily cap + rate-limit
  cooldowns. Writes incrementally to `profiles.json`; resumable (skips handles
  that already have an `enrichedAt`).

### `prospect.ts filter`

Produce the decision-maker shortlist.

- Uses `role-filter.ts`: keyword sets for exec / founder / hiring / recruiter /
  leadership titles.
- Two-stage:
  - strong title match → `roleConfidence: "strong"`
  - weaker/ambiguous signal → `roleConfidence: "review"`
  - clear non-match → dropped
- Writes `candidates.json` including `matchedKeywords` so the writer AI sees why
  each profile was kept.

### `prospect.ts prepare`

Convenience command: runs `sync` → `enrich` → `filter` in sequence.

## Component: `dm-bot.ts`

The only tool that performs irreversible actions. Safety-first by default.

### `dm-bot.ts send` — per-handle flow

For each handle in `messages.json`:

1. Skip if already in `dm-log.json` (idempotent — never double-DM).
2. **Open-DM check:** open the profile / compose view; if there is no Message
   affordance (DMs closed and not mutuals), log `skipped_no_open_dm` and move
   on — no wasted attempts.
3. **Validate:** message text non-empty and within X's DM length limit
   (~10,000 chars); handle exists in `candidates.json`.
4. **Send verbatim** (no template logic — the AI already personalized it),
   confirm it posted, log `sent` with a `textHash`.

### Safety model

- **Dry-run is the default.** Plain `dm-bot.ts send` simulates: it runs the
  open-DM check and logs `dry_run` for each, but sends nothing. Actually sending
  requires an explicit `--live` flag.
- **`--approve` interactive mode:** prints each recipient + message and waits
  for y/n before sending. For the first real runs.
- **Conservative daily cap** (`DM_MAX_PER_DAY`, default 30) — much lower than
  the follow cap because unsolicited DMs are flagged far faster. Reuses burst
  pacing + rate-limit cooldown.
- **`textHash` in the log** detects if the AI later revised a message, so an
  updated draft can be intentionally re-sent.

The default failure mode is "did nothing and told you what it would do." Live
sending is opt-in, and `--approve` adds a per-message gate on top.

## Error Handling

- **Missing selectors / DOM drift:** a single profile that fails to parse is
  logged and skipped — never crashes the batch. Partial scrapes store what was
  captured and null the rest rather than failing the whole profile.
- **Rate limits:** reuse the existing consecutive-failure → cooldown →
  `daily_cap`/`rate_limited` exit, so `enrich` and `send` stop cleanly and
  resume via cron/watchdog.
- **Not logged in:** clear "run `npm run login`" error (shared with existing
  bots).
- **Resumability:** every stage writes incrementally and dedupes by handle, so
  any stage can be re-run and picks up where it stopped.
- **Bad `messages.json`:** malformed entry, or handle missing from
  `candidates.json` → skip with a logged reason, keep going.

## Testing

The repo currently has no test framework.

- **Pure logic gets unit tests** via Node's built-in `node:test` + `tsx` (no new
  dependencies):
  - `role-filter.ts` matching (strong / review / drop)
  - `following.json` merge (firstSeen preserved, lastSynced updated, viaBot)
  - bio → role/company parsing against a saved fixture string
  - log dedupe (no double-DM, no double-enrich)
- **Browser scraping** is not unit-tested — it is verified through `--dry-run`
  and small live smoke runs.

This keeps testing focused on logic we can hold still, without pretending to
unit-test live X scraping.

## Out of Scope

- The DM-writing AI itself (it is a file handoff via `candidates.json` →
  `messages.json`).
- Unfollow handling for stale follows (we flag, not delete).
- Multi-account operation.

## NPM Scripts (proposed)

- `prospect:sync` → `tsx prospect.ts sync`
- `prospect:enrich` → `tsx prospect.ts enrich`
- `prospect:filter` → `tsx prospect.ts filter`
- `prospect:prepare` → `tsx prospect.ts prepare`
- `dm` → `tsx dm-bot.ts send` (dry-run by default; `--live` to send)
