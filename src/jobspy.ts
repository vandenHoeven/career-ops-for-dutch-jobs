import { spawn } from 'node:child_process';
import { loadProfile } from './config.js';
import { deduplicate } from './core.js';
import { plainText } from './posting-parser.js';
import type { DiscoveryCandidate, DiscoverySource, ProfileConfig, RawJob, WorkArrangement } from './types.js';

export const JOBSPY_VERSION = '1.4.1';
export const JOBSPY_SITES = ['indeed', 'glassdoor', 'zip_recruiter', 'bayt', 'bdjobs', 'naukri', 'hellowork'] as const;
export type JobSpySite = typeof JOBSPY_SITES[number];

interface JobSpyRow {
  site?: unknown; id?: unknown; job_url?: unknown; job_url_direct?: unknown;
  title?: unknown; company?: unknown; location?: unknown; date_posted?: unknown;
  description?: unknown; is_remote?: unknown; [key: string]: unknown;
}

export interface JobSpyRunOptions {
  site: JobSpySite; query: string; location?: string; countryIndeed?: string;
  resultsWanted?: number; timeoutMs?: number; hoursOld?: number; command?: string; prefixArgs?: string[];
}

export interface JobSpySourceOptions extends Omit<JobSpyRunOptions, 'query'> {
  query?: string; queries?: string[]; preferredCities?: string[];
  maxPerSearch?: number; maxPerCity?: number; maxPerPlatform?: number;
}

const text = (value: unknown) => plainText(String(value ?? ''));
const positiveInteger = (value: number | undefined, fallback: number, maximum: number) => Math.min(Math.max(Math.trunc(value ?? fallback), 1), maximum);

function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}

function workArrangement(row: JobSpyRow): WorkArrangement {
  return row.is_remote === true ? 'remote' : 'unknown';
}

export function rawJobFromJobSpy(row: JobSpyRow): RawJob | undefined {
  const site = text(row.site), externalId = text(row.id), title = text(row.title), company = text(row.company);
  const url = webUrl(row.job_url), location = text(row.location);
  if (!site || !externalId || !title || !company || !url) return undefined;
  const postedAt = /^\d{4}-\d{2}-\d{2}/.test(text(row.date_posted)) ? text(row.date_posted).slice(0, 10) : undefined;
  const countryCode = /\b(?:the )?netherlands\b|\bnederland\b/i.test(location) ? 'NL' : undefined;
  return {
    externalId, title, company, location, countryCode, url,
    applyUrl: webUrl(row.job_url_direct), postedAt,
    description: text(row.description) || undefined,
    workArrangement: workArrangement(row),
    raw: { source: 'jobspy', site, version: JOBSPY_VERSION, record: row },
  };
}

export function parseJobSpyJsonl(output: string, expectedSite?: JobSpySite): RawJob[] {
  const jobs: RawJob[] = [];
  for (const [index, line] of output.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row: JobSpyRow;
    try { row = JSON.parse(line); }
    catch { throw new Error(`JobSpy returned invalid JSONL on line ${index + 1}`); }
    const site = text(row.site);
    if (expectedSite && site !== expectedSite) throw new Error(`JobSpy returned site '${site || 'unknown'}' while collecting '${expectedSite}'`);
    const job = rawJobFromJobSpy(row);
    if (job) jobs.push(job);
  }
  return jobs;
}

