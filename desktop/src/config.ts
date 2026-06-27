/// <reference types="vite/client" />
import { resolveResource, appDataDir } from "@tauri-apps/api/path";
import type { LaunchCtx } from "./launcher";
import { nodeResourceName } from "./launcher";

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
  const [nodePath, engineDir, dataDir] = await Promise.all([
    resolveResource(nodeResourceName(navigator.userAgent)),
    resolveResource("resources/engine-dist"),
    appDataDir(),
  ]);
  return { packaged: true, nodePath, engineDir, repoDir: REPO_DIR, dataDir };
}

export async function dataPath(rel: string): Promise<string> {
  const ctx = await getLaunchCtx();
  return `${ctx.dataDir}/${rel}`;
}
