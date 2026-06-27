# Tauri App Shell (Phase 1 UI, dev-runnable) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri desktop app, runnable via `tauri dev`, that drives the existing list-builder engine through a non-technical UI — Connect X, define seeds + Target Criteria, run the crawl/enrich/filter pipeline with live progress, view results, export CSV.

**Architecture:** Thin Tauri v2 shell (Rust + OS webview) with a **vanilla-TS** frontend. The frontend spawns the existing engine commands (`prospect.ts`, `follow-bot.ts login`) via the Tauri **shell plugin**, streams their stdout into a log pane, reads `output/candidates.json` via the **fs plugin**, and reveals the CSV via the **opener plugin**. No engine rewrite — the app is a launcher over commands that already exist. Runs against the dev machine's Node + Chrome.

**Tech Stack:** Tauri v2, `@tauri-apps/plugin-shell` / `-fs` / `-opener`, vanilla TypeScript frontend, Node `node:test` for the one pure module. Reuses the repo's `prospect.ts` engine (in `gui`).

## Global Constraints

- Branch off `gui`; PR into `gui` (NOT `main`). All app work stays on the integration branch until end-to-end sign-off.
- Tauri **v2** (not v1). Frontend is **vanilla TS** — no React/Vue/Svelte.
- **Read-only Phase 1**: Connect, list-build (crawl→enrich→filter), results, CSV export. **No DM** (that's a later plan).
- **No packaging/bundling**: runs via `tauri dev` against the dev machine's Node + installed Chrome. Bundling Node + Playwright Chromium, installers, and signing are **Plan 3**.
- The engine lives in the **repo root** (parent of `desktop/`); the app spawns it there and reads its `output/` there.
- No new engine commands — reuse `prospect.ts {crawl,enrich,filter,export-csv}` and `follow-bot.ts login` exactly as shipped.
- Pure-logic tests run via `npx tsx --test`.

## Spec reference

`docs/superpowers/specs/2026-06-19-desktop-app-design.md` (screens, Connect-X flow), ADR 0001 (local BYO-login), ADR 0002 (Tauri + sidecar — sidecar packaging deferred to Plan 3), `CONTEXT.md` (Seed, Target Criteria).

## File Structure

| File | Responsibility |
|---|---|
| `desktop/` (new) | Tauri app project (created by scaffold). |
| `desktop/src-tauri/tauri.conf.json` | App config; registers plugins. |
| `desktop/src-tauri/capabilities/default.json` | Allowlist: execute the engine commands; read `output/`. |
| `desktop/src/config.ts` (new) | `REPO_DIR` (dev: absolute repo path) + engine program/args constants. |
| `desktop/src/steps.ts` (new) | `buildSteps(form)` — pure: form inputs → ordered engine invocations. |
| `desktop/src/steps.test.ts` (new) | Unit tests for `buildSteps`. |
| `desktop/src/main.ts` | Frontend: screens, spawn engine, stream stdout, results table, CSV export, Connect-X. |
| `desktop/index.html` | The 4 sections (Connect / Define / Run / Results). |
| `desktop/README.md` (new) | How to run the app in dev. |

---

## Task 1: Scaffold the Tauri app + plugins

**Files:** Create `desktop/` (scaffold), edit `desktop/src-tauri/capabilities/default.json`. Smoke-verified (a window opens) — no unit test.

**Interfaces:**
- Produces: a runnable Tauri v2 app at `desktop/` with the `shell`, `fs`, and `opener` plugins installed and allowlisted, launchable via `npm run tauri dev` from `desktop/`.

- [ ] **Step 1: Scaffold** (run from repo root):

```bash
npm create tauri-app@latest desktop -- --template vanilla-ts --manager npm --yes
cd desktop && npm install
```
This creates `desktop/` with `src-tauri/` (Rust) and `src/` (vanilla-TS frontend).

- [ ] **Step 2: Add the three plugins** (from `desktop/`):

```bash
npx tauri add shell
npx tauri add fs
npx tauri add opener
```
Each command edits `src-tauri/Cargo.toml`, registers the plugin in `src-tauri/src/lib.rs`, and installs the JS package. Confirm the JS packages now in `desktop/package.json`: `@tauri-apps/plugin-shell`, `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-opener`. **Record their exact import paths and the `Command`/`readTextFile`/`revealItemInDir` (or `openPath`) export names from each package's `dist`/`.d.ts`** — later tasks import these; if a name differs in the installed version, use the installed name and note it in the task report.

- [ ] **Step 3: Allowlist the engine commands + output dir.** Replace `desktop/src-tauri/capabilities/default.json` with (keep the existing `identity`/`windows` keys the scaffold generated — merge, don't drop them):

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "List-builder app capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "fs:default",
    {
      "identifier": "fs:allow-read-text-file",
      "allow": [{ "path": "$HOME/**" }]
    },
    "shell:allow-execute",
    "shell:allow-spawn",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        { "name": "npx", "cmd": "npx", "args": true, "sidecar": false }
      ]
    }
  ]
}
```
(The `shell:allow-execute` with `args: true` permits spawning `npx ...` with arbitrary args during dev. `ponytail: broad dev allowlist; Plan 3's sidecar packaging replaces this with a single bundled-binary permission.` Confirm the exact permission identifiers against the installed plugin versions — `npx tauri permission ls` lists them — and adjust if the schema differs.)

