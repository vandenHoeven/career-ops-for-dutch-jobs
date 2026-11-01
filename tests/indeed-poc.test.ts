import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deduplicate } from '../src/core.js';
import { loadProfile } from '../src/config.js';
import { Store } from '../src/database.js';
import { discover } from '../src/discovery.js';
import { indeedFixtureSource, mergeIndeedJsonLdDetail, parseIndeedMosaicSearch, parseJobSpyIndeedPage } from '../src/indeed-poc.js';
import { processJob } from '../src/processing.js';
import type { RawJob } from '../src/types.js';

const mosaic = readFileSync(resolve('tests/fixtures/indeed-mosaic-search.html'), 'utf8');
const detail = readFileSync(resolve('tests/fixtures/indeed-detail.html'), 'utf8');
const graphql = JSON.parse(readFileSync(resolve('tests/fixtures/indeed-jobspy-graphql.json'), 'utf8'));
const offline = { fetchJson: async () => { throw new Error('unexpected network request'); }, fetchText: async () => { throw new Error('unexpected network request'); } };

test('Mosaic fixture extracts stable Indeed card identity and searchable fields', () => {
  const jobs = parseIndeedMosaicSearch(mosaic);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(job => ({ id: job.externalId, title: job.title, company: job.company, location: job.location, postedAt: job.postedAt })), [
    { id: 'abc123def456', title: 'Data Analyst', company: 'Example Analytics B.V.', location: 'Amsterdam', postedAt: '2026-10-29' },
    { id: 'fed654cba321', title: 'Machine Learning Engineer', company: 'Canal AI', location: 'Utrecht', postedAt: '2026-10-30' },
  ]);
  assert.equal(jobs[0].url, 'https://nl.indeed.com/viewjob?jk=abc123def456');
  assert.match(jobs[0].summary ?? '', /SQL en Python/);
  assert.deepEqual((jobs[0].raw as any).extractedSalary, { min: 4200, max: 5200, type: 'monthly' });
});

test('JobPosting JSON-LD fixture supplies description, precise date and expiry', () => {
  const job = mergeIndeedJsonLdDetail(parseIndeedMosaicSearch(mosaic)[0], detail);
  assert.equal(job.title, 'Data Analyst');
  assert.equal(job.company, 'Example Analytics B.V.');
  assert.equal(job.location, 'Amsterdam, Noord-Holland, NL');
  assert.equal(job.description, 'Bouw dashboards en analyseer data met SQL en Python. Werk samen met productteams.');
  assert.equal(job.postedAt, '2026-10-29');
  assert.equal(job.validThrough, '2026-11-30');
  assert.equal(job.externalId, 'abc123def456');
});

test('current JobSpy GraphQL fixture maps cursor, description, Indeed ID and external apply URL', () => {
  const page = parseJobSpyIndeedPage(graphql);
  assert.equal(page.nextCursor, 'cursor-page-2');
  assert.equal(page.jobs.length, 2);
  assert.deepEqual({
    title: page.jobs[0].title,
    company: page.jobs[0].company,
    location: page.jobs[0].location,
    description: page.jobs[0].description,
    postedAt: page.jobs[0].postedAt,
    externalId: page.jobs[0].externalId,
    applyUrl: page.jobs[0].applyUrl,
  }, {
    title: 'Data Analyst',
    company: 'Example Analytics B.V.',
    location: 'Amsterdam, NH, Netherlands',
    description: 'Bouw dashboards en analyseer data met SQL en Python.',
    postedAt: '2026-10-29',
    externalId: 'abc123def456',
    applyUrl: 'https://careers.example.nl/jobs/REQ-42/apply',
  });
  assert.equal(page.jobs[1].applyUrl, undefined, 'an Indeed redirect is not misreported as a direct application URL');
});

test('offline Indeed source crosses DiscoverySource to processJob and SQLite without network', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diego-indeed-poc-')), store = new Store(join(dir, 'test.sqlite'));
  try {
    const jobs = parseJobSpyIndeedPage(graphql).jobs;
    const result = await discover({ store, sources: [indeedFixtureSource(jobs)], limit: 2, context: offline, enrichmentLimit: 0 });
    assert.equal(result.fetchedJobs, 2);
    assert.equal((store.db.prepare('SELECT count(*) n FROM jobs').get() as any).n, 2);
    assert.equal((store.db.prepare("SELECT count(*) n FROM source_observations WHERE source_id='indeed-netherlands-poc'").get() as any).n, 2);
    const saved = store.db.prepare("SELECT external_id,apply_url,posted_at,description FROM jobs WHERE external_id='abc123def456'").get() as any;
    assert.equal(saved.apply_url, 'https://careers.example.nl/jobs/REQ-42/apply');
    assert.equal(saved.posted_at, '2026-10-29');
    assert.match(saved.description, /SQL en Python/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Indeed, LinkedIn and ATS overlap deduplicates by cross-listing fingerprint and preserves provenance', async () => {
  const indeed = parseJobSpyIndeedPage(graphql).jobs[0];
  const linkedIn: RawJob = { ...indeed, externalId: 'linkedin-9988', url: 'https://www.linkedin.com/jobs/view/9988', applyUrl: undefined, raw: { source: 'linkedin-guest' } };
  const ats: RawJob = { ...indeed, externalId: 'REQ-42', url: 'https://careers.example.nl/jobs/REQ-42', raw: { source: 'ats' } };
  const memory = deduplicate([indeed, linkedIn, ats]);
  assert.equal(memory.jobs.length, 1);
  assert.equal(memory.duplicateCount, 2);

  const dir = mkdtempSync(join(tmpdir(), 'diego-indeed-dedup-')), store = new Store(join(dir, 'test.sqlite'));
  try {
    store.startRun('overlap');
    const profile = await loadProfile();
    for (const [sourceId, job] of [['indeed-netherlands-poc', indeed], ['linkedin-guest', linkedIn], ['example-ats', ats]] as const) {
      processJob(job, { store, profile, sourceId, provider: 'browser', scanId: 'overlap' });
    }
    assert.equal((store.db.prepare('SELECT count(*) n FROM jobs').get() as any).n, 1);
    assert.equal((store.db.prepare('SELECT count(*) n FROM source_observations').get() as any).n, 3);
    assert.deepEqual((store.db.prepare('SELECT source_id FROM source_observations ORDER BY source_id').all() as any[]).map(row => row.source_id), ['example-ats', 'indeed-netherlands-poc', 'linkedin-guest']);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('offline parsers fail closed on a challenge or changed response shape', () => {
  assert.throws(() => parseIndeedMosaicSearch('<html>Sign in</html>'), /no Mosaic job-card container/);
  assert.throws(() => parseJobSpyIndeedPage({ data: {} }), /no data\.jobSearch\.results/);
});
