// Read a logged-in user's Following list from X's GraphQL feed.
// Parsing lives here so it is the single place that knows X's response shape.

import type { Page, BrowserContext } from "playwright";

export interface XUser {
  username: string;
  displayName: string;
  bio: string;
}

export interface FollowingPage {
  users: XUser[];
  nextCursor: string | null; // null when the feed is exhausted
}

// Thrown when the feed can't be read/parsed (X likely changed its shape).
export class FeedParseError extends Error {}

interface AnyObj { [k: string]: any }

function getInstructions(json: any): AnyObj[] {
  const tl = json?.data?.user?.result?.timeline?.timeline
    ?? json?.data?.user?.result?.timeline_v2?.timeline;
  const instructions = tl?.instructions;
  if (!Array.isArray(instructions)) {
    throw new FeedParseError("Following feed: instructions not found (shape changed?)");
  }
  return instructions;
}

export function parseFollowingPage(json: unknown): FollowingPage {
  const instructions = getInstructions(json);
  const entries: AnyObj[] = [];
  for (const ins of instructions) {
    if (ins?.type === "TimelineAddEntries" && Array.isArray(ins.entries)) {
      entries.push(...ins.entries);
    }
  }

  const users: XUser[] = [];
  let bottomCursor: string | null = null;

  for (const entry of entries) {
    const content = entry?.content;
    if (content?.cursorType === "Bottom" && typeof content.value === "string") {
      bottomCursor = content.value;
      continue;
    }
    const result = content?.itemContent?.user_results?.result;
    if (!result || result.__typename !== "User") continue;
    const legacy = result.legacy ?? {};
    if (typeof legacy.screen_name !== "string") continue;
    users.push({
      username: legacy.screen_name,
      displayName: typeof legacy.name === "string" ? legacy.name : "",
      bio: typeof legacy.description === "string" ? legacy.description : "",
    });
  }

  return { users, nextCursor: users.length > 0 ? bottomCursor : null };
}

export interface RateLimit {
  remaining: number;
  reset: number; // epoch seconds
}

// Sleep before the next request only when the window is nearly spent.
// Returns ms to wait (0 if there is headroom).
export function rateLimitSleepMs(
  rl: RateLimit,
  nowSec: number,
  threshold = 5,
  marginMs = 2000,
): number {
  if (rl.remaining > threshold) return 0;
  const untilResetMs = (rl.reset - nowSec) * 1000;
  return Math.max(0, untilResetMs) + marginMs;
}

// Small polite delay between pages so the read loop is not a tight burst.
export function jitterMs(minMs = 300, maxMs = 800): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

export interface CapturedReq {
  url: string;
  headers: Record<string, string>;
}

// Thrown on HTTP 429 so the caller can back off and retry the same cursor.
export class RateLimitedError extends Error {
  constructor(public resetSec: number) {
    super("rate limited");
  }
}

const FOLLOWING_RE = /\/graphql\/[^/]+\/Following\?/;

// Open the signed-in user's Following page and capture the real GraphQL request.
export async function captureFollowing(
  page: Page,
  selfHandle: string,
  timeoutMs = 15000,
): Promise<CapturedReq> {
  const reqP = page.waitForRequest((r) => FOLLOWING_RE.test(r.url()), { timeout: timeoutMs });
  await page.goto(`https://x.com/${selfHandle}/following`, { waitUntil: "domcontentloaded" });
  const req = await reqP.catch(() => {
    throw new FeedParseError("Did not see X's Following request (the page may have changed).");
  });
  return { url: req.url(), headers: req.headers() };
}

// Replay the captured request with a new cursor and parse one page.
export async function fetchFollowingPage(
  context: BrowserContext,
  captured: CapturedReq,
  cursor: string | null,
): Promise<{ page: FollowingPage; rateLimit: RateLimit }> {
  let url = captured.url;
  if (cursor) {
    const u = new URL(captured.url);
    const vars = JSON.parse(u.searchParams.get("variables") ?? "{}");
    vars.cursor = cursor;
    u.searchParams.set("variables", JSON.stringify(vars));
    url = u.toString();
  }

  const resp = await context.request.get(url, { headers: captured.headers });
  const h = resp.headers();
  const rateLimit: RateLimit = {
    remaining: Number(h["x-rate-limit-remaining"] ?? "999"),
    reset: Number(h["x-rate-limit-reset"] ?? "0"),
  };

  if (resp.status() === 429) throw new RateLimitedError(rateLimit.reset);
  if (!resp.ok()) throw new FeedParseError(`Following feed HTTP ${resp.status()}`);

  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    throw new FeedParseError("Following feed did not return JSON.");
  }
  return { page: parseFollowingPage(json), rateLimit };
}
