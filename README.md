# Diego Career Ops

A local-first Netherlands job discovery and application workspace. It collects
target roles from many ATS sources, normalizes them into SQLite, ranks them
against an editable profile, and serves a responsive dashboard from the same
local API.

Employer discovery is automatic. Public vacancy feeds and ATS directories are
processed in rotating daily batches; `config/sources.json` is only an optional
override for corrections and unsupported employers.

## Requirements and setup

- Node.js 22.13 or newer
- npm

```powershell
cd "C:\Users\aadq-ftp\Diego career ops version"
npm install
npm run dev -- doctor
```

Provider detection currently supports Greenhouse, Lever, Ashby, Workable,
Recruitee, SmartRecruiters, Workday and iCIMS. Unknown public pages use an
experimental Playwright browser fallback.

```json
[
  {
    "id": "company-slug",
    "company": "Company Name",
    "careersUrl": "https://company.recruitee.com",
    "enabled": true
  }
]
```

## Commands

```powershell
npm run dev -- scan
npm run dev -- discover
npm run dev -- discover --limit 250
npm run dev -- discover --limit 100 --workers 6
npm run dev -- discover --mode fresh --limit 100
npm run dev -- discover --mode refresh-known --limit 100
npm run dev -- discover --source job-board-directory
npm run dev -- discover --resume
npm run dev -- discover --retry-failures --limit 50
npm run dev -- discovery-failures
npm run dev -- discovery-failures --retryable
npm run dev -- scan --provider recruitee
npm run dev -- scan --resume
npm run dev -- jobs --search scientist
npm run dev -- jobs --summary
npm run dev -- rescore --all
npm run dev -- enrich --missing
npm run dev -- sources
npm run dev -- stats
npm run dev -- employers
npm run dev -- coverage
npm run dev:api
```

`npm run dev:api` builds and starts the complete dashboard at
<http://127.0.0.1:4310>. It includes ranked jobs, application stages, employer
coverage, discovery controls, analytics, and editable search preferences.

Rules-based scores work without external services. Optional AI scoring is off
by default and uses `DIEGO_AI_ENABLED`, `DIEGO_AI_BASE_URL`,
`DIEGO_AI_API_KEY`, and `DIEGO_AI_MODEL`; keys are never stored in SQLite or
configuration files.

Discovery first stores a stable candidate queue, then processes it. `--resume`
continues that exact queue even if a directory or feed changes. Ctrl+C cancels
active HTTP work and leaves unprocessed candidates pending. Retryable failures
use increasing cooldowns (15 minutes, 1 hour, 6 hours, then 24 hours); missing
boards are rechecked after seven days.

Discovery modes are `balanced` (the default rotation and freshness windows),
`fresh` (never-processed candidates only), and `refresh-known` (stored employer
and ATS boards immediately, least-recently checked first). The dashboard shows
source selection, active workers, enrichment targets, adaptive ETA ranges, and
an expandable HTTP/processing trace. A candidate budget is a ceiling, not a
promise that every source can supply that many eligible candidates.

The final summary separates new and refreshed matching jobs, foreign-only
boards, empty boards, missing boards, unsupported sources, pending candidates,
and operational errors. HTTP 404 responses from ATS APIs are source-quality
findings (`board-not-found`), not parser failures.

The API listens only on `127.0.0.1:4310`:

- `GET /health`
- `GET /api/v1/jobs`
- `GET /api/v1/jobs/:id`
- `PATCH /api/v1/jobs/:id/review`
- `PUT /api/v1/jobs/:id/application`
- `GET /api/v1/applications`
- `GET|PUT /api/v1/profile`
- `GET /api/v1/sources`
- `GET /api/v1/scans`
- `GET /api/v1/stats`
- `GET /api/v1/employers`
- `GET /api/v1/employers/:id`
- `GET /api/v1/discovery/sources`
- `GET /api/v1/discovery/runs`
- `GET /api/v1/discovery/failures`
- `GET /api/v1/coverage`
- `POST /api/v1/scans?provider=recruitee&resume=true`
- `POST /api/v1/discovery?limit=100&source=job-board-directory&resume=true&retryFailures=false`
- `GET /api/v1/discovery/runs/:id`
- `GET /api/v1/discovery/runs/:id/trace?after=0&limit=200`
- `POST /api/v1/discovery/runs/:id/cancel`

Job filters include `company`, `roleFamily`, `provider`, `status`, `q`,
`minScore`, `reviewState`, `applicationStage`, `seniority`, `workArrangement`,
`sort`, `limit`, and `offset`.

