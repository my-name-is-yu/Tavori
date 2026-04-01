#!/bin/bash
# Self-improvement dogfooding — runs PulSeed against its own codebase
# to fix issues from GitHub issues #364, #363, #366, #365, #388.
# Run from project root: bash scripts/dogfood-self-improve.sh
#
# Duration: up to 2 hours. Does NOT commit or push.

set +e  # Don't exit on error — we want all phases to run

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PULSEED="node dist/cli-runner.js"
DATE="$(date +%Y%m%d)"
BRANCH="dogfood/self-improve-${DATE}"
LOG_DIR="/tmp/pulseed-self-improve-${DATE}-$$"
TIMEOUT_SECONDS=7200  # 2 hours

mkdir -p "$LOG_DIR"

echo "=== PulSeed Self-Improvement Dogfood $(date) ===" | tee "$LOG_DIR/summary.log"
echo "Branch: $BRANCH" | tee -a "$LOG_DIR/summary.log"
echo "Logs: $LOG_DIR" | tee -a "$LOG_DIR/summary.log"

# --- Build ---
echo "--- Building project ---" | tee -a "$LOG_DIR/summary.log"
npm run build 2>&1 | tee "$LOG_DIR/build.log"
if [ $? -ne 0 ]; then
  echo "FAIL: Build failed" | tee -a "$LOG_DIR/summary.log"
  exit 1
fi

# --- Create feature branch ---
echo "--- Creating branch $BRANCH ---" | tee -a "$LOG_DIR/summary.log"
git checkout -b "$BRANCH" 2>&1 | tee -a "$LOG_DIR/summary.log"

# --- Register goals ---
ISSUES=(364 363 366 365 388)
GOAL_IDS=()

for ISSUE in "${ISSUES[@]}"; do
  echo "--- Registering goal for issue #${ISSUE} ---" | tee -a "$LOG_DIR/summary.log"
  GOAL_OUTPUT=$($PULSEED goal add \
    --title "Fix issue #${ISSUE}" \
    --dim "test_pass_count:min:1" \
    --constraint "workspace_path:${REPO_DIR}" 2>&1)
  echo "$GOAL_OUTPUT" | tee "$LOG_DIR/goal-${ISSUE}.log"
  GOAL_ID=$(echo "$GOAL_OUTPUT" | grep "Goal ID:" | awk '{print $NF}')

  if [ -z "$GOAL_ID" ]; then
    echo "WARN: Failed to create goal for issue #${ISSUE}" | tee -a "$LOG_DIR/summary.log"
  else
    echo "Goal for #${ISSUE}: $GOAL_ID" | tee -a "$LOG_DIR/summary.log"
    GOAL_IDS+=("$GOAL_ID")
  fi
done

if [ ${#GOAL_IDS[@]} -eq 0 ]; then
  echo "FAIL: No goals created" | tee -a "$LOG_DIR/summary.log"
  exit 1
fi

# --- Run daemon ---
echo "--- Starting daemon (max ${TIMEOUT_SECONDS}s, check_interval=30s) ---" | tee -a "$LOG_DIR/summary.log"

GOAL_ARGS=""
for GID in "${GOAL_IDS[@]}"; do
  GOAL_ARGS="$GOAL_ARGS --goal $GID"
done

timeout "$TIMEOUT_SECONDS" $PULSEED daemon start \
  $GOAL_ARGS \
  --yes \
  --check-interval-ms 30000 \
  2>&1 | tee "$LOG_DIR/daemon.log"
DAEMON_EXIT=$?

echo "Daemon exit code: $DAEMON_EXIT" | tee -a "$LOG_DIR/summary.log"

# --- Results ---
echo "" | tee -a "$LOG_DIR/summary.log"
echo "=== Results ===" | tee -a "$LOG_DIR/summary.log"

PASS_COUNT=0
FAIL_COUNT=0

for i in "${!ISSUES[@]}"; do
  ISSUE="${ISSUES[$i]}"
  GID="${GOAL_IDS[$i]:-}"
  if [ -z "$GID" ]; then
    echo "#${ISSUE}: SKIP (no goal created)" | tee -a "$LOG_DIR/summary.log"
    continue
  fi

  # Check goal status
  STATUS_OUTPUT=$($PULSEED goal status "$GID" 2>&1 || true)
  if echo "$STATUS_OUTPUT" | grep -qi "completed\|satisfied"; then
    echo "#${ISSUE} ($GID): PASS" | tee -a "$LOG_DIR/summary.log"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "#${ISSUE} ($GID): FAIL" | tee -a "$LOG_DIR/summary.log"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

echo "" | tee -a "$LOG_DIR/summary.log"
echo "PASS: $PASS_COUNT / ${#ISSUES[@]}" | tee -a "$LOG_DIR/summary.log"
echo "FAIL: $FAIL_COUNT / ${#ISSUES[@]}" | tee -a "$LOG_DIR/summary.log"

# --- Do NOT commit or push ---
echo "" | tee -a "$LOG_DIR/summary.log"
echo "NOTE: Changes are on branch '$BRANCH' but NOT committed or pushed." | tee -a "$LOG_DIR/summary.log"
echo "=== Dogfooding complete $(date) ===" | tee -a "$LOG_DIR/summary.log"
echo "Logs: $LOG_DIR"
