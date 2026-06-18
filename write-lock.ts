import * as fs from "fs";
import * as path from "path";
import { OUTPUT_DIR } from "./config";

export type WriteCategory = "follow" | "dm";

export interface LockInfo {
  tool: string;
  pid: number;
  startedAt: string;
}

export type LockDecision = "acquire" | "reclaim" | "refuse" | "bypass";

// Pure decision: given the existing lock (if any), whether its owner is alive,
// and whether --force was passed, decide what to do.
export function decideLock(
  existing: LockInfo | null,
  isAlive: (pid: number) => boolean,
  force: boolean
): LockDecision {
  if (!existing) return "acquire";
  if (!isAlive(existing.pid)) return "reclaim"; // stale lock from a crashed run
  return force ? "bypass" : "refuse";
}

function lockPath(category: WriteCategory): string {
  return path.join(OUTPUT_DIR, `.write-${category}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
    return true;
  } catch {
    return false;
  }
}

// Acquire the write lock for a category. Exits the process on refusal.
// Returns release() which frees the lock (no-op when --force bypassed a holder).
export function acquireWriteLock(category: WriteCategory, tool: string, force: boolean): () => void {
  const file = lockPath(category);
  let existing: LockInfo | null = null;
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      existing = null;
    }
  }

  const decision = decideLock(existing, pidAlive, force);

  if (decision === "refuse") {
    console.error(
      `\n✋ '${existing?.tool}' is already running (pid ${existing?.pid}, since ${existing?.startedAt}).\n` +
        `Another '${category}' write tool would double velocity past the daily cap. Refusing.\n` +
        `(use --force to override)\n`
    );
    process.exit(1);
  }

  if (decision === "bypass") {
    console.warn(`⚠ --force: write-guard bypassed, running concurrently with '${existing?.tool}'.`);
    return () => {}; // no-op: must not clobber the holder's lock
  }

  // acquire or reclaim — write our own lock
  const info: LockInfo = { tool, pid: process.pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(info, null, 2));

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  };

  // Best-effort cleanup if the process exits or is Ctrl-C'd.
  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(130);
  });

  return release;
}
