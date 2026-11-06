import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, isNetherlandsJob } from "../src/discovery.js";
import { parseBoardDirectory, parseGigsignal, parseWerkenVoorNederland, parseWerkenVoorNederlandComponentUrl, parseWerkenVoorNederlandDetail, parseWerkenVoorNederlandLinks } from "../src/discovery-sources.js";
import { Store } from "../src/database.js";
import type { DiscoverySource, FetchContext, ProfileConfig } from "../src/types.js";
import { HttpError } from "../src/http.js";
import { enrichPendingJobs } from '../src/quality.js';

test('pending enrichment stores a description match once and marks its queue record complete',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diego-enrich-pending-')),store=new Store(join(dir,'test.sqlite'));
 try{store.queueEnrichment('pending-1',{company:'Example',title:'Insights Specialist',location:'Utrecht, Netherlands',url:'https://fixture.example/job',raw:{}},{sourceId:'fixture',company:'Example',provider:'recruitee'},undefined,'fixture');const context={fetchJson:async()=>({}),fetchText:async()=>`<main>${'Predictive modelling with statistics. '.repeat(8)}</main>`};const first=await enrichPendingJobs({store,context});assert.equal(first.stored,1);assert.equal(store.pendingEnrichments().length,0);const second=await enrichPendingJobs({store,context});assert.equal(second.processed,0);assert.equal(store.jobCount(),1);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

const profile: ProfileConfig = { country: "Netherlands", countryAliases: ["netherlands", "nederland", "nl", "amsterdam"], remoteAliases: ["remote netherlands"], roleFamilies: {}, excludeTitleTerms: [], expiryAfterMissedScans: 3 };

test('missing descriptions are capped at 100 pages and overflow survives restart', async () => {
  const dir=mkdtempSync(join(tmpdir(),'diego-budget-')),path=join(dir,'test.sqlite');let store=new Store(path),requests=0;
  const source:DiscoverySource={id:'budget',label:'Budget',license:'fixture',kind:'job-feed',async discover(){return{nextCursor:0,total:1,candidates:[{sourceId:'budget',company:'Fixture Employer',provider:'recruitee',jobs:Array.from({length:101},(_,i)=>({company:'Fixture Employer',title:`Insights Analyst ${i}`,location:'Utrecht, Netherlands',url:`https://fixture.example/jobs/${i}`,raw:{}}))}]}}};
  try {const result=await discover({store,sources:[source],limit:1,context:{fetchJson:async()=>({}),fetchText:async()=>{requests++;return `<main>${'Predictive modelling with statistics and machine learning. '.repeat(5)}</main>`;}}});assert.equal(requests,100);assert.equal(result.deferredEnrichments,1);assert.equal(result.descriptionMatches,100);store.close();store=new Store(path);assert.equal(store.pendingEnrichments().length,1);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('source-loading errors cannot produce a successful zero-coverage run',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diego-source-failure-')),store=new Store(join(dir,'test.sqlite'));
 try{const result=await discover({store,limit:1,sources:[{id:'broken',label:'Broken',license:'fixture',kind:'job-feed',async discover(){throw new Error('Unexpected listing structure');}}]});assert.equal(result.status,'partial');assert.equal(result.errors,1);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("directory and feed adapters reject malformed rows", () => {
  assert.equal(parseBoardDirectory([{ platform: "greenhouse", company: "Acme", board_url: "https://job-boards.greenhouse.io/acme", api_url: "https://boards-api.greenhouse.io/acme" }, { company: "Bad", board_url: "javascript:x" }]).length, 1);
  const jobs = parseGigsignal([{ title: "Data Scientist", apply_url: "https://acme.test/job", location: "Amsterdam", company_name: "Acme", company_website: "acme.test", first_seen_at: "2026-10-28", gist: "A useful summary" }]);
  assert.equal(jobs[0].domain, "acme.test");
  assert.equal(jobs[0].jobs?.[0].postedAt, undefined); assert.equal(jobs[0].jobs?.[0].firstObservedAt, "2026-10-28"); assert.equal(jobs[0].jobs?.[0].summary, "A useful summary");
  assert.deepEqual(parseGigsignal({ bad: true }), []);
});

test("government adapter reads JobPosting JSON-LD", () => {
  const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Data Scientist","url":"https://werkenvoornederland.nl/job/1","datePosted":"2026-10-28","hiringOrganization":{"name":"CBS"},"jobLocation":{"address":{"addressLocality":"Den Haag","addressCountry":"Netherlands"}}}</script>`;
  const rows = parseWerkenVoorNederland(html);
  assert.equal(rows.length, 1); assert.equal(rows[0].company, "CBS"); assert.equal(rows[0].headquarters, "netherlands");
});

test("government detail uses its page URL when JobPosting metadata omits url", () => {
  const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"Data-analist","hiringOrganization":{"name":"CBS"},"jobLocation":{"address":{"addressLocality":"Den Haag","addressCountry":"NL"}}}</script>`;
  const parsed = parseWerkenVoorNederlandDetail(html, "https://www.werkenvoornederland.nl/vacatures/data-analist-CBS-1");
  assert.equal(parsed[0].jobs?.[0].url, "https://www.werkenvoornederland.nl/vacatures/data-analist-CBS-1");
});

test("government adapter discovers listing links and parses detail fallback", () => {
  const listing = `<a href="/vacatures/data-scientist-CBS-2026-1">Bekijk vacature</a><a href="/vacatures/data-scientist-CBS-2026-1">Duplicate</a>`;
  assert.deepEqual(parseWerkenVoorNederlandLinks(listing), ["https://www.werkenvoornederland.nl/vacatures/data-scientist-CBS-2026-1"]);
  const detail = `<main><h1>Data Scientist</h1><a href="/organisaties/cbs">Centraal Bureau voor de Statistiek</a><ul><li>Den Haag - route</li></ul><p>Plaatsingsdatum: 28 oktober 2026</p></main>`;
  const parsed = parseWerkenVoorNederlandDetail(detail, "https://www.werkenvoornederland.nl/vacatures/data-scientist-CBS-2026-1");
  assert.equal(parsed[0].company, "Centraal Bureau voor de Statistiek"); assert.equal(parsed[0].jobs?.[0].location, "Den Haag");
});

test("government adapter resolves its asynchronous vacancy component", () => {
  const shell = `<div data-url="/vacatures?_hn:type=component-rendering&amp;_hn:ref=r46_r1_r4&amp;type=vacature">laden</div>`;
  assert.equal(parseWerkenVoorNederlandComponentUrl(shell, "https://www.werkenvoornederland.nl/vacatures?type=vacature"), "https://www.werkenvoornederland.nl/vacatures?_hn:type=component-rendering&_hn:ref=r46_r1_r4&type=vacature");
});

test("Netherlands classifier rejects generic remote and foreign jobs", () => {
  const base = { company: "Acme", title: "Data Scientist", url: "https://example.test/1", raw: {} };
  assert.equal(isNetherlandsJob({ ...base, location: "Remote" }, profile), false);
  assert.equal(isNetherlandsJob({ ...base, location: "Berlin, Germany" }, profile), false);
  assert.equal(isNetherlandsJob({ ...base, location: "Amsterdam" }, profile), true);
  assert.equal(isNetherlandsJob({ ...base, location: "Online" }, profile), false);
  assert.equal(isNetherlandsJob({ ...base, location: "Remote - Netherlands" }, profile), true);
  assert.equal(isNetherlandsJob({ ...base, location: "Berlin", description: "Our company also has an Amsterdam office" }, profile), false);
});

test("missing ATS boards are source-quality findings rather than parser errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-missing-")); const store = new Store(join(dir, "test.sqlite"));
  const source: DiscoverySource = { id: "missing", label: "Missing", license: "test", kind: "board-directory", async discover() { return { nextCursor: 1, candidates: [{ sourceId: "missing", company: "Old board", provider: "greenhouse", boardUrl: "https://job-boards.greenhouse.io/old" }] }; } };
  try {
    const result = await discover({ limit: 1, store, sources: [source], context: { fetchText: async () => "", fetchJson: async () => { throw new HttpError("HTTP 404", 404, false); } } });
    assert.equal(result.missingBoards, 1); assert.equal(result.errors, 0);
    assert.equal((store.db.prepare("SELECT latest_result FROM discovery_candidate_health").get() as any).latest_result, "board-not-found");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("discovery stores employers, lightweight observations, matches and cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-discovery-")); const store = new Store(join(dir, "test.sqlite"));
  const source: DiscoverySource = { id: "fixture", label: "Fixture", license: "test", kind: "job-feed", async discover() { return { nextCursor: 1, total: 1, candidates: [{ sourceId: "fixture", company: "Acme Nederland", domain: "acme.nl", headquarters: "netherlands", provider: "greenhouse", boardUrl: "https://job-boards.greenhouse.io/acme", jobs: [
    { company: "Acme Nederland", title: "Data Scientist", location: "Amsterdam, Netherlands", url: "https://acme.nl/jobs/1", raw: {} },
    { company: "Acme Nederland", title: "Accountant", location: "Utrecht, Netherlands", url: "https://acme.nl/jobs/2", raw: {} },
  ] }] }; } };
  const context: FetchContext = { fetchJson: async () => ({}), fetchText: async () => "" };
  try {
    const result = await discover({ limit: 10, store, sources: [source], context });
    assert.equal(result.status, "completed"); assert.equal(result.employers, 1); assert.equal(result.matchingJobs, 1); assert.equal(result.nonmatchingJobs, 1);
    assert.equal(store.employers({ hiring: true }).length, 1); assert.equal(store.jobs().length, 1); assert.equal(store.discoveredSources().length, 1);
    const coverage: any = store.coverage(); assert.equal(coverage.employers, 1); assert.equal(coverage.nonmatchingVacancies, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("every candidate gets a classified attempt and expected skips are not errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-attempts-")); const store = new Store(join(dir, "test.sqlite"));
  const base = { sourceId: "classify", company: "Acme" };
  const source: DiscoverySource = { id: "classify", label: "Classify", license: "test", kind: "job-feed", async discover() { return { nextCursor: 0, total: 5, candidates: [
    { ...base, company: "Dutch", jobs: [{ company: "Dutch", title: "Data Scientist", location: "Amsterdam", url: "https://dutch.test/1", raw: {} }] },
    { ...base, company: "Foreign", jobs: [{ company: "Foreign", title: "Data Scientist", location: "Berlin", url: "https://foreign.test/1", raw: {} }] },
    { ...base, company: "Empty", jobs: [] },
    { ...base, company: "Unsupported", boardUrl: "https://unsupported.test/jobs" },
    { ...base, company: "", jobs: [] },
  ] }; } };
  try {
    const result = await discover({ limit: 5, store, sources: [source], context: { fetchJson: async () => ({}), fetchText: async () => "" } });
    assert.equal(result.processed, 5); assert.equal(result.noNetherlandsJobs, 1); assert.equal(result.emptyBoards, 1); assert.equal(result.errors, 1);
    const attempts = store.db.prepare("SELECT result,COUNT(*) count FROM discovery_attempts GROUP BY result").all() as any[];
    assert.deepEqual(new Set(attempts.map(row => row.result)), new Set(["matched", "no-netherlands-jobs", "empty-board", "unsupported", "invalid-record"]));
    assert.equal(store.discoveryFailures().length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("timeouts and rate limits are retryable and can be selected for retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-retry-")); const store = new Store(join(dir, "test.sqlite"));
  const source: DiscoverySource = { id: "retry-source", label: "Retry", license: "test", kind: "board-directory", async discover() { return { nextCursor: 0, candidates: [
    { sourceId: "retry-source", company: "Slow", provider: "greenhouse", boardUrl: "https://job-boards.greenhouse.io/slow" },
    { sourceId: "retry-source", company: "Limited", provider: "greenhouse", boardUrl: "https://job-boards.greenhouse.io/limited" },
  ] }; } };
  let calls = 0;
  const context: FetchContext = { fetchText: async () => "", fetchJson: async () => { calls++; if (calls === 1) return new Promise(() => {}); throw new HttpError("HTTP 429", 429, true, 1); } };
  try {
    const result = await discover({ limit: 2, store, sources: [source], context, candidateTimeoutMs: 10, concurrency: 1 });
    assert.equal(result.retryableFailures, 2); assert.equal(store.discoveryFailures({ retryable: true }).length, 2);
    assert.equal(store.retryableCandidates(undefined, 10).length, 0, "cooldown prevents immediate repeated retries");
    assert.equal((store.db.prepare("SELECT COUNT(*) count FROM discovery_candidate_health WHERE retryable=1 AND next_retry_at IS NOT NULL").get() as any).count, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("bounded per-host concurrency and exact interrupted resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-resume-")); const store = new Store(join(dir, "test.sqlite"));
  const candidates = Array.from({ length: 5 }, (_, index) => ({ sourceId: "resume-source", company: `Company ${index}`, provider: "greenhouse" as const, boardUrl: `https://job-boards.greenhouse.io/company-${index}` }));
  let sourceCalls = 0;
  const source: DiscoverySource = { id: "resume-source", label: "Resume", license: "test", kind: "board-directory", async discover() { sourceCalls++; return { nextCursor: 5, total: 5, candidates: sourceCalls === 1 ? candidates : [...candidates].reverse() }; } };
  let active = 0, maximum = 0;
  const context: FetchContext = { fetchText: async () => "", fetchJson: async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 20)); active--; return { jobs: [] }; } };
  const controller = new AbortController(); setTimeout(() => controller.abort(), 5);
  try {
    const first = await discover({ limit: 5, store, sources: [source], context, concurrency: 4, signal: controller.signal });
    assert.equal(first.status, "interrupted"); assert.ok(first.processed <= 2); assert.ok(maximum <= 2);
    const resumed = await discover({ limit: 5, store, sources: [source], context, concurrency: 8, resume: true });
    assert.equal(resumed.processed, 5); assert.equal((store.db.prepare("SELECT COUNT(*) count FROM discovery_attempts").get() as any).count, 5);
    assert.equal((store.db.prepare("SELECT worker_count FROM discovery_runs WHERE id=?").get(first.id) as any).worker_count,4,"resume retains the worker count selected for the original run");
    assert.equal(sourceCalls, 1, "resume uses the persisted queue instead of reloading a changed source");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("discovery checkpoints each candidate without waiting for its slow batch peer",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"diego-step-progress-")),store=new Store(join(dir,"test.sqlite"));let releaseSlow!:()=>void;
  const slow=new Promise<void>(resolve=>{releaseSlow=resolve}),source:DiscoverySource={id:"step-source",label:"Step progress",license:"test",kind:"board-directory",async discover(){return {nextCursor:2,total:2,candidates:[{sourceId:"step-source",company:"Fast",provider:"greenhouse",boardUrl:"https://job-boards.greenhouse.io/fast"},{sourceId:"step-source",company:"Slow",provider:"greenhouse",boardUrl:"https://job-boards.greenhouse.io/slow"}]}}};
  const context:FetchContext={fetchText:async()=>"",fetchJson:async url=>{if(String(url).includes("/slow/"))await slow;return {jobs:[]}}};
  try{
    const running=discover({runId:"step-progress",limit:2,store,sources:[source],context,concurrency:2});
    let observed=0;for(let attempt=0;attempt<50&&!observed;attempt++){await new Promise(resolve=>setTimeout(resolve,10));observed=Number((store.db.prepare("SELECT processed_count count FROM discovery_runs WHERE id='step-progress'").get() as any)?.count??0);}
    assert.equal(observed,1,"the fast candidate is visible while its peer is still running");
    releaseSlow();const result=await running;assert.equal(result.processed,2);
  }finally{releaseSlow?.();store.close();rmSync(dir,{recursive:true,force:true});}
});

test("six-worker scheduler refills a free slot while a slow candidate is still active",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"diego-six-workers-")),store=new Store(join(dir,"test.sqlite"));
  const candidates=Array.from({length:7},(_,index)=>({sourceId:"pool-source",company:`Company ${index}`,provider:"browser" as const,boardUrl:`https://company-${index}.example.test/jobs`}));
  const source:DiscoverySource={id:"pool-source",label:"Pool",license:"test",kind:"board-directory",async discover(){return {nextCursor:7,total:7,candidates};}};
  let active=0,maximum=0,slowFinished=false,seventhStartedBeforeSlowFinished=false;
  const context:FetchContext={fetchJson:async()=>({}),fetchText:async url=>{const value=String(url),slow=value.includes("company-0");active++;maximum=Math.max(maximum,active);if(value.includes("company-6")&&!slowFinished)seventhStartedBeforeSlowFinished=true;await new Promise(resolve=>setTimeout(resolve,slow?100:10));active--;if(slow)slowFinished=true;return "";}};
  try{const result=await discover({limit:7,store,sources:[source],context,concurrency:6});assert.equal(result.processed,7);assert.ok(maximum<=6,"the six-worker setting bounds concurrent work");assert.ok(seventhStartedBeforeSlowFinished,"the seventh candidate starts when any worker frees");assert.equal((store.db.prepare("SELECT worker_count FROM discovery_runs WHERE id=?").get(result.id) as any).worker_count,6);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("Workday and Ashby retain one active collection per destination host",async()=>{
  for(const provider of ["workday","ashby"] as const){
    const dir=mkdtempSync(join(tmpdir(),`diego-${provider}-host-cap-`)),store=new Store(join(dir,"test.sqlite"));
    const host=provider==="workday"?"tenant.myworkdayjobs.com":"jobs.ashbyhq.com",candidates=Array.from({length:4},(_,index)=>({sourceId:"host-cap",company:`Company ${index}`,provider,boardUrl:`https://${host}/External-${index}`}));
    const source:DiscoverySource={id:"host-cap",label:"Host cap",license:"test",kind:"board-directory",async discover(){return {nextCursor:4,total:4,candidates};}};let active=0,maximum=0;
    const context:FetchContext={fetchText:async()=>"",fetchJson:async()=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,10));active--;return {total:0,jobPostings:[]};}};
    try{const result=await discover({limit:4,store,sources:[source],context,concurrency:8});assert.equal(result.processed,4);assert.equal(maximum,1,`${provider} host requests remain serialized`);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
  }
});

test("stale running discoveries are recovered as interrupted", () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-stale-")); const store = new Store(join(dir, "test.sqlite"));
  try { store.startDiscoveryRun("stale", undefined, 10); assert.equal(store.recoverStaleDiscoveryRuns(-1), 1); assert.equal((store.db.prepare("SELECT status FROM discovery_runs WHERE id='stale'").get() as any).status, "interrupted"); }
  finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
