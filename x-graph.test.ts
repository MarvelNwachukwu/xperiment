import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFollowingPage, FeedParseError } from "./x-graph";

// Minimal shape mirroring X's Following GraphQL response.
function page(entries: unknown[]) {
  return {
    data: { user: { result: { timeline: { timeline: { instructions: [
      { type: "TimelineClearCache" },
      { type: "TimelineAddEntries", entries },
    ] } } } } },
  };
}
function userEntry(id: string, screen: string, name: string, desc: string) {
  return {
    entryId: `user-${id}`,
    content: { entryType: "TimelineTimelineItem", itemContent: {
      itemType: "TimelineUser",
      user_results: { result: { __typename: "User", rest_id: id,
        legacy: { screen_name: screen, name, description: desc } } },
    } },
  };
}
function cursorEntry(type: "Bottom" | "Top", value: string) {
  return { entryId: `cursor-${type.toLowerCase()}-x`,
    content: { entryType: "TimelineTimelineCursor", cursorType: type, value } };
}

test("parseFollowingPage: extracts users and the bottom cursor", () => {
  const r = parseFollowingPage(page([
    userEntry("1", "alice", "Alice", "Corporate lawyer in Lagos"),
    userEntry("2", "bob", "Bob", "crypto degen"),
    cursorEntry("Top", "TOP"),
    cursorEntry("Bottom", "NEXT123"),
  ]));
  assert.deepEqual(r.users, [
    { username: "alice", displayName: "Alice", bio: "Corporate lawyer in Lagos" },
    { username: "bob", displayName: "Bob", bio: "crypto degen" },
  ]);
  assert.equal(r.nextCursor, "NEXT123");
});

test("parseFollowingPage: no users -> nextCursor null (exhausted)", () => {
  const r = parseFollowingPage(page([cursorEntry("Bottom", "NEXT123")]));
  assert.deepEqual(r.users, []);
  assert.equal(r.nextCursor, null);
});

test("parseFollowingPage: skips unavailable (non-User) results", () => {
  const bad = { entryId: "user-9", content: { itemContent: {
    user_results: { result: { __typename: "UserUnavailable" } } } } };
  const r = parseFollowingPage(page([bad, userEntry("1", "alice", "Alice", "bio"), cursorEntry("Bottom", "C")]));
  assert.deepEqual(r.users.map((u) => u.username), ["alice"]);
});

test("parseFollowingPage: missing instructions -> FeedParseError", () => {
  assert.throws(() => parseFollowingPage({ data: {} }), FeedParseError);
});
