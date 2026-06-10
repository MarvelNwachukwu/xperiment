// Pure parsers for scraped profile fields.

// Parses X follower/following count strings: "567", "1,234", "12.3K", "1.2M".
export function parseCount(raw: string): number | null {
  const s = raw.trim().replace(/,/g, "");
  const m = s.match(/^([\d.]+)\s*([KM]?)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2].toUpperCase() === "M" ? 1_000_000 : m[2].toUpperCase() === "K" ? 1_000 : 1;
  return Math.round(n * mult);
}

// Best-effort company extraction from a bio: first "@handle" mention, else
// the word(s) after " at ". Returns null when nothing matches.
export function parseCompany(bio: string): string | null {
  const at = bio.match(/(?<![\w])@([A-Za-z0-9_]{2,})/);
  if (at) return at[1];
  const phrase = bio.match(/\bat\s+([A-Z][A-Za-z0-9_.&-]+)/);
  if (phrase) return phrase[1];
  return null;
}
