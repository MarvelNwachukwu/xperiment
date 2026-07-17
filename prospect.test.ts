import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchQueries, filterFollowing } from "./prospect";

test("buildSearchQueries: who only, one plain query per term", () => {
  assert.deepEqual(buildSearchQueries(["solidity", "web3"], []), ["solidity", "web3"]);
});

test("buildSearchQueries: who×where pairs, plain AND (no OR/parens)", () => {
  assert.deepEqual(buildSearchQueries(["lawyer", "attorney"], ["Lagos", "Abuja"]), [
    "lawyer Lagos",
    "lawyer Abuja",
    "attorney Lagos",
    "attorney Abuja",
  ]);
});

test("buildSearchQueries: quotes multi-word terms", () => {
  assert.deepEqual(buildSearchQueries(["smart contract"], ["New York"]), ['"smart contract" "New York"']);
});

test("buildSearchQueries: ignores blank terms", () => {
  assert.deepEqual(buildSearchQueries(["solidity", " "], []), ["solidity"]);
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
