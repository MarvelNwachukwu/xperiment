import { Command } from "@tauri-apps/plugin-shell";
import type { Child } from "@tauri-apps/plugin-shell";
import { ENGINE, REPO_DIR } from "./config";
import { buildSteps, type ListForm } from "./steps";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

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
  $("connect-status").textContent = "Log in in the browser window, then click 'I've logged in'.";
}

$("btn-connect-done").addEventListener("click", async () => {
  if (loginChild) await loginChild.write("\n"); // the Enter the login flow waits for
});

$("btn-run").addEventListener("click", () => {
  $("log").textContent = "";
  runPipeline(readForm()).catch((e) => log(`Error: ${e}`));
});
$("btn-connect").addEventListener("click", () => connectX().catch((e) => log(`Error: ${e}`)));
