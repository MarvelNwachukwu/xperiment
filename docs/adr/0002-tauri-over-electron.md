# 2. Tauri shell with a Node sidecar (not Electron)

Date: 2026-06-19
Status: Accepted

## Context

ADR 0001 settled on a local desktop app. The existing codebase is 100%
Node + Playwright, which normally points straight at **Electron** (its main
process *is* Node — the code drops in with no porting). The competing option is
**Tauri** (Rust shell + the OS's built-in webview), which does not run Node —
the existing JS must run as a spawned **sidecar** binary.

The deciding factor is size/footprint. The app must ship a Chromium for
Playwright to drive (ADR-adjacent decision: bundle it so it works with zero
prerequisites). That changes the usual math:

| Setup | Approx installed size | Idle RAM |
|---|---|---|
| Tauri + bundled Playwright Chromium | ~190 MB | low (~tens of MB) |
| Electron + bundled Playwright Chromium | ~300 MB | high (hundreds of MB) |

Electron bundles a **second** Chromium for its own UI, on top of the Playwright
one — so it pays for Chromium twice. Tauri uses the OS webview for UI and pays
only for the (unavoidable) Playwright Chromium. Follow/automation speed is
identical either way (same Chromium, and the real bottleneck is the deliberate
burst pacing). The relevant difference for a tool that idles for hours between
bursts is **idle RAM**, where Tauri wins clearly.

## Decision

Use **Tauri** for the shell and run the existing Node/Playwright code as a
**sidecar** process that Tauri spawns. The Rust/webview side is UI only; it
talks to the sidecar by spawning the existing commands and streaming their
stdout.

## Consequences

- **~110 MB smaller and much lighter on idle RAM** than the Electron equivalent.
- **More wiring than Electron:** we package and spawn a Node runtime + the JS +
  Playwright's Chromium as a sidecar, rather than running Node in-process. The
  UI↔engine boundary is process-spawn + stdout streaming (acceptable: the
  commands already log progress and write results to `output/*.json`).
- A future contributor might be tempted to "simplify" to Electron because the
  codebase is all-Node; this ADR records that the size/RAM trade-off was
  deliberate and Electron was rejected for it.
- If the sidecar packaging proves too painful, Electron remains the fallback at
  the documented size cost — the decision is reversible but not free.
