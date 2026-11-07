#!/usr/bin/env bash
# Sync the backend tests into a CanSee_analytics_App checkout and run pytest.
#
# Requirements: the backend's Python dependencies installed
# (pip install -r requirements/dev.txt) and a PostgreSQL server matching
# config/settings/test.py (database cansee_test, user postgres).
#
# Usage: scripts/run-backend-tests.sh <path-to-CanSee_analytics_App> [pytest args]
# Examples:
#   scripts/run-backend-tests.sh ../CanSee_analytics_App
#   scripts/run-backend-tests.sh ../CanSee_analytics_App apps/search_gap/tests -x
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-}"
if [ -z "$target" ]; then
    echo "Usage: $0 <path-to-CanSee_analytics_App> [pytest args]" >&2
    exit 2
fi
shift

"$here/sync-backend-tests.sh" "$target"

cd "$target"
if [ "$#" -eq 0 ]; then
    # Run app by app: the full suite in one process can exhaust memory on
    # small machines.
    status=0
    for dir in $(find apps core services -type d -name tests ! -path '*/node_modules/*' | sort); do
        echo "== $dir"
        python -m pytest -q -o addopts="" -p no:cacheprovider "$dir" || status=1
    done
    exit "$status"
fi
exec python -m pytest -q -o addopts="" -p no:cacheprovider "$@"
