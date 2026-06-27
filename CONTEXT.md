# Context Glossary

The shared language for this project. Definitions only — no implementation details.

## Terms

### User
An end-user who runs the tool's outreach on **their own X account** — not the
operator. The product (B) is meant to be distributed to Users who are
non-technical ("normie friendly"). Each User authenticates as themselves; the
tool acts as that User on X.

### Operator
The person who builds/distributes the tool (currently: Marvel). Distinct from a
User. In the original CLI, Operator and User were the same person; in the
distributed product they are not.

### Auth (the User's auth)
What lets the tool act on X **as a specific User**. **Resolved (distributed
product):** local bring-your-own-login. The User clicks **Connect X**, a browser
window opens to `x.com/login`, the User logs in themselves (incl. 2FA), and the
session is saved to a profile folder on **their own machine**. No credentials or
sessions ever leave the device — there is no server. Same model as the CLI's
one-time `npm run login`, surfaced as a button.

### Target Criteria
The User's plain-language definition of *who counts as a match*, supplied as
free-text keywords (no code, no presets): a **who** set (e.g.
`lawyer, attorney, barrister, SAN, advocate`) and an optional **where** set
(e.g. `Nigeria, Lagos, Abuja`). A scraped profile is kept if its bio matches a
*who* keyword AND (when given) a *where* keyword. Replaces the hardcoded
tech/role keyword lists; the same word-boundary matcher does the work.

### Seed
An X account whose follow graph (followers/following) is crawled to discover
candidate profiles. The User supplies a few Seeds relevant to their niche (e.g.
the Nigerian Bar Association, large law firms). The only discovery source in v1;
keyword-search is a deferred fallback.

### Message Template
A single DM the User writes once, with variables (`{name}`, `{location}`, …)
that the App fills per matched profile to produce the per-handle text the
existing `dm-bot` sends. The normie alternative to an external writer AI;
optional "AI-personalize" is a deferred toggle, not v1.

### App
The distributed product: a **Tauri** desktop app (Rust shell + OS webview for
UI) that spawns the existing Node/Playwright code as a **sidecar** to do the
automation. Bundles its own Chromium for Playwright to drive (option (b)) so it
works with no prerequisites. Cross-OS (Linux/Windows/Mac).
