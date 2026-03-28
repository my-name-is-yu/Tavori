#!/bin/bash
# M13 Dogfooding — overnight validation
# Run from project root: bash scripts/overnight-m13-dogfood.sh

set +e  # Don't exit on error — we want both phases to run

PULSEED="node dist/cli-runner.js"
LOG_DIR="memory/archive/.overnight-m13-$(date +%Y-%m-%d)-$$"
mkdir -p "$LOG_DIR"

echo "=== M13 Dogfooding $(date) ===" | tee "$LOG_DIR/summary.log"

# --- Cleanup leftover test plugin artifacts ---
echo "--- Cleaning up test plugin artifacts ---" | tee -a "$LOG_DIR/summary.log"
for plugin in existing-plugin my-plugin shell-plugin; do
  if [ -d "$HOME/.pulseed/plugins/$plugin" ]; then
    echo "Removing test artifact: $plugin" | tee -a "$LOG_DIR/summary.log"
    rm -rf "$HOME/.pulseed/plugins/$plugin"
  fi
done

# --- Phase 1: General quality (tsc errors) ---
echo "--- Phase 1: tsc_error_count:min:0 ---" | tee -a "$LOG_DIR/summary.log"

# Add goal (raw mode, no LLM)
GOAL1_OUTPUT=$($PULSEED goal add --title "zero-tsc-errors" --dim "tsc_error_count:min:0" 2>&1)
echo "$GOAL1_OUTPUT" | tee "$LOG_DIR/phase1-goal-add.log"
GOAL1_ID=$(echo "$GOAL1_OUTPUT" | grep "Goal ID:" | awk '{print $NF}')

if [ -z "$GOAL1_ID" ]; then
  echo "ERROR: Failed to create goal 1" | tee -a "$LOG_DIR/summary.log"
else
  echo "Goal 1: $GOAL1_ID" | tee -a "$LOG_DIR/summary.log"
  $PULSEED run --goal "$GOAL1_ID" --yes --max-iterations 3 2>&1 | tee "$LOG_DIR/phase1.log"
  echo "Phase 1 exit: $?" | tee -a "$LOG_DIR/summary.log"
fi

# --- Phase 2: Plugin matching test ---
echo "--- Phase 2: Plugin matching ---" | tee -a "$LOG_DIR/summary.log"

# Create a test data_source plugin with dimensions matching a goal
PLUGIN_DIR="$HOME/.pulseed/plugins/test-coverage-source"
mkdir -p "$PLUGIN_DIR"
cat > "$PLUGIN_DIR/plugin.yaml" <<'YAML'
name: test-coverage-source
version: "1.0.0"
type: data_source
capabilities:
  - observe_test_coverage
dimensions:
  - test_coverage
  - test_count
  - branch_coverage
description: "Data source plugin that observes test coverage metrics"
config_schema: {}
dependencies: []
permissions:
  shell: true
YAML
echo "Created plugin at $PLUGIN_DIR" | tee -a "$LOG_DIR/summary.log"

# Add goal with dimensions that should match the plugin
GOAL2_OUTPUT=$($PULSEED goal add --title "improve-test-coverage" --dim "test_coverage:min:80" --dim "test_count:min:4000" 2>&1)
echo "$GOAL2_OUTPUT" | tee "$LOG_DIR/phase2-goal-add.log"
GOAL2_ID=$(echo "$GOAL2_OUTPUT" | grep "Goal ID:" | awk '{print $NF}')

if [ -z "$GOAL2_ID" ]; then
  echo "ERROR: Failed to create goal 2" | tee -a "$LOG_DIR/summary.log"
else
  echo "Goal 2: $GOAL2_ID" | tee -a "$LOG_DIR/summary.log"
  $PULSEED run --goal "$GOAL2_ID" --yes --max-iterations 2 2>&1 | tee "$LOG_DIR/phase2.log"
  echo "Phase 2 exit: $?" | tee -a "$LOG_DIR/summary.log"
fi

# --- Summary ---
echo "" | tee -a "$LOG_DIR/summary.log"
echo "=== Dogfooding complete $(date) ===" | tee -a "$LOG_DIR/summary.log"
echo "Logs: $LOG_DIR" | tee -a "$LOG_DIR/summary.log"

# Show plugin list to verify plugin was detected
echo "--- Plugin list ---" | tee -a "$LOG_DIR/summary.log"
$PULSEED plugin list 2>&1 | tee -a "$LOG_DIR/summary.log"
