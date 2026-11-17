# Diego Career Ops

Diego Career Ops is a local-first dashboard for finding, reviewing, and tracking Netherlands job opportunities. It searches public vacancy sources and ATS boards, normalizes results into SQLite, evaluates them against your search profile, and keeps the entire application workflow in one browser interface.

The dashboard is the primary product. Command-line tools are available for diagnostics, maintenance, and development, but they are not required for normal use.

## Quick start

### Requirements

- Node.js 22.13 or newer
- npm
- Python only if you enable the optional JobSpy integration

### Install and open the dashboard

```powershell
cd "Diego career ops version"
npm install
npm run dev:api
```

Open <http://127.0.0.1:4310>.

Keep that PowerShell window open while using the dashboard. Stop the server with `Ctrl+C` when you are finished. The first startup builds both the dashboard and API before serving them from the same local address.

For a quick installation check:

```powershell
npm run dev -- doctor
```

## Dashboard guide

### Overview

The Overview is the daily starting point. It shows:

- jobs that still need a decision;
- saved jobs and applications in preparation;
- active applications and follow-ups due;
- the highest-ranked recent matches; and
- recent discovery runs and their outcomes.

### Discovery

Discovery is the main collection workspace.

1. Choose a 5, 10, 20, or 30 minute run.
2. Review the expected useful-match range and current source ranking.
3. Select **Start discovery**.
4. Watch the live clock, active work, freshness counts, scheduler decisions, and source trace.
5. Review the completed run, then open new jobs from Overview or Jobs.

Only one discovery run can be active at a time. Repeated starts attach to the existing run instead of creating competing collectors. **Cancel safely** stops new work and preserves completed results.

The Discovery page also provides:

- **Add a vacancy by URL** for importing and saving one public vacancy directly;
- description-enrichment status and a **Run due now** action; and
- expandable history with source-level results and technical traces.

### Jobs

Jobs is the review table. It combines strong and possible matches by default and provides quick views for new, saved, submitted, declined, active, and expired jobs. Filters cover match state, role family, source/provider, work arrangement, commute accessibility, review state, and application stage.

Open a job to see the complete evidence behind its classification and score: role evidence, location evidence, source history, points ledger, description, and discovery trace. From there you can save or decline it, change its application stage, add notes and follow-up dates, and attach application documents.

Excluded observations remain available through the match-state filters, so uncertain or rejected records do not silently disappear.

### Applications

Applications can be managed as a board or table. The pipeline uses these exact stages:

`saved`, `preparing`, `applied`, `screening`, `interview`, `assessment`, `offer`, `hired`, `rejected`, and `withdrawn`.

Cards can be moved between pipeline groups, while the job detail page stores the precise stage, applied date, next follow-up, notes, documents, and status history.

### Employers

Employers shows which organizations have been observed, whether they are hiring in the Netherlands, their known boards and board health, recent vacancies, and stored matches. Employer detail pages separate verified evidence from unknown company attributes.

### Sources

Sources explains where results are coming from and how each source is performing. It includes recent and lifetime yield, acquisition and processing cost, errors, duplicate overlap, Dutch coverage indicators, and source-specific candidate attempts. Use it to distinguish a low-yield source from a source that was never attempted or is temporarily cooling down.

### Analytics

Analytics summarizes stored jobs, employers, discovery failures, duplicate merges, role-family distribution, and provider coverage.

### Settings

Settings controls location ranking and commute accessibility from Den Bosch. Saving the page reclassifies stored jobs using the updated location preferences.

