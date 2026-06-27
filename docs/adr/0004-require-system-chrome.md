# 4. Require the user's installed Chrome, don't bundle Chromium

Date: 2026-06-21
Status: Accepted (revises an assumption in ADR 0002)

## Context

ADR 0002 chose Tauri over Electron, and its reasoning leaned on the premise that the app "must ship a Chromium for Playwright to drive (~190MB)". When packaging the app (the deferred Plan 3), that premise turned out not to match the code.

The engine launches the browser with:

```ts
chromium.launchPersistentContext(PROFILE_DIR, { channel: "chrome", headless: false, ... })
```

`channel: "chrome"` drives the user's **installed Google Chrome**, not Playwright's downloaded Chromium. The Playwright npm package is used only as a CDP driver; its browser binaries are never launched. So nothing requires us to bundle a browser.

This is a real trade-off for packaging. Bundling Chromium gives zero prerequisites but adds ~170-340MB to the installer, a browser binary to sign/notarize, and a behavior change (Chromium renders X slightly differently and lacks the user's real Chrome profile/extensions). Requiring Chrome keeps the installer small (~60-80MB), matches the existing code, and runs in the same Chrome the user already trusts, at the cost of one prerequisite.

## Decision

**Require Google Chrome on the target machine; do not bundle Chromium.** Keep `channel: "chrome"`. The packaged app checks for Chrome on launch (macOS: `/Applications/Google Chrome.app`; Windows: the `chrome.exe` App Paths registry key / Program Files) and, if absent, shows a banner linking to google.com/chrome.

Install Playwright in the bundled `node_modules` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so no Chromium ships.

## Consequences

- **Installer stays ~60-80MB** instead of ~230-250MB, with no browser binary to sign.
- **One prerequisite:** Chrome must be installed. It is near-universal, and the launch check makes the requirement obvious rather than a silent failure.
- **Behavior matches dev** exactly (same `channel: "chrome"` path in dev and packaged), so packaging introduces no rendering/automation differences.
- **ADR 0002 still holds** (Tauri over Electron); only its Chromium-size figures were based on the bundling assumption this ADR overturns. The Tauri-vs-Electron idle-RAM argument is unaffected.
- If we ever need true zero-prerequisite distribution, bundling Chromium remains available at the documented size/signing cost, by dropping `channel: "chrome"`.
