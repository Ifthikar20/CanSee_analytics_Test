#!/usr/bin/env bash
# Copy the backend test suite into a CanSee_analytics_App checkout.
#
# The tests import each other by their in-repo module paths (for example
# apps.accounts.tests.factories), so they must sit inside the backend tree
# to run. The backend's .gitignore ignores tests/ and the root conftest.py,
# so the copied files never show up as changes in the backend repo.
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

cd "$here/backend"
# Copy file by file so the backend's own non-test files are never touched.
find . -type f -name '*.py' ! -path '*/__pycache__/*' | while read -r file; do
    mkdir -p "$target/$(dirname "$file")"
    cp "$file" "$target/$file"
done

count="$(find . -type f -name '*.py' ! -path '*/__pycache__/*' | wc -l | tr -d ' ')"
echo "Copied $count test files into $target"
