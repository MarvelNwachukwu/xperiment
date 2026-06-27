import { Command, type Child } from "@tauri-apps/plugin-shell";
import { ENGINE, REPO_DIR } from "./config";

// Pure registry of live children, testable without a browser.
export class ChildRegistry<T> {
  private items = new Set<T>();
  add(c: T) { this.items.add(c); }
  remove(c: T) { this.items.delete(c); }
  size() { return this.items.size; }
  async killAll(kill: (c: T) => Promise<void>) {
    for (const c of [...this.items]) {
      await kill(c).catch(() => {});
      this.items.delete(c);
    }
  }
}

export interface EngineRun {
  done: Promise<void>;
  kill: () => Promise<void>;
}

const registry = new ChildRegistry<Child>();
export function activeCount(): number { return registry.size(); }
export async function killAllEngine(): Promise<void> {
  await registry.killAll((c) => c.kill());
}

// Spawn an engine command, streaming stdout+stderr lines to onLine.
export function runEngine(args: string[], onLine: (line: string) => void): EngineRun {
  const cmd = Command.create(ENGINE, args, { cwd: REPO_DIR });
  cmd.stdout.on("data", (l) => onLine(l));
  cmd.stderr.on("data", (l) => onLine(l));
  let child: Child | null = null;
  const done = new Promise<void>((resolve) => {
    cmd.on("close", () => {
      if (child) registry.remove(child);
      resolve();
    });
    cmd.spawn().then((c) => { child = c; registry.add(c); });
  });
  return {
    done,
    kill: async () => { if (child) await child.kill(); },
  };
}
