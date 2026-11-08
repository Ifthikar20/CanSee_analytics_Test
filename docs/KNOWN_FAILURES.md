# Known failing backend tests

None. Run on 2026-11-08: this repository at the commit that changes this
file, against CanSee_analytics_App `feature/November-26` at `7886e9a`
(wave 1 merged), one app at a time with `scripts/run-backend-tests.sh`:
4605 passed, 0 failed, 1 skipped. The UI suite against
Cansee_analytics_UI_APP `feature/November-26` at `95c571c` (wave 2 merged): 3419 passed.

The six backend bugs this file used to list (response envelope pagination,
event log CSV export, dotless website hosts, truncated JSON repair, the geo
tagger "generation" rule, Plackett-Luce strengths for brands never
compared) are fixed. The four nginx tests the blog location broke now
cover that location instead.

When a test fails because of a backend bug, leave it failing on purpose and
list it here: fix the app code, then remove the entry. Do not skip, xfail or
loosen tests to get a green run.

## How the suite got here

The suite restored from early September 2026 had about 127 failures against
the current backend. They were resolved in the commits titled "Align ... tests
with the merged backend":

- Test files whose subject was deliberately removed from the backend were
  deleted (for example `geo_rewrite`, `google_search`, the old Brand Security
  agents and safety endpoints, Content Studio, prompt test environments). Each
  deletion names the removing commit.
- Tests whose expected behaviour changed on purpose were updated to assert the
  current behaviour (for example the knowledge base and dashboards being shared
  per project, the Search Console return to `/settings/connections`, plan
  limits, login throttling). Isolation tests now check isolation between
  projects and organizations.
- The onboarding tests no longer exhaust memory: one test mocked the whole
  `WebsiteService`, a query returned a mock, and the JSON encoder recursed on
  it.

## Console

Two tests in `console/tests/server/proxyEdges.test.js` fail against
cansee_console_app `main` at `5745b5b` and pass with the fix on its
`hd/console` branch ("Map backend body-read failures to the timeout and
network errors"):

- `answers 504 when the headers arrive but the body stalls past the timeout`:
  the timeout signal aborts the body read, but only the fetch call was
  wrapped, so the console answered 502 "The backend request failed."
- `answers 502 "could not be reached" when the connection drops mid-body`:
  same cause, generic message instead of the network error.

Remove this section once that fix is merged.