- [ ] **Step 4: Smoke — the app launches.** Run from `desktop/`:

```bash
npm run tauri dev
```
Expected: a desktop window opens showing the scaffold's default page, no plugin/permission errors in the terminal. Close it (Ctrl-C). (If the Rust toolchain is missing, install it first: `https://tauri.app/start/prerequisites/`.)

- [ ] **Step 5: Commit**

```bash
cd .. && git add desktop && git commit -m "feat(app): scaffold Tauri v2 shell with shell/fs/opener plugins"
```

---

## Task 2: `buildSteps` — form inputs → engine pipeline (pure)

**Files:** Create `desktop/src/config.ts`, `desktop/src/steps.ts`, `desktop/src/steps.test.ts`.

**Interfaces:**
- Produces:
  - `config.ts`: `export const ENGINE = "npx";` and `export const REPO_DIR = "<absolute repo path>";` (dev value; `ponytail: dev hardcode — Plan 3 replaces with the bundled sidecar path`).
  - `steps.ts`: `export interface ListForm { seeds: string[]; side: "following" | "followers"; who: string; where: string; }` and `export interface Step { label: string; args: string[]; }` and `export function buildSteps(form: ListForm): Step[]`. Returns one crawl Step per non-empty seed (`["tsx","prospect.ts","crawl",seed,"--side",side]`), then enrich (`["tsx","prospect.ts","enrich"]`), then filter (`["tsx","prospect.ts","filter","--who",who]` plus `"--where",where` only when `where` is non-empty). All program = `ENGINE` (the caller pairs args with `ENGINE`). Seeds are trimmed, `@` stripped, blanks dropped.

- [ ] **Step 1: Write the failing test — create `desktop/src/steps.test.ts`:**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSteps } from "./steps";

test("crawl per seed, then enrich, then filter with who+where", () => {
  const steps = buildSteps({
    seeds: ["@NigerianBar", "lawfirmA"],
    side: "followers",
    who: "lawyer,attorney",
    where: "nigeria,lagos",
  });
  assert.deepEqual(steps.map((s) => s.args), [
    ["tsx", "prospect.ts", "crawl", "NigerianBar", "--side", "followers"],
    ["tsx", "prospect.ts", "crawl", "lawfirmA", "--side", "followers"],
    ["tsx", "prospect.ts", "enrich"],
    ["tsx", "prospect.ts", "filter", "--who", "lawyer,attorney", "--where", "nigeria,lagos"],
  ]);
});

test("omits --where when blank; drops blank seeds; strips @", () => {
  const steps = buildSteps({ seeds: ["  @a ", "", "  "], side: "following", who: "lawyer", where: "  " });
  assert.deepEqual(steps.map((s) => s.args), [
    ["tsx", "prospect.ts", "crawl", "a", "--side", "following"],
    ["tsx", "prospect.ts", "enrich"],
    ["tsx", "prospect.ts", "filter", "--who", "lawyer"],
  ]);
});
```

- [ ] **Step 2: Run — `cd desktop && npx tsx --test src/steps.test.ts` — confirm FAIL (cannot find module './steps').**

- [ ] **Step 3: Implement — create `desktop/src/config.ts`:**

```typescript
// Engine launcher config. Dev values; Plan 3 (packaging) replaces these with
// the bundled sidecar path.
export const ENGINE = "npx";
// ponytail: dev hardcode — set to YOUR absolute repo path. Plan 3 swaps this
// for the packaged sidecar working directory.
export const REPO_DIR = "/Users/0xmarvel/superconductor/projects/xperiment";
```

Then `desktop/src/steps.ts`:

```typescript
export interface ListForm {
  seeds: string[];
  side: "following" | "followers";
  who: string;
  where: string;
}

export interface Step {
  label: string;
  args: string[];
}

