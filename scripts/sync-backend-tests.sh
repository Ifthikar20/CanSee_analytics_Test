#!/usr/bin/env bash
# Mirror the backend test suite into a CanSee_analytics_App checkout.
#
# The tests import each other by their in-repo module paths (for example
# apps.accounts.tests.factories), so they must sit inside the backend tree
# to run. The backend's .gitignore ignores tests/ and the root conftest.py,
# so the copied files never show up as changes in the backend repo.
#
# Mirroring means the checkout's tests/ folders and root conftest.py are
# replaced by this repository's copy: a test deleted here is deleted there
# too, instead of lingering and running against code it no longer matches.
# Edit tests in this repository, not in the checkout.
#
# Usage: scripts/sync-backend-tests.sh <path-to-CanSee_analytics_App>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-}"

if [ -z "$target" ] || [ ! -f "$target/manage.py" ]; then
    echo "Usage: $0 <path-to-CanSee_analytics_App>" >&2
    echo "The path must be a backend checkout (it must contain manage.py)." >&2
    exit 2
fi
# Resolve before changing directory, so a relative path keeps working.
target="$(cd "$target" && pwd)"

cd "$target"
old_dirs="$(find apps core services -type d -name tests -prune 2>/dev/null || true)"

# Never delete anything the backend repository tracks.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    tracked="$(git ls-files -- $old_dirs conftest.py 2>/dev/null || true)"
    if [ -n "$tracked" ]; then
        echo "Refusing to sync: these files are tracked by the backend repository:" >&2
        echo "$tracked" | head -20 >&2
        exit 1
    fi
fi

# shellcheck disable=SC2086
[ -n "$old_dirs" ] && rm -rf $old_dirs
rm -f conftest.py

cd "$here/backend"
find . -type f -name '*.py' ! -path '*/__pycache__/*' | while read -r file; do
    mkdir -p "$target/$(dirname "$file")"
    cp "$file" "$target/$file"
done

count="$(find . -type f -name '*.py' ! -path '*/__pycache__/*' | wc -l | tr -d ' ')"
echo "Mirrored $count test files into $target"
