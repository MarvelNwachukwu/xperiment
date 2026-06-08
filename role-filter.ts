// Decision-maker bio matcher. Mirrors the tech-filter.ts word-boundary approach.
// Two-stage: STRONG titles -> "strong"; weaker leadership signals -> "review";
// otherwise no match.

const STRONG_TITLES = [
  "founder", "co-founder", "cofounder", "ceo", "cto", "coo", "cfo", "cmo",
  "cpo", "chief", "president", "vice president", "vp", "head of", "director of",
  "managing director", "general partner", "partner", "hiring", "we're hiring",
  "we are hiring", "recruiter", "talent", "people ops", "hiring manager",
  "owner", "principal",
];

const REVIEW_SIGNALS = [
  "lead", "manager", "director", "advisor", "investor", "growth",
  "operations", "biz dev", "business development", "founding",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeMatchers(words: string[]) {
  return words.map((kw) => ({
    kw,
    re: new RegExp(`(?<![\\w])${escapeRegExp(kw)}(?![\\w])`, "i"),
  }));
}

const STRONG_MATCHERS = makeMatchers(STRONG_TITLES);
const REVIEW_MATCHERS = makeMatchers(REVIEW_SIGNALS);

export type RoleConfidence = "strong" | "review";

export interface RoleMatch {
  confidence: RoleConfidence | null;
  matchedKeywords: string[];
}

export function matchRole(bio: string): RoleMatch {
  const strong = STRONG_MATCHERS.filter(({ re }) => re.test(bio)).map((m) => m.kw);
  if (strong.length > 0) return { confidence: "strong", matchedKeywords: strong };

  const review = REVIEW_MATCHERS.filter(({ re }) => re.test(bio)).map((m) => m.kw);
  if (review.length > 0) return { confidence: "review", matchedKeywords: review };

  return { confidence: null, matchedKeywords: [] };
}

// Human-readable role summary, e.g. "founder/ceo (strong)" or "-" when no match.
export function roleLabel(confidence: RoleConfidence | null, keywords: string[]): string {
  if (keywords.length === 0) return "-";
  return `${keywords.join("/")} (${confidence})`;
}
