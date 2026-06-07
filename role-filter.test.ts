import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRole } from "./role-filter";

test("strong title -> strong confidence", () => {
  const r = matchRole("Co-founder & CEO at Acme. Building the future.");
  assert.equal(r.confidence, "strong");
  assert.ok(r.matchedKeywords.includes("ceo"));
});

test("hiring language -> strong", () => {
  assert.equal(matchRole("We're hiring senior engineers!").confidence, "strong");
});

test("ambiguous leadership word -> review", () => {
  assert.equal(matchRole("Engineering lead. Opinions my own.").confidence, "review");
});

test("no signal -> null", () => {
  const r = matchRole("Coffee lover, dog dad, runner.");
  assert.equal(r.confidence, null);
  assert.deepEqual(r.matchedKeywords, []);
});

test("word boundary: 'lead' does not match inside 'leadership' only as a word", () => {
  // "leaderboard" should NOT trigger the bare 'lead' review keyword
  assert.equal(matchRole("I love the leaderboard rankings.").confidence, null);
});