export async function runJobSpy(options: JobSpyRunOptions): Promise<RawJob[]> {
  const limit = positiveInteger(options.resultsWanted, 20, 50);
  const timeoutMs = positiveInteger(options.timeoutMs, 60_000, 300_000);
  const args = [
    ...(options.prefixArgs ?? []), options.query,
    '--site', options.site,
    '--location', options.location ?? 'Netherlands',
    '--country-indeed', options.countryIndeed ?? 'Netherlands',
    '--results-wanted', String(limit),
    '--fields', 'all', '--description-format', 'plain', '--quiet',
  ];
  if (options.hoursOld !== undefined) args.push('--hours-old', String(positiveInteger(options.hoursOld, 168, 24 * 365)));
  const command = options.command ?? 'jobspy';
  const output = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, timedOut = false, tooLarge = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const append = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { tooLarge = true; child.kill(); return; }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Cannot start JobSpy ${JOBSPY_VERSION}: ${error.message}`)); });
    child.once('close', code => {
      clearTimeout(timer);
      const errorText = Buffer.concat(stderr).toString('utf8').trim();
      if (timedOut) return reject(new Error(`JobSpy ${options.site} collection timed out after ${timeoutMs}ms`));
      if (tooLarge) return reject(new Error('JobSpy output exceeded the 8 MiB safety limit'));
      if (code !== 0) return reject(new Error(`JobSpy ${options.site} failed with exit code ${code}${errorText ? `: ${errorText.slice(0, 1000)}` : ''}`));
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: errorText });
    });
  });
  return parseJobSpyJsonl(output.stdout, options.site).slice(0, limit);
}

export function jobSpyQueryFromProfile(profile: ProfileConfig): string {
  const preferred = [...(profile.preferredRoleFamilies ?? []), ...(profile.acceptableRoleFamilies ?? []), ...Object.keys(profile.roleFamilies)];
  const terms: string[] = [], seen = new Set<string>();
  for (const family of preferred) {
    if (seen.has(family)) continue;
    seen.add(family);
    const term = profile.roleFamilies[family]?.[0]?.trim();
    if (term) terms.push(term.includes(' ') ? `"${term}"` : term);
  }
  return terms.join(' OR ');
}

export function jobSpyQueriesFromProfile(profile: ProfileConfig): string[] {
  const preferred = [...(profile.preferredRoleFamilies ?? []), ...(profile.acceptableRoleFamilies ?? []), ...Object.keys(profile.roleFamilies)];
  const queries: string[] = [], seen = new Set<string>();
  for (const family of preferred) {
    if (seen.has(family)) continue;
    seen.add(family);
    const terms = [...new Set((profile.roleFamilies[family] ?? []).map(term => term.trim()).filter(Boolean))].slice(0, 3);
    if (terms.length) queries.push(terms.map(term => term.includes(' ') ? `"${term}"` : term).join(' OR '));
  }
  return queries;
}

export function jobSpyPreferredCitiesFromProfile(profile: ProfileConfig): string[] {
  const configured = profile.preferredLocations?.length ? profile.preferredLocations : profile.locationPreferences?.stronglyPreferredCities ?? [];
  const seen = new Set<string>(), cities: string[] = [];
  for (const city of configured) {
    const value = city.trim(), key = value.toLowerCase().replace(/^['’]/, '');
    if (value && !seen.has(key)) { seen.add(key); cities.push(value); }
  }
  return cities.slice(0, 5);
}

const candidate = (site: JobSpySite, job: RawJob): DiscoveryCandidate => ({ sourceId: `jobspy-${site}`, company: job.company, headquarters: 'unknown', provider: 'browser', jobs: [job] });

export function createJobSpySource(options: JobSpySourceOptions): DiscoverySource {
  const id = `jobspy-${options.site}`;
  let profile: ProfileConfig | undefined;
  return {
    id, label: `JobSpy ${options.site}`, license: `MIT bridge; ${options.site} access requires separate authorization`, kind: 'job-feed', experimental: true,
    async discover(_context, cursor, limit) {
      profile ??= await loadProfile();
      const queries = (options.queries?.length ? options.queries : options.query ? [options.query] : jobSpyQueriesFromProfile(profile)).map(value => value.trim()).filter(Boolean);
      const broadQuery = options.query ?? jobSpyQueryFromProfile(profile);
      const cities = options.preferredCities ?? jobSpyPreferredCitiesFromProfile(profile);
      if (!queries.length || !broadQuery) throw new Error('CareerOps profile has no JobSpy search terms');
      const platformLimit = Math.min(limit, positiveInteger(options.maxPerPlatform ?? options.resultsWanted, 100, 200));
      const perSearch = positiveInteger(options.maxPerSearch, 15, 50), requestedCityLimit = positiveInteger(options.maxPerCity, 10, 25);
      const cityBudget = cities.length ? Math.min(cities.length * requestedCityLimit, Math.floor(platformLimit * .3)) : 0;
      const cityLimit = cityBudget ? Math.max(1, Math.floor(cityBudget / cities.length)) : 0;
      const nationalBudget = platformLimit - cityLimit * cities.length;
      const activeQueries = queries.slice(0, Math.min(queries.length, nationalBudget));
      const nationalLimit = activeQueries.length ? Math.max(1, Math.min(perSearch, Math.floor(nationalBudget / activeQueries.length) || 1)) : 0;
      const plan = [
        ...activeQueries.map(query => ({ query, location: options.location ?? 'Netherlands', limit: nationalLimit, kind: 'national-role' })),
        ...cities.filter(() => cityLimit > 0).map(location => ({ query: broadQuery, location, limit: cityLimit, kind: 'preferred-city' })),
      ];
      const byId = new Map<string, RawJob>();
      for (const search of plan) {
        const jobs = await runJobSpy({ ...options, query: search.query, location: search.location, resultsWanted: search.limit });
        for (const job of jobs) {
          const evidence = { query: search.query, location: search.location, kind: search.kind };
          const prior = byId.get(job.externalId ?? job.url);
          if (prior) {
            const raw = prior.raw as any;
            raw.searches = [...(raw.searches ?? []), evidence];
          } else {
            byId.set(job.externalId ?? job.url, { ...job, raw: { ...(job.raw as object), searches: [evidence] } });
          }
        }
      }
      const jobs = deduplicate([...byId.values()]).jobs.slice(0, platformLimit);
      return { candidates: jobs.map(job => candidate(options.site, job)), nextCursor: cursor, total: jobs.length };
    },
  };
}

function requestedSites(): JobSpySite[] {
  const requested = (process.env.DIEGO_JOBSPY_SITES ?? '').split(',').map(value => value.trim()).filter(Boolean);
  return requested.filter((value): value is JobSpySite => (JOBSPY_SITES as readonly string[]).includes(value));
}

export function jobSpySiteAuthorized(site: JobSpySite): boolean {
  const key = `DIEGO_JOBSPY_${site.toUpperCase()}_PERMISSION_CONFIRMED`;
  return process.env.DIEGO_ENABLE_JOBSPY === 'true' && process.env[key] === 'true';
}

export function configuredJobSpySources(): DiscoverySource[] {
  if (process.env.DIEGO_ENABLE_JOBSPY !== 'true') return [];
  const timeoutMs = Number(process.env.DIEGO_JOBSPY_TIMEOUT_MS) || undefined;
  const maxPerPlatform = Number(process.env.DIEGO_JOBSPY_MAX_PER_PLATFORM) || undefined;
  const maxPerSearch = Number(process.env.DIEGO_JOBSPY_MAX_PER_SEARCH) || undefined;
  const maxPerCity = Number(process.env.DIEGO_JOBSPY_MAX_PER_CITY) || undefined;
  const hoursOld = Number(process.env.DIEGO_JOBSPY_HOURS_OLD) || undefined;
  const queries = process.env.DIEGO_JOBSPY_QUERIES?.split(';').map(value => value.trim()).filter(Boolean);
  const preferredCities = process.env.DIEGO_JOBSPY_PREFERRED_CITIES?.split(';').map(value => value.trim()).filter(Boolean);
  return requestedSites().filter(jobSpySiteAuthorized).map(site => createJobSpySource({
    site, timeoutMs, maxPerPlatform, maxPerSearch, maxPerCity, hoursOld, queries, preferredCities,
    command: process.env.DIEGO_JOBSPY_COMMAND,
    query: process.env.DIEGO_JOBSPY_QUERY,
    location: process.env.DIEGO_JOBSPY_LOCATION,
    countryIndeed: process.env.DIEGO_JOBSPY_COUNTRY,
  }));
}

