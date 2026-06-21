export interface ListForm {
  seeds: string[];
  side: "following" | "followers";
  who: string;
  where: string;
}

export interface Step {
  label: string;
  args: string[];
}

// Turn the Define-screen form into the ordered list of engine invocations:
// crawl each seed -> enrich -> filter. args are paired with ENGINE by the caller.
export function buildSteps(form: ListForm): Step[] {
  const seeds = form.seeds.map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
  const steps: Step[] = seeds.map((seed) => ({
    label: `Crawling @${seed}`,
    args: ["tsx", "prospect.ts", "crawl", seed, "--side", form.side],
  }));
  steps.push({ label: "Enriching profiles", args: ["tsx", "prospect.ts", "enrich"] });
  const filterArgs = ["tsx", "prospect.ts", "filter", "--who", form.who];
  if (form.where.trim()) filterArgs.push("--where", form.where);
  steps.push({ label: "Filtering to matches", args: filterArgs });
  return steps;
}

export function followArgs(
  target: string,
  opts: { following: boolean; techOnly: boolean; keywords?: string }
): string[] {
  const args = ["tsx", "follow-bot.ts", "follow", target.trim().replace(/^@/, "")];
  if (opts.following) args.push("--following");
  const kw = (opts.keywords ?? "").trim();
  if (kw) args.push("--keywords", kw); // keywords take precedence over --tech-only in the engine
  else if (opts.techOnly) args.push("--tech-only");
  return args;
}

export function chainArgs(seed: string, opts: { resume: boolean; keywords?: string }): string[] {
  const kw = (opts.keywords ?? "").trim();
  const kwArgs = kw ? ["--keywords", kw] : [];
  if (opts.resume) return ["tsx", "chain-runner.ts", "--resume", ...kwArgs];
  return ["tsx", "chain-runner.ts", seed.trim().replace(/^@/, ""), ...kwArgs];
}

export function unfollowScanArgs(keywords?: string): string[] {
  const kw = (keywords ?? "").trim();
  const args = ["tsx", "unfollow-bot.ts", "scan"];
  if (kw) args.push("--keywords", kw);
  return args;
}

export function unfollowArgs(): string[] {
  return ["tsx", "unfollow-bot.ts", "unfollow"];
}

export function dmArgs(opts: { live: boolean }): string[] {
  const args = ["tsx", "dm-bot.ts", "send"];
  if (opts.live) args.push("--live");
  return args;
}
