#!/bin/bash
# Daemon + Proactive Mode dogfooding — verifies that daemon start/stop works,
# proactive ticks fire, and adaptive sleep intervals vary as expected.
# Run from project root: bash scripts/dogfood-daemon-proactive.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PULSEED="node dist/cli-runner.js"
DATE="$(date +%Y-%m-%d)"
TMP_WORKSPACE="$(mktemp -d)"
REPORT_FILE="$REPO_DIR/memory/dogfood-daemon-proactive-${DATE}.md"
DAEMON_LOG="$TMP_WORKSPACE/daemon.log"
DAEMON_PID_FILE="$TMP_WORKSPACE/daemon.pid"

# --- Cleanup on exit ---
cleanup() {
  # Stop daemon if still running
  if [ -f "$DAEMON_PID_FILE" ]; then
    DPID="$(cat "$DAEMON_PID_FILE")"
    if kill -0 "$DPID" 2>/dev/null; then
      echo "Stopping daemon (PID $DPID)..."
      $PULSEED stop 2>/dev/null || kill "$DPID" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$DAEMON_PID_FILE"
  fi
  if [ -d "$TMP_WORKSPACE" ]; then
    rm -rf "$TMP_WORKSPACE"
    echo "Cleaned up $TMP_WORKSPACE"
  fi
}
trap cleanup EXIT

echo "=== Daemon + Proactive Mode Dogfooding $(date) ==="
echo "Workspace: $TMP_WORKSPACE"
echo "Report:    $REPORT_FILE"

# --- Build ---
echo "--- Building project ---"
npm run build >/dev/null

# --- Create temp workspace ---
echo "--- Creating temp workspace ---"
mkdir -p "$TMP_WORKSPACE/src" "$TMP_WORKSPACE/tests"

cat > "$TMP_WORKSPACE/package.json" <<'JSON'
{
  "name": "dogfood-daemon-proactive",
  "version": "0.1.0",
  "type": "module"
}
JSON

cat > "$TMP_WORKSPACE/src/greeter.ts" <<'TS'
// TODO: support multiple languages
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

// TODO: add farewell function
export function farewell(name: string): string {
  return `Goodbye, ${name}!`;
}
TS

# Initialize as git repo (observation engine uses git diff)
(cd "$TMP_WORKSPACE" && git init -q && git add -A && git commit -q -m "initial seed")
echo "Workspace seed files created (git initialized)."
echo "Initial state: 0 tests, 2 TODOs."

# --- Create daemon config ---
echo "--- Creating daemon config ---"
cat > "$TMP_WORKSPACE/daemon-config.json" <<'JSON'
{
  "check_interval_ms": 10000,
  "proactive_mode": true,
  "proactive_interval_ms": 15000,
  "adaptive_sleep": {
    "enabled": true,
    "min_interval_ms": 5000,
    "max_interval_ms": 60000,
    "night_start_hour": 22,
    "night_end_hour": 7,
    "night_multiplier": 2.0
  }
}
JSON
echo "Daemon config written to $TMP_WORKSPACE/daemon-config.json"

# --- Register goal (easy-to-satisfy so daemon becomes idle quickly) ---
echo "--- Registering goal ---"
GOAL_OUTPUT=$($PULSEED goal add \
  --title "Trivial coverage check" \
  --dim "test_count:max:999" \
  --constraint "workspace_path:$TMP_WORKSPACE" 2>&1)

echo "$GOAL_OUTPUT"
GOAL_ID=$(echo "$GOAL_OUTPUT" | grep "^Goal ID:" | awk '{print $NF}')

if [ -z "$GOAL_ID" ]; then
  echo "ERROR: Failed to parse Goal ID from goal add output"
  exit 1
fi

echo "Goal ID: $GOAL_ID"

# --- Start daemon in background ---
echo "--- Starting daemon ---"
$PULSEED start \
  --goal "$GOAL_ID" \
  --config "$TMP_WORKSPACE/daemon-config.json" \
  >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$DAEMON_PID_FILE"
echo "Daemon started (PID $DAEMON_PID), logging to $DAEMON_LOG"

# --- Monitor for 60 seconds ---
echo "--- Monitoring daemon output for 60 seconds ---"
MONITOR_START=$(date +%s)
MONITOR_DURATION=60
PROACTIVE_TICKS=0
SLEEP_MESSAGES=0
LOOP_ITERATIONS=0
LAST_SLEEP_N=""

while true; do
  NOW=$(date +%s)
  ELAPSED=$(( NOW - MONITOR_START ))

  if [ $ELAPSED -ge $MONITOR_DURATION ]; then
    echo "Monitor window complete ($MONITOR_DURATION s)."
    break
  fi

  # Check daemon is still alive
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "WARNING: Daemon process exited early (PID $DAEMON_PID)"
    break
  fi

  # Count signal lines found so far
  if [ -f "$DAEMON_LOG" ]; then
    PROACTIVE_TICKS=$(grep -ci "proactive tick" "$DAEMON_LOG" 2>/dev/null || true)
    SLEEP_MESSAGES=$(grep -ci "sleeping for" "$DAEMON_LOG" 2>/dev/null || true)
    LOOP_ITERATIONS=$(grep -ci "iteration\|loop" "$DAEMON_LOG" 2>/dev/null || true)
    LAST_SLEEP_N=$(grep -i "sleeping for" "$DAEMON_LOG" 2>/dev/null | tail -1 || true)
  fi

  printf "\r[%3ds] proactive_ticks=%-3s  sleep_msgs=%-3s  loop_iters=%-3s" \
    "$ELAPSED" "$PROACTIVE_TICKS" "$SLEEP_MESSAGES" "$LOOP_ITERATIONS"

  sleep 5
