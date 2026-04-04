import * as path from "path";

// ── Paths ─────────────────────────────────────────────────────
export const LOG_FILE = path.join(__dirname, "follow-log.json");
export const PROFILE_DIR = path.join(__dirname, ".chrome-profile");
export const CHAIN_STATE_FILE = path.join(__dirname, "chain-state.json");
export const CHAIN_LOG_FILE = path.join(__dirname, "chain-log.txt");

// ── Follow Engine ─────────────────────────────────────────────
export const MIN_DELAY_SEC = 15;
export const MAX_DELAY_SEC = 45;
export const FOLLOW_TIMEOUT_MS = 5000;
export const SCROLL_WAIT_MS = 5000;

// ── Rate Limiting ─────────────────────────────────────────────
export const RATE_LIMIT_THRESHOLD = 3;
export const RATE_LIMIT_COOLDOWN_MIN = 15;
export const MAX_RATE_LIMIT_WAITS = 5;

// ── Chain Runner ──────────────────────────────────────────────
export const DRY_STREAK_THRESHOLD = 20;
export const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
