import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSpawn, nodeCommandName } from "./launcher";

test("nodeCommandName: scope name node-win on Windows, node elsewhere", () => {
  assert.equal(nodeCommandName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "node-win");
  assert.equal(nodeCommandName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)"), "node");
});

const base = { nodePath: "/res/node", engineDir: "/res/engine-dist", repoDir: "/repo", dataDir: "/data" };

test("resolveSpawn dev: npx tsx at the repo", () => {
  const s = resolveSpawn(["tsx", "follow-bot.ts", "follow", "x"], { ...base, packaged: false });
  assert.equal(s.program, "npx");
  assert.deepEqual(s.args, ["tsx", "follow-bot.ts", "follow", "x"]);
  assert.equal(s.cwd, "/repo");
});

test("resolveSpawn packaged: bundled node + compiled js, data dir env", () => {
  const s = resolveSpawn(["tsx", "follow-bot.ts", "follow", "x"], { ...base, packaged: true });
  assert.equal(s.program, "/res/node");
  assert.deepEqual(s.args, ["/res/engine-dist/follow-bot.js", "follow", "x"]);
  assert.equal(s.cwd, "/data");
  assert.equal(s.env.XPERIMENT_DATA_DIR, "/data");
});

test("resolveSpawn packaged: maps the .ts entry to .js", () => {
  const s = resolveSpawn(["tsx", "cleanup.ts"], { ...base, packaged: true });
  assert.deepEqual(s.args, ["/res/engine-dist/cleanup.js"]);
});
