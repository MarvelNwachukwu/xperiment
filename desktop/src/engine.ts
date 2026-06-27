import { Command, type Child } from "@tauri-apps/plugin-shell";
import { getLaunchCtx } from "./config";
import { resolveSpawn } from "./launcher";

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
  let child: Child | null = null;
  let killRequested = false;
  const done = (async () => {
    try {
      const ctx = await getLaunchCtx();
      const s = resolveSpawn(args, ctx);
      const cmd = Command.create(s.program, s.args, { cwd: s.cwd, env: s.env });
      cmd.stdout.on("data", (l) => onLine(l));
      cmd.stderr.on("data", (l) => onLine(l));
      await new Promise<void>((resolve) => {
        cmd.on("close", () => { if (child) registry.remove(child); resolve(); });
        cmd.spawn()
          .then((c) => { child = c; registry.add(c); if (killRequested) c.kill().catch(() => {}); })
          .catch((e) => { onLine(`Failed to start engine: ${e}`); resolve(); });
      });
    } catch (e) {
      onLine(`Engine error: ${e}`);
    }
  })();
  return { done, kill: async () => { killRequested = true; if (child) await child.kill().catch(() => {}); } };
}
