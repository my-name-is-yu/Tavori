#!/bin/bash
# Hook Lifecycle dogfooding — verifies that LoopCycleStart, PostObserve, and
# GoalStateChange hooks fire during a normal run.
# Run from project root: bash scripts/dogfood-hooks.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PULSEED="node dist/cli-runner.js"
DATE="$(date +%Y-%m-%d)"
TMP_WORKSPACE="/tmp/pulseed-dogfood-hooks-$$"
HOOKS_FILE="$HOME/.pulseed/hooks.json"
HOOKS_BACKUP="$HOME/.pulseed/hooks.json.bak-$$"
HOOK_LOG="/tmp/pulseed-hook-test.log"
REPORT_FILE="$REPO_DIR/memory/dogfood-hooks-${DATE}.md"
HOOKS_BACKED_UP=false

# --- Cleanup on exit ---
cleanup() {
  if [ "$HOOKS_BACKED_UP" = true ] && [ -f "$HOOKS_BACKUP" ]; then
    mv "$HOOKS_BACKUP" "$HOOKS_FILE"
    echo "Restored original hooks.json"
  elif [ "$HOOKS_BACKED_UP" = true ]; then
    rm -f "$HOOKS_FILE"
    echo "Removed test hooks.json (no original to restore)"
  fi
  if [ -d "$TMP_WORKSPACE" ]; then
    rm -rf "$TMP_WORKSPACE"
    echo "Cleaned up $TMP_WORKSPACE"
  fi
}
trap cleanup EXIT

echo "=== Hook Lifecycle Dogfooding $(date) ==="
echo "Workspace: $TMP_WORKSPACE"
echo "Hook log: $HOOK_LOG"
echo "Report: $REPORT_FILE"

# --- Build ---
echo "--- Building project ---"
npm run build >/dev/null

# --- Create temp workspace ---
echo "--- Creating temp workspace ---"
mkdir -p "$TMP_WORKSPACE/src"

cat > "$TMP_WORKSPACE/package.json" <<'JSON'
{
  "name": "dogfood-hooks",
  "version": "0.1.0",
  "type": "module"
}
JSON

cat > "$TMP_WORKSPACE/src/utils.ts" <<'TS'
// TODO: add input validation
// TODO: handle edge cases
// FIXME: missing error handling
export function add(a: number, b: number): number {
  return a + b;
}

// TODO: add more operations
export function subtract(a: number, b: number): number {
  return a - b;
}
TS

# Initialize as git repo (observation engine uses git diff)
(cd "$TMP_WORKSPACE" && git init -q && git add -A && git commit -q -m "initial seed")
echo "Workspace seed files created (git initialized)."
echo "Initial state: 3 TODOs, 1 FIXME, 0 tests."

# --- Install hooks config ---
echo "--- Installing hooks config ---"
mkdir -p "$HOME/.pulseed"

if [ -f "$HOOKS_FILE" ]; then
  cp "$HOOKS_FILE" "$HOOKS_BACKUP"
  HOOKS_BACKED_UP=true
  echo "Backed up existing hooks.json to $HOOKS_BACKUP"
else
  HOOKS_BACKED_UP=true
  echo "No existing hooks.json — will remove test config on exit"
fi

cat > "$HOOKS_FILE" <<'JSON'
{
  "hooks": [
    {
      "event": "LoopCycleStart",
      "type": "shell",
      "command": "echo \"HOOK_FIRED: LoopCycleStart\" >> /tmp/pulseed-hook-test.log",
      "timeout_ms": 5000,
      "enabled": true
    },
    {
      "event": "PostObserve",
      "type": "shell",
      "command": "echo \"HOOK_FIRED: PostObserve\" >> /tmp/pulseed-hook-test.log",
      "timeout_ms": 5000,
      "enabled": true
    },
    {
      "event": "GoalStateChange",
      "type": "shell",
      "command": "echo \"HOOK_FIRED: GoalStateChange\" >> /tmp/pulseed-hook-test.log",
      "timeout_ms": 5000,
      "enabled": true
    }
  ]
}
JSON

echo "hooks.json installed."

# --- Clear hook log ---
> "$HOOK_LOG"
echo "Cleared hook log: $HOOK_LOG"

# --- Register goal ---
echo "--- Registering goal ---"
GOAL_OUTPUT=$($PULSEED goal add \
  --title "hook-lifecycle-test" \
  --dim "test_count:min:3" \
  --constraint "workspace_path:$TMP_WORKSPACE" 2>&1)

echo "$GOAL_OUTPUT"
GOAL_ID=$(echo "$GOAL_OUTPUT" | grep "^Goal ID:" | awk '{print $NF}')

if [ -z "$GOAL_ID" ]; then
  echo "ERROR: Failed to parse Goal ID from goal add output"
  exit 1
fi

echo "Goal ID: $GOAL_ID"

# --- Run pulseed ---
echo "--- Running pulseed (max 3 iterations) ---"
RUN_LOG="/tmp/pulseed-dogfood-hooks-run-$$.log"
$PULSEED run --goal "$GOAL_ID" --yes --max-iterations 3 2>&1 | tee "$RUN_LOG" || true
RUN_EXIT="${PIPESTATUS[0]}"

echo "Run exit code: $RUN_EXIT"

