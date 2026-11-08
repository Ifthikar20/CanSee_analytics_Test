# Known failing backend tests

Run on 2026-11-07: this repository at the commit that adds this file,
against CanSee_analytics_App `feature/November-26` at `d658e55`, one app
at a time with `scripts/run-backend-tests.sh`. That run had 6 failures, each
pointing at a real backend bug.

All six are fixed on the backend branch `w1/be-correct` (response envelope
pagination check, event log CSV export, dotless website hosts, truncated
JSON repair, the geo tagger "generation" rule, Plackett-Luce strengths for
brands never compared).

Run on 2026-11-08 against `feature/November-26` at `f43e144` plus
`w1/be-correct`: every app passes except the four tests below. They began
failing with `f43e144` ("Serve the prerendered blog pages from nginx"),
not with the fixes above.

These are not backend bugs: `f43e144` added a `location ^~ /blog` block
that serves the prerendered blog shells and deliberately repeats the
`/index.html` nonce, no-cache and security headers. The tests still expect
exactly two SPA locations and one nonce source, so they need updating to
check the blog block the same way (every server header repeated, its own
nonce). Do not skip, xfail or loosen them; update them, then remove the
entry here.

| Test | Cause | Where |
| --- | --- | --- |
| `apps/agent/tests/test_fix_be_platform_infra.py::test_spa_locations_repeat_every_server_security_header[nginx.prod.conf]` and `[nginx.http.conf]` | The set of SPA locations now includes `^~ /blog`. | `docker/nginx/nginx.prod.conf`, `docker/nginx/nginx.http.conf` |
| `apps/agent/tests/test_fix_be_platform_infra.py::test_the_spa_document_nonces_its_own_inline_scripts[nginx.prod.conf]` and `[nginx.http.conf]` | `'nonce-$request_id'` now appears twice (`/index.html` and `/blog`). | `docker/nginx/nginx.prod.conf`, `docker/nginx/nginx.http.conf` |

When a test fails because of a backend bug, leave it failing on purpose and
list it here: fix the app code, then remove the entry. Do not skip, xfail or
loosen these tests to get a green run.

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
