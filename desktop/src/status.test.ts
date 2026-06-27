import { test } from "node:test";
import assert from "node:assert/strict";
import { countToday, capLabel } from "./status";

test("countToday counts same-UTC-day timestamps", () => {
  const ts = ["2026-06-20T01:00:00.000Z", "2026-06-20T23:00:00.000Z", "2026-06-19T23:00:00.000Z"];
  assert.equal(countToday(ts, "2026-06-20T12:00:00.000Z"), 2);
});

test("capLabel formats used/max", () => {
  assert.equal(capLabel(120, 350), "120/350");
});
