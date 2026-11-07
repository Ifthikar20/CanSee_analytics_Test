#!/usr/bin/env bash
# Copy the UI test suite into a Cansee_analytics_UI_APP checkout.
#
# Specs import the code they test by relative path (for example
# '../SerpView.vue'), so they must sit next to it to run. The UI's
# .gitignore ignores spec files, __tests__/ folders and src/test/, so the
# copied files never show up as changes in the UI repo.
#
# Usage: scripts/sync-ui-tests.sh <path-to-Cansee_analytics_UI_APP>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-}"

if [ -z "$target" ] || [ ! -f "$target/package.json" ] || [ ! -d "$target/src" ]; then
    echo "Usage: $0 <path-to-Cansee_analytics_UI_APP>" >&2
    echo "The path must be a UI checkout (it must contain package.json and src/)." >&2
    exit 2
fi
# Resolve before changing directory, so a relative path keeps working.
target="$(cd "$target" && pwd)"

cd "$here/ui"
find . -type f ! -name 'README.md' | while read -r file; do
    mkdir -p "$target/$(dirname "$file")"
    cp "$file" "$target/$file"
done

count="$(find . -type f ! -name 'README.md' | wc -l | tr -d ' ')"
echo "Copied $count test files into $target"
