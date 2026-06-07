import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFollowing, type FollowingRecord } from "./following-store";

test("mergeFollowing preserves firstSeen, refreshes lastSynced, sets viaBot", () => {
  const existing: FollowingRecord[] = [
    { handle: "alice", name: "Alice", bioSnippet: "old bio", firstSeen: "2026-01-01T00:00:00.000Z", lastSynced: "2026-01-01T00:00:00.000Z", viaBot: false },
  ];
  const scraped = [
    { handle: "alice", name: "Alice A", bioSnippet: "new bio" },
    { handle: "bob", name: "Bob", bioSnippet: "bob bio" },
  ];
  const now = "2026-06-07T12:00:00.000Z";
  const out = mergeFollowing(existing, scraped, new Set(["bob"]), now);

  const alice = out.find((r) => r.handle === "alice")!;
  const bob = out.find((r) => r.handle === "bob")!;

  assert.equal(alice.firstSeen, "2026-01-01T00:00:00.000Z"); // preserved
  assert.equal(alice.lastSynced, now); // refreshed
  assert.equal(alice.name, "Alice A"); // updated
  assert.equal(bob.firstSeen, now); // new
  assert.equal(bob.viaBot, true); // in botHandles
  assert.equal(alice.viaBot, false);
});

test("mergeFollowing keeps records not present in the latest scrape (stale, not deleted)", () => {
  const existing: FollowingRecord[] = [
    { handle: "carol", name: "Carol", bioSnippet: "", firstSeen: "2026-01-01T00:00:00.000Z", lastSynced: "2026-01-01T00:00:00.000Z", viaBot: false },
  ];
  const out = mergeFollowing(existing, [], new Set(), "2026-06-07T12:00:00.000Z");
  assert.equal(out.length, 1);
  assert.equal(out[0].lastSynced, "2026-01-01T00:00:00.000Z"); // unchanged -> stale signal
});
