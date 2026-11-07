#!/usr/bin/env bash
# Sync the UI tests into a Cansee_analytics_UI_APP checkout and run Vitest.
#
# Requirements: the UI's dependencies installed (npm ci). The UI repo keeps
# vitest.config.js and the test dependencies; only the tests live here.
#
# Usage: scripts/run-ui-tests.sh <path-to-Cansee_analytics_UI_APP> [vitest args]
# Examples:
#   scripts/run-ui-tests.sh ../Cansee_analytics_UI_APP
#   scripts/run-ui-tests.sh ../Cansee_analytics_UI_APP src/lib/charts
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-}"
if [ -z "$target" ]; then
    echo "Usage: $0 <path-to-Cansee_analytics_UI_APP> [vitest args]" >&2
    exit 2
fi
shift

"$here/sync-ui-tests.sh" "$target"

cd "$target"
exec npx vitest run "$@"
