/// <reference types="vite/client" />
import { resolveResource, appDataDir } from "@tauri-apps/api/path";
import type { LaunchCtx } from "./launcher";
import { nodeCommandName } from "./launcher";

// Dev repo path (only used when running via `tauri dev`).
export const REPO_DIR = "/Users/0xmarvel/superconductor/projects/xperiment";

let cached: Promise<LaunchCtx> | null = null;
export function getLaunchCtx(): Promise<LaunchCtx> {
  if (!cached) cached = buildLaunchCtx();
  return cached;
}
async function buildLaunchCtx(): Promise<LaunchCtx> {
  const packaged = !import.meta.env.DEV; // tauri dev => Vite DEV=true
  if (!packaged) return { packaged: false, nodePath: "", engineDir: "", repoDir: REPO_DIR, dataDir: REPO_DIR };
  // nodePath is the shell-scope command NAME (not a path); Tauri resolves it to
  // the bundled binary via the capability's `cmd`. engineDir is a real path used
  // as an argument, so it is resolved.
  const [engineDir, dataDir] = await Promise.all([
    resolveResource("resources/engine-dist"),
    appDataDir(),
  ]);
  return { packaged: true, nodePath: nodeCommandName(navigator.userAgent), engineDir, repoDir: REPO_DIR, dataDir };
}

export async function dataPath(rel: string): Promise<string> {
  const ctx = await getLaunchCtx();
  return `${ctx.dataDir}/${rel}`;
}
