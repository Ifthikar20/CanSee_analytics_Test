#!/usr/bin/env bash
# Mirror the console test suite into a cansee_console_app checkout.
#
# Tests import the code they test by relative path (for example
# '../../server/app.js'), so they must sit inside the console tree to
# run. The console's .gitignore ignores tests/, so the copied files never
# show up as changes in the console repo.
#
# Mirroring means the checkout's tests/ folder is replaced by this
# repository's copy: a test deleted here is deleted there too. Edit tests
# in this repository, not in the checkout.
#
# Usage: scripts/sync-console-tests.sh <path-to-cansee_console_app>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-}"

if [ -z "$target" ] || [ ! -f "$target/package.json" ] || [ ! -d "$target/server" ]; then
    echo "Usage: $0 <path-to-cansee_console_app>" >&2
    echo "The path must be a console checkout (it must contain package.json and server/)." >&2
    exit 2
fi
# Resolve before changing directory, so a relative path keeps working.
target="$(cd "$target" && pwd)"

cd "$target"

# Never delete anything the console repository tracks.
if [ -d tests ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    tracked="$(git ls-files -- tests 2>/dev/null || true)"
    if [ -n "$tracked" ]; then
        echo "Refusing to sync: these files are tracked by the console repository:" >&2
        echo "$tracked" | head -20 >&2
        exit 1
    fi
fi

rm -rf tests

cd "$here/console"
find . -type f ! -name 'README.md' | while read -r file; do
    mkdir -p "$target/$(dirname "$file")"
    cp "$file" "$target/$file"
done

count="$(find . -type f ! -name 'README.md' | wc -l | tr -d ' ')"
echo "Mirrored $count test files into $target"
