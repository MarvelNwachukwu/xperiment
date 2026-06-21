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

import { followArgs, chainArgs, unfollowScanArgs, unfollowArgs, dmArgs } from "./steps";

test("followArgs strips @, adds flags only when set", () => {
  assert.deepEqual(followArgs("@dev", { following: true, techOnly: true }),
    ["tsx", "follow-bot.ts", "follow", "dev", "--following", "--tech-only"]);
  assert.deepEqual(followArgs("dev", { following: false, techOnly: false }),
    ["tsx", "follow-bot.ts", "follow", "dev"]);
});
test("followArgs: keywords override --tech-only", () => {
  assert.deepEqual(followArgs("@dev", { following: false, techOnly: true, keywords: "law, attorney" }),
    ["tsx", "follow-bot.ts", "follow", "dev", "--keywords", "law, attorney"]);
  assert.deepEqual(followArgs("@dev", { following: true, techOnly: false, keywords: "  " }),
    ["tsx", "follow-bot.ts", "follow", "dev", "--following"]);
});

test("chainArgs: seed vs resume", () => {
  assert.deepEqual(chainArgs("@x", { resume: false }), ["tsx", "chain-runner.ts", "x"]);
  assert.deepEqual(chainArgs("", { resume: true }), ["tsx", "chain-runner.ts", "--resume"]);
});

test("chainArgs: custom keywords (and blank is omitted)", () => {
  assert.deepEqual(chainArgs("@x", { resume: false, keywords: "law, attorney" }),
    ["tsx", "chain-runner.ts", "x", "--keywords", "law, attorney"]);
  assert.deepEqual(chainArgs("@x", { resume: false, keywords: "   " }),
    ["tsx", "chain-runner.ts", "x"]);
  assert.deepEqual(chainArgs("", { resume: true, keywords: "finance" }),
    ["tsx", "chain-runner.ts", "--resume", "--keywords", "finance"]);
});

test("unfollow + dm args", () => {
  assert.deepEqual(unfollowScanArgs(), ["tsx", "unfollow-bot.ts", "scan"]);
  assert.deepEqual(unfollowScanArgs("law, attorney"), ["tsx", "unfollow-bot.ts", "scan", "--keywords", "law, attorney"]);
  assert.deepEqual(unfollowScanArgs("   "), ["tsx", "unfollow-bot.ts", "scan"]);
  assert.deepEqual(unfollowArgs(), ["tsx", "unfollow-bot.ts", "unfollow"]);
  assert.deepEqual(dmArgs({ live: false }), ["tsx", "dm-bot.ts", "send"]);
  assert.deepEqual(dmArgs({ live: true }), ["tsx", "dm-bot.ts", "send", "--live"]);
});
