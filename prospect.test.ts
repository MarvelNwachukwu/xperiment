import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchQuery, filterFollowing } from "./prospect";

test("buildSearchQuery: single who term, no parens", () => {
  assert.equal(buildSearchQuery(["solidity"], []), "solidity");
});

test("buildSearchQuery: OR-groups who and where, ANDed", () => {
  assert.equal(
    buildSearchQuery(["solidity", "web3"], ["Lagos", "Nigeria"]),
    "(solidity OR web3) (Lagos OR Nigeria)"
  );
});

test("buildSearchQuery: quotes multi-word terms", () => {
  assert.equal(buildSearchQuery(["smart contract"], []), '"smart contract"');
});

test("buildSearchQuery: ignores blank terms", () => {
  assert.equal(buildSearchQuery(["solidity", " "], []), "solidity");
});

const rows = [
  { name: "Ada L", bioSnippet: "solidity dev in Lagos" },
  { name: "Bob", bioSnippet: "web3 founder, Abuja" },
  { name: "Cara", bioSnippet: "chef in Lagos" },
];

test("filterFollowing: who AND where", () => {
  const out = filterFollowing(rows, ["solidity", "web3"], ["Lagos"]);
  assert.deepEqual(out.map((r) => r.name), ["Ada L"]);
});

test("filterFollowing: where-only matches on location terms", () => {
  const out = filterFollowing(rows, [], ["Lagos"]);
  assert.deepEqual(out.map((r) => r.name), ["Ada L", "Cara"]);
});

test("filterFollowing: empty criteria returns everything", () => {
  assert.equal(filterFollowing(rows, [], []).length, rows.length);
});
