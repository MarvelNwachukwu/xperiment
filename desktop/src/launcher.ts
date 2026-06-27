export interface LaunchCtx {
  packaged: boolean;
  nodePath: string;   // bundled node (packaged only)
  engineDir: string;  // bundled engine-dist (packaged only)
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
