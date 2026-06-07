import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCount, parseCompany } from "./profile-parse";

test("parseCount handles plain, comma, K, M", () => {
  assert.equal(parseCount("567"), 567);
  assert.equal(parseCount("1,234"), 1234);
  assert.equal(parseCount("12.3K"), 12300);
  assert.equal(parseCount("1.2M"), 1200000);
  assert.equal(parseCount(""), null);
  assert.equal(parseCount("garbage"), null);
});

test("parseCompany extracts an @mention or 'at X'", () => {
  assert.equal(parseCompany("CTO @Stripe. building payments"), "Stripe");
  assert.equal(parseCompany("Engineer at Vercel"), "Vercel");
  assert.equal(parseCompany("just a person"), null);
});
