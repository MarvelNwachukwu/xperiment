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