# --- Check hook log ---
echo "--- Checking hook log ---"
echo "Contents of $HOOK_LOG:"
cat "$HOOK_LOG" || echo "(empty)"

LOOP_CYCLE_COUNT=$(grep -c "HOOK_FIRED: LoopCycleStart" "$HOOK_LOG" 2>/dev/null || true)
LOOP_CYCLE_COUNT=${LOOP_CYCLE_COUNT:-0}
POST_OBSERVE_COUNT=$(grep -c "HOOK_FIRED: PostObserve" "$HOOK_LOG" 2>/dev/null || true)
POST_OBSERVE_COUNT=${POST_OBSERVE_COUNT:-0}
GOAL_STATE_COUNT=$(grep -c "HOOK_FIRED: GoalStateChange" "$HOOK_LOG" 2>/dev/null || true)
GOAL_STATE_COUNT=${GOAL_STATE_COUNT:-0}
TOTAL_COUNT=$(grep -c "HOOK_FIRED:" "$HOOK_LOG" 2>/dev/null || true)
TOTAL_COUNT=${TOTAL_COUNT:-0}

echo ""
echo "--- Hook fire counts ---"
echo "LoopCycleStart : $LOOP_CYCLE_COUNT"
echo "PostObserve    : $POST_OBSERVE_COUNT"
echo "GoalStateChange: $GOAL_STATE_COUNT"
echo "Total          : $TOTAL_COUNT"

# --- Determine pass/fail ---
PASS=true
FAILURES=""

if [ "$LOOP_CYCLE_COUNT" -lt 1 ]; then
  PASS=false
  FAILURES="${FAILURES}\n- FAIL: LoopCycleStart did not fire (count=$LOOP_CYCLE_COUNT, expected >=1)"
else
  echo "PASS: LoopCycleStart fired $LOOP_CYCLE_COUNT time(s)"
fi

if [ "$POST_OBSERVE_COUNT" -lt 1 ]; then
  PASS=false
  FAILURES="${FAILURES}\n- FAIL: PostObserve did not fire (count=$POST_OBSERVE_COUNT, expected >=1)"
else
  echo "PASS: PostObserve fired $POST_OBSERVE_COUNT time(s)"
fi

# GoalStateChange may or may not fire depending on whether state changes — just report
if [ "$GOAL_STATE_COUNT" -ge 1 ]; then
  echo "INFO: GoalStateChange fired $GOAL_STATE_COUNT time(s)"
else
  echo "INFO: GoalStateChange did not fire (may be expected if state did not change)"
fi

# --- Write markdown report ---
mkdir -p "$(dirname "$REPORT_FILE")"

HOOK_LOG_CONTENTS=$(cat "$HOOK_LOG" 2>/dev/null || echo "(empty)")

if [ "$PASS" = true ]; then
  RESULT_LABEL="PASS"
else
  RESULT_LABEL="FAIL"
fi

cat > "$REPORT_FILE" <<MDHEADER
# Hook Lifecycle Dogfood — ${DATE}

## Summary

- **Result**: ${RESULT_LABEL}
- **Goal ID**: ${GOAL_ID}
- **Workspace**: ${TMP_WORKSPACE}
- **Dimensions**: \`test_count:min:3\`
- **Max iterations**: 3
- **Run exit code**: ${RUN_EXIT}

## Hook Fire Counts

| Event | Count |
|-------|-------|
| LoopCycleStart | ${LOOP_CYCLE_COUNT} |
| PostObserve | ${POST_OBSERVE_COUNT} |
| GoalStateChange | ${GOAL_STATE_COUNT} |
| **Total** | **${TOTAL_COUNT}** |

## Objective

Verify that hooks registered in \`~/.pulseed/hooks.json\` fire during a normal run:
- \`LoopCycleStart\` fires at least once per iteration
- \`PostObserve\` fires after each observation
- \`GoalStateChange\` fires when goal state transitions occur

## Hook Log (/tmp/pulseed-hook-test.log)

\`\`\`
MDHEADER

echo "$HOOK_LOG_CONTENTS" >> "$REPORT_FILE"

cat >> "$REPORT_FILE" <<'MDSEP'
```

## Full Run Log

```
MDSEP

cat "$RUN_LOG" >> "$REPORT_FILE"

cat >> "$REPORT_FILE" <<MDFOOTER
\`\`\`

## Verification Checklist

- [$([ "$LOOP_CYCLE_COUNT" -ge 1 ] && echo "x" || echo " ")] LoopCycleStart fired at least once
- [$([ "$POST_OBSERVE_COUNT" -ge 1 ] && echo "x" || echo " ")] PostObserve fired at least once
- [$([ "$GOAL_STATE_COUNT" -ge 1 ] && echo "x" || echo " ")] GoalStateChange fired (optional)
- [$([ "$TOTAL_COUNT" -ge 1 ] && echo "x" || echo " ")] At least one hook fired in total
MDFOOTER

rm -f "$RUN_LOG"

echo ""
echo "=== Dogfooding complete $(date) ==="
echo "Result: $RESULT_LABEL"
echo "Report: $REPORT_FILE"

if [ "$PASS" != true ]; then
  echo ""
  echo "Failures:"
  echo -e "$FAILURES"
  exit 1
fi
