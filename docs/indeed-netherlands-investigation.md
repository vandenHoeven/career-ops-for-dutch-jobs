# Indeed Netherlands source investigation

Date: 2026-10-30

> Implementation recommendation superseded by [JobSpy collection layer](jobspy-integration.md). This document remains the record of the Indeed-specific parser and access investigation.

## Recommendation

Use the pinned JobSpy JSONL CLI through the shared TypeScript bridge when Indeed access is authorized. The CLI removes the need for a custom Python wrapper and makes JobSpy reusable for Glassdoor and other boards. Keep the Mosaic/JSON-LD code as an offline parser POC, not a second live transport.

## Current JobSpy behavior

Inspected upstream `main` and package version 1.4.1:

- `Indeed.scrape()` maps `country_indeed="Netherlands"` to country `NL`, language `nl`, and base URL `https://nl.indeed.com`.
- Search is a `POST` to `https://apis.indeed.com/graphql`, not an HTML-card scraper. Its request includes a bundled `indeed-api-key`, `indeed-co: NL`, `indeed-locale: nl-NL`, and an Indeed iOS-app user agent/app-info header.
- The GraphQL `jobSearch` query requests 100 rows per page, relevance sorting, descriptions, locations, compensation, attributes, employer data and `recruit.viewJobUrl`.
- Pagination follows `pageInfo.nextCursor`. Each page is deduplicated by Indeed `job.key`; it stops when there are no new keys or no next cursor. The caller's numeric offset is implemented by fetching and skipping preceding results, not by an Indeed numeric offset.
- Parsing is validated with Pydantic. The output maps the key to `in-{key}`, converts `dateOnIndeed` from epoch milliseconds, turns description HTML into the selected output format, creates `https://nl.indeed.com/viewjob?jk={key}`, and keeps `recruit.viewJobUrl` only when it is outside `indeed.com`.
- Netherlands is explicitly present in JobSpy's country enum, country-code table and locale table.
- A failed request or payload validation ends collection after recording an error; duplicates and malformed individual jobs are skipped.

