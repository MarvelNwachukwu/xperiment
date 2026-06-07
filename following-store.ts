import * as fs from "fs";
import * as path from "path";

const FOLLOWING_FILE = path.join(__dirname, "following.json");

export interface FollowingRecord {
  handle: string;
  name: string;
  bioSnippet: string;
  firstSeen: string;
  lastSynced: string;
  viaBot: boolean;
}

export interface ScrapedFollowing {
  handle: string;
  name: string;
  bioSnippet: string;
}

export function loadFollowing(): FollowingRecord[] {
  if (!fs.existsSync(FOLLOWING_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FOLLOWING_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function saveFollowing(records: FollowingRecord[]): void {
  fs.writeFileSync(FOLLOWING_FILE, JSON.stringify(records, null, 2));
}

// Merge a fresh scrape into the canonical set. New handles get firstSeen;
// matched handles get lastSynced refreshed and name/bio updated. Records absent
// from the scrape are kept untouched (stale lastSynced = likely unfollowed).
export function mergeFollowing(
  existing: FollowingRecord[],
  scraped: ScrapedFollowing[],
  botHandles: Set<string>,
  now: string
): FollowingRecord[] {
  const byHandle = new Map<string, FollowingRecord>();
  for (const r of existing) byHandle.set(r.handle, { ...r });

  for (const s of scraped) {
    const prev = byHandle.get(s.handle);
    if (prev) {
      prev.name = s.name || prev.name;
      prev.bioSnippet = s.bioSnippet;
      prev.lastSynced = now;
      prev.viaBot = prev.viaBot || botHandles.has(s.handle);
    } else {
      byHandle.set(s.handle, {
        handle: s.handle,
        name: s.name,
        bioSnippet: s.bioSnippet,
        firstSeen: now,
        lastSynced: now,
        viaBot: botHandles.has(s.handle),
      });
    }
  }

  return [...byHandle.values()];
}
