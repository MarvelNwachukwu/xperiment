import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCriteria } from "./criteria-filter";

const who = ["lawyer", "attorney", "barrister", "SAN"];
const where = ["nigeria", "lagos", "abuja"];

test("who + where both present -> matched", () => {
  const r = matchCriteria("Corporate lawyer based in Lagos.", who, where);
  assert.equal(r.matched, true);
  assert.deepEqual(r.matchedKeywords, ["lawyer"]);
});

test("who present, where required but missing -> not matched", () => {
  assert.equal(matchCriteria("Corporate lawyer in London.", who, where).matched, false);
});

test("no who keyword -> not matched", () => {
  const r = matchCriteria("Lagos-based chef and foodie.", who, where);
  assert.equal(r.matched, false);
  assert.deepEqual(r.matchedKeywords, []);
});

test("empty where -> location not required", () => {
  assert.equal(matchCriteria("Barrister. Opinions mine.", who, []).matched, true);
});

test("word-boundary: 'law' does not match inside 'lawnmower'", () => {
  assert.equal(matchCriteria("I sell a lawnmower in Lagos.", ["law"], where).matched, false);
});
