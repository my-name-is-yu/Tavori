#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

DATE_TAG="$(date +%F)"
START_TS="$(date '+%F %T %Z')"
REPORT_DIR="$REPO_DIR/memory"
RUN_TAG="$(date +%H%M%S)"
REPORT="$REPORT_DIR/overnight-${DATE_TAG}-${RUN_TAG}.md"

mkdir -p "$REPORT_DIR"

say() { printf "%s\n" "$*"; }
hr() { printf "%s\n" "---"; }

TMP_DIR="$REPO_DIR/memory/.overnight-tmp-${DATE_TAG}-$$"
mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

# 7 curated goals aimed at improving PulSeed itself.
# Keep descriptions concrete and verification-oriented so PulSeed can drive changes.
GOALS=(
  "Fix 'pulseed suggest' so it returns actionable improvement goals for this repo. Ensure it uses repo context (--path .) and doesn't prematurely return empty. Align behavior with docs/design where applicable. Add/adjust tests."
  "Harden CLI UX around API/provider configuration: ensure error messages mention the correct env vars for OpenAI vs Anthropic vs Codex; add tests for missing/invalid provider config. Follow docs/design/provider spec."
  "Stability: make 'pulseed run' resilient to adapter failures/timeouts (clear reporting, non-zero exits, no silent success). Add tests to cover adapter error propagation."
  "Docs/design alignment pass: pick one subsystem with drift (goal negotiation / observation / verification) and align implementation to docs/design. Add a regression test demonstrating the spec."
  "Improve state integrity: detect and repair/avoid corrupted goal state files under ~/.pulseed (e.g., partial writes). Add atomic write strategy or validation + recovery. Tests required."
  "TUI reliability: ensure TUI start doesn't crash without optional dependencies/config and handles missing goals gracefully. Add tests or a smoke test harness."
  "Performance/ergonomics: reduce unnecessary LLM calls in one core path (e.g., observation dedup/context) while preserving correctness. Add a unit test proving fewer calls in a mocked scenario."
)

say "# PulSeed overnight loop (${DATE_TAG})" > "$REPORT"
say "" >> "$REPORT"
say "Started: ${START_TS}" >> "$REPORT"
say "Repo: ${REPO_DIR}" >> "$REPORT"
say "" >> "$REPORT"

say "## Environment" >> "$REPORT"
say "- node: $(node -v)" >> "$REPORT"
say "- npm: $(npm -v)" >> "$REPORT"
say "" >> "$REPORT"

say "## Provider" >> "$REPORT"
{
  say "\`\`\`json";
  node dist/cli-runner.js provider show;
  say "\`\`\`";
} >> "$REPORT" 2>/dev/null || true

say "" >> "$REPORT"
hr >> "$REPORT"

# Ensure build works before starting.
npm run build >/dev/null

