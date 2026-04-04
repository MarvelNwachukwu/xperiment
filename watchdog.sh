#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/chain-state.json"
LOG_FILE="$SCRIPT_DIR/chain-log.txt"
STALE_MINUTES=10

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] WATCHDOG: $1" >> "$LOG_FILE"
}

# Check if state file exists
if [ ! -f "$STATE_FILE" ]; then
  log "No chain-state.json found. Nothing to watch."
  exit 0
fi

# Read status — if not paused/running, skip
STATUS=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['status'])" 2>/dev/null || echo "unknown")
if [ "$STATUS" = "unknown" ]; then
  log "Could not read state file. Skipping."
  exit 0
fi

# Read last heartbeat
HEARTBEAT=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['lastHeartbeat'])" 2>/dev/null || echo "")
if [ -z "$HEARTBEAT" ]; then
  log "No heartbeat found. Restarting."
else
  # Check if heartbeat is stale
  HEARTBEAT_EPOCH=$(date -jf "%Y-%m-%dT%H:%M:%S" "$(echo "$HEARTBEAT" | cut -d. -f1 | sed 's/Z$//')" +%s 2>/dev/null || date -d "$HEARTBEAT" +%s 2>/dev/null || echo "0")
  NOW_EPOCH=$(date +%s)
  AGE_MIN=$(( (NOW_EPOCH - HEARTBEAT_EPOCH) / 60 ))

  if [ "$AGE_MIN" -lt "$STALE_MINUTES" ]; then
    # Heartbeat is fresh — script is alive
    exit 0
  fi

  log "Heartbeat is ${AGE_MIN}m old (threshold: ${STALE_MINUTES}m). Script is dead or hung."
fi

# Kill any hung process
PIDS=$(pgrep -f "chain-runner" || true)
if [ -n "$PIDS" ]; then
  log "Killing hung chain-runner processes: $PIDS"
  kill $PIDS 2>/dev/null || true
  sleep 2
  kill -9 $PIDS 2>/dev/null || true
fi

# Restart
log "Restarting chain-runner with --resume"
cd "$SCRIPT_DIR"
nohup npx tsx chain-runner.ts --resume >> "$LOG_FILE" 2>&1 &
log "Restarted with PID $!"
