# Desktop App (normie-friendly wrapper) — Design

**Date:** 2026-06-19
**Status:** Approved (design); pending implementation plan
**Glossary:** see `CONTEXT.md` (User, Operator, Auth, App, Seed, Target Criteria, Message Template)

## Purpose

Package the existing CLI tool as a desktop app a **non-technical User** can run on their own machine to build a targeted list of X profiles and (optionally) DM them. First real User: builds a list of lawyers & legal entities in Nigeria. The product is distributed to many Users, each acting on **their own** X account.

## Decisions (resolved during grilling)

| # | Decision | Choice |
|---|---|---|
| 1 | Audience | Distributed product for other Users (not just the Operator) |
| 2 | Execution/auth model | **Local app, bring-your-own-login.** No server, no hosted browser farm. |
| 3 | Shell | **Tauri** (Rust + OS webview) with the existing Node/Playwright code as a **sidecar** |
| 4 | Browser | **Bundle Playwright's Chromium** (option b) — works with zero prerequisites |
| 5 | Auth UX | **Connect X** button → opens the bundled browser to `x.com/login` → User logs in (incl. 2FA) → session saved locally. Nothing leaves the device. |
| 6 | Discovery source | **Seed-graph crawl** (reuse). X keyword-search = deferred fallback. |
| 7 | Filter | **Target Criteria** — free-text who/where keywords through the existing word-boundary matcher. No presets, no LLM. |
| 8 | Output | **Both**: CSV export (primary) + in-app DM (phase 2) |
| 9 | DM authoring | **Message Template** with `{variables}`, filled per profile → existing `dm-bot`. AI-personalize deferred. |
| 10 | Write scope | **DM only.** `follow`/`chain`/`unfollow` stay in the repo, NOT wired into the app. |

## Architecture

The App is **glue**, not a rewrite. The existing Node tools already: take config, drive Chrome via Playwright, and write output JSON (`output/*.json`). The Tauri app drives them.

```
Tauri (Rust shell + webview UI)
   │  spawn sidecar + stream stdout (progress)
   ▼
Node sidecar  ── reuses ──▶ browser.ts (acquireBrowser, bundled Chromium)
   prospect (sync/enrich/filter)        prospect/* , following-store, profile-parse
   dm-bot (send, dry-run default)       dm-bot, dm-store, write-lock
   │  reads/writes
   ▼
output/  following.json · profiles.json · candidates.json · messages.json · dm-log.json
```

- **UI ↔ automation:** the app spawns the existing commands as a sidecar and streams their **stdout** (they already `console.log` progress) into the UI; results are read back from `output/*.json`. No new IPC protocol, no rewrite of the engines.
- **Browser:** `acquireBrowser` already centralizes launch; point it at the bundled Chromium (ship Playwright's Chromium with the app) instead of `channel:"chrome"`.
- **Auth:** Connect X reuses the existing `login` flow (open browser → user logs in → persistent profile saved under the app's data dir).

```
// ponytail: the app is a thin shell over commands that already exist and already
//           write their results to disk. New backend logic is minimal (below).
```

## New code (everything else is reused)

1. **Target Criteria filter.** Generalize the `prospect filter` step (and enrich's role tag) to accept User-supplied **who** + optional **where** keyword lists instead of the hardcoded `role-filter`/`tech-filter` arrays. Reuse the existing word-boundary matcher (`escapeRegExp` + lookbehind/lookahead). Match rule: bio matches a *who* keyword AND (if *where* given) the scraped `location`/bio matches a *where* keyword.
2. **CSV export.** Dump `candidates.json` → CSV (handle, name, bio, location, link, matched keywords). Stdlib string join; no library.
3. **Template filler.** Fill the Message Template per candidate → write the `messages.json` (`{handle: {tone, text}}`) that `dm-bot` already consumes.
4. **Tauri app.** Rust shell + webview screens (below); spawn/stream sidecar; render `output/*.json`.
5. **Packaging.** Bundle Node + the JS + Playwright's Chromium as the sidecar; per-OS installers.

Reused unchanged: `browser.ts`, `pacing.ts`, `write-lock.ts`, `prospect` sync/enrich, `following-store`, `profile-parse`, `dm-bot`/`dm-store`, the burst pacing + daily caps + dry-run safety.

## Screens (v1, minimal)

1. **Connect X** — one button → login window → "Connected as @her".
2. **Define** — Seeds (a few @handles) + Target Criteria (*Looking for* keywords, *Location* optional).
3. **Run** — kicks off sync/enrich/filter against the seeds; live progress from sidecar stdout (e.g. "enriched 120 / found 18 matches").
4. **Results** — table of matched profiles; **Export CSV** button.
5. **Outreach (phase 2)** — write a Message Template; **Dry-run** (default) shows who'd be messaged + who's skipped (closed DMs); explicit **Send** with the 30/day cap and per-message preview.

## Safety (non-negotiable, write side)

DM is a write on the User's account. Carry the existing `dm-bot` guards into the UI, **on by default**:
- Dry-run is the default; sending requires an explicit, clearly-labelled action.
- 30 DMs/day cap; closed-DM profiles auto-skipped (`skipped_no_open_dm`).
- Read-only list-building (sync/enrich/filter) needs login but takes **no write actions** → low ban risk; it is Phase 1 and ships first.

## Delivery order

- **Phase 1 — list-building (read-only):** Connect X → seeds + Target Criteria → crawl/enrich/filter → CSV export. Delivers the first User's full stated goal with zero write risk.
- **Phase 2 — DM:** Message Template → `dm-bot` send with guards.

## Out of scope / deferred

- X keyword-search discovery (fallback only if seeds can't fill a list).
- LLM personalization / classification (optional later toggle; needs API key + cost).
- `follow`/`chain`/`unfollow` in the app surface (remain CLI-only).
- Hosted/multi-tenant anything — there is deliberately no server.

## Open risks (flag, not blockers)

- **App distribution friction:** code-signing / notarization (macOS Gatekeeper, Windows SmartScreen). Unsigned = scary warnings for a normie. Resolve before wide distribution; for the first User a one-time "allow" is acceptable. `ponytail: notarize when distributing past user #1.`
- **X ToS / account safety:** automating a real account always carries ban risk; the read-only Phase 1 minimizes it; the pacing/caps mitigate Phase 2.
- **Bundled-Chromium size (~190 MB):** accepted for "just works"; an "use my installed Chrome (lite, ~50 MB)" toggle is a future option if size becomes real feedback.
