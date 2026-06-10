import { test } from "node:test";
import assert from "node:assert/strict";
import {
  textHash,
  validateMessage,
  alreadySent,
  dmsToday,
  parseDmFlags,
  type DmRecord,
} from "./dm-store";

test("textHash is stable and differs by input", () => {
  assert.equal(textHash("hello"), textHash("hello"));
  assert.notEqual(textHash("hello"), textHash("hello!"));
});

test("validateMessage rejects empty/whitespace/over-long, accepts normal", () => {
  assert.equal(validateMessage("", 100).ok, false);
  assert.equal(validateMessage("   ", 100).ok, false);
  assert.equal(validateMessage("x".repeat(101), 100).ok, false);
  assert.equal(validateMessage("hi there", 100).ok, true);
});

test("alreadySent only blocks the same text previously SENT", () => {
  const log: DmRecord[] = [
    { handle: "alice", status: "sent", reason: "", timestamp: "2026-06-08T00:00:00.000Z", textHash: textHash("hi") },
    { handle: "bob", status: "dry_run", reason: "", timestamp: "2026-06-08T00:00:00.000Z", textHash: textHash("hi bob") },
  ];
  assert.equal(alreadySent(log, "alice", "hi"), true);
  assert.equal(alreadySent(log, "alice", "hi again"), false);
  assert.equal(alreadySent(log, "bob", "hi bob"), false);
  assert.equal(alreadySent(log, "carol", "hi"), false);
});

test("dmsToday counts only SENT records on the given UTC day", () => {
  const log: DmRecord[] = [
    { handle: "a", status: "sent", reason: "", timestamp: "2026-06-08T01:00:00.000Z", textHash: "x" },
    { handle: "b", status: "sent", reason: "", timestamp: "2026-06-08T23:00:00.000Z", textHash: "y" },
    { handle: "c", status: "dry_run", reason: "", timestamp: "2026-06-08T02:00:00.000Z", textHash: "z" },
    { handle: "d", status: "sent", reason: "", timestamp: "2026-06-07T02:00:00.000Z", textHash: "w" },
  ];
  assert.equal(dmsToday(log, "2026-06-08T12:00:00.000Z"), 2);
});

test("parseDmFlags reads --live and --approve", () => {
  assert.deepEqual(parseDmFlags([]), { live: false, approve: false });
  assert.deepEqual(parseDmFlags(["--live"]), { live: true, approve: false });
  assert.deepEqual(parseDmFlags(["--approve", "--live"]), { live: true, approve: true });
});
