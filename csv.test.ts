import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "./csv";

test("header only when no rows", () => {
  assert.equal(toCsv([], ["handle", "name"]), "handle,name");
});

test("quotes cells with comma, quote, or newline", () => {
  const rows = [{ a: "plain", b: "has,comma", c: 'has"quote', d: "line\nbreak" }];
  assert.equal(
    toCsv(rows, ["a", "b", "c", "d"]),
    'a,b,c,d\nplain,"has,comma","has""quote","line\nbreak"'
  );
});

test("null/undefined become empty; arrays stringify (and get quoted)", () => {
  const rows = [{ handle: "x", kw: ["lawyer", "SAN"], loc: null }];
  assert.equal(toCsv(rows, ["handle", "kw", "loc"]), 'handle,kw,loc\nx,"lawyer,SAN",');
});
