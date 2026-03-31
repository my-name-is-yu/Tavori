#!/usr/bin/env bash
set -euo pipefail

# Remote test execution script — runs vitest on Mac Mini via ssh mini
# Remote repo: ~/Documents/dev/PulSeed

REMOTE_HOST="mini"
REMOTE_DIR="~/Documents/dev/PulSeed"

COVERAGE=false
FILE_PATTERN=""
SYNC_ONLY=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --coverage)
      COVERAGE=true
      shift
      ;;
    --file)
      if [[ -z "${2:-}" ]]; then
        echo "error: --file requires a pattern argument" >&2
        exit 1
      fi
      FILE_PATTERN="$2"
      shift 2
      ;;
    --sync-only)
      SYNC_ONLY=true
      shift
      ;;
    *)
      echo "error: unknown option: $1" >&2
      echo "usage: $0 [--coverage] [--file <pattern>] [--sync-only]" >&2
      exit 1
      ;;
  esac
done

# Determine current local branch
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "=> syncing branch '${BRANCH}' to ${REMOTE_HOST}:${REMOTE_DIR} ..."

# Sync: fetch + checkout + pull on remote
ssh "${REMOTE_HOST}" bash <<EOF
set -euo pipefail
cd ${REMOTE_DIR}
git fetch origin
git checkout ${BRANCH} 2>/dev/null || git checkout -b ${BRANCH} origin/${BRANCH}
git pull origin ${BRANCH}
EOF

echo "=> sync done."

if [[ "${SYNC_ONLY}" == "true" ]]; then
  echo "=> --sync-only specified, skipping tests."
  exit 0
fi

# Check if package-lock.json changed on remote (compared to previous HEAD before pull)
# Install if needed by always running npm ci --prefer-offline (fast when nothing changed)
echo "=> checking dependencies ..."
ssh "${REMOTE_HOST}" bash <<EOF
set -euo pipefail
cd ${REMOTE_DIR}
# Use npm install only when package-lock.json is newer than node_modules
if [[ ! -d node_modules ]] || [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
  echo "   package-lock.json changed or node_modules missing — running npm install ..."
  npm install --prefer-offline
else
  echo "   dependencies up to date, skipping npm install."
fi
EOF

# Build vitest command
VITEST_CMD="npx vitest run"

if [[ -n "${FILE_PATTERN}" ]]; then
  VITEST_CMD="${VITEST_CMD} ${FILE_PATTERN}"
fi

if [[ "${COVERAGE}" == "true" ]]; then
  VITEST_CMD="${VITEST_CMD} --coverage"
fi

echo "=> running tests on ${REMOTE_HOST}: ${VITEST_CMD}"
echo ""

# Run tests and capture exit code
REMOTE_EXIT=0
ssh "${REMOTE_HOST}" bash <<EOF || REMOTE_EXIT=$?
set -euo pipefail
cd ${REMOTE_DIR}
${VITEST_CMD}
EOF

if [[ "${REMOTE_EXIT}" -eq 0 ]]; then
  echo ""
  echo "=> tests passed."
else
  echo ""
  echo "=> tests failed (exit code: ${REMOTE_EXIT})." >&2
fi

exit "${REMOTE_EXIT}"
