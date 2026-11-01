import { processJob } from './processing.js';
import { collectSource, checkpointCollection } from './collection.js';
import { assessLocation } from './locations.js';
import type { CollectionResult } from './types.js';
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { dataDir, loadProfile } from "./config.js";
import {
  canonicalizeUrl,
  fingerprint,
  isPlausibleRecallCandidate,
  normalizeText,
  stableJobId,
} from "./core.js";
import { Store } from "./database.js";
import {
  benchmarkCandidate,
  getDiscoverySources,
} from "./discovery-sources.js";
import { BENCHMARK_EMPLOYERS } from "./benchmark.js";
import { createHttpContext, HttpError } from "./http.js";
import { resolveProvider } from "./providers.js";
import { enrichJob } from "./enrichment.js";
import { createEnrichmentLimiter } from "./enrichment-limiter.js";
import { JOBSPY_SITES, JOBSPY_VERSION, jobSpyPreferredCitiesFromProfile, jobSpyQueriesFromProfile, jobSpyQueryFromProfile } from "./jobspy.js";
import { linkedInKeywordsFromProfile } from "./linkedin-guest.js";
import type {
  DiscoveryAttempt,
  DiscoveryAttemptResult,
  DiscoveryCandidate,
  DiscoverySource,
  FetchContext,
  ProfileConfig,
  RawJob,
  SourceConfig,
} from "./types.js";

