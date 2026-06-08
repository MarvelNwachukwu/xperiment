import * as fs from "fs";
import * as path from "path";

// ── Paths ─────────────────────────────────────────────────────
// All generated state/logs live under output/ to keep the repo root clean.
// Created on import so any tool can write without a separate setup step.
export const OUTPUT_DIR = path.join(__dirname, "output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

export const LOG_FILE = path.join(OUTPUT_DIR, "follow-log.json");
export const CHAIN_STATE_FILE = path.join(OUTPUT_DIR, "chain-state.json");
export const CHAIN_LOG_FILE = path.join(OUTPUT_DIR, "chain-log.txt");
export const FOLLOWING_FILE = path.join(OUTPUT_DIR, "following.json");
export const PROFILES_FILE = path.join(OUTPUT_DIR, "profiles.json");
export const CANDIDATES_FILE = path.join(OUTPUT_DIR, "candidates.json");
export const MESSAGES_FILE = path.join(OUTPUT_DIR, "messages.json");
export const DM_LOG_FILE = path.join(OUTPUT_DIR, "dm-log.json");
export const UNFOLLOW_CANDIDATES_FILE = path.join(OUTPUT_DIR, "unfollow-candidates.json");
export const UNFOLLOW_LOG_FILE = path.join(OUTPUT_DIR, "unfollow-log.json");

// Browser session cache stays at repo root — moving it forces a re-login.
export const PROFILE_DIR = path.join(__dirname, ".chrome-profile");

// ── Follow Engine ─────────────────────────────────────────────
export const FOLLOW_TIMEOUT_MS = 5000;
export const SCROLL_WAIT_MS = 5000;

// ── Follow Pacing (burst scheduler) ───────────────────────────
// Rather than a fixed delay between every follow, the engine follows in small
// bursts (a cluster of follows close together) then rests longer. This reads
// like a person scrolling and following a few accounts, then stepping away —
// far less bot-like than a fixed metronome, and the longer rests give X's
// rate-limit window time to reset between bursts.

// Proactive daily cap, counted per UTC calendar day from the follow log. We
// stop BEFORE X rate-limits us rather than sprinting until it pushes back.
// X's soft daily follow limit is ~400; staying under it avoids churn flags.
export const MAX_FOLLOWS_PER_DAY = 350;

// Safe long-running burst profile (default). ~33 follows/hour on average, so
// a full day's budget drains in ~10h, then the bot idles until UTC midnight.
export const CLUSTER_MIN = 2; // follows per burst
export const CLUSTER_MAX = 5;
export const INTRA_DELAY_MIN_SEC = 5; // seconds between follows within a burst
export const INTRA_DELAY_MAX_SEC = 20;
export const REST_DELAY_MIN_SEC = 180; // 3 min — rest between bursts
export const REST_DELAY_MAX_SEC = 480; // 8 min

// Burst mode (chain --burst): no daily cap, small fast clusters. Higher ban
// risk — for short, deliberate, attended runs only.
export const BURST_CLUSTER_MIN = 3;
export const BURST_CLUSTER_MAX = 5;
export const BURST_INTRA_DELAY_MIN_SEC = 3;
export const BURST_INTRA_DELAY_MAX_SEC = 10;
export const BURST_REST_DELAY_MIN_SEC = 30;
export const BURST_REST_DELAY_MAX_SEC = 90;

// ── Rate Limiting ─────────────────────────────────────────────
export const RATE_LIMIT_THRESHOLD = 3;
export const RATE_LIMIT_COOLDOWN_MIN = 15;
export const MAX_RATE_LIMIT_WAITS = 5;

// ── Chain Runner ──────────────────────────────────────────────
export const DRY_STREAK_THRESHOLD = 20;
export const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

// ── Profile Enrichment ────────────────────────────────────────
// Enrichment is READ-ONLY (visit profile, read DOM) — no follows/writes, so it
// is NOT exposed to follow limits or spam-follow detection. Pacing here only
// needs to (a) stay under X's read budget via the daily cap, and (b) avoid
// hammering page navigations fast enough to trip an anti-automation soft-lock.
// Hence brisk seconds-scale pacing, not the minutes-scale rests of following.
export const ENRICH_MAX_PER_DAY = 800;
export const ENRICH_CLUSTER_MIN = 8;
export const ENRICH_CLUSTER_MAX = 15;
export const ENRICH_INTRA_DELAY_MIN_SEC = 2;
export const ENRICH_INTRA_DELAY_MAX_SEC = 6;
export const ENRICH_REST_DELAY_MIN_SEC = 20;
export const ENRICH_REST_DELAY_MAX_SEC = 45;
export const RECENT_TWEETS_COUNT = 5;
