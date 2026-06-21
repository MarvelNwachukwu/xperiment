import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { staleLockFiles } from "./cleanup";

test("staleLockFiles returns only locks whose pid is dead", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locks-"));
  fs.writeFileSync(path.join(dir, ".write-follow.lock"), JSON.stringify({ tool: "follow", pid: 999999, startedAt: "x" }));
  fs.writeFileSync(path.join(dir, ".write-dm.lock"), JSON.stringify({ tool: "dm", pid: process.pid, startedAt: "x" }));
  fs.writeFileSync(path.join(dir, "other.json"), "{}");
  const isAlive = (pid: number) => pid === process.pid;
  const stale = staleLockFiles(dir, isAlive).map((p) => path.basename(p)).sort();
  assert.deepEqual(stale, [".write-follow.lock"]); // dm's pid is alive; other.json ignored
});

test("staleLockFiles tolerates missing dir and corrupt files", () => {
  assert.deepEqual(staleLockFiles("/no/such/dir", () => true), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locks2-"));
  fs.writeFileSync(path.join(dir, ".write-follow.lock"), "not json");
  // corrupt lock -> treat as removable (can't prove owner alive)
  assert.deepEqual(staleLockFiles(dir, () => true).map((p) => path.basename(p)), [".write-follow.lock"]);
});
