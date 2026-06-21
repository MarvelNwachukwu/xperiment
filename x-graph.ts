// Read a logged-in user's Following list from X's GraphQL feed.
// Parsing lives here so it is the single place that knows X's response shape.

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
