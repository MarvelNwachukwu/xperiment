import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { OUTPUT_DIR } from "./config";
import { decideLock, type LockInfo } from "./write-lock";

// Lock files in `dir` whose owning process is no longer alive (or that are
// corrupt and can't prove an owner). Pure given an isAlive probe.
export function staleLockFiles(dir: string, isAlive: (pid: number) => boolean): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name.startsWith(".write-") || !name.endsWith(".lock")) continue;
    const file = path.join(dir, name);
    let info: LockInfo | null = null;
    try {
      info = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      out.push(file); // corrupt -> removable
      continue;
    }
    // decideLock("reclaim") == existing lock whose pid is dead.
    if (decideLock(info, isAlive, false) === "reclaim") out.push(file);
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Engine processes the GUI may have spawned. Matched by command substring.
const ENGINE_PATTERNS = [
  "tsx prospect.ts",
  "tsx follow-bot.ts",
  "tsx chain-runner.ts",
  "tsx dm-bot.ts",
  "tsx unfollow-bot.ts",
];

function killByPattern(pattern: string): number {
  try {
    // -f match full arg line; exclude ourselves. Returns nonzero if none matched.
    execSync(`pkill -f ${JSON.stringify(pattern)}`, { stdio: "ignore" });
    return 1;
  } catch {
    return 0;
  }
}

function cleanup(): void {
  let killed = 0;
  for (const p of ENGINE_PATTERNS) killed += killByPattern(p);
  // Stray automation Chrome bound to our profile dir.
  killed += killByPattern(".chrome-profile");

  const stale = staleLockFiles(OUTPUT_DIR, pidAlive);
  for (const f of stale) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
  console.log(`Cleanup done. Killed ~${killed} process group(s); removed ${stale.length} stale lock(s).`);
}

if (require.main === module) cleanup();
