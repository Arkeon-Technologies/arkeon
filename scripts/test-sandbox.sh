#!/usr/bin/env bash
set -euo pipefail

# Run sandbox tests inside Docker to test bwrap in a production-like environment.
# This builds the same image used in production, then runs the sandbox test suite.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
IMAGE="arke-sandbox-test"

echo "=== Building Docker image (same as production) ==="
docker build -t "$IMAGE" --target api "$ROOT"

echo ""
echo "=== Running sandbox tests inside container ==="
# --security-opt seccomp=unconfined: allows bwrap to create namespaces
# Without this, bwrap fails the same way it does on deployed instances
docker run --rm \
  --security-opt seccomp=unconfined \
  "$IMAGE" \
  npx tsx packages/runtime/test/sandbox.test.ts

echo ""
echo "=== Also testing WITHOUT seccomp (should fallback to direct) ==="
docker run --rm \
  "$IMAGE" \
  npx tsx packages/runtime/test/sandbox.test.ts
