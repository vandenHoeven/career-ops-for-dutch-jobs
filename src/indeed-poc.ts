import { plainText, postingObjects } from './posting-parser.js';
import type { DiscoveryCandidate, DiscoverySource, RawJob } from './types.js';

const SOURCE_ID = 'indeed-netherlands-poc';
const DEFAULT_ORIGIN = 'https://nl.indeed.com';
const MOSAIC_ASSIGNMENT = 'window.mosaic.providerData["mosaic-provider-jobcards"]';

function clean(value: unknown): string {
  return plainText(String(value ?? ''));
}

function isoDay(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.valueOf()) ? undefined : date.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString().slice(0, 10);
}

function safeDirectApplyUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return /(^|\.)indeed\.com$/i.test(url.hostname) ? undefined : url.toString();
  } catch {
    return undefined;
  }
}

/** Extract one balanced JSON object without relying on a regex over remote HTML. */
function assignedObject(html: string, assignment: string): Record<string, any> | undefined {
  const marker = html.indexOf(assignment);
  if (marker < 0) return undefined;
  const equals = html.indexOf('=', marker + assignment.length);
  if (equals < 0) return undefined;
  const start = html.indexOf('{', equals + 1);
  if (start < 0) return undefined;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, index + 1)); }
      catch { return undefined; }
    }
  }
  return undefined;
}

/** Parse fetchaller's documented Mosaic job-card surface from saved HTML. */
export function parseIndeedMosaicSearch(html: string, origin = DEFAULT_ORIGIN): RawJob[] {
  if (!html.includes('mosaic-provider-jobcards')) throw new Error('Indeed fixture has no Mosaic job-card container');
  const payload = assignedObject(html, MOSAIC_ASSIGNMENT);
  const results = payload?.metaData?.mosaicProviderJobCardsModel?.results;
  if (!Array.isArray(results)) throw new Error('Indeed Mosaic job-card payload is missing or malformed');
  const jobs: RawJob[] = [], seen = new Set<string>();
  for (const card of results) {
    const externalId = clean(card?.jobkey), title = clean(card?.title), company = clean(card?.company);
    if (!/^[a-z0-9]{1,32}$/i.test(externalId) || !title || !company || seen.has(externalId)) continue;
    seen.add(externalId);
    const location = clean(card?.formattedLocation), summary = clean(card?.snippet) || undefined;
    jobs.push({
      externalId, title, company, location, countryCode: 'NL', summary,
      postedAt: isoDay(card?.pubDate ?? card?.datePosted ?? card?.createDate),
      url: new URL(`/viewjob?jk=${encodeURIComponent(externalId)}`, origin).toString(),
      raw: { source: SOURCE_ID, surface: 'mosaic-jobcards', formattedRelativeTime: clean(card?.formattedRelativeTime) || undefined, extractedSalary: card?.extractedSalary ?? undefined },
    });
  }
  return jobs;
}

/** Join a saved Indeed detail page's schema.org JobPosting data to its search card. */
export function mergeIndeedJsonLdDetail(card: RawJob, html: string): RawJob {
  const posting = postingObjects(html).find(value => value && typeof value === 'object' && [value['@type']].flat().includes('JobPosting'));
  if (!posting) throw new Error(`Indeed detail fixture for ${card.externalId ?? card.url} has no JobPosting JSON-LD`);
  const locations = [posting.jobLocation].flat().filter(Boolean);
  const addresses = locations.map((value: any) => value?.address ?? value).filter(Boolean);
  const location = addresses.map((address: any) => [address.addressLocality, address.addressRegion, typeof address.addressCountry === 'object' ? address.addressCountry?.name : address.addressCountry].filter(Boolean).join(', ')).filter(Boolean).join(' / ');
  const country = addresses.map((address: any) => typeof address.addressCountry === 'object' ? address.addressCountry?.name : address.addressCountry).filter(Boolean);
  return {
    ...card,
    title: clean(posting.title) || card.title,
    company: clean(posting.hiringOrganization?.name) || card.company,
    location: location || card.location,
    countryCode: country.length === 1 ? clean(country[0]) : card.countryCode,
    description: clean(posting.description) || card.description,
    postedAt: isoDay(posting.datePosted) ?? card.postedAt,
    validThrough: isoDay(posting.validThrough),
    raw: { ...(card.raw as object), detailSurface: 'schema.org/JobPosting', jsonLd: posting },
  };
}

/** Parse a saved response matching JobSpy 1.4.x's current Indeed GraphQL query. */
export function parseJobSpyIndeedPage(payload: unknown, origin = DEFAULT_ORIGIN): { jobs: RawJob[]; nextCursor?: string } {
  const search = (payload as any)?.data?.jobSearch;
  if (!search || !Array.isArray(search.results)) throw new Error('JobSpy Indeed fixture has no data.jobSearch.results');
  const jobs: RawJob[] = [], seen = new Set<string>();
  for (const result of search.results) {
    const row = result?.job, externalId = clean(row?.key), title = clean(row?.title);
    const company = clean(row?.employer?.name ?? row?.sourceEmployerName);
    if (!/^[a-z0-9]{1,32}$/i.test(externalId) || !title || !company || seen.has(externalId)) continue;
    seen.add(externalId);
    const countryCode = clean(row?.location?.countryCode) || undefined;
    const country = countryCode === 'NL' ? 'Netherlands' : countryCode;
    const location = [clean(row?.location?.city), clean(row?.location?.admin1Code), country].filter(Boolean).join(', ');
    jobs.push({
      externalId, title, company, location, countryCode,
      description: clean(row?.description?.html) || undefined,
      postedAt: isoDay(row?.dateOnIndeed),
      url: new URL(`/viewjob?jk=${encodeURIComponent(externalId)}`, origin).toString(),
      applyUrl: safeDirectApplyUrl(row?.recruit?.viewJobUrl),
      raw: { source: SOURCE_ID, surface: 'jobspy-graphql', attributes: row?.attributes ?? [], compensation: row?.compensation ?? undefined },
    });
  }
  const nextCursor = typeof search?.pageInfo?.nextCursor === 'string' && search.pageInfo.nextCursor ? search.pageInfo.nextCursor : undefined;
  return { jobs, nextCursor };
}

function candidate(job: RawJob): DiscoveryCandidate {
  return { sourceId: SOURCE_ID, company: job.company, headquarters: 'unknown', provider: 'browser', jobs: [job] };
}

/** Offline-only DiscoverySource used to prove the existing pipeline boundary. */
export function indeedFixtureSource(jobs: RawJob[]): DiscoverySource {
  return {
    id: SOURCE_ID,
    label: 'Indeed Netherlands (offline POC fixture)',
    license: 'Saved offline fixture; live collection is not implemented or enabled',
    kind: 'job-feed',
    experimental: true,
    async discover(_context, cursor, limit) {
      const page = jobs.slice(cursor, cursor + limit);
      return { candidates: page.map(candidate), nextCursor: cursor + page.length, total: jobs.length };
    },
  };
}