// Turn the Define-screen form into the ordered list of engine invocations:
// crawl each seed -> enrich -> filter. args are paired with ENGINE by the caller.
export function buildSteps(form: ListForm): Step[] {
  const seeds = form.seeds.map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
  const steps: Step[] = seeds.map((seed) => ({
    label: `Crawling @${seed}`,
    args: ["tsx", "prospect.ts", "crawl", seed, "--side", form.side],
  }));
  steps.push({ label: "Enriching profiles", args: ["tsx", "prospect.ts", "enrich"] });
  const filterArgs = ["tsx", "prospect.ts", "filter", "--who", form.who];
  if (form.where.trim()) filterArgs.push("--where", form.where);
  steps.push({ label: "Filtering to matches", args: filterArgs });
  return steps;
}
```

- [ ] **Step 4: Run — `npx tsx --test src/steps.test.ts` — confirm PASS (2 pass, 0 fail).**

- [ ] **Step 5: Commit**

```bash
cd .. && git add desktop/src/config.ts desktop/src/steps.ts desktop/src/steps.test.ts
git commit -m "feat(app): buildSteps — form inputs to engine pipeline (pure, tested)"
```

---

## Task 3: Screens + Run pipeline

**Files:** Modify `desktop/index.html`, `desktop/src/main.ts`. Smoke-verified.

**Interfaces:**
- Consumes: `buildSteps`, `ListForm` (Task 2), `ENGINE`/`REPO_DIR` (Task 2), `Command` from `@tauri-apps/plugin-shell` (Task 1).
- Produces: `runPipeline(form)` that executes each Step's command sequentially (`Command.create(ENGINE, step.args, { cwd: REPO_DIR })`), appending stdout/stderr lines to the `#log` element and the step labels as headers; resolves when all steps finish.

