import { test } from "node:test";
import assert from "node:assert/strict";
import { decideLock, type LockInfo } from "./write-lock";

const HOLDER: LockInfo = { tool: "follow", pid: 4242, startedAt: "2026-06-10T00:00:00.000Z" };
const alive = () => true;
const dead = () => false;

test("no existing lock -> acquire", () => {
  assert.equal(decideLock(null, alive, false), "acquire");
});

test("live holder, no force -> refuse", () => {
  assert.equal(decideLock(HOLDER, alive, false), "refuse");
});

test("live holder, force -> bypass", () => {
  assert.equal(decideLock(HOLDER, alive, true), "bypass");
});

test("dead holder (stale) -> reclaim", () => {
  assert.equal(decideLock(HOLDER, dead, false), "reclaim");
});
