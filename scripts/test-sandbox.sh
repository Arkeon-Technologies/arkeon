#!/usr/bin/env bash
set -euo pipefail

# Run the worker sandbox test suite directly on the host.
#
# On Linux, this exercises bubblewrap namespace isolation — you must
# have `bwrap` installed (`sudo apt-get install bubblewrap` on Debian/
# Ubuntu). On macOS, the sandbox test suite runs against the direct-
# execution fallback path (see packages/arkeon/src/runtime/sandbox.ts).
#
# No Docker required. This script used to build a production image and
# run inside a container; that's no longer how Arkeon ships.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

OS="$(uname -s)"

echo "=== Running sandbox tests on $OS ==="
if [ "$OS" = "Linux" ]; then
  if ! command -v bwrap > /dev/null 2>&1; then
    echo "ERROR: bwrap not found. Install with: sudo apt-get install bubblewrap"
    exit 1
  fi
  echo "bwrap: $(bwrap --version)"
elif [ "$OS" = "Darwin" ]; then
  echo "macOS detected — sandbox will use direct-execution fallback (no namespace isolation)"
else
  echo "Unsupported host OS: $OS"
  exit 1
fi

npx tsx packages/arkeon/test/manual/sandbox.ts
