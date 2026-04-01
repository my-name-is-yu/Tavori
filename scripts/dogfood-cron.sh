#!/bin/bash
# CronScheduler dogfooding — verifies that scheduled tasks are detected as due,
# executed, and have their last_fired_at updated within a single daemon run.
# Run from project root: bash scripts/dogfood-cron.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PULSEED="node dist/cli-runner.js"
DATE="$(date +%Y-%m-%d)"
TMP_WORKSPACE="$(mktemp -d)"
# Use an isolated pulseed state dir so we never touch ~/.pulseed
PULSEED_STATE_DIR="$TMP_WORKSPACE/pulseed-state"
REPORT_FILE="$REPO_DIR/memory/dogfood-cron-${DATE}.md"
DAEMON_LOG="$TMP_WORKSPACE/daemon.log"
DAEMON_PID_FILE="$TMP_WORKSPACE/daemon.pid"
CONFIG_FILE="$TMP_WORKSPACE/daemon-config.json"

export PULSEED_HOME="$PULSEED_STATE_DIR"

# --- Cleanup on exit ---
cleanup() {
  # Stop daemon if still running
  if [ -f "$DAEMON_PID_FILE" ]; then
    DPID="$(cat "$DAEMON_PID_FILE")"
    if kill -0 "$DPID" 2>/dev/null; then
      echo "Stopping daemon (PID $DPID)..."
      PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED stop 2>/dev/null \
        || kill "$DPID" 2>/dev/null || true
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

echo "=== CronScheduler Dogfooding $(date) ==="
echo "Workspace:   $TMP_WORKSPACE"
echo "PulSeed dir: $PULSEED_STATE_DIR"
echo "Report:      $REPORT_FILE"

# --- Build ---
echo "--- Building project ---"
npm run build >/dev/null

# --- Create temp workspace (git repo for observation engine) ---
echo "--- Creating temp workspace ---"
mkdir -p "$TMP_WORKSPACE/src" "$PULSEED_STATE_DIR"

cat > "$TMP_WORKSPACE/package.json" <<'JSON'
{
  "name": "dogfood-cron",
  "version": "0.1.0",
  "type": "module"
}
JSON

cat > "$TMP_WORKSPACE/src/counter.ts" <<'TS'
// TODO: add overflow protection
export function increment(n: number): number {
  return n + 1;
}
TS

# Initialize as git repo (observation engine uses git diff)
(cd "$TMP_WORKSPACE" && git init -q && git add -A && git commit -q -m "initial seed")
echo "Workspace seed files created (git initialized)."

# --- Seed scheduled tasks ---
echo "--- Seeding scheduled tasks ---"
cat > "$PULSEED_STATE_DIR/scheduled-tasks.json" <<'JSON'
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "cron": "* * * * *",
    "prompt": "Check test coverage status",
    "type": "reflection",
    "enabled": true,
    "last_fired_at": null,
    "permanent": false,
    "created_at": "2026-04-01T00:00:00.000Z"
  },
  {
    "id": "550e8400-e29b-41d4-a716-446655440002",
    "cron": "* * * * *",
    "prompt": "Consolidate recent observations",
    "type": "consolidation",
    "enabled": true,
    "last_fired_at": null,
    "permanent": true,
    "created_at": "2026-04-01T00:00:00.000Z"
  }
]
JSON
echo "Scheduled tasks written to $PULSEED_STATE_DIR/scheduled-tasks.json"

# --- Create daemon config ---
echo "--- Creating daemon config ---"
cat > "$CONFIG_FILE" <<'JSON'
{
  "check_interval_ms": 10000
}
JSON
echo "Daemon config written to $CONFIG_FILE"

