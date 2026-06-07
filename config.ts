import * as path from "path";

// ── Paths ─────────────────────────────────────────────────────
export const LOG_FILE = path.join(__dirname, "follow-log.json");
export const PROFILE_DIR = path.join(__dirname, ".chrome-profile");
export const CHAIN_STATE_FILE = path.join(__dirname, "chain-state.json");
export const CHAIN_LOG_FILE = path.join(__dirname, "chain-log.txt");

// ── Follow Engine ─────────────────────────────────────────────
// Delays are deliberately wide so follows trickle out instead of bursting.
// Bursting then stalling on a cooldown is exactly the pattern X's spam
// heuristics flag. At ~195s average, MAX_FOLLOWS_PER_DAY worth of follows
// spreads naturally across ~16h — no proactive scheduling needed.
export const MIN_DELAY_SEC = 90;
export const MAX_DELAY_SEC = 300;
export const FOLLOW_TIMEOUT_MS = 5000;
export const SCROLL_WAIT_MS = 5000;

// Proactive daily cap. We stop BEFORE X rate-limits us rather than sprinting
// until it pushes back. Counted per UTC calendar day from the follow log.
// X's soft daily follow limit is ~400; staying under it avoids churn flags.
export const MAX_FOLLOWS_PER_DAY = 300;

// Burst mode (chain --burst): no daily cap and the old fast delays. Higher
// ban risk — for short, deliberate one-off runs, not unattended cron use.
export const BURST_MIN_DELAY_SEC = 15;
export const BURST_MAX_DELAY_SEC = 45;

// ── Rate Limiting ─────────────────────────────────────────────
export const RATE_LIMIT_THRESHOLD = 3;
export const RATE_LIMIT_COOLDOWN_MIN = 15;
export const MAX_RATE_LIMIT_WAITS = 5;

// ── Chain Runner ──────────────────────────────────────────────
export const DRY_STREAK_THRESHOLD = 20;
export const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
