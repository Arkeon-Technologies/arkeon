#!/usr/bin/env bash
# Deploy schema to a Neon database.
#
# Usage:
#   ./schema/deploy.sh                    # uses DATABASE_URL from env or .dev.vars
#   ./schema/deploy.sh <connection_string> # explicit connection string
#   DATABASE_URL=... ./schema/deploy.sh    # explicit via env var

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Resolve DATABASE_URL
if [ $# -ge 1 ]; then
  DATABASE_URL="$1"
elif [ -z "${DATABASE_URL:-}" ]; then
  # Try .dev.vars
  DEV_VARS="$SCRIPT_DIR/../api/.dev.vars"
  if [ -f "$DEV_VARS" ]; then
    DATABASE_URL=$(grep '^DATABASE_URL=' "$DEV_VARS" | cut -d= -f2-)
  fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Error: No DATABASE_URL. Pass as argument, set env var, or add to .dev.vars"
  exit 1
fi

# Auto-discover all schema files in numeric order (excludes tests/ subdirectory)
SCHEMA_FILES=()
while IFS= read -r f; do
  SCHEMA_FILES+=("$f")
done < <(find "$SCRIPT_DIR" -maxdepth 1 -name '*.sql' | sort)

echo "Deploying schema to: $(echo "$DATABASE_URL" | sed 's/:[^@]*@/:*****@/')"
echo ""

FAILED=0
for f in "${SCHEMA_FILES[@]}"; do
  name=$(basename "$f")
  echo -n "  $name ... "
  output=$(psql "$DATABASE_URL" -f "$f" 2>&1) || true

  # Filter out idempotent "already exists" and pg_cron errors
  real_errors=$(echo "$output" | grep "ERROR:" \
    | grep -v "already exists" \
    | grep -v "cron" \
    | grep -v "pg_cron" \
    | grep -v "create extension" \
    | grep -v "does not exist, skipping" \
    || true)

  skipped=$(echo "$output" | grep "ERROR:" | grep "already exists" || true)
  cron_skipped=$(echo "$output" | grep "ERROR:" | grep "cron" || true)

  if [ -n "$real_errors" ]; then
    echo "ERROR"
    echo "$real_errors" | sed 's/^/    /'
    FAILED=1
  elif [ -n "$skipped" ] && [ -n "$cron_skipped" ]; then
    echo "OK (exists, pg_cron skipped)"
  elif [ -n "$skipped" ]; then
    echo "OK (exists)"
  elif [ -n "$cron_skipped" ]; then
    echo "OK (pg_cron skipped)"
  else
    echo "OK"
  fi
done

echo ""
if [ $FAILED -eq 0 ]; then
  echo "Schema deployed successfully."
else
  echo "Schema deployment had errors. Review output above."
  exit 1
fi
