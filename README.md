# CanSee_analytics_Test

Test suites for Cansee, kept outside the application repositories.

| Folder | Tests for | Runner |
| --- | --- | --- |
| `backend/` | [CanSee_analytics_App](https://github.com/Ifthikar20/CanSee_analytics_App) (Django, DRF, Celery) | pytest |
| `ui/` | [Cansee_analytics_UI_APP](https://github.com/Ifthikar20/Cansee_analytics_UI_APP) (Vue 3, Vite) | Vitest |
| `console/` | [CanSee_console_app](https://github.com/Ifthikar20/CanSee_console_app) (Node.js, Express, Vue 3) | Vitest, supertest |
| `scripts/` | Helpers that copy a suite into an app checkout and run it | bash |
| `docs/` | Known failures and notes | |

## Layout

`backend/` mirrors the backend repository's paths exactly:

```
backend/
  conftest.py                  -> CanSee_analytics_App/conftest.py
  apps/<app>/tests/            -> CanSee_analytics_App/apps/<app>/tests/
  core/tests/                  -> CanSee_analytics_App/core/tests/
  core/validators/tests/       -> CanSee_analytics_App/core/validators/tests/
  services/<service>/tests/    -> CanSee_analytics_App/services/<service>/tests/
```

The tests import each other by those module paths (for example
`apps.accounts.tests.factories`), so they run from inside a backend checkout.
The backend's `.gitignore` ignores `tests/` and the root `conftest.py`, so the
copied files never appear as changes there.

## Running the backend tests

Prerequisites, in the backend checkout:

- Python 3.12 or newer with `pip install -r requirements/dev.txt`
- PostgreSQL matching `config/settings/test.py` (user `postgres`, password
  `postgres`, database `cansee_test`; create it with `createdb cansee_test`)

From this repository, with the two repositories side by side:

```bash
scripts/run-backend-tests.sh ../CanSee_analytics_App
```

That mirrors the tests in, then runs each app's tests in turn (the whole suite
in one process can run out of memory on small machines). To run part of it:

```bash
scripts/run-backend-tests.sh ../CanSee_analytics_App apps/search_gap/tests -x
```

To mirror the tests without running them, for example to work on them from the
backend checkout:

```bash
scripts/sync-backend-tests.sh ../CanSee_analytics_App
```

## Running the UI tests

Prerequisite: `npm ci` in the UI checkout (it keeps `vitest.config.js` and the
test dependencies). Then, from this repository:

```bash
scripts/run-ui-tests.sh ../Cansee_analytics_UI_APP
```

Extra arguments go to Vitest, for example a folder:

```bash
scripts/run-ui-tests.sh ../Cansee_analytics_UI_APP src/lib/charts
```

`ui/` mirrors the UI repository's paths (`src/**/__tests__/*.spec.js`, their
`__fixtures__/`, and `src/test/setup.js`); the UI's `.gitignore` ignores the
copies.

## Running the console tests

`console/` mirrors the console repository's paths: `console/tests/` becomes
`tests/` in a console checkout, which the console's `.gitignore` ignores.
Server tests (`tests/server/`) use supertest against the Express app with a
fake backend, so nothing listens on a port of its own; UI unit tests
(`tests/client/`) use Vitest, with jsdom for component tests.

Prerequisite: `npm ci` in the console checkout. Then, from this repository:

```bash
scripts/sync-console-tests.sh ../cansee_console_app
(cd ../cansee_console_app && npm test)
```

## Changing tests

Edit tests here, not in the app checkouts. The sync scripts mirror this
repository into a checkout: they delete the checkout's test folders (and the
backend's root `conftest.py`, the console's `tests/`) and copy this
repository's versions in, so a test deleted here disappears there too. Any edit made in a checkout is lost on the
next sync. The scripts refuse to run if any of those files are tracked by the
app repository.

## Status

Against the backend and UI on `feature/November-26` (2026-11-07):

- Backend: 3789 passed, 6 failed. The 6 failures are real backend bugs,
  listed in [docs/KNOWN_FAILURES.md](docs/KNOWN_FAILURES.md).
- UI: 2434 passed, 0 failed.
