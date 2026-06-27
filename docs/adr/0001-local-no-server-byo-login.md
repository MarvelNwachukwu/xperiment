# 1. Local app, no server, bring-your-own-login

Date: 2026-06-19
Status: Accepted

## Context

The CLI tool drives a real, logged-in Chrome via Playwright to act on the
Operator's own X account. We want to distribute it to non-technical **Users**,
each acting on **their own** X account. That forces a decision about where the
automation runs and how each User authenticates ("getting the User's auth" was
the flagged hard part).

Three models were considered:

1. **Official X API + OAuth** — clean, sanctioned auth, but the write API is
   gutted (free tier can't write; Basic ~$200/mo for tiny caps; bulk
   follow/DM effectively unavailable). The API cannot do what this tool does —
   it is the reason the tool exists.
2. **Hosted browser farm** — Users log in through our web app; we store their
   sessions and run Playwright per User on our servers. Replicates capability
   but makes us custodian of strangers' live X sessions (security + liability),
   costs a browser farm, and server-side automated logins are the fastest route
   to getting Users' accounts banned.
3. **Local app, bring-your-own-login** — the automation runs on the User's own
   machine against their own login; the session lives only on their disk.

## Decision

Adopt **model 3**: a local desktop app with **no backend**. The User clicks
**Connect X**, a browser window opens to `x.com/login`, they log in themselves
(including 2FA), and Playwright's persistent profile is saved locally. No
credentials or sessions ever leave the device. This is the CLI's one-time
`npm run login`, surfaced as a button.

## Consequences

- **The auth "problem" largely dissolves** — there is no auth to host; each User
  authenticates themselves locally, exactly as the Operator does today.
- **No server to build, secure, pay for, or get breached.** We never hold a
  User's credentials or session.
- **Account-ban risk stays with the User's own machine/account** and is
  mitigated by the existing pacing/caps; we are not running automation against
  many accounts from one place.
- **Cost:** distribution is heavier than a URL — Users download and install an
  app (see ADR 0002). We also can't centrally meter, update, or monetize as
  tightly as a SaaS.
- Reversing this later (moving to hosted) is a near-total rebuild, which is why
  it is recorded here.