- [ ] **Step 1: Replace `desktop/index.html` body** with the 4 sections (keep the scaffold's `<script type="module" src="/src/main.ts">`):

```html
<main class="container">
  <h1>List Builder</h1>

  <section id="connect">
    <h2>1. Connect X</h2>
    <button id="btn-connect">Connect X</button>
    <button id="btn-connect-done" hidden>I've logged in</button>
    <span id="connect-status"></span>
  </section>

  <section id="define">
    <h2>2. Who are you looking for?</h2>
    <label>Seed accounts (one @handle per line)<textarea id="seeds" rows="4"></textarea></label>
    <label>Crawl side
      <select id="side"><option value="following">following</option><option value="followers">followers</option></select>
    </label>
    <label>Looking for (keywords)<input id="who" placeholder="lawyer, attorney, barrister, SAN" /></label>
    <label>Location (optional)<input id="where" placeholder="nigeria, lagos, abuja" /></label>
    <button id="btn-run">Build list</button>
  </section>

  <section id="run">
    <h2>3. Progress</h2>
    <pre id="log"></pre>
  </section>

  <section id="results">
    <h2>4. Results</h2>
    <button id="btn-export" hidden>Export CSV</button>
    <div id="results-table"></div>
  </section>
</main>
```

- [ ] **Step 2: Replace `desktop/src/main.ts`** with the pipeline wiring (results/export/connect added in Tasks 4–5; this task delivers Define→Run):

```typescript
import { Command } from "@tauri-apps/plugin-shell";
import { ENGINE, REPO_DIR } from "./config";
import { buildSteps, type ListForm } from "./steps";

const $ = (id: string) => document.getElementById(id)!;
const log = (line: string) => {
  const pre = $("log");
  pre.textContent += line + "\n";
  pre.scrollTop = pre.scrollHeight;
};

function readForm(): ListForm {
  return {
    seeds: ($("seeds") as HTMLTextAreaElement).value.split("\n"),
    side: ($("side") as HTMLSelectElement).value as "following" | "followers",
    who: ($("who") as HTMLInputElement).value,
    where: ($("where") as HTMLInputElement).value,
  };
}

// Run one engine command, streaming its output into the log. Resolves on close.
async function runCommand(args: string[]): Promise<void> {
  const cmd = Command.create(ENGINE, args, { cwd: REPO_DIR });
  cmd.stdout.on("data", (l) => log(l));
  cmd.stderr.on("data", (l) => log(l));
  return new Promise((resolve) => {
    cmd.on("close", () => resolve());
    cmd.spawn();
  });
}

async function runPipeline(form: ListForm): Promise<void> {
  const steps = buildSteps(form);
  for (const step of steps) {
    log(`\n— ${step.label} —`);
    await runCommand(step.args);
  }
  log("\n✓ Done. Loading results…");
  await showResults(); // defined in Task 5
}

// Stubs filled in later tasks:
async function showResults(): Promise<void> {}
async function connectX(): Promise<void> {}

$("btn-run").addEventListener("click", () => {
  $("log").textContent = "";
  runPipeline(readForm()).catch((e) => log(`Error: ${e}`));
});
$("btn-connect").addEventListener("click", () => connectX().catch((e) => log(`Error: ${e}`)));
```

- [ ] **Step 3: Smoke.** `cd desktop && npm run tauri dev`. In the window: enter a seed (a small account so the crawl is short), `who` = `lawyer`, click **Build list**. Expected: the log pane streams the crawl → enrich → filter output (the same lines the CLI prints), ending with "Done". (This drives the real engine against your logged-in Chrome — run a tiny seed. If not logged in, the log shows "Not logged in" — Task 4 adds Connect.)

- [ ] **Step 4: Commit**

```bash
cd .. && git add desktop/index.html desktop/src/main.ts
git commit -m "feat(app): define + run screens — pipeline streams engine stdout"
```

---

## Task 4: Connect-X (BYO-login)

**Files:** Modify `desktop/src/main.ts`. Smoke-verified.

**Interfaces:**
- Consumes: `Command` (shell plugin), `ENGINE`/`REPO_DIR`.
- Produces: `connectX()` — spawns `tsx follow-bot.ts login` (opens the browser to X login), shows the "I've logged in" button; clicking it writes a newline to the child's stdin so the existing `login` flow saves the session.

Per ADR 0001, login is local BYO — the existing `login` command opens a browser and waits for Enter on stdin; the GUI provides that Enter.

- [ ] **Step 1: Replace the `connectX` stub in `desktop/src/main.ts`** with:

```typescript
import type { Child } from "@tauri-apps/plugin-shell"; // add to the top import group

let loginChild: Child | null = null;

async function connectX(): Promise<void> {
  $("connect-status").textContent = "Opening login window…";
  const cmd = Command.create(ENGINE, ["tsx", "follow-bot.ts", "login"], { cwd: REPO_DIR });
  cmd.stdout.on("data", (l) => log(l));
  cmd.stderr.on("data", (l) => log(l));
  cmd.on("close", () => {
    $("connect-status").textContent = "Connected ✓";
    ($("btn-connect-done") as HTMLButtonElement).hidden = true;
    loginChild = null;
  });
  loginChild = await cmd.spawn();
  ($("btn-connect-done") as HTMLButtonElement).hidden = false;
  $("connect-status").textContent = "Log in in the browser window, then click ‘I've logged in’.";
}

$("btn-connect-done").addEventListener("click", async () => {
  if (loginChild) await loginChild.write("\n"); // the Enter the login flow waits for
});
```

- [ ] **Step 2: Smoke.** `npm run tauri dev` → click **Connect X**. Expected: a Chrome window opens to X login; the status shows the instruction and the "I've logged in" button appears. Log in, click the button. Expected: the login command closes and status shows "Connected ✓" (session saved to the engine's profile dir). Then a **Build list** run no longer says "Not logged in".

- [ ] **Step 3: Commit**

```bash
cd .. && git add desktop/src/main.ts
git commit -m "feat(app): Connect X — spawn login, finish via stdin newline (ADR 0001)"
```

---

## Task 5: Results table + CSV export

**Files:** Modify `desktop/src/main.ts`. Smoke-verified.

**Interfaces:**
- Consumes: `readTextFile` from `@tauri-apps/plugin-fs`; `revealItemInDir` (or `openPath`) from `@tauri-apps/plugin-opener`; `Command`; `REPO_DIR`.
- Produces: `showResults()` reads `<REPO_DIR>/output/candidates.json`, renders a table; the Export CSV button spawns `tsx prospect.ts export-csv` then reveals `<REPO_DIR>/output/candidates.csv`.

- [ ] **Step 1: Replace the `showResults` stub in `desktop/src/main.ts`** with (and add the imports to the top group):

```typescript
import { readTextFile } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

interface Candidate {
  handle: string;
  name: string;
  location: string | null;
  followers: number | null;
  matchedKeywords: string[];
}

async function showResults(): Promise<void> {
  let candidates: Candidate[] = [];
  try {
    candidates = JSON.parse(await readTextFile(`${REPO_DIR}/output/candidates.json`));
  } catch {
    $("results-table").textContent = "No candidates yet.";
    return;
  }
  const rows = candidates
    .map(
      (c) =>
        `<tr><td>@${c.handle}</td><td>${c.name ?? ""}</td><td>${c.location ?? ""}</td>` +
        `<td>${c.followers ?? ""}</td><td>${(c.matchedKeywords ?? []).join(", ")}</td></tr>`
    )
    .join("");
  $("results-table").innerHTML =
    `<p>${candidates.length} matches.</p><table><thead><tr>` +
    `<th>Handle</th><th>Name</th><th>Location</th><th>Followers</th><th>Matched</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`;
  ($("btn-export") as HTMLButtonElement).hidden = candidates.length === 0;
}

$("btn-export").addEventListener("click", async () => {
  log("\n— Exporting CSV —");
  const cmd = Command.create(ENGINE, ["tsx", "prospect.ts", "export-csv"], { cwd: REPO_DIR });
  cmd.stdout.on("data", (l) => log(l));
  await new Promise<void>((resolve) => {
    cmd.on("close", () => resolve());
    cmd.spawn();
  });
  await revealItemInDir(`${REPO_DIR}/output/candidates.csv`);
});
```

- [ ] **Step 2: Smoke.** With `output/candidates.json` present (from a prior Build list run, or copy a small fixture there): `npm run tauri dev`, run Build list (or just trigger results) → the table renders matches and the **Export CSV** button appears. Click it → the file manager opens revealing `output/candidates.csv`. (If `revealItemInDir` isn't the installed export name, use the opener plugin's actual reveal/open function recorded in Task 1.)

- [ ] **Step 3: Commit**

```bash
cd .. && git add desktop/src/main.ts
git commit -m "feat(app): results table + CSV export with reveal"
```

---

## Task 6: Desktop README + pure-test run

**Files:** Create `desktop/README.md`.

- [ ] **Step 1: Run the pure tests** — `cd desktop && npx tsx --test src/steps.test.ts` → expect 2 pass, 0 fail. Then from repo root `npm test` → confirm the engine suite still passes (no engine files were touched by this plan, so it should be unchanged — paste counts).

- [ ] **Step 2: Create `desktop/README.md`** documenting, in plain steps: prerequisites (Rust toolchain link, Node, the engine in the repo root with a logged-in Chrome or use Connect X); set `REPO_DIR` in `src/config.ts` to the absolute repo path; `cd desktop && npm install && npm run tauri dev`; the in-app flow (Connect X → enter seeds + keywords → Build list → Results → Export CSV); a note that this is the dev shell — packaging into an installer is Plan 3.

- [ ] **Step 3: Commit**

```bash
cd .. && git add desktop/README.md
git commit -m "docs(app): how to run the Tauri shell in dev"
```

---

## Self-Review

- **Spec coverage (Phase 1 UI):** Connect-X (Task 4, ADR 0001), Define seeds+Target Criteria (Task 3), Run with live progress (Task 3, streams engine stdout), Results table (Task 5), CSV export (Task 5). Tauri v2 + vanilla TS + sidecar-via-shell (ADR 0002, packaging deferred). All Phase-1 screens covered. DM and packaging are explicitly out of scope (later plans).
- **Placeholder scan:** none — scaffold uses real `create-tauri-app`/`tauri add` commands; frontend/steps code is complete; the two honest unknowns (exact plugin export names; the dev `REPO_DIR` value) are called out as explicit confirm/set steps, not silent TODOs.
- **Type consistency:** `buildSteps(form: ListForm): Step[]` defined in Task 2, consumed in Task 3; `ENGINE`/`REPO_DIR` from `config.ts` used in Tasks 3–5; `connectX`/`showResults` declared as stubs in Task 3 and filled in Tasks 4/5 (same names); `Command`/`Child`/`readTextFile`/`revealItemInDir` are the Tauri-plugin imports established in Task 1.

## Verification posture (read this)

A GUI scaffold is **not** unit-testable end-to-end. Only `buildSteps` (Task 2) is TDD. Tasks 1, 3, 4, 5 are verified by **launching the app and clicking through** — those smokes need a human at the window (and a logged-in X session for the engine), so the implementer should run what they can headlessly (type-check, `tauri dev` launches) and hand the click-through smokes to you. This is the honest cost of a UI shell; it's why packaging (Plan 3) and the real end-to-end no-regression test (your gate before `gui → main`) are separate.

## Next plans (not in scope)

- **Plan 3 — Packaging:** bundle Node + Playwright Chromium as a Tauri sidecar (replace the `npx`/`REPO_DIR` dev shortcuts), point the engine at the bundled Chromium, per-OS installers, signing/notarization.
- **Plan 4 — DM in the app:** Message Template screen → fill → `dm-bot` with dry-run/cap/closed-DM guards.
