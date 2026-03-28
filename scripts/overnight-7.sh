#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

DATE_TAG="$(date +%F)"
START_TS="$(date '+%F %T %Z')"
REPORT_DIR="$REPO_DIR/memory"
REPORT="$REPORT_DIR/overnight-${DATE_TAG}.md"

mkdir -p "$REPORT_DIR"

say() { printf "%s\n" "$*"; }
hr() { printf "%s\n" "---"; }

# Keep the report concise: store full command outputs in tmp files and only
# extract key lines + short tails on error.
TMP_DIR="$REPO_DIR/memory/.overnight-tmp-${DATE_TAG}-$$"
mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

say "# PulSeed overnight improvement loop (${DATE_TAG})" > "$REPORT"
say "" >> "$REPORT"
say "Started: ${START_TS}" >> "$REPORT"
say "Repo: ${REPO_DIR}" >> "$REPORT"
say "" >> "$REPORT"

say "## Environment" >> "$REPORT"
say "- node: $(node -v)" >> "$REPORT"
say "- npm: $(npm -v)" >> "$REPORT"
say "- git: $(git --version)" >> "$REPORT"
say "" >> "$REPORT"

say "## Provider" >> "$REPORT"
{
  say "\`\`\`json";
  node dist/cli-runner.js provider show;
  say "\`\`\`";
} >> "$REPORT" 2>/dev/null || true

say "" >> "$REPORT"
hr >> "$REPORT"

# Baseline sanity
if ! npm run build >/dev/null 2>&1; then
  say "Build failed at baseline. Run locally: npm run build" >> "$REPORT"
  exit 1
fi

for i in $(seq 1 7); do
  ITER_TS="$(date '+%F %T %Z')"
  OUT_IMPROVE="$TMP_DIR/improve-${i}.log"
  OUT_BUILD="$TMP_DIR/build-${i}.log"
  OUT_TEST="$TMP_DIR/test-${i}.log"

  say "" >> "$REPORT"
  say "# Iteration $i" >> "$REPORT"
  say "Started: ${ITER_TS}" >> "$REPORT"
  say "" >> "$REPORT"

  # 1) PulSeed run (improvement loop)
  set +e
  node dist/cli-runner.js improve . --auto --yes >"$OUT_IMPROVE" 2>&1
  IMPROVE_CODE=$?
  set -e

  # Extract the "task" we asked PulSeed to pursue (best-effort from output)
  SUGGESTED_TITLE="$(grep -E "^\[PulSeed Improve\] Negotiating goal:" "$OUT_IMPROVE" | head -n 1 | sed -E 's/^\[PulSeed Improve\] Negotiating goal: "(.*)"\.\.\./\1/' || true)"
  GOAL_ID="$(grep -E "^\[PulSeed Improve\] Goal registered:" "$OUT_IMPROVE" | head -n 1 | awk '{print $5}' || true)"

  say "## What PulSeed was asked to do" >> "$REPORT"
  if [[ -n "$SUGGESTED_TITLE" ]]; then
    say "- Goal (selected suggestion): ${SUGGESTED_TITLE}" >> "$REPORT"
  else
    say "- Goal (selected suggestion): (could not parse from output)" >> "$REPORT"
  fi
  if [[ -n "$GOAL_ID" ]]; then
    say "- Goal ID: ${GOAL_ID}" >> "$REPORT"
  fi
  say "- Command: pulseed improve . --auto --yes" >> "$REPORT"
  say "- Exit: ${IMPROVE_CODE}" >> "$REPORT"
  say "" >> "$REPORT"

  say "## Findings / issues surfaced" >> "$REPORT"
  if [[ $IMPROVE_CODE -ne 0 ]]; then
    # Show a short tail; avoid dumping everything.
    say "PulSeed run returned non-zero. Tail:" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
    tail -n 60 "$OUT_IMPROVE" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
  else
    # Pull any warning/error-ish lines if present.
    ERR_LINES="$(grep -E "(Error:|Unhandled|exception|failed|Failed|ERR_|Timed out|timeout)" "$OUT_IMPROVE" | head -n 20 || true)"
    if [[ -n "$ERR_LINES" ]]; then
      say "Potential issues detected (grep):" >> "$REPORT"
      say "\`\`\`" >> "$REPORT"
      printf "%s\n" "$ERR_LINES" >> "$REPORT"
      say "\`\`\`" >> "$REPORT"
    else
      say "No obvious errors in PulSeed output." >> "$REPORT"
    fi
  fi
  say "" >> "$REPORT"

  # 2) Build + Test to verify repo health
  set +e
  npm run build >"$OUT_BUILD" 2>&1
  BUILD_CODE=$?
  npm test >"$OUT_TEST" 2>&1
  TEST_CODE=$?
  set -e

  say "## Verification" >> "$REPORT"
  say "- build: ${BUILD_CODE}" >> "$REPORT"
  say "- test: ${TEST_CODE}" >> "$REPORT"

  if [[ $BUILD_CODE -ne 0 ]]; then
    say "" >> "$REPORT"
    say "Build failed. Tail:" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
    tail -n 60 "$OUT_BUILD" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
  fi

  if [[ $TEST_CODE -ne 0 ]]; then
    say "" >> "$REPORT"
    say "Tests failed. Summary/tail:" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
    # vitest output ends with summary; keep tail.
    tail -n 80 "$OUT_TEST" >> "$REPORT"
    say "\`\`\`" >> "$REPORT"
  fi

  say "" >> "$REPORT"
  say "## Current repo state" >> "$REPORT"
  say "- git status (porcelain):" >> "$REPORT"
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