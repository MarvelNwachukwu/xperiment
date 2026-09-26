import * as fs from "fs";
import * as readline from "readline";
import { createHash } from "crypto";
import { todayCountUTC } from "./pacing";
import { DM_LOG_FILE, MESSAGES_FILE, CANDIDATES_FILE } from "./config";

// (All output paths are centralized in config.ts under output/.)
// One record shape serves every channel: dm-bot (X), tg-bot (Telegram) and
// mail-bot (email) each keep their own log file of DmRecords.

// skipped_no_open_dm: the person can't be messaged (X closed inbox, Telegram
//   privacy setting). skipped_bad_handle: the handle is wrong (no such
//   username, or a channel/group/bot rather than a person). drafted: an email
//   saved to Drafts, not yet sent.
export type DmStatus = "sent" | "skipped_no_open_dm" | "skipped_bad_handle" | "drafted" | "failed" | "dry_run";

export interface DmRecord {
  handle: string;
  status: DmStatus;
  reason: string;
  timestamp: string;
  textHash: string;
}

// angle: short label copied into the outreach sheet. subject: email only.
export interface OutgoingMessage {
  tone: string;
  text: string;
  angle?: string;
  subject?: string;
}

export interface DmFlags {
  live: boolean;
  approve: boolean;
}

// Executor form on purpose: tsconfig.engine.json targets ES2020, which has no
// Promise.withResolvers.
export function confirmPrompt(question: string, verb = "Send"): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question}\n  ${verb}? [y/N] `, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === "y");
    });
  });
}

// Short stable fingerprint of a message body — lets us detect a revised draft.
export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function validateMessage(text: string, maxLen: number): { ok: boolean; reason: string } {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty message" };
  if (text.length > maxLen) return { ok: false, reason: `message too long (${text.length} > ${maxLen})` };
  return { ok: true, reason: "" };
}

// True only if THIS exact text was already sent to this handle. A revised draft
// (different hash) is allowed through for an intentional resend; dry_run/failed
// records never block.
export function alreadySent(log: DmRecord[], handle: string, text: string): boolean {
  const h = textHash(text);
  return log.some((r) => r.handle === handle && r.status === "sent" && r.textHash === h);
}

// Count DMs actually SENT on the current UTC day (drives the daily cap).
export function dmsToday(log: DmRecord[], nowISO: string): number {
  const sentTimestamps = log.filter((r) => r.status === "sent").map((r) => r.timestamp);
  return todayCountUTC(sentTimestamps, nowISO);
}

export function parseDmFlags(args: string[]): DmFlags {
  return { live: args.includes("--live"), approve: args.includes("--approve") };
}

export function loadDmLog(file = DM_LOG_FILE): DmRecord[] {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

export function saveDmLog(records: DmRecord[], file = DM_LOG_FILE): void {
  fs.writeFileSync(file, JSON.stringify(records, null, 2));
}

// messages.json is { "<handle>": { tone, text } }; keys may include a leading @.
// Returns a map keyed by bare handle (no @).
export function loadMessages(file = MESSAGES_FILE): Record<string, OutgoingMessage> {
  if (!fs.existsSync(file)) return {};
  let raw: Record<string, OutgoingMessage>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
  const out: Record<string, OutgoingMessage> = {};
  for (const [k, v] of Object.entries(raw)) out[k.replace(/^@/, "")] = v;
  return out;
}

export function loadCandidateHandles(): Set<string> {
  if (!fs.existsSync(CANDIDATES_FILE)) return new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(CANDIDATES_FILE, "utf-8")) as Array<{ handle: string }>;
    return new Set(arr.map((c) => c.handle));
  } catch {
    return new Set();
  }
}
