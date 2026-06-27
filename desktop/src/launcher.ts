// Shell-scope command NAME for the bundled node (NOT a path): Tauri matches the
// program passed to Command.create against a capability entry's `name`, then
// runs that entry's `cmd` ($RESOURCE/resources/node[.exe]). Passing the resolved
// path instead is rejected as "program not allowed on the configured shell scope".
export function nodeCommandName(userAgent: string): string {
  return /Windows/i.test(userAgent) ? "node-win" : "node";
}

export interface LaunchCtx {
  packaged: boolean;
  nodePath: string;   // shell-scope command NAME for bundled node (packaged only)
  engineDir: string;  // bundled engine-dist absolute path (packaged only)
  repoDir: string;    // dev repo root
  dataDir: string;    // writable app-data dir (packaged); repoDir in dev
}

export interface Spawn {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

// Logical args look like ["tsx", "<file>.ts", ...rest].
export function resolveSpawn(logicalArgs: string[], ctx: LaunchCtx): Spawn {
  const [, entry, ...rest] = logicalArgs; // drop "tsx"
  if (!ctx.packaged) {
    return { program: "npx", args: logicalArgs, cwd: ctx.repoDir, env: {} };
  }
  const js = entry.replace(/\.ts$/, ".js");
  return {
    program: ctx.nodePath,
    args: [`${ctx.engineDir}/${js}`, ...rest],
    cwd: ctx.dataDir,
    env: { XPERIMENT_DATA_DIR: ctx.dataDir },
  };
}
