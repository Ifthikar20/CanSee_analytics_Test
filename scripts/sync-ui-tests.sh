#!/usr/bin/env bash
# Mirror the UI test suite into a Cansee_analytics_UI_APP checkout.
#
# Specs import the code they test by relative path (for example
# '../SerpView.vue'), so they must sit next to it to run. The UI's
# .gitignore ignores spec files, __tests__/ folders and src/test/, so the
# copied files never show up as changes in the UI repo.
#
# Mirroring means the checkout's __tests__/ folders, *.spec.js files and
# src/test/ are replaced by this repository's copy: a test deleted here is
# deleted there too. Edit tests in this repository, not in the checkout.
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

cd "$target"
old_dirs="$(find src -type d -name __tests__ -prune)"
[ -d src/test ] && old_dirs="$old_dirs src/test"
old_specs="$(find src -type f -name '*.spec.js' ! -path '*/__tests__/*' ! -path 'src/test/*')"

# Never delete anything the UI repository tracks.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    tracked="$(git ls-files -- $old_dirs $old_specs 2>/dev/null || true)"
    if [ -n "$tracked" ]; then
        echo "Refusing to sync: these files are tracked by the UI repository:" >&2
        echo "$tracked" | head -20 >&2
        exit 1
    fi
fi

# shellcheck disable=SC2086
[ -n "$old_dirs" ] && rm -rf $old_dirs
# shellcheck disable=SC2086
[ -n "$old_specs" ] && rm -f $old_specs

cd "$here/ui"
find . -type f ! -name 'README.md' | while read -r file; do
    mkdir -p "$target/$(dirname "$file")"
    cp "$file" "$target/$file"
done

count="$(find . -type f ! -name 'README.md' | wc -l | tr -d ' ')"
echo "Mirrored $count test files into $target"
