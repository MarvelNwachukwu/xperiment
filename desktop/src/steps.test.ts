import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSteps } from "./steps";

test("crawl per seed, then enrich, then filter with who+where", () => {
  const steps = buildSteps({
    seeds: ["@NigerianBar", "lawfirmA"],
    side: "followers",
    who: "lawyer,attorney",
    where: "nigeria,lagos",
  });
  assert.deepEqual(steps.map((s) => s.args), [
    ["tsx", "prospect.ts", "crawl", "NigerianBar", "--side", "followers"],
    ["tsx", "prospect.ts", "crawl", "lawfirmA", "--side", "followers"],
    ["tsx", "prospect.ts", "enrich"],
    ["tsx", "prospect.ts", "filter", "--who", "lawyer,attorney", "--where", "nigeria,lagos"],
  ]);
});

test("omits --where when blank; drops blank seeds; strips @", () => {
  const steps = buildSteps({ seeds: ["  @a ", "", "  "], side: "following", who: "lawyer", where: "  " });
  assert.deepEqual(steps.map((s) => s.args), [
    ["tsx", "prospect.ts", "crawl", "a", "--side", "following"],
    ["tsx", "prospect.ts", "enrich"],
    ["tsx", "prospect.ts", "filter", "--who", "lawyer"],
  ]);
});
