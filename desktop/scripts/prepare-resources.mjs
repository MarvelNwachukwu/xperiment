import { execSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, createWriteStream, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform, arch } from "node:os";
import { pipeline } from "node:stream/promises";

const NODE_VERSION = "v22.11.0";
const repo = join(import.meta.dirname, "..", "..");      // engine repo root
const res = join(import.meta.dirname, "..", "src-tauri", "resources");

rmSync(res, { recursive: true, force: true });
mkdirSync(res, { recursive: true });

// 1. compiled engine
execSync("npm run build:engine", { cwd: repo, stdio: "inherit" });
cpSync(join(repo, "engine-dist"), join(res, "engine-dist"), { recursive: true });

// 2. pruned prod node_modules (no chromium)
execSync("npm ci --omit=dev", {
  cwd: repo, stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
});
cpSync(join(repo, "node_modules"), join(res, "node_modules"), { recursive: true });

// 3. node binary for this OS
const isWin = platform() === "win32";
const plat = isWin ? "win" : "darwin";
const a = arch() === "arm64" ? "arm64" : "x64";
const ext = isWin ? "zip" : "tar.gz";
const name = `node-${NODE_VERSION}-${plat}-${a}`;
const url = `https://nodejs.org/dist/${NODE_VERSION}/${name}.${ext}`;
const tmp = join(tmpdir(), `${name}.${ext}`);
const r = await fetch(url);
if (!r.ok) throw new Error(`node download failed: ${r.status} ${url}`);
await pipeline(r.body, createWriteStream(tmp));
const work = join(tmpdir(), name);
rmSync(work, { recursive: true, force: true });
if (isWin) {
  execSync(`tar -xf "${tmp}" -C "${tmpdir()}"`); // bsdtar on win extracts zip
  cpSync(join(work, "node.exe"), join(res, "node.exe"));
} else {
  execSync(`tar -xf "${tmp}" -C "${tmpdir()}"`);
  const nodeBin = join(res, "node");
  cpSync(join(work, "bin", "node"), nodeBin);
  chmodSync(nodeBin, 0o755);
}
console.log("resources prepared at", res);
