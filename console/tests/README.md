# Console tests

Tests for the Cansee console (`cansee_console_app`). This folder mirrors the
console repository's paths: `console/tests/` here becomes `tests/` in a
console checkout, which the console's `.gitignore` ignores.

- `tests/server/*.test.js`: server tests (Vitest + supertest, Node environment).
- `tests/client/*.spec.js`: UI unit tests (Vitest, jsdom where needed).

Mirror them in with `scripts/sync-console-tests.sh <path-to-console-checkout>`,
then run `npm test` in the checkout.
