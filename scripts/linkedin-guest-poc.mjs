#!/usr/bin/env node

/**
 * Isolated probe for LinkedIn's unofficial guest jobs HTML endpoints.
 * It does not import the dashboard, write to SQLite, or join the production
 * discovery-source registry. Output is a measurement report only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SEARCH = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const DETAIL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting";
const args = new Map(process.argv.slice(2).map((value, index, all) => {
  if (!value.startsWith("--")) return ["", ""];
  const [key, inline] = value.slice(2).split("=", 2);
  return [key, inline ?? (all[index + 1]?.startsWith("--") ? "true" : all[index + 1]) ?? "true"];
}));
const keywords = args.get("keywords") ?? "data analyst";
const location = args.get("location") ?? "Netherlands";
const delayMs = Number(args.get("delay-ms") ?? 450);
const output = resolve(args.get("output") ?? "data/linkedin-guest-poc-results.json");
const pageStarts = (args.get("starts") ?? "0,25,50,75,100").split(",").map(Number).filter(Number.isFinite);
const detailLimit = Math.max(0, Number(args.get("detail-limit") ?? 10));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const decode = (value = "") => value
  .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
  .replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/\s+/g, " ").trim();
const attr = (html, name) => decode(html.match(new RegExp(`${name}=["']([^"']*)`, "i"))?.[1]);
const content = (html, classPart) => decode(html.match(new RegExp(`<[^>]+class=["'][^"']*${classPart}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"))?.[1]);
const idFrom = (html) => html.match(/urn:li:jobPosting:(\d+)/i)?.[1]
  ?? html.match(/\/jobs\/view\/(?:[^?"']*?-)?(\d+)(?:[/?"']|$)/i)?.[1];

function parseSearch(html) {
  const blocks = [...html.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi)].map((match) => match[1]);
  const rows = [];
  for (const block of blocks) {
    const id = idFrom(block);
    const href = decode(block.match(/<a[^>]+class=["'][^"']*(?:base-card__full-link|full-link)[^"']*["'][^>]+href=["']([^"']+)/i)?.[1]
      ?? block.match(/<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*(?:base-card__full-link|full-link)/i)?.[1]);
    const title = content(block, "(?:base-search-card__title|_title)");
    const company = content(block, "(?:base-search-card__subtitle|_subtitle)");
    const jobLocation = content(block, "(?:job-search-card__location|_location)");
    const time = block.match(/<time[^>]*>([\s\S]*?)<\/time>/i)?.[0] ?? "";
    if (!id && !href && !title) continue;
    rows.push({ id, title, company, location: jobLocation, postedAt: attr(time, "datetime") || decode(time), url: href?.split("?")[0] });
  }
  return rows;
}

function parseDetail(html, id) {
  const descriptionHtml = html.match(/<div[^>]+class=["'][^"']*show-more-less-html__markup[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1]
    ?? html.match(/<div[^>]+class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  const criteria = {};
  for (const match of html.matchAll(/<li[^>]+class=["'][^"']*description__job-criteria-item[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)) {
    const label = content(match[1], "description__job-criteria-subheader");
    const value = content(match[1], "description__job-criteria-text");
    if (label) criteria[label] = value;
  }
  const applyUrl = decode(html.match(/<a[^>]+class=["'][^"']*(?:apply-button|topcard__link)[^"']*["'][^>]+href=["']([^"']+)/i)?.[1]);
  return { id, description: decode(descriptionHtml), descriptionLength: decode(descriptionHtml).length, criteria, applyUrl: applyUrl || undefined };
}

async function request(url, kind) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(url, { headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (compatible; DiegoCareerOps-PoC/0.1; local research)" }, signal: AbortSignal.timeout(20_000) });
    const body = await response.text();
    return { kind, url, status: response.status, ok: response.ok, durationMs: Math.round(performance.now() - started), bytes: Buffer.byteLength(body), body };
  } catch (error) {
    return { kind, url, status: undefined, ok: false, durationMs: Math.round(performance.now() - started), bytes: 0, error: error instanceof Error ? error.message : String(error), body: "" };
  } finally {
    await sleep(delayMs);
  }
}

const makeSearchUrl = (extra = {}) => {
  const url = new URL(SEARCH);
  for (const [key, value] of Object.entries({ keywords, location, ...extra })) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  return url.toString();
};
const searchRuns = [];
async function probeSearch(name, params) {
  const response = await request(makeSearchUrl(params), `search:${name}`);
  const jobs = response.ok ? parseSearch(response.body) : [];
  searchRuns.push({ name, params, status: response.status, ok: response.ok, durationMs: response.durationMs, bytes: response.bytes, error: response.error, count: jobs.length, ids: jobs.map((job) => job.id).filter(Boolean), jobs });
  return jobs;
}

for (const start of pageStarts) await probeSearch(`page-${start}`, { start });
const baseline = searchRuns[0]?.jobs ?? [];
const filterCases = [
  ["past-24h", { start: 0, f_TPR: "r86400" }],
  ["entry-level", { start: 0, f_E: 2 }],
  ["full-time", { start: 0, f_JT: "F" }],
  ["remote", { start: 0, f_WT: 2 }],
  ["easy-apply", { start: 0, f_AL: true }],
];
for (const [name, params] of filterCases) await probeSearch(name, params);
for (const start of [975, 1000, 1025]) if (!pageStarts.includes(start)) await probeSearch(`boundary-${start}`, { start });

const detailRuns = [];
for (const job of [...new Map(searchRuns.flatMap((run) => run.jobs).filter((job) => job.id).map((job) => [job.id, job])).values()].slice(0, detailLimit)) {
  const response = await request(`${DETAIL}/${job.id}`, `detail:${job.id}`);
  const detail = response.ok ? parseDetail(response.body, job.id) : { id: job.id, description: "", descriptionLength: 0, criteria: {} };
  const { description: _description, ...measuredDetail } = detail;
  detailRuns.push({ ...measuredDetail, status: response.status, ok: response.ok, durationMs: response.durationMs, bytes: response.bytes, error: response.error });
}

const pageRuns = searchRuns.filter((run) => run.name.startsWith("page-"));
const allPageJobs = pageRuns.flatMap((run) => run.jobs);
const uniquePageIds = new Set(allPageJobs.map((job) => job.id).filter(Boolean));
const duplicateIds = [...new Set(allPageJobs.map((job) => job.id).filter((id, index, all) => id && all.indexOf(id) !== index))];
const missing = (rows, field) => rows.filter((row) => !row[field]).length;
const baselineIds = new Set(baseline.map((job) => job.id).filter(Boolean));
const filters = Object.fromEntries(searchRuns.filter((run) => filterCases.some(([name]) => name === run.name)).map((run) => {
  const ids = new Set(run.ids);
  const overlap = [...ids].filter((id) => baselineIds.has(id)).length;
  return [run.name, { status: run.status, count: run.count, overlapWithBaseline: overlap, sameOrderedIdsAsBaseline: run.ids.join(",") === baseline.map((job) => job.id).filter(Boolean).join(",") }];
}));
const report = {
  generatedAt: new Date().toISOString(),
  scope: { keywords, location, pageStarts, detailLimit, unofficialHtmlEndpoints: true, productionIntegration: false },
  summary: {
    requests: searchRuns.length + detailRuns.length,
    httpFailures: [...searchRuns, ...detailRuns].filter((run) => !run.ok).length,
    searchRows: allPageJobs.length,
    uniqueSearchIds: uniquePageIds.size,
    duplicateRowsAcrossPages: allPageJobs.length - uniquePageIds.size,
    duplicateIds,
    missingSearchFields: Object.fromEntries(["id", "title", "company", "location", "postedAt", "url"].map((field) => [field, missing(allPageJobs, field)])),
    detailRetrieved: detailRuns.filter((run) => run.ok).length,
    detailsWithDescription: detailRuns.filter((run) => run.descriptionLength > 0).length,
    detailsWithCriteria: detailRuns.filter((run) => Object.keys(run.criteria).length > 0).length,
    detailsWithApplyUrl: detailRuns.filter((run) => run.applyUrl).length,
  },
  filters,
  paginationBoundary: Object.fromEntries(searchRuns.filter((run) => run.name.startsWith("boundary-")).map((run) => [run.params.start, { status: run.status, count: run.count, ids: run.ids }])),
  searchRuns,
  detailRuns,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, ...report.summary, filters: report.filters, paginationBoundary: report.paginationBoundary }, null, 2));