export interface DiscoverOptions {
  runId?: string;
  limit?: number;
  source?: string;
  resume?: boolean;
  retryFailures?: boolean;
  store?: Store;
  sources?: DiscoverySource[];
  context?: FetchContext;
  onProgress?: (message: string) => void;
  handleSignals?: boolean;
  signal?: AbortSignal;
  candidateTimeoutMs?: number;
  concurrency?: number;
  enrichmentLimit?:number;
  allocations?: DiscoveryAllocations;
}
export type DiscoveryCategory = "linkedin" | "jobspy" | "priority" | "native" | "directories";
export type DiscoveryAllocations = Record<DiscoveryCategory, number>;
export interface DiscoveryPlanSource {
  id: string; label: string; kind: DiscoverySource["kind"]; category: DiscoveryCategory;
  planned: number; enabled: boolean; status: "enabled" | "disabled" | "unauthorized";
  lastError?: string;
}
export interface DiscoveryPlan {
  limit: number; allocations: DiscoveryAllocations; sources: DiscoveryPlanSource[];
  rules: { redistribution: string; candidateMeaning: string };
  scope?: { linkedin: { location: string; terms: string[]; strategy: string }; jobspy: { platforms: string[]; location: string; preferredCities: string[]; queries: string[]; broadQuery: string; hoursOld?: number; version: string } };
}
export interface DiscoverResult {
  id: string;
  status: string;
  processed: number;
  pending: number;
  employers: number;
  matchingJobs: number;
  newJobs: number;
  refreshedJobs: number;
  fetchedJobs: number;
  partialCollections: number;
  nonmatchingJobs: number;
  noNetherlandsJobs: number;
  emptyBoards: number;
  missingBoards: number;
  unsupported: number;
  retryableFailures: number;
  permanentFailures: number;
  errors: number;
  durationMs: number;
  descriptionCandidates: number;
  enrichedJobs: number;
  deferredEnrichments: number;
  descriptionMatches: number;
  enrichmentFailures: number;
}
interface Counts {
  processed: number;
  employers: number;
  matching: number;
  newJobs: number;
  refreshedJobs: number;
  fetched: number;
  partialCollections: number;
  nonmatching: number;
  errors: number;
  noNl: number;
  empty: number;
  missing: number;
  unsupported: number;
  retryableErrors: number;
  permanentErrors: number;
  descriptionCandidates: number;
  enrichedJobs: number;
  deferredEnrichments: number;
  descriptionMatches: number;
  enrichmentFailures: number;
}
const zeroCounts = (): Counts => ({
  processed: 0,
  employers: 0,
  matching: 0,
  newJobs: 0,
  refreshedJobs: 0,
  fetched: 0,
  partialCollections: 0,
  nonmatching: 0,
  errors: 0,
  noNl: 0,
  empty: 0,
  missing: 0,
  unsupported: 0,
  retryableErrors: 0,
  permanentErrors: 0,
  descriptionCandidates: 0,
  enrichedJobs: 0,
  deferredEnrichments: 0,
  descriptionMatches: 0,
  enrichmentFailures: 0,
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
const operationalFailures = new Set<DiscoveryAttemptResult>([
  "timeout",
  "rate-limited",
  "network-error",
  "parse-error",
  "invalid-record",
]);

export function isNetherlandsJob(job: RawJob, profile: ProfileConfig): boolean {
  return assessLocation(job, profile).state === 'netherlands';
}

function classifyError(error: unknown): {
  result: DiscoveryAttemptResult;
  retryable: boolean;
  status?: number;
  message: string;
} {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 1000);
  if(/No public JobPosting|requires an explicit public apiUrl|Cross-domain redirect requires an explicitly configured/i.test(message))return {result:'unsupported',retryable:false,message};
  if (/timeout|aborted/i.test(message))
    return { result: "timeout", retryable: true, message };
  if (error instanceof HttpError && error.status === 404)
    return {
      result: "board-not-found",
      retryable: false,
      status: 404,
      message,
    };
  if (error instanceof HttpError && error.status === 429)
    return { result: "rate-limited", retryable: true, status: 429, message };
  if (error instanceof HttpError)
    return {
      result: error.retryable ? "network-error" : "parse-error",
      retryable: error.retryable,
      status: error.status,
      message,
    };
  if (/HTTP 5\d\d|fetch failed|ENOTFOUND|EAI_AGAIN|ECONN|DNS/i.test(message))
    return { result: "network-error", retryable: true, message };
  return { result: "parse-error", retryable: false, message };
}

function signaledContext(
  context: FetchContext,
  signal: AbortSignal,
): FetchContext {
  const init = (value?: RequestInit): RequestInit => ({
    ...value,
    signal: value?.signal ? AbortSignal.any([value.signal, signal]) : signal,
  });
  return {
    fetchJson: (url, value) => context.fetchJson(url, init(value)),
    fetchText: (url, value) => context.fetchText(url, init(value)),
  };
}

async function bounded<T>(
  timeoutMs: number,
  parent: AbortSignal | undefined,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectBoundary: ((reason: unknown) => void) | undefined;
  const boundary = new Promise<T>((_, reject) => {
    rejectBoundary = reject;
  });
  const timer = setTimeout(() => {
    const error = new Error(`Candidate timeout after ${timeoutMs}ms`);
    controller.abort(error);
    rejectBoundary?.(error);
  }, timeoutMs);
  const abort = () => {
    const error = parent?.reason ?? new DOMException("Aborted", "AbortError");
    controller.abort(error);
    rejectBoundary?.(error);
  };
  parent?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([task(controller.signal), boundary]);
  } catch (error) {
    if (controller.signal.aborted && !parent?.aborted)
      throw new Error(`Candidate timeout after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

async function fetchCandidate(
  candidate: DiscoveryCandidate,
  context: FetchContext,
  store: Store,
  signal?:AbortSignal, timeoutMs=45_000,
): Promise<CollectionResult> {
  if (candidate.jobs) return {jobs:candidate.jobs,complete:true};
  if (!candidate.boardUrl || !candidate.provider)
    throw Object.assign(new Error("No supported ATS provider or board URL"), {
      discoveryResult: "unsupported",
    });
  const source: SourceConfig = {
    id: hash(candidate.boardUrl),
    company: candidate.company,
    careersUrl: candidate.boardUrl,
    apiUrl: candidate.apiUrl,
    provider: candidate.provider ?? 'browser',
  };
  return collectSource(store,source,context,signal,candidate,timeoutMs);
}

function candidateId(candidate: DiscoveryCandidate): string {
  return hash(
    [
      candidate.sourceId,
      candidate.provider ?? "",
      candidate.boardUrl ?? "",
      candidate.company,
      ...(candidate.jobs ?? []).map((job) => job.url),
    ].join("|"),
  );
}
function destinationHost(candidate: DiscoveryCandidate): string {
  if (candidate.provider === "greenhouse") return "boards-api.greenhouse.io";
  if (candidate.provider === "lever")
    return candidate.boardUrl?.includes("jobs.eu.lever.co")
      ? "api.eu.lever.co"
      : "api.lever.co";
  if (candidate.provider === "ashby") return "api.ashbyhq.com";
  try {
    return candidate.boardUrl
      ? new URL(candidate.apiUrl ?? candidate.boardUrl).hostname
      : candidate.domain ?? candidate.sourceId;
  } catch {
    return candidate.sourceId;
  }
}
function hostLimit(candidate: DiscoveryCandidate): number {
  return candidate.provider === "workday" || candidate.provider === "ashby"
    ? 1
    : 2;
}
function groups<T extends { candidate: DiscoveryCandidate }>(
  items: T[],
  concurrency: number,
): T[][] {
  const pending = [...items],
    result: T[][] = [];
  while (pending.length) {
    const group: T[] = [],
      hosts = new Map<string, number>();
    for (
      let index = 0;
      index < pending.length && group.length < concurrency;

    ) {
      const item = pending[index],
        host = destinationHost(item.candidate),
        count = hosts.get(host) ?? 0;
      if (count < hostLimit(item.candidate)) {
        group.push(item);
        hosts.set(host, count + 1);
        pending.splice(index, 1);
      } else index++;
    }
    if (!group.length) group.push(pending.shift()!);
    result.push(group);
  }
  return result;
}

export function prioritySources(store:Store,sources:DiscoverySource[]):DiscoverySource[]{
 const rows=store.db.prepare(`SELECT eb.board_url,e.canonical_name company,eb.provider,eb.api_url FROM employer_boards eb JOIN employers e ON e.id=eb.employer_id WHERE EXISTS(SELECT 1 FROM vacancy_observations v WHERE v.employer_id=e.id) ORDER BY COALESCE(eb.last_checked_at,'') ASC`).all() as any[];
 const partials=store.db.prepare("SELECT candidate_json FROM collection_checkpoints WHERE state!='complete' AND cursor IS NOT NULL AND candidate_json IS NOT NULL ORDER BY last_checked_at").all() as any[];
 const candidates:DiscoveryCandidate[]=[...partials.map(r=>JSON.parse(r.candidate_json)),...rows.map(r=>({sourceId:'known-netherlands',company:r.company,boardUrl:r.board_url,provider:r.provider??'browser',apiUrl:r.api_url??undefined}))];
 return [...sources.filter(s=>s.id==='benchmark-employers'),{id:'known-netherlands',label:'Known Netherlands boards and pending collection',license:'Public employer sources',kind:'board-directory' as const,discover:async(_ctx:FetchContext,cursor:number,limit:number)=>({candidates:candidates.slice(cursor,cursor+limit),nextCursor:cursor+limit,total:candidates.length})},...sources.filter(s=>s.id!=='benchmark-employers')];
}
const categories:DiscoveryCategory[]=["linkedin","jobspy","priority","native","directories"];
export function sourceCategory(source:Pick<DiscoverySource,"id"|"kind">):DiscoveryCategory{
 if(source.id==='linkedin-guest')return 'linkedin';
 if(source.id.startsWith('jobspy-'))return 'jobspy';
 if(['benchmark-employers','known-netherlands'].includes(source.id))return 'priority';
 if(source.kind==='job-feed')return 'native';
 return 'directories';
}
function weightedCounts(limit:number,weights:number[]):number[]{
 if(!weights.length)return [];
 const total=weights.reduce((a,b)=>a+b,0),raw=weights.map(value=>limit*value/total),base=raw.map(Math.floor),left=limit-base.reduce((a,b)=>a+b,0);
 return base.map((value,index)=>value+(index<left?1:0));
}
export function defaultDiscoveryAllocations(limit:number):DiscoveryAllocations{
 const values=weightedCounts(limit,[25,25,25,15,10]);
 return Object.fromEntries(categories.map((key,index)=>[key,values[index]])) as unknown as DiscoveryAllocations;
}
export function validateDiscoveryAllocations(limit:number,value?:Partial<DiscoveryAllocations>):DiscoveryAllocations{
 const allocations=value?Object.fromEntries(categories.map(key=>[key,Number(value[key])])) as unknown as DiscoveryAllocations:defaultDiscoveryAllocations(limit);
 if(categories.some(key=>!Number.isInteger(allocations[key])||allocations[key]<0)||categories.reduce((sum,key)=>sum+allocations[key],0)!==limit)
   throw Object.assign(new Error(`Discovery allocations must be non-negative integers totalling ${limit}`),{statusCode:400});
 return allocations;
}
function splitBudget(total:number,sources:DiscoverySource[]):Map<string,number>{
 const result=new Map<string,number>();if(!sources.length)return result;
 const counts=weightedCounts(total,sources.map(()=>1));sources.forEach((source,index)=>result.set(source.id,counts[index]));return result;
}
export function buildDiscoveryPlan(limit:number,sources:DiscoverySource[],requested?:Partial<DiscoveryAllocations>):DiscoveryPlan{
 const allocations=validateDiscoveryAllocations(limit,requested),budgets=new Map<string,number>();
 for(const category of categories)for(const [id,count] of splitBudget(allocations[category],sources.filter(source=>sourceCategory(source)===category)))budgets.set(id,count);
 return {limit,allocations,sources:sources.map(source=>({id:source.id,label:source.label,kind:source.kind,category:sourceCategory(source),planned:budgets.get(source.id)??0,enabled:true,status:'enabled'})),rules:{redistribution:'Unused capacity is reassigned proportionally among sources that can still return candidates.',candidateMeaning:'A candidate is a job or employer board to investigate; it is not the same as a vacancy.'}};
}
export async function discoveryPlanForUi(store:Store,limit:number):Promise<DiscoveryPlan>{
 const sources=prioritySources(store,getDiscoverySources()),plan=buildDiscoveryPlan(limit,sources),profile=await loadProfile(),rows=store.discoverySourceRows() as any[],health=new Map(rows.map(row=>[row.id,row]));
 for(const row of plan.sources)row.lastError=health.get(row.id)?.last_error??undefined;
 const linkedinEnabled=sources.some(source=>source.id==='linkedin-guest');
 if(!linkedinEnabled)plan.sources.push({id:'linkedin-guest',label:'LinkedIn Guest (EXPERIMENTAL)',kind:'job-feed',category:'linkedin',planned:0,enabled:false,status:process.env.DIEGO_ENABLE_LINKEDIN_GUEST==='true'?'unauthorized':'disabled'});
 const requested=(process.env.DIEGO_JOBSPY_SITES??'').split(',').map(value=>value.trim()).filter(Boolean);
 for(const site of requested.filter(site=>(JOBSPY_SITES as readonly string[]).includes(site))){const id=`jobspy-${site}`;if(!sources.some(source=>source.id===id))plan.sources.push({id,label:`JobSpy ${site}`,kind:'job-feed',category:'jobspy',planned:0,enabled:false,status:process.env.DIEGO_ENABLE_JOBSPY==='true'?'unauthorized':'disabled'});}
 const terms=linkedInKeywordsFromProfile(profile).split(/\s+OR\s+/).map(value=>value.replace(/^"|"$/g,''));
 const explicitQueries=process.env.DIEGO_JOBSPY_QUERIES?.split(';').map(value=>value.trim()).filter(Boolean),explicitQuery=process.env.DIEGO_JOBSPY_QUERY?.trim();
 plan.scope={linkedin:{location:process.env.DIEGO_LINKEDIN_GUEST_LOCATION??'Netherlands',terms,strategy:'Up to 10 newest results, then saved continuation.'},jobspy:{platforms:sources.filter(source=>source.id.startsWith('jobspy-')).map(source=>source.id.slice(7)),location:process.env.DIEGO_JOBSPY_LOCATION??'Netherlands',preferredCities:(process.env.DIEGO_JOBSPY_PREFERRED_CITIES?.split(';').map(value=>value.trim()).filter(Boolean)??jobSpyPreferredCitiesFromProfile(profile)),queries:explicitQueries?.length?explicitQueries:explicitQuery?[explicitQuery]:jobSpyQueriesFromProfile(profile),broadQuery:explicitQuery??jobSpyQueryFromProfile(profile),hoursOld:Number(process.env.DIEGO_JOBSPY_HOURS_OLD)||undefined,version:JOBSPY_VERSION}};
 return plan;
}
export async function buildQueue(id:string,limit:number,sources:DiscoverySource[],store:Store,context:FetchContext,timeoutMs:number,signal:AbortSignal|undefined,progress:(message:string)=>void,weighted=false,plan?:DiscoveryPlan):Promise<number>{
 if(plan)return buildPlannedQueue(id,limit,sources,store,context,timeoutMs,signal,progress,plan);
 const selected=new Map<string,DiscoveryCandidate>(),cursors=new Map(sources.map(s=>[s.id,s.id==='known-netherlands'?0:store.discoveryCursor(s.id)])),exhausted=new Set<string>();
 const category=(s:DiscoverySource)=>['benchmark-employers','known-netherlands'].includes(s.id)?0:s.kind==='job-feed'?1:2;
 const quotas=weighted?[Math.ceil(limit*.5),Math.floor(limit*.3),limit-Math.ceil(limit*.5)-Math.floor(limit*.3)]:[limit,limit,limit],used=[0,0,0];
 let errors=0,overflow=false;
 for(let round=0;selected.size<limit&&exhausted.size<sources.length&&round<100;round++){
  let addedRound=0;
  for(const source of sources){
   if(signal?.aborted||selected.size>=limit)break;if(exhausted.has(source.id))continue;
   const group=category(source),allowance=overflow?limit:quotas[group]-used[group];if(allowance<=0)continue;
   store.registerDiscoverySource(source);
   const peers=sources.filter(s=>category(s)===group).length;
   const request=Math.min(limit-selected.size,allowance,Math.max(1,Math.ceil((weighted?quotas[group]:limit)/peers))),cursor=cursors.get(source.id)??0;
   try{
    const batch=await bounded(timeoutMs,signal,active=>source.discover(signaledContext(context,active),cursor,request));
    for(const candidate of batch.candidates){
     if(weighted&&candidate.benchmarkId&&!store.benchmarkBoardNeedsCheck(candidate.benchmarkId))continue;
     if(weighted&&!store.candidateDue(candidate))continue;
     const key=candidate.boardUrl&&!candidate.jobs?'board:'+canonicalizeUrl(candidate.boardUrl):candidateId(candidate);
     const prior=selected.get(key);
     if(prior){prior.contributingSources=[...new Set([...(prior.contributingSources??[prior.sourceId]),candidate.sourceId])];continue;}
     if(selected.size<limit){candidate.contributingSources=[candidate.sourceId];selected.set(key,candidate);used[group]++;addedRound++;}
    }
    cursors.set(source.id,batch.nextCursor);store.updateDiscoverySource(source.id,batch.nextCursor,batch.total,batch.candidates.length);
    if(!batch.candidates.length||batch.nextCursor===cursor||(batch.total!==undefined&&batch.total<=batch.candidates.length))exhausted.add(source.id);
    progress('['+source.id+'] selected '+selected.size+' total; next cursor '+batch.nextCursor);
   }catch(error){errors++;const failure=classifyError(error);store.updateDiscoverySource(source.id,cursor,undefined,0,failure.message);exhausted.add(source.id);progress('['+source.id+'] '+failure.message);}
  }
  if(!addedRound){if(!overflow){overflow=true;continue;}break;}
 }
 const ranked=[...selected.values()].sort((a,b)=>store.candidateLastChecked(a).localeCompare(store.candidateLastChecked(b)));
 store.enqueueDiscoveryCandidates(id,ranked.map(candidate=>({id:candidateId(candidate),candidate})));
 progress('Queued '+ranked.length+' unique candidates.');return errors;
}

async function buildPlannedQueue(id:string,limit:number,sources:DiscoverySource[],store:Store,context:FetchContext,timeoutMs:number,signal:AbortSignal|undefined,progress:(message:string)=>void,plan:DiscoveryPlan):Promise<number>{
 const selected=new Map<string,DiscoveryCandidate>(),cursors=new Map(sources.map(s=>[s.id,s.id==='known-netherlands'?0:store.discoveryCursor(s.id)])),exhausted=new Set<string>(),accepted=new Map<string,number>(),duplicates=new Map<string,number>(),reassigned=new Map<string,number>();
 const planned=new Map(plan.sources.map(row=>[row.id,row.planned])),sourceById=new Map(sources.map(source=>[source.id,source]));let errors=0;
 store.saveDiscoveryPlan(id,plan);
 const collect=async(source:DiscoverySource,wanted:number,extra=false)=>{
  let added=0,rounds=0;
  while(added<wanted&&!exhausted.has(source.id)&&selected.size<limit&&!signal?.aborted&&rounds++<100){
   const cursor=cursors.get(source.id)??0,request=Math.max(1,wanted-added);store.registerDiscoverySource(source);
   try{
    const batch=await bounded(timeoutMs,signal,active=>source.discover(signaledContext(context,active),cursor,request));let eligible=0;
    for(const candidate of batch.candidates){
     if(candidate.benchmarkId&&!store.benchmarkBoardNeedsCheck(candidate.benchmarkId))continue;if(!store.candidateDue(candidate))continue;eligible++;
     const key=candidate.boardUrl&&!candidate.jobs?'board:'+canonicalizeUrl(candidate.boardUrl):candidateId(candidate),prior=selected.get(key);
     if(prior){prior.contributingSources=[...new Set([...(prior.contributingSources??[prior.sourceId]),candidate.sourceId])];duplicates.set(source.id,(duplicates.get(source.id)??0)+1);continue;}
     if(selected.size<limit&&added<wanted){candidate.contributingSources=[candidate.sourceId];selected.set(key,candidate);added++;accepted.set(source.id,(accepted.get(source.id)??0)+1);if(extra)reassigned.set(source.id,(reassigned.get(source.id)??0)+1);}
    }
    cursors.set(source.id,batch.nextCursor);store.updateDiscoverySource(source.id,batch.nextCursor,batch.total,batch.candidates.length);
    if(!batch.candidates.length||batch.nextCursor===cursor||(batch.total!==undefined&&batch.nextCursor>=batch.total)||(!eligible&&rounds>4))exhausted.add(source.id);
   }catch(error){errors++;const failure=classifyError(error);store.updateDiscoverySource(source.id,cursor,undefined,0,failure.message);exhausted.add(source.id);progress('['+source.id+'] '+failure.message);}
  }
  store.updateDiscoveryPlanSource(id,source.id,{queued:accepted.get(source.id)??0,duplicates:duplicates.get(source.id)??0,reassigned:reassigned.get(source.id)??0,exhausted:exhausted.has(source.id)});return added;
 };
 for(const row of plan.sources){const source=sourceById.get(row.id);if(source&&row.planned>0)await collect(source,row.planned);}
 while(selected.size<limit){
  const available=sources.filter(source=>!exhausted.has(source.id));if(!available.length)break;
  const remaining=limit-selected.size,weights=available.map(source=>Math.max(1,planned.get(source.id)??0)),shares=weightedCounts(remaining,weights);let added=0;
  for(let index=0;index<available.length&&selected.size<limit;index++)added+=await collect(available[index],Math.max(1,shares[index]),true);
  if(!added)break;
 }
 const ranked=[...selected.values()].sort((a,b)=>store.candidateLastChecked(a).localeCompare(store.candidateLastChecked(b)));
 store.enqueueDiscoveryCandidates(id,ranked.map(candidate=>({id:candidateId(candidate),candidate})));
 for(const source of sources)store.updateDiscoveryPlanSource(id,source.id,{queued:accepted.get(source.id)??0,duplicates:duplicates.get(source.id)??0,reassigned:reassigned.get(source.id)??0,exhausted:exhausted.has(source.id)});
 progress(`Queued ${ranked.length} unique candidates with ${[...duplicates.values()].reduce((a,b)=>a+b,0)} duplicates merged.`);return errors;
}

export async function discover(
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const store = options.store ?? new Store(),
    owned = !options.store,
    progress = options.onProgress ?? (() => {});
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 5000),
    timeoutMs = options.candidateTimeoutMs ?? 45_000,
    concurrency = Math.min(Math.max(options.concurrency ?? 4, 1), 8);
  store.recoverStaleDiscoveryRuns();
  const configuredSources=options.sources??(options.source?getDiscoverySources(options.source):prioritySources(store,getDiscoverySources()));
  const requestedPlan=!options.sources&&!options.source?buildDiscoveryPlan(limit,configuredSources,options.allocations):undefined;
  const prior = options.resume
    ? store.incompleteDiscoveryRun(options.source)
    : null;
  const id = prior?.id ?? options.runId ?? randomUUID(),
    scanId = `discovery-${id}`,
    started = Date.now();
  if (!prior) {
    store.startDiscoveryRun(id, options.source, limit,requestedPlan);
    store.startRun(scanId, "discovery");
  } else store.resumeDiscoveryRun(id);
  const context =
    options.context ??
    createHttpContext({
      cacheDir: resolve(dataDir, "cache/discovery"),
      cacheTtlMs: 30 * 60_000,
    });
  const controller = new AbortController(),
    abort = () => {
      controller.abort();
      progress(
        "Interrupt received; cancelling active work and preserving the queue...",
      );
    };
  if (options.handleSignals) process.once("SIGINT", abort);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let sourceErrors = 0;
  const limitEnrichment = createEnrichmentLimiter();
  const heartbeat = setInterval(() => {
    store.db
      .prepare(
        "UPDATE discovery_runs SET heartbeat_at=? WHERE id=? AND status='running'",
      )
      .run(new Date().toISOString(), id);
  }, 5000);
  try {
    if (!prior) {
      const retries = options.retryFailures
        ? store.retryableCandidates(options.source, limit)
        : undefined;
      if (retries)
        store.enqueueDiscoveryCandidates(
          id,
          retries.map((candidate) => ({
            id: candidateId(candidate),
            candidate,
          })),
        );
      else
        sourceErrors = await buildQueue(
          id,
          limit,
          configuredSources,
          store,
          context,
          timeoutMs,
          controller.signal,
          progress,
          !options.sources && !options.source && !requestedPlan,
          requestedPlan,
        );
    }
    const profile = await loadProfile(),
      saved = prior?.row,
      counts: Counts = saved
        ? {
            processed: Number(saved.processed_count),
            employers: Number(saved.employer_count),
            matching: Number(saved.matching_jobs),
            newJobs: Number(saved.new_jobs ?? 0),
            refreshedJobs: Number(saved.refreshed_jobs ?? 0),
            fetched: Number(saved.fetched_jobs ?? 0),
            partialCollections: Number(saved.partial_collection_count ?? 0),
            nonmatching: Number(saved.nonmatching_jobs),
            errors: Number(saved.error_count),
            noNl: Number(saved.no_nl_count),
            empty: Number(saved.empty_count),
            missing: Number(saved.missing_board_count ?? 0),
            unsupported: Number(saved.unsupported_count ?? 0),
            retryableErrors: Number(saved.retryable_error_count),
            permanentErrors: Number(saved.permanent_error_count),
            descriptionCandidates: Number(
              saved.description_candidate_count ?? 0,
            ),
            enrichedJobs: Number(saved.enriched_job_count ?? 0),
            deferredEnrichments: Number(saved.deferred_enrichment_count ?? 0),
            descriptionMatches: Number(saved.description_match_count ?? 0),
            enrichmentFailures: Number(saved.enrichment_failure_count ?? 0),
          }
        : zeroCounts();
    const employerIds = new Set<string>(),
      circuit = new Map<string, number>();
    counts.errors += sourceErrors;
    let enrichmentUsed = counts.enrichedJobs + counts.enrichmentFailures;
    const queue = store.discoveryQueue(id);
    progress(
      `Discovery ${id}: ${queue.length} pending, concurrency ${concurrency}, timeout ${Math.round(timeoutMs / 1000)}s.`,
    );
    const checkpointOutcome=(outcome:{result:DiscoveryAttemptResult;retryable:boolean;matches:number;employerId?:string;jobs:number;newJobs:number;refreshedJobs:number;collectionPartial:boolean})=>{
      counts.processed++;
      counts.fetched+=outcome.jobs;
      counts.matching+=outcome.matches;
      counts.newJobs+=outcome.newJobs;
      counts.refreshedJobs+=outcome.refreshedJobs;
      if(outcome.collectionPartial)counts.partialCollections++;
      if(outcome.employerId&&!employerIds.has(outcome.employerId)){employerIds.add(outcome.employerId);counts.employers++;}
      if(outcome.result==="no-netherlands-jobs")counts.noNl++;
      else if(outcome.result==="empty-board")counts.empty++;
      else if(outcome.result==="board-not-found")counts.missing++;
      else if(outcome.result==="unsupported")counts.unsupported++;
      if(operationalFailures.has(outcome.result)){counts.errors++;outcome.retryable?counts.retryableErrors++:counts.permanentErrors++;}
      // Persist after every completed candidate. Other workers in this batch may
      // still be running, so the dashboard no longer waits for the slowest one.
      store.updateDiscoveryCheckpoint(id,{queue:true},counts);
      store.updateRecallCheckpoint(id,counts);
      progress(`${counts.processed} processed | ${counts.employers} employers | ${counts.newJobs} new jobs | ${counts.errors} errors`);
    };
    for (const group of groups(queue, concurrency)) {
      if (controller.signal.aborted) break;
      const eligible = group.filter(
        (item) => (circuit.get(destinationHost(item.candidate)) ?? 0) < 5,
      );
      if (!eligible.length) continue;
      await Promise.all(
        eligible.map(async (item) => {
          const { candidateId: idValue } = item,
            startedAt = new Date().toISOString(),
            attemptStarted = Date.now(),
            key = destinationHost(item.candidate);
          const candidate = item.candidate;
          let result: DiscoveryAttemptResult = "invalid-record",
            retryable = false,
            status: number | undefined,
            errorMessage: string | undefined,
            collection: CollectionResult | undefined,
            jobs: RawJob[] = [],
            nlJobs: RawJob[] = [],
            matches = 0,
            employerId: string | undefined,
            newJobs = 0,
            refreshedJobs = 0;
          const enrichment = new Map<
            string,
            { status: string; error?: string; retryAfterMs?:number }
          >();
          try {
            if (!candidate.company?.trim())
              throw Object.assign(new Error("Candidate company is missing"), {
                discoveryResult: "invalid-record",
              });
            jobs = await (async () => {
                const signal=controller.signal;
                const activeContext = signaledContext(context, signal);
                if (candidate.benchmarkId && !candidate.discoveryEvidence) {
                  const employer = BENCHMARK_EMPLOYERS.find(
                    (value) => value.id === candidate.benchmarkId,
                  );
                  if (employer)
                    Object.assign(
                      candidate,
                      await bounded(timeoutMs,signal,active=>benchmarkCandidate(signaledContext(activeContext,active),employer)),
                    );
                }
                collection = await fetchCandidate(candidate, activeContext, store, signal, timeoutMs);
                const fetched = collection.jobs, prepared: RawJob[] = [];
                for (const job of fetched) {
                  if (
                    assessLocation(job,profile).state !== 'foreign' &&
                    isPlausibleRecallCandidate(job, profile) &&
                    (job.description?.trim().length ?? 0) < 160
                  ) {
                    counts.descriptionCandidates++;
                    if (enrichmentUsed >= Math.min(Math.max(options.enrichmentLimit??100,0),100)) {
                      enrichment.set(job.url, { status: "deferred" });
                      counts.deferredEnrichments++;
                      prepared.push(job);
                      continue;
                    }
                    enrichmentUsed++;
                    const value = await limitEnrichment(job.url, signal, () =>
                      enrichJob(job, activeContext),
                    );
                    enrichment.set(job.url, {
                      status: value.status,
                      error: value.error,
                      retryAfterMs:value.retryAfterMs,
                    });
                    value.status === "complete"
                      ? counts.enrichedJobs++
                      : counts.enrichmentFailures++;
                    prepared.push(value.job);
                  } else {
                    enrichment.set(job.url, {
                      status:
                        (job.description?.trim().length ?? 0) >= 160
                          ? "not-needed"
                          : "unavailable",
                    });
                    prepared.push(job);
                  }
                }
                return prepared;
              })();
            if (!jobs.length) result = "empty-board";
            else {
              nlJobs = jobs.filter((job) => isNetherlandsJob(job, profile));
              result = nlJobs.length ? "matched" : "no-netherlands-jobs";
            }
          } catch (error: any) {
            if (
              error?.discoveryResult === "unsupported" ||
              error?.discoveryResult === "invalid-record"
            ) {
              result = error.discoveryResult;
              errorMessage = error.message;
            } else {
              const failure = classifyError(error);
              result = failure.result;
              retryable = failure.retryable;
              status = failure.status;
              errorMessage = failure.message;
            }
          }
          // Collected records are committed even when cancellation arrives mid-chunk.
          const actualCompany =
            nlJobs[0]?.company || jobs[0]?.company || candidate.company;
          const normalizedCandidate = { ...candidate, company: actualCompany };
          const collectionPartial=collection ? !collection.complete : false, continuation=collection?.nextCursor;
          if(collection?.error){const failure=classifyError(new HttpError(collection.error,collection.httpStatus,collection.retryable??true,collection.retryAfterMs));result=failure.result;errorMessage=collection.error;retryable=failure.retryable;}
          const attempt: DiscoveryAttempt = {
            runId: id,
            sourceId: candidate.sourceId,
            company: actualCompany,
            boardUrl: candidate.boardUrl,
            provider: candidate.provider,
            startedAt,
            durationMs: Date.now() - attemptStarted,
            result,
            httpStatus: status,
            retryable,
            errorMessage,
            jobsFetched: jobs.length,
            netherlandsJobs: nlJobs.length,
            profileMatches: 0,
            collectionPartial,
            continuation,
            candidate: normalizedCandidate,
          };
          store.transaction(() => {
            if (actualCompany.trim()) {
              employerId = store.upsertEmployer(
                normalizedCandidate,
                hash(
                  normalizedCandidate.domain ?? normalizeText(actualCompany),
                ),
                normalizeText(actualCompany),
                result === "matched" ? nlJobs.length : 0,
              );
              const boardStatus =
                result === "matched" ||
                result === "no-netherlands-jobs" ||
                result === "empty-board"
                  ? "healthy"
                  : result === "unsupported"
                    ? "unsupported"
                    : "failing";
              store.upsertEmployerBoard(
                employerId,
                normalizedCandidate,
                hash(
                  candidate.boardUrl ??
                    `${candidate.sourceId}:${actualCompany}`,
                ),
                boardStatus,
                errorMessage,
              );
            }
            store.recordBenchmarkBoardAttempt(normalizedCandidate);
            if(employerId)for(const job of jobs){
              const state=enrichment.get(job.url);
              const processed=processJob(job,{store,profile,sourceId:candidate.sourceId,provider:candidate.provider??'browser',scanId,discoveryRunId:id,candidateId:idValue,boardUrl:candidate.boardUrl,candidate:normalizedCandidate,employerId,enrichmentStatus:state?.status==='deferred'?'unavailable':state?.status,enrichmentError:state?.error});
              if(isNetherlandsJob(job,profile))store.observeVacancy(employerId,candidate.sourceId,job,fingerprint(job),processed.decision.retain);
              if(processed.decision.retain){matches++;processed.write==='new'?newJobs++:refreshedJobs++;if(processed.decision.evidence?.matchedFrom==='description')counts.descriptionMatches++;}
              else counts.nonmatching++;
              if(processed.id && state)store.recordEnrichment(processed.id,state.status,job.url,state.error);
              if(state?.status==='failed'||state?.status==='unavailable')store.finishQueuedEnrichment(stableJobId('enrichment',job),'failed',state.error,state.retryAfterMs);
            }
            if(collection && candidate.boardUrl && !candidate.jobs){
              const source={id:hash(candidate.boardUrl),company:candidate.company,careersUrl:candidate.boardUrl,provider:candidate.provider??'browser' as const};
              checkpointCollection(store,source,collection,normalizedCandidate);
              if(collection.complete)store.ageUnseenBoard(candidate.boardUrl,store.collection(candidate.boardUrl).snapshot_started_at,profile.expiryAfterMissedScans);
            }
            attempt.profileMatches = matches;
            store.recordDiscoveryAttempt(attempt);
            store.updateCandidateHealth(idValue, attempt);
            store.markDiscoveryQueue(id, idValue, "completed", result);
          });
          if (["network-error", "rate-limited", "timeout"].includes(result))
            circuit.set(key, (circuit.get(key) ?? 0) + 1);
          else circuit.set(key, 0);
          const outcome = {
            result,
            retryable,
            matches,
            employerId,
            jobs: jobs.length,
            newJobs,
            refreshedJobs,
            collectionPartial,
          };
          checkpointOutcome(outcome);
          return outcome;
        }),
      );
    }
    const pending = store.pendingDiscoveryCount(id),
      durationMs = Date.now() - started,
      interrupted = controller.signal.aborted;
    const status = interrupted
      ? "interrupted"
      : pending
        ? "partial"
        : counts.errors || counts.partialCollections
          ? "partial"
          : "completed";
    store.finishDiscoveryRun(id, {
      status,
      ...counts,
      durationMs,
      checkpoint: { queue: true },
      fetched: counts.fetched,
      newJobs: counts.newJobs,
      refreshedJobs: counts.refreshedJobs,
      missingBoards: counts.missing,
      unsupported: counts.unsupported,
      partialCollections: counts.partialCollections,
    });
    if (!interrupted)
      store.finishRun(scanId, status === "completed" ? "completed" : "partial");
    progress(
      `Discovery ${status}: ${counts.processed} processed, ${pending} pending, ${counts.employers} employers, ${counts.newJobs} new and ${counts.refreshedJobs} refreshed jobs, ${counts.missing} missing boards, ${counts.errors} errors, ${Math.round(durationMs / 1000)}s.`,
    );
    return {
      id,
      status,
      processed: counts.processed,
      pending,
      employers: counts.employers,
      matchingJobs: counts.matching,
      newJobs: counts.newJobs,
      refreshedJobs: counts.refreshedJobs,
      fetchedJobs: counts.fetched,
      partialCollections: counts.partialCollections,
      nonmatchingJobs: counts.nonmatching,
      noNetherlandsJobs: counts.noNl,
      emptyBoards: counts.empty,
      missingBoards: counts.missing,
      unsupported: counts.unsupported,
      retryableFailures: counts.retryableErrors,
      permanentFailures: counts.permanentErrors,
      errors: counts.errors,
      durationMs,
      descriptionCandidates: counts.descriptionCandidates,
      enrichedJobs: counts.enrichedJobs,
      deferredEnrichments: counts.deferredEnrichments,
      descriptionMatches: counts.descriptionMatches,
      enrichmentFailures: counts.enrichmentFailures,
    };
  } finally {
    clearInterval(heartbeat);
    if (options.handleSignals) process.removeListener("SIGINT", abort);
    options.signal?.removeEventListener("abort", abort);
    if (owned) store.close();
  }
}
