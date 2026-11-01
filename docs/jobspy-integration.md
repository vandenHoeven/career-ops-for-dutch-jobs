# JobSpy collection layer

JobSpy can serve as CareerOps' reusable collection layer for supported boards. Version 1.4.0 added a CLI that emits one JSON object per job on stdout, sends diagnostics to stderr, and defines useful exit codes. Passing `--fields all` includes `id`, `site`, full description, direct application URL and the rest of the `JobPost` schema; the default preview would omit several fields CareerOps needs. The integration pins `python-jobspy==1.4.1`.

The implementation is deliberately small:

- `runJobSpy()` spawns the CLI directly without a shell, caps each individual search at 50 results, enforces a timeout and 8 MiB output ceiling, and treats nonzero exits or malformed JSONL as collection failures.
- `rawJobFromJobSpy()` maps the CLI record to `RawJob`.
- `createJobSpySource()` exposes an ordinary job-feed `DiscoverySource`; existing filtering, ranking, `processJob`, deduplication and SQLite storage are unchanged.
- Each platform is a separate source (`jobspy-indeed`, `jobspy-glassdoor`, and so on), while the original JobSpy `site` and record remain in `raw`. This preserves provenance and prevents one board's success from hiding another board's failure.
- LinkedIn is intentionally absent from `JOBSPY_SITES`; the existing LinkedIn Guest adapter is unchanged.

Configuration is independent per platform. A source appears only when all three conditions hold:

1. `DIEGO_ENABLE_JOBSPY=true`
2. the platform is listed in `DIEGO_JOBSPY_SITES`
3. `DIEGO_JOBSPY_<PLATFORM>_PERMISSION_CONFIRMED=true`

The bridge currently permits JobSpy's Indeed, Glassdoor, ZipRecruiter, Bayt, BDJobs, Naukri and HelloWork identifiers. This is capability, not authorization: do not set a platform flag until its required permission has been obtained. The country/location defaults are Netherlands.

Coverage uses a bounded hybrid plan. Each role family gets a focused national query using up to its first three configured title terms. Up to 30% of the platform budget is reserved for broad top-up searches in the profile's preferred cities (currently Den Bosch, Utrecht and Eindhoven). Duplicate platform IDs and cross-listing fingerprints are removed before candidates enter discovery, while every query/location that found a retained job is kept in its raw provenance. Defaults are 15 results per national search, 10 per city and 100 total per platform; the hard total cap is 200. Semicolon-separated `DIEGO_JOBSPY_QUERIES` and `DIEGO_JOBSPY_PREFERRED_CITIES` override the derived plan, and `DIEGO_JOBSPY_HOURS_OLD` adds a freshness filter.

## Complexity comparison

The reusable bridge is roughly the same amount of production TypeScript as the earlier Indeed-only offline POC, but covers seven JobSpy platforms and delegates their request, pagination and parsing changes upstream. A separate native adapter would repeat transport, blocking detection, pagination, schema mapping, error handling and fixtures for every board. The subprocess cost is one pinned Python CLI environment and a process launch per enabled platform; for an on-demand local hobby application this is a better maintenance tradeoff than independent adapters.

JobSpy does not remove platform access restrictions. It is a technical collection layer, not an authorization layer. Per-platform gates remain mandatory, and a blocked or unauthorized platform must remain disabled.

Upstream references: [CLI implementation](https://github.com/speedyapply/JobSpy/blob/main/jobspy/cli.py), [JSONL records](https://github.com/speedyapply/JobSpy/blob/main/jobspy/records.py), [v1.4.0 release](https://github.com/speedyapply/JobSpy/releases/tag/v1.4.0), and [pinned package metadata](https://github.com/speedyapply/JobSpy/blob/main/pyproject.toml).
