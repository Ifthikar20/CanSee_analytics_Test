# UI tests

Vitest suite for [Cansee_analytics_UI_APP](https://github.com/Ifthikar20/Cansee_analytics_UI_APP).

Files mirror the UI repository's paths (for example
`ui/src/lib/charts/__tests__/format.spec.js` tests `src/lib/charts/format.js`).
Specs import the code they test by relative path, so they run from inside a
UI checkout: `scripts/run-ui-tests.sh ../Cansee_analytics_UI_APP` copies them
in and runs Vitest.

- `**/__tests__/*.spec.js`: the specs
- `**/__tests__/__fixtures__/`: shared test data
- `src/test/setup.js`: Vitest setup, referenced by the UI repo's
  `vitest.config.js`

The UI repo keeps `vitest.config.js`, the `test` scripts in `package.json` and
the test dependencies.
