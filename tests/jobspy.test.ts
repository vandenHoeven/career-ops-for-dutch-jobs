import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/database.js';
import { discover } from '../src/discovery.js';
import { getDiscoverySources } from '../src/discovery-sources.js';
import { createJobSpySource, jobSpyPreferredCitiesFromProfile, jobSpyQueriesFromProfile, JOBSPY_VERSION, parseJobSpyJsonl, runJobSpy } from '../src/jobspy.js';
import { loadProfile } from '../src/config.js';

const fixture = readFileSync(resolve('tests/fixtures/jobspy-cli.jsonl'), 'utf8');
const emitter = resolve('tests/fixtures/jobspy-cli-fixture.mjs');
const offline = { fetchJson: async () => { throw new Error('unexpected network request'); }, fetchText: async () => { throw new Error('unexpected network request'); } };

test('JobSpy all-fields JSONL maps to RawJob without losing board identity', () => {
  const jobs = parseJobSpyJsonl(fixture);
  assert.equal(JOBSPY_VERSION, '1.4.1');
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(job => ({ site: (job.raw as any).site, id: job.externalId, title: job.title, country: job.countryCode })), [
    { site: 'indeed', id: 'in-abc123', title: 'Data Analyst', country: 'NL' },
    { site: 'glassdoor', id: 'gd-987', title: 'Data Scientist', country: 'NL' },
  ]);
  assert.equal(jobs[0].applyUrl, 'https://careers.example.nl/jobs/42/apply');
  assert.equal(jobs[0].description, 'Analyseer data met SQL en Python.');
  assert.equal(jobs[1].workArrangement, 'remote');
});

test('small subprocess bridge invokes the JSONL CLI contract with bounded output', async () => {
  const jobs = await runJobSpy({ site: 'indeed', query: 'data', command: process.execPath, prefixArgs: [emitter], resultsWanted: 1, timeoutMs: 5_000 });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].externalId, 'in-abc123');
  assert.equal((jobs[0].raw as any).site, 'indeed');
});

test('JobSpy exposes rotating role and city search arms and pulls one meaningful batch', async () => {
  const source = createJobSpySource({ site: 'indeed', query: 'data roles', queries: ['data analyst', 'data scientist'], preferredCities: ['den bosch', 'utrecht'], maxPerPlatform: 8, maxPerSearch: 3, maxPerCity: 1, command: process.execPath, prefixArgs: [emitter], timeoutMs: 5_000 });
  const arms=await source.listArms!();assert.equal(arms.length,4);assert.deepEqual(arms.map(arm=>arm.metadata?.kind).sort(),['national-role','national-role','preferred-city','preferred-city']);assert.deepEqual(arms.filter(arm=>arm.metadata?.kind==='preferred-city').map(arm=>arm.metadata?.location).sort(),['den bosch','utrecht']);
  const first=await source.discoverArm!(offline,arms[0],8),second=await source.discover(offline,1,8),record=(first.candidates[0].jobs![0].raw as any).record;assert.equal(first.candidates.length,1);assert.equal(second.candidates.length,1);assert.equal(first.candidates[0].searchArmId,arms[0].id);assert.equal(second.arm?.id,arms[1].id);assert.equal(((first.candidates[0].jobs![0].raw as any).searches as any[]).length,1);assert.equal(record.fixture_hours_old,'168');assert.equal(record.fixture_results_wanted,'3');
});

test('default hybrid plan derives role-family queries and current preferred cities from the profile', async () => {
  const profile = await loadProfile(), queries = jobSpyQueriesFromProfile(profile), cities = jobSpyPreferredCitiesFromProfile(profile);
  assert.ok(queries.some(query => query.includes('data scientist')));
  assert.ok(queries.some(query => query.includes('machine learning engineer')));
  assert.ok(queries.some(query => query.includes('data analyst')));
  assert.deepEqual(cities, ['den bosch', 'utrecht', 'eindhoven']);
});

test('subprocess bridge reports CLI failure, malformed JSONL and timeout', async () => {
  await assert.rejects(runJobSpy({ site: 'indeed', query: 'fail', command: process.execPath, prefixArgs: [emitter], timeoutMs: 5_000 }), /exit code 1: fixture board failed/);
  await assert.rejects(runJobSpy({ site: 'indeed', query: 'malformed', command: process.execPath, prefixArgs: [emitter], timeoutMs: 5_000 }), /invalid JSONL on line 1/);
  await assert.rejects(runJobSpy({ site: 'indeed', query: 'hang', command: process.execPath, prefixArgs: [emitter], timeoutMs: 50 }), /timed out after 50ms/);
});

test('independent JobSpy platform sources reuse discovery, filtering and SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diego-jobspy-')), store = new Store(join(dir, 'test.sqlite'));
  try {
    const common = { query: 'data', command: process.execPath, prefixArgs: [emitter], resultsWanted: 1, timeoutMs: 5_000 };
    const result = await discover({ store, sources: [createJobSpySource({ ...common, site: 'indeed' }), createJobSpySource({ ...common, site: 'glassdoor' })], limit: 2, context: offline, enrichmentLimit: 0 });
    assert.equal(result.fetchedJobs, 2);
    assert.deepEqual((store.db.prepare('SELECT DISTINCT source_id FROM source_observations ORDER BY source_id').all() as any[]).map(row => row.source_id), ['jobspy-glassdoor', 'jobspy-indeed']);
    assert.equal((store.db.prepare('SELECT count(*) n FROM jobs').get() as any).n, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('each JobSpy platform requires global enablement, selection and its own permission flag', () => {
  const names = ['DIEGO_ENABLE_JOBSPY', 'DIEGO_JOBSPY_SITES', 'DIEGO_JOBSPY_INDEED_PERMISSION_CONFIRMED', 'DIEGO_JOBSPY_GLASSDOOR_PERMISSION_CONFIRMED'];
  const prior = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.throws(() => getDiscoverySources('jobspy-indeed'), /disabled/);
    process.env.DIEGO_ENABLE_JOBSPY = 'true';
    process.env.DIEGO_JOBSPY_SITES = 'indeed,glassdoor';
    process.env.DIEGO_JOBSPY_INDEED_PERMISSION_CONFIRMED = 'true';
    assert.equal(getDiscoverySources('jobspy-indeed')[0].id, 'jobspy-indeed');
    assert.throws(() => getDiscoverySources('jobspy-glassdoor'), /disabled/);
    assert.ok(!getDiscoverySources().some(source => source.id === 'linkedin-guest'));
  } finally {
    for (const [name, value] of prior) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
});
