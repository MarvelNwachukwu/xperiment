/// <reference types="vite/client" />
import { resolveResource, appDataDir } from "@tauri-apps/api/path";
import type { LaunchCtx } from "./launcher";

// Dev repo path (only used when running via `tauri dev`).
export const REPO_DIR = "/Users/0xmarvel/superconductor/projects/xperiment";

let cached: LaunchCtx | null = null;
export async function getLaunchCtx(): Promise<LaunchCtx> {
  if (cached) return cached;
  const packaged = !import.meta.env.DEV; // tauri dev => Vite DEV=true
  if (!packaged) {
    cached = { packaged: false, nodePath: "", engineDir: "", repoDir: REPO_DIR, dataDir: REPO_DIR };
  } else {
    const data = await appDataDir();
    cached = {
      packaged: true,
      nodePath: await resolveResource("resources/node"),       // see Task 5 layout
      engineDir: await resolveResource("resources/engine-dist"),
      repoDir: REPO_DIR,
      dataDir: data,
    };
  }
  return cached;
}
