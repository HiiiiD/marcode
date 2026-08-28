#!/usr/bin/env bash
# Scan test files for `assert.strictEqual(<dom query>, null)` and friends —
# the shape that can allocate multiple GB via util.inspect when the assert
# fails (see CLAUDE.md "Never pass a DOM node to an assertion").
#
# Cross-platform wrapper: the actual scan is Node (works identically on
# Windows/macOS/Linux); this script just locates Node and the repo root.
#
# Usage: scripts/check-dom-null-asserts.sh [file-or-dir ...]
# Exit code: 0 = clean, 1 = findings.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo "node not found on PATH" >&2
    exit 127
fi

cd "$REPO_ROOT"
exec node scripts/check-dom-null-asserts.mjs "$@"