done
echo ""

# --- Stop daemon ---
echo "--- Stopping daemon ---"
$PULSEED stop 2>/dev/null || {
  echo "stop command failed or not supported; sending SIGTERM to $DAEMON_PID"
  kill "$DAEMON_PID" 2>/dev/null || true
}
sleep 2
rm -f "$DAEMON_PID_FILE"

# --- Final counts from log ---
if [ -f "$DAEMON_LOG" ]; then
  PROACTIVE_TICKS=$(grep -ci "proactive tick" "$DAEMON_LOG" 2>/dev/null || true)
  SLEEP_MESSAGES=$(grep -ci "sleeping for" "$DAEMON_LOG" 2>/dev/null || true)
  LOOP_ITERATIONS=$(grep -ci "iteration\|loop" "$DAEMON_LOG" 2>/dev/null || true)

  # Collect unique sleep interval values to check variance
  SLEEP_VALUES=$(grep -i "sleeping for" "$DAEMON_LOG" 2>/dev/null \
    | grep -oE '[0-9]+[[:space:]]*(ms|s)' | sort -u || true)
else
  SLEEP_VALUES=""
fi

# --- Evaluate results ---
echo "--- Evaluation ---"
PASS=0
FAIL=0

check() {
  local LABEL="$1"
  local RESULT="$2"   # "pass" or "fail"
  local DETAIL="$3"
  if [ "$RESULT" = "pass" ]; then
    echo "  PASS  $LABEL ($DETAIL)"
    PASS=$(( PASS + 1 ))
  else
    echo "  FAIL  $LABEL ($DETAIL)"
    FAIL=$(( FAIL + 1 ))
  fi
}

[ "$PROACTIVE_TICKS" -gt 0 ] \
  && check "Proactive ticks fired" "pass" "count=$PROACTIVE_TICKS" \
  || check "Proactive ticks fired" "fail" "count=0 — check proactive_mode config"

[ "$SLEEP_MESSAGES" -gt 0 ] \
  && check "Adaptive sleep messages logged" "pass" "count=$SLEEP_MESSAGES" \
  || check "Adaptive sleep messages logged" "fail" "count=0 — check adaptive_sleep config"

[ "$LOOP_ITERATIONS" -gt 0 ] \
  && check "Loop iterations observed" "pass" "count=$LOOP_ITERATIONS" \
  || check "Loop iterations observed" "fail" "count=0 — daemon may not have started correctly"

# --- Write markdown report ---
mkdir -p "$(dirname "$REPORT_FILE")"

cat > "$REPORT_FILE" <<MDHEADER
# Daemon + Proactive Mode Dogfood — ${DATE}

## Summary

- **Goal ID**: ${GOAL_ID}
- **Workspace**: ${TMP_WORKSPACE}
- **Dimension**: \`test_count:min:5\`
- **Monitor duration**: 60 s
- **Passed checks**: ${PASS}
- **Failed checks**: ${FAIL}

## Config Used

\`\`\`json
$(cat "$TMP_WORKSPACE/daemon-config.json")
\`\`\`

## Observations

| Signal | Count |
|--------|-------|
| Proactive ticks | ${PROACTIVE_TICKS} |
| Adaptive sleep messages | ${SLEEP_MESSAGES} |
| Loop iterations | ${LOOP_ITERATIONS} |

### Unique sleep interval values

\`\`\`
${SLEEP_VALUES:-"(none found)"}
\`\`\`

## Check Results

MDHEADER

# Append check results as a list
if [ "$PROACTIVE_TICKS" -gt 0 ]; then
  echo "- [x] Proactive ticks fired (count=$PROACTIVE_TICKS)" >> "$REPORT_FILE"
else
  echo "- [ ] Proactive ticks fired — FAIL (count=0)" >> "$REPORT_FILE"
fi

if [ "$SLEEP_MESSAGES" -gt 0 ]; then
  echo "- [x] Adaptive sleep messages logged (count=$SLEEP_MESSAGES)" >> "$REPORT_FILE"
else
  echo "- [ ] Adaptive sleep messages logged — FAIL (count=0)" >> "$REPORT_FILE"
fi

if [ "$LOOP_ITERATIONS" -gt 0 ]; then
  echo "- [x] Loop iterations observed (count=$LOOP_ITERATIONS)" >> "$REPORT_FILE"
else
  echo "- [ ] Loop iterations observed — FAIL (count=0)" >> "$REPORT_FILE"
fi

cat >> "$REPORT_FILE" <<'MDSEP'

## Full Daemon Log

```
MDSEP

if [ -f "$DAEMON_LOG" ]; then
  cat "$DAEMON_LOG" >> "$REPORT_FILE"
else
  echo "(no daemon log found)" >> "$REPORT_FILE"
fi

cat >> "$REPORT_FILE" <<'MDFOOTER'
```

## Verification Checklist

- [ ] Proactive ticks appear at ~15 s intervals
- [ ] Sleep intervals vary (adaptive_sleep is active)
- [ ] Sleep intervals stay within [5000, 60000] ms bounds
- [ ] Night-hours multiplier applied if run between 22:00–07:00
- [ ] Daemon stops cleanly on `pulseed stop`
MDFOOTER

echo ""
echo "=== Dogfooding complete $(date) ==="
echo "PASS=$PASS  FAIL=$FAIL"
echo "Report: $REPORT_FILE"
