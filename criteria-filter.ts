// Free-text Target Criteria matcher. Same word-boundary approach as
// role-filter.ts / tech-filter.ts, but the keyword lists come from the User.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns the subset of `words` that appear in `text` as whole words.
function hits(text: string, words: string[]): string[] {
  return words
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .filter((w) => new RegExp(`(?<![\\w])${escapeRegExp(w)}(?![\\w])`, "i").test(text));
}

export interface CriteriaMatch {
  matched: boolean;
  matchedKeywords: string[];
}

// text matches if it contains a `who` keyword AND (when `where` is non-empty)
// a `where` keyword. matchedKeywords = the who-keywords that hit.
export function matchCriteria(text: string, who: string[], where: string[]): CriteriaMatch {
  const whoHits = hits(text, who);
  if (whoHits.length === 0) return { matched: false, matchedKeywords: [] };
  if (where.filter((w) => w.trim()).length > 0 && hits(text, where).length === 0) {
    return { matched: false, matchedKeywords: [] };
  }
  return { matched: true, matchedKeywords: whoHits };
}

// ── Shared --keywords plumbing (chain / follow / unfollow) ────────────
// Parse `--keywords "law, attorney, barrister"` (comma-separated) from argv. [] if absent.
export function parseKeywordsArg(args: string[]): string[] {
  const i = args.indexOf("--keywords");
  if (i === -1) return [];
  return (args[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// A bio filter that matches any of the given keywords (whole-word).
export function keywordBioFilter(keywords: string[]): (bio: string) => boolean {
  return (bio: string) => matchCriteria(bio, keywords, []).matched;
}