Employer filters include `name`, `headquarters`, `hiring`, `sizeBand`,
`provider`, `boardStatus`, `since`, `limit`, and `offset`.

## Discovery behavior

- All Netherlands vacancies contribute employer and source-health evidence.
- Full job records retain strong matches and plausible possible matches against `config/profile.json`. Both appear in the default Jobs list.
- Other vacancies retain lightweight identity and decision evidence, available through the Excluded/All filters without retaining full descriptions. Decision history records the rule version, profile fingerprint, inspected fields, reasons, source, URL, and observation date.
- A generic `Remote` or Europe-wide remote location is unconfirmed. Plausible roles remain possible matches; structured foreign country evidence excludes them. A bundled Dutch locality lookup and configured nearby towns recognize city-only listings.
- Headquarters and employee size remain `unknown` unless a source supplies
  evidence. A verified Netherlands vacancy is enough to keep an employer.
- Cached feeds use ETag/Last-Modified revalidation and atomic cache writes.
- The default on-demand budget is 100 candidates: 50% benchmark/known Netherlands boards, 30% Dutch feeds, and 20% global directories. Unused capacity is redistributed. Known Netherlands boards refresh after 24 hours; foreign-only and unresolved employers after seven days. Persistent cursors and deduplicated board URLs prevent wasting budget.
- Each candidate records an explainable result, request duration, job counts,
  HTTP status, retryability, and a sanitized failure reason.
- Live runs distinguish fresh candidates, due rechecks, incomplete
  continuations, forced refreshes, recently skipped candidates, and duplicates.
  Technical traces retain at most 2,000 events per run and never store request
  headers or response bodies.
- `Ctrl+C` finishes active candidates, saves a heartbeat/checkpoint, and marks
  the run interrupted. `--resume` continues at the exact next candidate.
- Discovery uses four workers by default, at most two per ATS hostname and one
  for Workday/Ashby. Each collection chunk has a 45-second timeout; collected pages and continuations survive partial failures.
- Expected outcomes (`no-netherlands-jobs`, `empty-board`, `unsupported`) do
  not increase the error count. Retryable failures can be replayed separately.

Discovery sources include the confirmed Job Board Directory, GigSignal's public
Amsterdam feed, Werken voor Nederland, AcademicTransfer, and rotating provider
manifests. Personio public XML boards and Recruitee JSON/XML boards are supported.
The representative employer benchmark is also probed for official career pages
and supported ATS links. Optional Brave Search fallback is enabled with
`DIEGO_SEARCH_ENABLED=true` and `DIEGO_SEARCH_API_KEY`; it is never required.

The LinkedIn Guest adapter is experimental and excluded by default. Its parser
and pipeline can be exercised with saved POC responses without network access.
Live collection is registered only when both
`DIEGO_ENABLE_LINKEDIN_GUEST=true` and
`DIEGO_LINKEDIN_GUEST_PERMISSION_CONFIRMED=true` are set; the second flag is an
explicit acknowledgement that appropriate permission has been obtained. Search
keywords are derived from the configured CareerOps role families by default;
keywords and location can be overridden with `DIEGO_LINKEDIN_GUEST_KEYWORDS`
and `DIEGO_LINKEDIN_GUEST_LOCATION`. No LinkedIn source is shown or queried
without these opt-ins.

JobSpy is an optional multi-board discovery layer and is also excluded by
default. Install the pinned CLI with `py -m pip install -r requirements-jobspy.txt`
(preferably in a dedicated virtual environment), then set
`DIEGO_ENABLE_JOBSPY=true` and list boards in `DIEGO_JOBSPY_SITES`, for example
`indeed,glassdoor`. Every board additionally needs its own permission flag,
such as `DIEGO_JOBSPY_INDEED_PERMISSION_CONFIRMED=true`; selected boards without
that flag are neither registered nor invoked. `DIEGO_JOBSPY_COMMAND` can point
to the virtual environment's `jobspy` executable. By default, focused searches
are derived from each role family across the Netherlands, with small top-up
searches for the profile's preferred cities. Optional bounds are
`DIEGO_JOBSPY_TIMEOUT_MS`, `DIEGO_JOBSPY_MAX_PER_SEARCH` (default 15),
`DIEGO_JOBSPY_MAX_PER_CITY` (default 10), and
`DIEGO_JOBSPY_MAX_PER_PLATFORM` (default 100, hard cap 200). Up to 30% of the
platform budget is reserved for preferred-city top-ups. Set
`DIEGO_JOBSPY_HOURS_OLD` for a freshness filter. Queries and preferred cities
can be overridden with semicolon-separated `DIEGO_JOBSPY_QUERIES` and
`DIEGO_JOBSPY_PREFERRED_CITIES`; the broad city query and Netherlands location
can be overridden with `DIEGO_JOBSPY_QUERY`, `DIEGO_JOBSPY_LOCATION`, and
`DIEGO_JOBSPY_COUNTRY`. JobSpy's LinkedIn scraper
is intentionally unavailable through this bridge; LinkedIn Guest remains the
existing independent adapter.

