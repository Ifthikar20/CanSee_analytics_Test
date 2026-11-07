# CanSee_analytics_Test

Test suites for Cansee, kept outside the application repositories.

| Folder | Tests for | Runner |
| --- | --- | --- |
| `backend/` | [CanSee_analytics_App](https://github.com/Ifthikar20/CanSee_analytics_App) (Django, DRF, Celery) | pytest |
| `ui/` | [Cansee_analytics_UI_APP](https://github.com/Ifthikar20/Cansee_analytics_UI_APP) (Vue 3, Vite) | Vitest (not set up yet) |
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

That copies the tests in, then runs each app's tests in turn (the whole suite
in one process can run out of memory on small machines). To run part of it:

```bash
scripts/run-backend-tests.sh ../CanSee_analytics_App apps/search_gap/tests -x
```

To copy the tests without running them, for example to work on them from the
backend checkout:

```bash
scripts/sync-backend-tests.sh ../CanSee_analytics_App
```

## Changing tests

Edit tests here, not in the backend checkout: copies made by the sync script
are overwritten on the next sync. If you do edit them in the backend checkout,
copy them back before committing here.

## Status

`backend/` holds two sets of tests:

- The suite restored from the last backend commit that tracked it (the
  parent of `c2d7892`, early September 2026), plus tests added since. About
  127 of these fail because they predate later backend changes; see
  [docs/KNOWN_FAILURES.md](docs/KNOWN_FAILURES.md).
- Tests that were only on a local machine, added in `e6690fc`, including
  the `agent`, `autopilot`, `boards`, `insights` and `prompt_box` apps and
  new `search_gap`, `billing` and `web_analytics` tests. Several of these
  apps exist only on the backend branch `agent-workspace`, so run these
  tests against a checkout that includes that work.
