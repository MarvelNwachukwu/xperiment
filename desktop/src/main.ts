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