for i in $(seq 1 7); do
  ITER_TS="$(date '+%F %T %Z')"
  DESC="${GOALS[$((i-1))]}"

  OUT_ADD="$TMP_DIR/goal-add-${i}.log"
  OUT_RUN="$TMP_DIR/run-${i}.log"
  OUT_BUILD="$TMP_DIR/build-${i}.log"
  OUT_TEST="$TMP_DIR/test-${i}.log"

  say "" >> "$REPORT"
  say "# Iteration $i" >> "$REPORT"
  say "Started: ${ITER_TS}" >> "$REPORT"
  say "" >> "$REPORT"

  say "## Goal" >> "$REPORT"
  say "${DESC}" >> "$REPORT"
  say "" >> "$REPORT"

  # 1) Goal add (auto-accept counter proposal)
  set +e
  node dist/cli-runner.js goal add "$DESC" --yes >"$OUT_ADD" 2>&1
  ADD_CODE=$?
  set -e

  GOAL_ID="$(grep -E "^Goal ID:" "$OUT_ADD" | head -n 1 | awk '{print $3}' || true)"

  say "## Goal registration" >> "$REPORT"
  say "- exit: ${ADD_CODE}" >> "$REPORT"
  if [[ -n "$GOAL_ID" ]]; then
    say "- goal_id: ${GOAL_ID}" >> "$REPORT"
  else
    say "- goal_id: (not parsed)" >> "$REPORT"
  fi

  if [[ $ADD_CODE -ne 0 || -z "$GOAL_ID" ]]; then
    say "- status: failed to register goal" >> "$REPORT"
    say "- tail:" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
    tail -n 80 "$OUT_ADD" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
    hr >> "$REPORT"
    # Can't proceed without a goal id.
    continue
  fi
  say "" >> "$REPORT"

  # 2) Run PulSeed for that goal (bounded iterations)
  set +e
  node dist/cli-runner.js run --goal "$GOAL_ID" --yes --max-iterations 12 >"$OUT_RUN" 2>&1
  RUN_CODE=$?
  set -e

  FINAL_STATUS="$(grep -E "^Final status:" "$OUT_RUN" | head -n 1 | sed -E 's/^Final status:\s+//' || true)"
  TOTAL_ITERS="$(grep -E "^Total iterations:" "$OUT_RUN" | head -n 1 | sed -E 's/^Total iterations:\s+//' || true)"

  say "## PulSeed run" >> "$REPORT"
  say "- command: pulseed run --goal ${GOAL_ID} --yes --max-iterations 12" >> "$REPORT"
  say "- exit: ${RUN_CODE}" >> "$REPORT"
  [[ -n "$FINAL_STATUS" ]] && say "- final_status: ${FINAL_STATUS}" >> "$REPORT"
  [[ -n "$TOTAL_ITERS" ]] && say "- total_iterations: ${TOTAL_ITERS}" >> "$REPORT"

  if [[ $RUN_CODE -ne 0 ]]; then
    say "- status: issues found during run (see tail)" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
    tail -n 120 "$OUT_RUN" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
  else
    # Pull a few notable lines if present
    NOTE_LINES="$(grep -E "(Error:|failed|Failed|WARNING|Warning|stalled|Ethics gate|Timed out|timeout)" "$OUT_RUN" | head -n 20 || true)"
    if [[ -n "$NOTE_LINES" ]]; then
      say "- notes:" >> "$REPORT"
      say "\`\`\`" >> "$REPORT"
      printf "%s\n" "$NOTE_LINES" >> "$REPORT"
      say "\`\`\`" >> "$REPORT"
    else
      say "- notes: no obvious errors in output" >> "$REPORT"
    fi
  fi

  say "" >> "$REPORT"

  # 3) Verify repo health after PulSeed-run-driven changes
  set +e
  npm run build >"$OUT_BUILD" 2>&1
  BUILD_CODE=$?
  npm test >"$OUT_TEST" 2>&1
  TEST_CODE=$?
  set -e

  say "## Verification (post-run)" >> "$REPORT"
  say "- build_exit: ${BUILD_CODE}" >> "$REPORT"
  say "- test_exit: ${TEST_CODE}" >> "$REPORT"

  if [[ $BUILD_CODE -ne 0 ]]; then
    say "- build_tail:" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
    tail -n 80 "$OUT_BUILD" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
  fi

  if [[ $TEST_CODE -ne 0 ]]; then
    say "- test_tail:" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
    tail -n 120 "$OUT_TEST" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
  fi

  say "" >> "$REPORT"
  say "## Current state" >> "$REPORT"
  say "- git status:" >> "$REPORT"
  say "\`\`\`" >> "$REPORT"
  git status --porcelain=v1 >> "$REPORT" || true
  say "\`\`\`" >> "$REPORT"

  say "- diff stat:" >> "$REPORT"
  say "\`\`\`" >> "$REPORT"
  git diff --stat >> "$REPORT" || true
  say "\`\`\`" >> "$REPORT"

  hr >> "$REPORT"

done

FIN_TS="$(date '+%F %T %Z')"
say "" >> "$REPORT"
say "# Done" >> "$REPORT"
say "Finished: ${FIN_TS}" >> "$REPORT"

printf "[overnight] done. report: %s\n" "$REPORT"