The complete role and eligibility profile lives in [`config/profile.json`](config/profile.json). See [Search profile](#search-profile) before changing it.

## Recommended daily workflow

1. Open Overview and clear jobs in **Needs review**.
2. Open Discovery and run a 10- or 20-minute search.
3. Review the run summary, especially new strong matches, useful matches, duplicate rate, and source errors.
4. Use Jobs to save, decline, or investigate new results.
5. Move saved roles through Applications and set follow-up dates.
6. Check Sources when a run looks unexpectedly weak; it shows whether the cause was low supply, repeated results, slow boards, cooldowns, or collection failures.

Longer runs give the scheduler more time to exhaust additional search arms and ATS pages. They do not guarantee proportionally more jobs when the enabled sources have little new inventory.

## How adaptive discovery works

Dashboard discovery optimizes for distinct, newly discovered, strong Netherlands matches with a verified posting date. Its reward weights are:

| Posting age | Reward |
| --- | ---: |
| 0-7 days | 1.0 |
| 8-30 days | 0.4 |
| 31-60 days | 0.1 |
| Older or unknown | 0 |

The scheduler considers both acquisition time and the later cost of resolving a board, fetching vacancies, evaluating jobs, and saving results. Repeated candidates, failures, cooling search arms, and slow processing reduce priority. Sparse or new sources retain an exploration allowance so that historical winners do not permanently crowd them out.

LinkedIn Guest and every enabled JobSpy platform receive at least three targeted pulls before normal yield ranking takes over. Current pull sizes are 25 results for LinkedIn Guest, 20 requested results for JobSpy, and 10 candidates for other discovery sources. JobSpy applies its own per-search caps after that request.

Timed runs start with six candidate-processing workers. Concurrency is bounded per destination host and provider: Workday and Ashby use one request per host, other hosts use at most two, and recent provider failures can reduce that provider's capacity without slowing unrelated sources. Five consecutive transient failures open a circuit for the affected host or provider.

At the selected deadline, the scheduler stops launching new work and allows active requests up to 30 seconds to drain. Results are committed after every completed candidate, so the dashboard does not wait for the slowest task before updating.

### What the run counters mean

- **New strong**: a strong Netherlands match first stored during this run.
- **Reward-eligible**: a distinct strong match with a posting date no more than 60 days old.
- **Weighted reward**: reward-eligible matches adjusted by the freshness weights above.
- **Processed**: employer boards or embedded-feed candidates fully evaluated; this is not the number of vacancies returned.
- **Returned**: raw candidates returned by a source pull.
- **Uniquely queued**: returned candidates that were not already in the run queue.
- **True duplicates**: repeated candidates merged before processing.

All Netherlands vacancies contribute employer and source-health evidence. Full job records retain strong and plausible possible matches. Other vacancies retain lightweight identity and decision evidence, which remains visible through the Excluded or All filters.

## Search profile

[`config/profile.json`](config/profile.json) defines:

- target country and recognized Dutch locations;
- preferred and acceptable role families;
- title, description, and technical-evidence terms;
- seniority and exclusion rules;
- location preferences and commute categories; and
- scoring and expiry behavior.

The Settings page is the safest way to change location preferences. For role families and other advanced rules, stop the dashboard, edit `config/profile.json`, validate the configuration, rescore stored jobs, and restart:

```powershell
npm run dev -- doctor
npm run dev -- rescore --all
npm run dev:api
```

Rescoring preserves applications, notes, review states, documents, and first-seen dates.

Employer discovery is automatic. [`config/sources.json`](config/sources.json) is an optional override for corrected or unsupported employer boards, not the main way to populate the database. Verified benchmark career URLs live in [`config/employers.json`](config/employers.json).

## Discovery sources

Built-in discovery includes public Dutch feeds, ATS directories, known employer boards, benchmark employers, and provider manifests. Provider resolution supports Greenhouse, Lever, Ashby, Workable, Recruitee, SmartRecruiters, Workday, iCIMS, Personio public XML boards, and constrained public-page fallback.

Optional sources are disabled until explicitly configured.

### LinkedIn Guest

LinkedIn Guest is experimental and is not registered unless both opt-ins are present:

```dotenv
DIEGO_ENABLE_LINKEDIN_GUEST=true
DIEGO_LINKEDIN_GUEST_PERMISSION_CONFIRMED=true
```

The permission flag acknowledges that you have appropriate permission to use the public endpoint. Keywords are derived from the search profile unless overridden:

```dotenv
DIEGO_LINKEDIN_GUEST_KEYWORDS="data scientist OR machine learning engineer"
DIEGO_LINKEDIN_GUEST_LOCATION=Netherlands
```

Timed discovery starts from the 25 newest results and continues through later pages while there is useful capacity.

### JobSpy

JobSpy is an optional multi-board layer and is disabled by default. Install the pinned integration, preferably in a dedicated Python virtual environment:

```powershell
py -m pip install -r requirements-jobspy.txt
```

Then enable the integration and explicitly confirm each selected board:

```dotenv
DIEGO_ENABLE_JOBSPY=true
DIEGO_JOBSPY_SITES=indeed,glassdoor
DIEGO_JOBSPY_INDEED_PERMISSION_CONFIRMED=true
DIEGO_JOBSPY_GLASSDOOR_PERMISSION_CONFIRMED=true
```

An unconfirmed platform is neither registered nor queried. JobSpy's LinkedIn scraper is intentionally unavailable through this bridge; LinkedIn Guest is a separate adapter.

JobSpy uses focused role/city search arms. The default freshness window is seven days (`168` hours), with a maximum of 15 results per national role search, 10 per preferred-city search, and 100 per platform per collection call. The hard platform cap is 200.

Common overrides:

```dotenv
DIEGO_JOBSPY_COMMAND=C:\path\to\jobspy.exe
DIEGO_JOBSPY_HOURS_OLD=168
DIEGO_JOBSPY_QUERIES=data scientist;machine learning engineer
DIEGO_JOBSPY_PREFERRED_CITIES=Amsterdam;Utrecht;Eindhoven
DIEGO_JOBSPY_LOCATION=Netherlands
DIEGO_JOBSPY_COUNTRY=Netherlands
DIEGO_JOBSPY_TIMEOUT_MS=120000
DIEGO_JOBSPY_MAX_PER_SEARCH=15
DIEGO_JOBSPY_MAX_PER_CITY=10
DIEGO_JOBSPY_MAX_PER_PLATFORM=100
```

See [`docs/jobspy-integration.md`](docs/jobspy-integration.md) for implementation and troubleshooting details.

### Brave Search fallback

Brave Search is optional and never required:

```dotenv
DIEGO_SEARCH_ENABLED=true
DIEGO_SEARCH_API_KEY=your-key
```

### Optional AI scoring

Rules-based matching and scoring always work locally. AI scoring is off by default:

```dotenv
DIEGO_AI_ENABLED=true
DIEGO_AI_BASE_URL=https://your-compatible-endpoint.example/v1
DIEGO_AI_API_KEY=your-key
DIEGO_AI_MODEL=your-model
```

Keys stay in environment variables and are not stored in SQLite or checked-in configuration files. Application notes and provider response bodies are not sent for AI scoring.

Place local environment settings in `.env.local`; this file is ignored by Git.

## Description enrichment and recall

Discovery does not wait for every description. Plausible jobs with missing or short descriptions enter a persistent enrichment queue. The background runner processes batches of 20 with at most two concurrent requests, and only while discovery is idle. Starting discovery pauses enrichment without consuming a retry.

Exact-title, structured-metadata, and description-derived matches remain distinct in the job evidence and scoring ledger. A generic Remote or Europe-wide location is treated as uncertain rather than automatically Dutch; structured foreign-country evidence excludes it.

Transient enrichment failures use cooldowns and `Retry-After`, with at most four automatic attempts. Permanent HTTP failures and pages without a usable description become terminal immediately.

## Local data and privacy

The dashboard and API bind to `127.0.0.1` by default. Data stays on the machine unless an enabled source or optional AI endpoint is called.

Default storage:

- SQLite database: `data/diego-career-ops.sqlite`
- automatic migration backups: `data/backups`
- uploaded application documents: managed under the local data directory
- search profile: `config/profile.json`

Override the data locations with `DIEGO_DATA_DIR` or `DIEGO_DB_PATH`.

Only public HTTPS pages are collected. Redirects are validated and limited, private-network destinations and credentials in URLs are rejected, and the collectors do not bypass authentication, CAPTCHAs, or access controls. Experimental sources fail independently and do not abort unrelated sources.

To restore a database backup, stop the dashboard and all collectors first. Move the current SQLite database and its `-wal` and `-shm` files aside, restore the selected backup under the configured database filename, and keep the displaced files until the restored database has been verified.

## Troubleshooting

### `EADDRINUSE: address already in use 127.0.0.1:4310`

Another Diego server is already using port 4310. Usually the dashboard is already running, so open <http://127.0.0.1:4310> instead of starting a second copy. Otherwise, return to the PowerShell window running Diego and press `Ctrl+C`.

To use another port:

```powershell
npm run dev:api -- --port 4311
```

Then open <http://127.0.0.1:4311>.

### SQLite experimental warning

Node 22 may print:

```text
ExperimentalWarning: SQLite is an experimental feature
```

This is a Node runtime warning, not a Diego startup failure. The line after it should show the dashboard address. An actual startup failure includes an error such as `EADDRINUSE`.

### Dashboard does not open

- Confirm that the terminal still shows `Diego Career Ops: http://127.0.0.1:4310`.
- Run `npm run dev -- doctor` after stopping the server.
- Check that no local firewall or security tool is blocking the selected loopback port.
- Run `npm run build` to surface dashboard or TypeScript build errors.

### An optional source is missing

- Confirm its enable flag in `.env.local`.
- Confirm every required permission flag.
- Restart the dashboard after changing environment variables.
- For JobSpy, confirm that the configured command is installed and callable.
- Open Sources and the latest Discovery run to distinguish disabled, cooling, exhausted, and failed sources.

### A run found fewer jobs than expected

Open its history on Discovery and inspect Returned, Uniquely queued, True duplicates, Processed, source errors, and the technical trace. A low total can mean the source returned little new inventory, results were already known, search arms were cooling down, boards were slow, or the run ended before more pages could be processed. Sources provides the longer-term comparison.

## Command line reference

The CLI is an advanced interface. Normal discovery, review, and application tracking belong in the dashboard.

```powershell
# Health and configuration
npm run dev -- doctor

# Read-only reports
npm run dev -- jobs --summary
npm run dev -- employers
npm run dev -- sources
npm run dev -- coverage
npm run dev -- stats
npm run dev -- discovery-failures --retryable

# Maintenance
npm run dev -- rescore --all
npm run dev -- enrich --pending --limit 100

# Legacy candidate-budget discovery
npm run dev -- discover --limit 100 --workers 6
npm run dev -- discover --mode refresh-known --limit 100
npm run dev -- discover --retry-failures --limit 50
```

CLI discovery uses a candidate budget rather than the dashboard's processing-time window. `Ctrl+C` cancels active HTTP work, saves the checkpoint, and leaves pending candidates resumable with `--resume`.

## API reference

The browser uses the local JSON API. The most useful integration endpoints are:

- `GET /health`
- `GET /api/v1/overview`
- `GET /api/v1/jobs` and `GET /api/v1/jobs/:id`
- `PATCH /api/v1/jobs/:id/review`
- `PUT|PATCH /api/v1/jobs/:id/application`
- `GET /api/v1/applications`
- `GET /api/v1/employers` and `GET /api/v1/employers/:id`
- `GET /api/v1/source-performance`
- `GET /api/v1/coverage` and `GET /api/v1/coverage/overlap`
- `GET /api/v1/discovery/plan?durationMinutes=10`
- `POST /api/v1/discovery` with `{ "durationMinutes": 10 }`
- `GET /api/v1/discovery/active`
- `GET /api/v1/discovery/runs` and `GET /api/v1/discovery/runs/:id`
- `GET /api/v1/discovery/runs/:id/trace`
- `POST /api/v1/discovery/runs/:id/cancel`
- `POST /api/v1/discovery/manual` with `{ "url": "https://...", "saveToPipeline": true }`
- `GET /api/v1/enrichment/queue`
- `POST /api/v1/enrichment/queue/process`
- `GET|PUT /api/v1/profile`

Jobs support query filters including `q`, `company`, `roleFamily`, `provider`, `status`, `matchState`, `minScore`, `reviewState`, `applicationStage`, `seniority`, `workArrangement`, `locationAccess`, `sort`, `limit`, and `offset`.

## Development

```powershell
npm run typecheck
npm test
npm run test:web
npm run build
```

`npm test` builds and runs the server tests. `npm run test:web` runs the dashboard tests. `npm run build` creates the production server and web assets in `dist`.

Recall verification is available for changes to collection or matching behavior:

```powershell
npm run dev -- recall-check --file tests/fixtures/recall-30.json
npm run dev -- recall-check --file tests/fixtures/recall-30.json --live
```

## Attribution

Selected Feashliaa ATS directories remain included under CC BY-NC 4.0. See [`NOTICE.md`](NOTICE.md) for attribution and third-party notices.