Sources: [JobSpy Indeed adapter](https://github.com/speedyapply/JobSpy/blob/main/jobspy/indeed/__init__.py), [query and country constants](https://github.com/speedyapply/JobSpy/blob/main/jobspy/indeed/constant.py), [Indeed models](https://github.com/speedyapply/JobSpy/blob/main/jobspy/indeed/model.py), [package metadata](https://github.com/speedyapply/JobSpy/blob/main/pyproject.toml), and [README](https://github.com/speedyapply/JobSpy).

## fetchaller-mcp structured data

fetchaller documents and implements a different, Canada-specific surface:

- Search HTML assigns structured JSON to `window.mosaic.providerData["mosaic-provider-jobcards"]`.
- Cards live at `metaData.mosaicProviderJobCardsModel.results` and include `jobkey`, title, company, formatted location, relative posting text, snippets, and structured salary data such as `extractedSalary: {min, max, type}`.
- Detail HTML carries published schema.org `JobPosting` JSON-LD with full description, `datePosted`, salary and `validThrough`.
- Its current implementation deliberately fetches one reliable search page. The project measured deeper `start` offsets returning a sign-in wall; other page parameters were ignored, and some parameters triggered Cloudflare. It therefore reports partial coverage instead of pretending pagination completed.
- It validates page structure so a login shell, soft 404, challenge, or markup change is not misreported as an empty search.

This is valuable parser evidence, but not proof that the same live behavior currently holds on `nl.indeed.com`. The POC therefore uses offline fixtures only.

Sources: [fetchaller site API notes](https://github.com/Averyy/fetchaller-mcp/blob/main/docs/site-apis.md) and [Indeed parser implementation](https://github.com/Averyy/fetchaller-mcp/blob/main/src/fetchaller/indeed/api.py).

## JobSpy subprocess vs native TypeScript

| Concern | JobSpy subprocess | Native TypeScript adapter |
|---|---|---|
| CareerOps fit | Requires a process/JSON boundary before `RawJob` | Direct `DiscoverySource -> RawJob -> processJob` |
| Dependencies | Python 3.10+, `requests`, BeautifulSoup, pandas, Pydantic, `curl_cffi`, markdownify | No new dependency for the offline parser; existing Node APIs are sufficient |
| Coverage | Cursor pagination, 100/page, full descriptions and direct apply URL in the search response | Mosaic is one reliable page per targeted query; GraphQL can match JobSpy only if specifically authorized |
| Cursor fit | JobSpy accepts numeric offset but replays prior cursor pages | Query-index cursor fits today; opaque GraphQL cursor would need persistence work or replay |
| Operational complexity | Python discovery, environment/version pinning, subprocess timeout, stdout/stderr framing, schema/version drift | Existing fetch timeout/error path; smaller deployment surface |
| Upstream maintenance | Indeed changes may be repaired upstream, but can also arrive unexpectedly after an upgrade | CareerOps owns a small parser and transport contract |
| Access risk | Uses an undocumented API, static app key and mobile app identity | Browser HTML is a public interface, but automation still needs Indeed's express written permission |

JobSpy remains an excellent reference implementation and possible manually pinned fallback for an explicitly authorized GraphQL test. It is not the lowest-complexity production dependency for this Node/TypeScript application.

## Architecture and deduplication

The fixture source uses:

`DiscoverySource (job-feed) -> DiscoveryCandidate.jobs -> RawJob -> processJob -> SQLite`

No new persistence path is needed. The correct production provenance would be source ID `indeed-netherlands`; adding an `indeed` provider ID can wait until the source is authorized and registered. The POC uses provider `browser`, so no production type or registry was changed.

Existing duplicate handling works in two layers:

1. `deduplicate()` removes canonical-URL, external-ID, or normalized `company + title + location` fingerprint matches in a batch.
2. `processJob()`/`Store.upsertJob()` checks canonical URL or fingerprint against SQLite. Cross-posted Indeed, LinkedIn and ATS URLs with different external IDs converge on one job row, while `source_observations` retains all observed sources and URLs.

The fingerprint is intentionally simple. It can false-merge simultaneous same-title roles at one company/location and can miss overlaps when company aliases or location strings differ. Indeed does not make this worse, but a future improvement should normalize employer aliases and preserve provider-specific IDs in an identity table rather than weakening the current fingerprint.

## Offline proof of concept and results

Implemented without registry or dashboard changes:

- `src/indeed-poc.ts`: balanced Mosaic JSON extraction, schema.org detail joining, current JobSpy GraphQL response mapping, and an offline fixture `DiscoverySource`.
- Three fixtures cover Mosaic cards, detail JSON-LD, and JobSpy's GraphQL shape.
- `tests/indeed-poc.test.ts`: six tests, all passing.

Verified fields:

| Field | Mosaic card | JSON-LD detail | JobSpy GraphQL fixture |
|---|---:|---:|---:|
| title | yes | yes | yes |
| company | yes | yes | yes |
| location | yes | yes | yes |
| description | snippet only | full | full |
| posting date | `pubDate` when present; relative text retained only as raw evidence | `datePosted` | `dateOnIndeed` |
| Indeed job ID | `jobkey` | joined from card | `key` |
| application URL | no reliable direct URL | not generally published separately | external `recruit.viewJobUrl` when present; Indeed links rejected as direct URLs |

The pipeline test stored two Netherlands jobs in SQLite with descriptions, dates, IDs and the available external application URL. The overlap test fed equivalent Indeed, LinkedIn and ATS records: the in-memory result was one job plus two duplicates, SQLite contained one job, and three source-observation rows were preserved. Challenge/changed-shape fixtures fail closed.

## Access restrictions and live-test gate

Indeed's Netherlands terms, updated 1 April 2026, allow personal non-commercial job-seeking use but prohibit automated systems from accessing or collecting from the site without Indeed's express written permission, apart from conditional robots.txt permission. They also prohibit crawling/scraping/extraction and bypassing restrictions. API use is subject to separate developer/API terms and limits. See the [Netherlands terms, website rules](https://nl.indeed.com/legal#tos?from=gnav-homepage) (the relevant current text is in section D.21).

A permitted live test requires all of the following before any request is enabled:

1. Express written permission from Indeed, not only permission from employers or other job providers.
2. The permission identifies CareerOps' personal/local use and the exact authorized surface: official API, Mosaic search HTML, detail `/viewjob`, or the GraphQL endpoint. Permission for one must not be assumed to cover another.
3. Written limits for query volume, frequency, pagination, storage/retention, display, and whether descriptions/direct application URLs may be stored.
4. Confirmation of the permitted user agent/authentication and whether robots.txt restrictions remain applicable. Do not impersonate the Indeed mobile app or reuse JobSpy's bundled API key unless Indeed expressly authorizes that behavior.
5. A manual, isolated test command guarded by two opt-ins (feature enabled plus permission confirmed), a very small request cap, sequential requests, clear identification, no proxies or challenge bypass, content-shape validation, and immediate stop on 403/429, login wall, CAPTCHA, missing container, or revoked permission.
6. Only after saved responses pass the offline parser and dedup tests should the source be considered for the production discovery registry.

## Expected maintenance burden

- Native Mosaic + JSON-LD, targeted queries: low code burden, medium operational burden. JSON-LD is comparatively stable; Mosaic field/assignment names and access behavior can change. Expect a fixture refresh and selector/schema check when parsing fails, plus periodic permission/terms review.
- Native authorized GraphQL: medium code burden, high access-contract burden. It provides substantially better recall and fewer detail requests, but the schema, credentials, headers and cursor behavior are undocumented unless Indeed grants a supported contract.
- JobSpy subprocess: low Indeed-specific coding burden, medium-to-high deployment burden. Pinning reduces surprise but delays upstream fixes; unpinned upgrades risk silent schema changes. Python and native `curl_cffi` packaging are disproportionate for this local Node application.

For the stated goal, start with a handful of high-yield Netherlands role queries through the native adapter after permission, measure unique new jobs after fingerprint dedup, and add query partitions only when they contribute incremental relevant vacancies.