Description-aware recall fetches at most 100 plausible missing descriptions per
discovery run. Remaining work is persisted and can be resumed with:

```powershell
npm.cmd run dev -- enrich --pending --limit 100
```

Exact-title, structured-metadata, and description-derived matches remain visibly
distinct in each job's stored match evidence and scoring ledger.

Selected Feashliaa ATS directories remain included under CC BY-NC 4.0; see
[NOTICE.md](NOTICE.md).

## Safety and scope

Only public HTTPS pages are collected. Same-site redirects (including the exact
`www` alias) are validated at every hop and limited to four hops. Cross-domain
redirects require an explicit board URL. Private-network destinations,
credentials in URLs, and custom ports are rejected. Diego Career Ops does not
bypass authentication, CAPTCHAs or access controls. Experimental sources fail
independently and never abort unrelated sources.

See [NOTICE.md](NOTICE.md) for Career-Ops attribution.

## Coverage and recall verification

The Jobs page shows **Strong match** and **Possible match** together. Filters also expose excluded jobs. A missing description or uncertain country no longer silently drops a plausible role. Existing seniority and internship preferences still apply, using whole-word/phrase exclusions.

All ingestion, enrichment, and reevaluation use the same processing service. Changing the profile reevaluates stored jobs and lightweight observations without replacing applications, notes, review states, or first-seen dates. Missing evidence is queued for public-page enrichment.

Collection adapters return an explicit `{ jobs, nextCursor, complete, total? }` result. Workday traverses resumable chunks of up to 200 records, prioritizes a Netherlands country facet when the response supplies one, and then traverses the full board. An incomplete collection never expires unseen jobs. Public-page fallback follows vacancy details and JobPosting graphs, with constrained rendering when needed; browser HTTP requests pass through the same public-source client.

Version 1 of the coverage migration creates a consistent SQLite backup in `data/backups` before changing an existing database. Legacy collection completeness starts unknown. To restore, stop the API and all collectors, move the current SQLite database and its WAL/SHM files aside, then restore a backup under the configured database filename. Keep the displaced files until the restored database has been verified.

Additional interfaces:

- `GET /api/v1/jobs?matchState=strong|possible|excluded|all` (existing eligibility filters still work).
- `GET /api/v1/jobs/:id/decisions` for append-only explanations.
- `POST /api/v1/diagnostics/job` with `{"url":"https://?"}` starts a saved missing-job check; poll `GET /api/v1/diagnostics/job/:id`.
- `GET /api/v1/coverage/trace` for collection states, backlog, and rejection reasons.
- `GET /api/v1/enrichment/queue/items` and `POST /api/v1/enrichment/queue/:id/retry` for manual retries.
- `POST /api/v1/enrichment/queue/process` starts up to 100 pending descriptions. Failed requests use cooldowns and Retry-After, with at most four automatic attempts.

Use `config/employers.json` for verified benchmark career URLs. Each entry requires an employer benchmark ID, careersUrl, evidenceUrl, and verifiedAt; a provider is optional. Exact identity or official-site evidence is required; fuzzy company-name matches are not used. The Sources page distinguishes unattempted, resolved, completely collected, partially collected, temporarily failed, and unsupported employers. These states do not assert total market coverage.

```powershell
npm.cmd run dev -- recall-check --file tests/fixtures/recall-30.json
npm.cmd run dev -- recall-check --file tests/fixtures/recall-30.json --live
npm.cmd run dev -- discover --source benchmark-employers --limit 120
npm.cmd run dev -- discover --source benchmark-employers --resume
npm.cmd run dev -- enrich --pending --limit 100
```

The 30-example corpus contains captured public vacancies with independently recorded expected retention/exclusion decisions and evidence. Synthetic regression tests additionally cover nearby locations, pagination beyond 200, partial cancellation, repeated pages, budget allocation, migrations, and API/UI behavior. The corpus was reviewed by the implementing agent; applicant suitability remains for the user to assess. Live recall checks report retrieval separately from matching, and retain inaccessible or unsupported URLs in the retrieval denominator.
