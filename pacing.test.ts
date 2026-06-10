import { test } from "node:test";
import assert from "node:assert/strict";
import { BurstScheduler, todayCountUTC } from "./pacing";

// rng = () => 0 makes randInt always return its min, so cluster size = clusterMin.
const PACING = {
  clusterMin: 2,
  clusterMax: 5,
  intraDelayMinSec: 5,
  intraDelayMaxSec: 20,
  restDelayMinSec: 180,
  restDelayMaxSec: 480,
};

test("BurstScheduler: intra delays within a cluster, rest at the boundary", () => {
  const s = new BurstScheduler(PACING, () => 0); // cluster size = 2
  const d1 = s.next(); // 2 -> 1, still in burst
  const d2 = s.next(); // 1 -> 0, burst done -> rest, reset to 2
  const d3 = s.next(); // 2 -> 1, new burst
  assert.deepEqual(
    [d1.kind, d2.kind, d3.kind],
    ["intra", "rest", "intra"]
  );
  assert.equal(d1.sec, 5); // intraDelayMinSec
  assert.equal(d2.sec, 180); // restDelayMinSec
});

test("todayCountUTC counts only same-UTC-day timestamps", () => {
  const ts = [
    "2026-06-07T01:00:00.000Z",
    "2026-06-07T23:00:00.000Z",
    "2020-01-01T00:00:00.000Z",
  ];
  assert.equal(todayCountUTC(ts, "2026-06-07T12:00:00.000Z"), 2);
});
