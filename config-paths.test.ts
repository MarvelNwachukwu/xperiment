import { test } from "node:test";
import assert from "node:assert/strict";
import { dataDir } from "./config";
import * as path from "path";

test("dataDir: uses XPERIMENT_DATA_DIR when set", () => {
  assert.equal(dataDir({ XPERIMENT_DATA_DIR: "/data/x" }, "/app"), "/data/x");
});
test("dataDir: falls back to dirname when unset", () => {
  assert.equal(dataDir({}, "/app"), "/app");
});
test("OUTPUT_DIR/PROFILE_DIR are under the resolved data dir", async () => {
  // Importing config.ts (no env) must keep dev behavior: under __dirname.
  const cfg = await import("./config");
  assert.ok(cfg.OUTPUT_DIR.endsWith(path.join("output")));
  assert.ok(cfg.PROFILE_DIR.endsWith(".chrome-profile"));
});
