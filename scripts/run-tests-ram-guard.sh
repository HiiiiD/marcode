#!/usr/bin/env bash
# Run a test suite with a live RAM guard: polls the test process's real
# memory (RSS / WorkingSet64) and kills it the instant it crosses a
# threshold, instead of letting a runaway assertion (e.g. handing a DOM
# node/list straight to assert.strictEqual — see check-dom-null-asserts.mjs)
# take the whole machine down.
#
# Usage:
#   scripts/run-tests-ram-guard.sh <unit|dom> [--limit-mb=2048] [--interval-ms=250]
#
# Exit code: the wrapped suite's own exit code, or 137 if killed for RAM.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo "node not found on PATH" >&2
    exit 127
fi

cd "$REPO_ROOT"
exec node scripts/run-tests-ram-guard.mjs "$@"