# --- Register goal ---
echo "--- Registering goal ---"
GOAL_OUTPUT=$(PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED goal add \
  --title "cron-scheduler-test" \
  --dim "todo_count:max:0" \
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
PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED start \
  --goal "$GOAL_ID" \
  --config "$CONFIG_FILE" \
  >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$DAEMON_PID_FILE"
echo "Daemon started (PID $DAEMON_PID), logging to $DAEMON_LOG"

# --- Wait ~90 seconds for at least 1 cron cycle ---
echo "--- Waiting 90 seconds for cron cycle to fire ---"
MONITOR_START=$(date +%s)
MONITOR_DURATION=90
CRON_DUE=0
CRON_FIRED=0

while true; do
  NOW=$(date +%s)
  ELAPSED=$(( NOW - MONITOR_START ))

  if [ $ELAPSED -ge $MONITOR_DURATION ]; then
    echo "Monitor window complete (${MONITOR_DURATION}s)."
    break
  fi

  # Check daemon is still alive
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "WARNING: Daemon process exited early (PID $DAEMON_PID)"
    break
  fi

  if [ -f "$DAEMON_LOG" ]; then
    CRON_DUE=$(grep -c "Cron task due:" "$DAEMON_LOG" 2>/dev/null || true)
    CRON_FIRED=$(grep -c "Cron task fired:" "$DAEMON_LOG" 2>/dev/null || true)
  fi

  printf "\r[%3ds] cron_due=%-3s  cron_fired=%-3s" \
    "$ELAPSED" "$CRON_DUE" "$CRON_FIRED"

  sleep 5
done
echo ""

# --- Stop daemon ---
echo "--- Stopping daemon ---"
PULSEED_HOME="$PULSEED_STATE_DIR" $PULSEED stop 2>/dev/null || {
  echo "stop command failed or not supported; sending SIGTERM to $DAEMON_PID"
  kill "$DAEMON_PID" 2>/dev/null || true
}
sleep 2
rm -f "$DAEMON_PID_FILE"

# --- Final counts from log ---
if [ -f "$DAEMON_LOG" ]; then
  CRON_DUE=$(grep -c "Cron task due:" "$DAEMON_LOG" 2>/dev/null || true)
  CRON_FIRED=$(grep -c "Cron task fired:" "$DAEMON_LOG" 2>/dev/null || true)
else
  CRON_DUE=0
  CRON_FIRED=0
fi

# --- Check last_fired_at was updated ---
TASKS_FILE="$PULSEED_STATE_DIR/scheduled-tasks.json"
FIRED_AT_UPDATED=0
if [ -f "$TASKS_FILE" ]; then
  # Count tasks where last_fired_at is not null
  FIRED_AT_UPDATED=$(python3 -c "
import json, sys
data = json.load(open('$TASKS_FILE'))
count = sum(1 for t in data if t.get('last_fired_at') is not None)
print(count)
" 2>/dev/null || echo "0")
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

[ "$CRON_DUE" -gt 0 ] \
  && check "CronScheduler.getDueTasks detected due tasks" "pass" "count=$CRON_DUE" \
  || check "CronScheduler.getDueTasks detected due tasks" "fail" "count=0 — check daemon cron integration"

[ "$CRON_FIRED" -gt 0 ] \
  && check "CronScheduler.markFired called" "pass" "count=$CRON_FIRED" \
  || check "CronScheduler.markFired called" "fail" "count=0 — tasks were not executed"

[ "$FIRED_AT_UPDATED" -gt 0 ] \
  && check "last_fired_at updated in scheduled-tasks.json" "pass" "tasks_updated=$FIRED_AT_UPDATED" \
  || check "last_fired_at updated in scheduled-tasks.json" "fail" "tasks_updated=0 — file may not have been written"

# --- Write markdown report ---
mkdir -p "$(dirname "$REPORT_FILE")"

cat > "$REPORT_FILE" <<MDHEADER
# CronScheduler Dogfood — ${DATE}

## Summary

- **Goal ID**: ${GOAL_ID}
- **Workspace**: ${TMP_WORKSPACE}
- **Dimension**: \`todo_count:max:0\`
- **Monitor duration**: 90 s
- **Passed checks**: ${PASS}
- **Failed checks**: ${FAIL}

## Scheduled Tasks Seeded

- \`550e8400-...0001\` — cron=\`* * * * *\`, type=reflection, permanent=false
- \`550e8400-...0002\` — cron=\`* * * * *\`, type=consolidation, permanent=true

## Config Used

\`\`\`json
$(cat "$CONFIG_FILE")
\`\`\`

## Observations

| Signal | Count |
|--------|-------|
| "Cron task due:" log lines | ${CRON_DUE} |
| "Cron task fired:" log lines | ${CRON_FIRED} |
| Tasks with last_fired_at updated | ${FIRED_AT_UPDATED} |

## Check Results

MDHEADER

if [ "$CRON_DUE" -gt 0 ]; then
  echo "- [x] CronScheduler.getDueTasks detected due tasks (count=$CRON_DUE)" >> "$REPORT_FILE"
else
  echo "- [ ] CronScheduler.getDueTasks detected due tasks — FAIL (count=0)" >> "$REPORT_FILE"
fi

if [ "$CRON_FIRED" -gt 0 ]; then
  echo "- [x] CronScheduler.markFired called (count=$CRON_FIRED)" >> "$REPORT_FILE"
else
  echo "- [ ] CronScheduler.markFired called — FAIL (count=0)" >> "$REPORT_FILE"
fi

if [ "$FIRED_AT_UPDATED" -gt 0 ]; then
  echo "- [x] last_fired_at updated in scheduled-tasks.json (tasks_updated=$FIRED_AT_UPDATED)" >> "$REPORT_FILE"
else
  echo "- [ ] last_fired_at updated in scheduled-tasks.json — FAIL (tasks_updated=0)" >> "$REPORT_FILE"
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

- [ ] "Cron task due:" appears at least twice (one per task)
- [ ] "Cron task fired:" appears at least twice (one per task)
- [ ] scheduled-tasks.json shows last_fired_at != null for both tasks
- [ ] Both reflection and consolidation task types were processed
- [ ] Daemon stops cleanly on `pulseed stop`
MDFOOTER

echo ""
echo "=== Dogfooding complete $(date) ==="
echo "PASS=$PASS  FAIL=$FAIL"
echo "Report: $REPORT_FILE"
