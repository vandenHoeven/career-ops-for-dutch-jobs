import { processJob } from './processing.js';
import { collectSource, checkpointCollection } from './collection.js';
import { assessLocation } from './locations.js';
import type { CollectionResult } from './types.js';
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { dataDir, loadProfile } from "./config.js";
import {
  canonicalizeUrl,
  fingerprint,
  normalizeText,
} from "./core.js";
import { Store } from "./database.js";
import {
  benchmarkCandidate,
  getDiscoverySources,
} from "./discovery-sources.js";
import { BENCHMARK_EMPLOYERS } from "./benchmark.js";
import { createHttpContext, HttpError } from "./http.js";
import { resolveProvider } from "./providers.js";
import { JOBSPY_SITES, JOBSPY_VERSION, jobSpyPreferredCitiesFromProfile, jobSpyQueriesFromProfile, jobSpyQueryFromProfile } from "./jobspy.js";
import { linkedInKeywordsFromProfile } from "./linkedin-guest.js";
import { discoveryArmId, validateDiscoveryDuration, type DiscoveryDurationMinutes } from "./adaptive-discovery.js";
import type {
  DiscoveryAttempt,
  DiscoveryAttemptResult,
  DiscoveryCandidate,
  DiscoverySource,
  DiscoverySourceArm,
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
  mode?: DiscoveryRunMode;
  claimedRun?: boolean;
  durationMinutes?: DiscoveryDurationMinutes;
  /** Test-only millisecond override for the timed scheduler. */
  timeBudgetMs?: number;
}
export function validateDiscoveryWorkers(value: unknown): number {
  if (value === undefined || value === null || value === "") return 6;
  const workers = Number(value);
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw Object.assign(new Error("Discovery workers must be an integer from 1 to 8"), { statusCode: 400 });
  return workers;
}
export type DiscoveryRunMode = "balanced" | "fresh" | "refresh-known" | "turbo" | "adaptive";
export function validateDiscoveryMode(value:unknown):DiscoveryRunMode {if(value===undefined||value===null||value==="")return "balanced";if(value==="balanced"||value==="fresh"||value==="refresh-known"||value==="turbo")return value;throw Object.assign(new Error("Discovery mode must be balanced, fresh, refresh-known, or turbo"),{statusCode:400});}
export type DiscoveryCategory = "linkedin" | "jobspy" | "priority" | "native" | "directories";
export type DiscoveryAllocations = Record<DiscoveryCategory, number>;
export type DiscoveryAllocationWeights = Record<DiscoveryCategory, number>;
export interface DiscoveryPlanSource {
  id: string; label: string; kind: DiscoverySource["kind"]; category: DiscoveryCategory;
  planned: number; enabled: boolean; status: "enabled" | "disabled" | "unauthorized";
  lastError?: string;
  originalPlanned?: number; deprioritized?: boolean;
  yieldEvidence?: { attempts: number; averageDurationMs: number; matchYield: number; reason: string };
  tier?: "primary" | "fallback" | "excluded";
  turboScore?: number;
  turboReason?: string;
  turboEvidence?: { attempts: number; averageDurationMs: number; matchYield: number; failureRate: number };
}
export interface DiscoveryPlan {
  limit: number; allocations: DiscoveryAllocations; sources: DiscoveryPlanSource[];
  rules: { redistribution: string; candidateMeaning: string; selectionPolicy: "strict" | "turbo-tiered" };
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
function schedulingProvider(candidate: DiscoveryCandidate): string {
  // Embedded feed records do not consume their nominal `browser` provider at
  // processing time. Keep each feed isolated from slow ATS/browser boards.
  return candidate.jobs ? `feed:${candidate.sourceId}` : candidate.provider ?? "embedded";
}
function hostLimit(candidate: DiscoveryCandidate): number {
  return candidate.provider === "workday" || candidate.provider === "ashby"
    ? 1
    : 2;
}
export function prioritySources(store:Store,sources:DiscoverySource[]):DiscoverySource[]{
 const rows=store.db.prepare(`SELECT eb.board_url,e.canonical_name company,eb.provider,eb.api_url FROM employer_boards eb JOIN employers e ON e.id=eb.employer_id WHERE EXISTS(SELECT 1 FROM vacancy_observations v WHERE v.employer_id=e.id) ORDER BY COALESCE(eb.last_checked_at,'') ASC`).all() as any[];
 const partials=store.db.prepare("SELECT candidate_json FROM collection_checkpoints WHERE state!='complete' AND cursor IS NOT NULL AND candidate_json IS NOT NULL ORDER BY last_checked_at").all() as any[];
 const candidates:DiscoveryCandidate[]=[...partials.map(r=>JSON.parse(r.candidate_json)),...rows.map(r=>({sourceId:'known-netherlands',company:r.company,boardUrl:r.board_url,provider:r.provider??'browser',apiUrl:r.api_url??undefined}))];
 return [...sources.filter(s=>s.id==='benchmark-employers'),{id:'known-netherlands',label:'Known Netherlands boards and pending collection',license:'Public employer sources',kind:'board-directory' as const,discover:async(_ctx:FetchContext,cursor:number,limit:number)=>({candidates:candidates.slice(cursor,cursor+limit),nextCursor:cursor+limit,total:candidates.length})},...sources.filter(s=>s.id!=='benchmark-employers')];
}
function refreshKnownSources(store:Store):DiscoverySource[]{
 const rows=store.db.prepare(`SELECT eb.board_url,e.canonical_name company,eb.provider,eb.api_url FROM employer_boards eb JOIN employers e ON e.id=eb.employer_id WHERE eb.board_url IS NOT NULL ORDER BY COALESCE(eb.last_checked_at,'') ASC,e.canonical_name`).all() as any[];
 const candidates:DiscoveryCandidate[]=rows.map(row=>({sourceId:"known-netherlands",company:row.company,boardUrl:row.board_url,provider:row.provider??"browser",apiUrl:row.api_url??undefined}));
 return [{id:"known-netherlands",label:"Known employer and ATS boards",license:"Public employer sources",kind:"board-directory",discover:async(_context,cursor,limit)=>({candidates:candidates.slice(cursor,cursor+limit),nextCursor:cursor+limit,total:candidates.length})}];
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
function largestRemainderCounts(limit:number,weights:number[]):number[]{
 if(!weights.length)return [];
 const total=weights.reduce((sum,value)=>sum+Math.max(0,value),0),normalized=total>0?weights.map(value=>Math.max(0,value)/total):weights.map(()=>1/weights.length),raw=normalized.map(value=>value*limit),counts=raw.map(Math.floor),order=raw.map((value,index)=>({index,remainder:value-counts[index]})).sort((a,b)=>b.remainder-a.remainder||a.index-b.index);
 for(let left=limit-counts.reduce((sum,value)=>sum+value,0),index=0;left>0;left--,index++)counts[order[index%order.length].index]++;
 return counts;
}
function boundedTurboWeights(scores:number[]):number[]{
 if(scores.length<=1)return scores.length?[1]:[];
 const floor=Math.min(.05,1/scores.length),ceiling=Math.max(.4,1/scores.length),positive=scores.map(value=>Math.max(value,1e-9)),weights=Array(scores.length).fill(0),open=new Set(scores.map((_,index)=>index));let remaining=1;
 while(open.size){const total=[...open].reduce((sum,index)=>sum+positive[index],0),shares=[...open].map(index=>({index,value:remaining*positive[index]/total})),high=shares.filter(item=>item.value>ceiling+1e-12).sort((a,b)=>b.value-a.value||a.index-b.index)[0];if(high){weights[high.index]=ceiling;remaining-=ceiling;open.delete(high.index);continue;}const low=shares.filter(item=>item.value<floor-1e-12).sort((a,b)=>a.value-b.value||a.index-b.index)[0];if(low){weights[low.index]=floor;remaining-=floor;open.delete(low.index);continue;}for(const item of shares)weights[item.index]=item.value;break;}
 return weights;
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
export function validateDiscoveryAllocationWeights(value:unknown,fallback:DiscoveryAllocations):DiscoveryAllocationWeights{
 const candidate=(value&&typeof value==="object"?value:fallback) as Partial<Record<DiscoveryCategory,unknown>>,numbers=Object.fromEntries(categories.map(key=>[key,Number(candidate[key]??0)])) as DiscoveryAllocationWeights,total=categories.reduce((sum,key)=>sum+numbers[key],0);
 if(categories.some(key=>!Number.isFinite(numbers[key])||numbers[key]<0)||total<=0)throw Object.assign(new Error("Discovery allocation weights must be non-negative finite numbers with a positive total"),{statusCode:400});
 return Object.fromEntries(categories.map(key=>[key,numbers[key]/total])) as DiscoveryAllocationWeights;
}
export function scaleDiscoveryAllocations(limit:number,weights:DiscoveryAllocationWeights):DiscoveryAllocations{
 const target=Math.max(1,Math.round(limit)),raw=categories.map(key=>target*weights[key]),base=raw.map(Math.floor),remaining=target-base.reduce((sum,value)=>sum+value,0),ranked=categories.map((_,index)=>index).sort((a,b)=>(raw[b]-base[b])-(raw[a]-base[a])||a-b);
 for(let index=0;index<remaining;index++)base[ranked[index]]++;
 return Object.fromEntries(categories.map((key,index)=>[key,base[index]])) as DiscoveryAllocations;
}
function splitBudget(total:number,sources:DiscoverySource[]):Map<string,number>{
 const result=new Map<string,number>();if(!sources.length)return result;
 const counts=weightedCounts(total,sources.map(()=>1));sources.forEach((source,index)=>result.set(source.id,counts[index]));return result;
}
export function buildDiscoveryPlan(limit:number,sources:DiscoverySource[],requested?:Partial<DiscoveryAllocations>,store?:Store,deprioritize=false):DiscoveryPlan{
 const allocations=validateDiscoveryAllocations(limit,requested),budgets=new Map<string,number>();
 for(const category of categories)for(const [id,count] of splitBudget(allocations[category],sources.filter(source=>sourceCategory(source)===category)))budgets.set(id,count);
 const evidence=new Map<string,{attempts:number;averageDurationMs:number;matchYield:number;reason:string}>();
 if(store&&deprioritize)for(const source of sources){const row=store.sourceYieldEvidence(source.id);if(row&&row.attempts>=50&&row.averageDurationMs>=2000&&row.matchYield<0.03)evidence.set(source.id,{...row,reason:'At least 50 attempts in 30 days, average duration ≥2s, and profile match yield below 3%'});}
 const planSources=sources.map(source=>{const original=budgets.get(source.id)??0,poor=evidence.get(source.id);return {id:source.id,label:source.label,kind:source.kind,category:sourceCategory(source),planned:poor?Math.min(1,original):original,originalPlanned:original,deprioritized:Boolean(poor),yieldEvidence:poor,enabled:true,status:'enabled' as const};});
 for(const category of categories){const rows=planSources.filter(row=>row.category===category),released=rows.reduce((sum,row)=>sum+(row.originalPlanned??row.planned)-row.planned,0),healthy=rows.filter(row=>!row.deprioritized);if(released&&healthy.length){const shares=weightedCounts(released,healthy.map(row=>Math.max(1,row.originalPlanned??row.planned)));healthy.forEach((row,index)=>row.planned+=shares[index]);}}
 return {limit,allocations,sources:planSources,rules:{selectionPolicy:'strict',redistribution:'Unused capacity is reassigned only within categories whose allocation is above zero. A zero allocation excludes that category, and the run may finish below its budget.',candidateMeaning:'A candidate is a job or employer board to investigate; it is not the same as a vacancy.'}};
}
export function buildTurboDiscoveryPlan(limit:number,sources:DiscoverySource[],store:Store):DiscoveryPlan{
 const classified=sources.map(source=>{
  const evidence=store.sourceYieldEvidence(source.id),attempts=evidence?.attempts??0,averageDurationMs=evidence?.averageDurationMs??1000,matchYield=evidence?.matchYield??.1,failureRate=evidence?.failureRate??0,limited=attempts<20;
  const primary=source.kind==="job-feed"&&(limited||(averageDurationMs<=2000&&failureRate<=.1&&matchYield>=.03)),fallback=!primary&&(limited||(failureRate<=.2&&matchYield>=.03)),tier:DiscoveryPlanSource["tier"]=primary?"primary":fallback?"fallback":"excluded",smoothedYield=((evidence?.matches??0)+2)/(attempts+20),score=smoothedYield*Math.max(0,1-failureRate)/Math.sqrt(Math.max(averageDurationMs,250)/1000);
  const turboReason=primary?(limited?"Fast job feed with provisional evidence":"Fast, reliable job feed"):fallback?(limited?"Provisional slower source; used only if fast feeds underfill":"Proven fallback; used only if fast feeds underfill"):(failureRate>.2?"Excluded: operational failure rate exceeds 20%":"Excluded: profile-match yield is below 3%");
  return {source,tier,score,turboReason,turboEvidence:{attempts,averageDurationMs,matchYield,failureRate}};
 }).sort((a,b)=>b.score-a.score||a.source.id.localeCompare(b.source.id));
 if(!classified.some(row=>row.tier==="primary")){const promote=classified.find(row=>row.tier==="fallback");if(promote){promote.tier="primary";promote.turboReason="Promoted because no fast primary source is available";}}
 const primary=classified.filter(row=>row.tier==="primary"),counts=largestRemainderCounts(limit,boundedTurboWeights(primary.map(row=>row.score))),planned=new Map(primary.map((row,index)=>[row.source.id,counts[index]]));
 const planSources:DiscoveryPlanSource[]=classified.map(row=>({id:row.source.id,label:row.source.label,kind:row.source.kind,category:sourceCategory(row.source),planned:planned.get(row.source.id)??0,enabled:true,status:"enabled",tier:row.tier,turboScore:Number(row.score.toFixed(6)),turboReason:row.turboReason,turboEvidence:row.turboEvidence}));
 const allocations=Object.fromEntries(categories.map(category=>[category,planSources.filter(row=>row.category===category).reduce((sum,row)=>sum+row.planned,0)])) as DiscoveryAllocations;
 return {limit,allocations,sources:planSources,rules:{selectionPolicy:"turbo-tiered",redistribution:"Fast primary feeds run first. Remaining capacity stays with fast feeds when possible, then proven fallbacks run in evidence order until the budget is filled.",candidateMeaning:"A candidate is a job or employer board to investigate; it is not the same as a vacancy."}};
}
export async function discoveryPlanForUi(store:Store,limit:number,mode:DiscoveryRunMode="balanced"):Promise<DiscoveryPlan>{
 const sources=prioritySources(store,getDiscoverySources()),plan=mode==="turbo"?buildTurboDiscoveryPlan(limit,sources,store):buildDiscoveryPlan(limit,sources,undefined,store,true),profile=await loadProfile(),rows=store.discoverySourceRows() as any[],health=new Map(rows.map(row=>[row.id,row]));
 for(const row of plan.sources)row.lastError=health.get(row.id)?.last_error??undefined;
 const linkedinEnabled=sources.some(source=>source.id==='linkedin-guest');
 if(!linkedinEnabled)plan.sources.push({id:'linkedin-guest',label:'LinkedIn Guest (EXPERIMENTAL)',kind:'job-feed',category:'linkedin',planned:0,enabled:false,status:process.env.DIEGO_ENABLE_LINKEDIN_GUEST==='true'?'unauthorized':'disabled'});
 const requested=(process.env.DIEGO_JOBSPY_SITES??'').split(',').map(value=>value.trim()).filter(Boolean);
 for(const site of requested.filter(site=>(JOBSPY_SITES as readonly string[]).includes(site))){const id=`jobspy-${site}`;if(!sources.some(source=>source.id===id))plan.sources.push({id,label:`JobSpy ${site}`,kind:'job-feed',category:'jobspy',planned:0,enabled:false,status:process.env.DIEGO_ENABLE_JOBSPY==='true'?'unauthorized':'disabled'});}
 const terms=linkedInKeywordsFromProfile(profile).split(/\s+OR\s+/).map(value=>value.replace(/^"|"$/g,''));
 const explicitQueries=process.env.DIEGO_JOBSPY_QUERIES?.split(';').map(value=>value.trim()).filter(Boolean),explicitQuery=process.env.DIEGO_JOBSPY_QUERY?.trim();
 plan.scope={linkedin:{location:process.env.DIEGO_LINKEDIN_GUEST_LOCATION??'Netherlands',terms,strategy:'Start with 25 newest results, then paginate continuously.'},jobspy:{platforms:sources.filter(source=>source.id.startsWith('jobspy-')).map(source=>source.id.slice(7)),location:process.env.DIEGO_JOBSPY_LOCATION??'Netherlands',preferredCities:(process.env.DIEGO_JOBSPY_PREFERRED_CITIES?.split(';').map(value=>value.trim()).filter(Boolean)??jobSpyPreferredCitiesFromProfile(profile)),queries:explicitQueries?.length?explicitQueries:explicitQuery?[explicitQuery]:jobSpyQueriesFromProfile(profile),broadQuery:explicitQuery??jobSpyQueryFromProfile(profile),hoursOld:Number(process.env.DIEGO_JOBSPY_HOURS_OLD)||168,version:JOBSPY_VERSION}};
 return plan;
}
export async function adaptiveDiscoveryPreview(store:Store,durationMinutes:unknown){
 const duration=validateDiscoveryDuration(durationMinutes),sources=prioritySources(store,getDiscoverySources()),forecast=store.adaptiveForecast(duration,sources.map(source=>({id:source.id,label:source.label}))),profile=await loadProfile();
 return {durationMinutes:duration,durations:[5,10,20,30],deadlinePolicy:"Stop launching at the selected time; drain active work for up to 30 seconds.",objective:{label:"New, strong, date-verified Netherlands matches",weights:{"0-7":1,"8-30":.4,"31-60":.1,older:0,unknown:0}},forecast,sources:forecast.arms.map((arm:any)=>({...arm,status:"enabled"})),scope:{linkedin:{location:process.env.DIEGO_LINKEDIN_GUEST_LOCATION??"Netherlands",terms:linkedInKeywordsFromProfile(profile).split(/\s+OR\s+/).map(value=>value.replace(/^"|"$/g,""))},jobspy:{platforms:sources.filter(source=>source.id.startsWith("jobspy-")).map(source=>source.id.slice(7)),location:process.env.DIEGO_JOBSPY_LOCATION??"Netherlands",queries:jobSpyQueriesFromProfile(profile)}}};
}
function curveBudgets(limit:number):number[]{
 const maximum=Math.max(1000,limit),rawStep=maximum/20,power=10**Math.floor(Math.log10(rawStep)),scaled=rawStep/power,nice=scaled<=1?1:scaled<=2?2:scaled<=2.5?2.5:scaled<=5?5:10,step=Math.max(1,Math.round(nice*power)),values=new Set<number>([1,limit,maximum]);
 for(let value=step;value<=maximum;value+=step)values.add(value);
 return [...values].filter(value=>value>=1&&value<=5000).sort((a,b)=>a-b);
}
export async function discoveryForecastForUi(store:Store,limit:number,allocations:DiscoveryAllocations|undefined,mode:DiscoveryRunMode,allocationWeights?:unknown){
 const sources=mode==="refresh-known"?refreshKnownSources(store):prioritySources(store,getDiscoverySources()),fallbackAllocations=allocations??defaultDiscoveryAllocations(limit),currentPlan=mode==="turbo"?buildTurboDiscoveryPlan(limit,sources,store):buildDiscoveryPlan(limit,sources,mode==="refresh-known"?{linkedin:0,jobspy:0,priority:limit,native:0,directories:0}:fallbackAllocations,store,mode==="balanced"||mode==="fresh"),turboHasAllocation=categories.some(category=>currentPlan.allocations[category]>0),weights=mode==="turbo"?validateDiscoveryAllocationWeights(turboHasAllocation?currentPlan.allocations:fallbackAllocations,fallbackAllocations):mode==="refresh-known"?validateDiscoveryAllocationWeights({linkedin:0,jobspy:0,priority:1,native:0,directories:0},fallbackAllocations):validateDiscoveryAllocationWeights(allocationWeights,fallbackAllocations),budgets=curveBudgets(limit),curvePlans=budgets.map(sampleLimit=>{const plan=mode==="turbo"?buildTurboDiscoveryPlan(sampleLimit,sources,store):buildDiscoveryPlan(sampleLimit,sources,scaleDiscoveryAllocations(sampleLimit,weights),store,mode==="balanced"||mode==="fresh");return {limit:sampleLimit,plan:plan.sources.map(row=>({sourceId:row.id,label:row.label,category:row.category,planned:row.planned}))};}),forecasts=store.discoveryForecastSeries([{limit,plan:currentPlan.sources.map(row=>({sourceId:row.id,label:row.label,category:row.category,planned:row.planned}))},...curvePlans],mode),current=forecasts[0],support=store.discoveryForecastBudgetSupport();
 return {...current,curve:{minLimit:1,maxLimit:Math.max(1000,limit),historicalSupport:support,allocationWeights:weights,points:budgets.map((sampleLimit,index)=>{const forecast=forecasts[index+1];return {limit:sampleLimit,ml:{point:forecast.ml.point,lower:forecast.ml.lower,upper:forecast.ml.upper},baseline:{point:forecast.baseline.point}};})}};
}
export async function buildQueue(id:string,limit:number,sources:DiscoverySource[],store:Store,context:FetchContext,timeoutMs:number,signal:AbortSignal|undefined,progress:(message:string)=>void,weighted=false,plan?:DiscoveryPlan,mode:DiscoveryRunMode="balanced"):Promise<number>{
 if(plan)return buildPlannedQueue(id,limit,sources,store,context,timeoutMs,signal,progress,plan,mode);
 const selected=new Map<string,DiscoveryCandidate>(),cursors=new Map(sources.map(s=>[s.id,s.id==='known-netherlands'?0:store.discoveryCursor(s.id)])),exhausted=new Set<string>(),composition={fresh:0,recheck:0,continuation:0,forcedRefresh:0,skippedRecent:0};
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
    store.updateDiscoveryPhase(id,"querying-sources",`Querying ${source.label}`);store.recordDiscoveryEvent(id,{phase:"querying-sources",type:"source-query",sourceId:source.id,cursor,message:`Requested up to ${request} candidates from ${source.label}`});
    const batch=await bounded(timeoutMs,signal,active=>source.discover(signaledContext(context,active),cursor,request));
    for(const candidate of batch.candidates){
     if(weighted&&candidate.benchmarkId&&!store.benchmarkBoardNeedsCheck(candidate.benchmarkId))continue;
     let disposition=store.candidateDisposition(candidate,mode);if(disposition==="skipped-recent"){if(weighted||mode!=="balanced"){composition.skippedRecent++;continue;}disposition="recheck";}
     const key=candidate.boardUrl&&!candidate.jobs?'board:'+canonicalizeUrl(candidate.boardUrl):candidateId(candidate);
     const prior=selected.get(key);
     if(prior){prior.contributingSources=[...new Set([...(prior.contributingSources??[prior.sourceId]),candidate.sourceId])];continue;}
     if(selected.size<limit){candidate.contributingSources=[candidate.sourceId];selected.set(key,candidate);composition[disposition==="forced-refresh"?"forcedRefresh":disposition]++;used[group]++;addedRound++;}
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
 store.updateDiscoveryComposition(id,{queued:ranked.length,...composition});
 progress('Queued '+ranked.length+' unique candidates.');return errors;
}

async function buildPlannedQueue(id:string,limit:number,sources:DiscoverySource[],store:Store,context:FetchContext,timeoutMs:number,signal:AbortSignal|undefined,progress:(message:string)=>void,plan:DiscoveryPlan,mode:DiscoveryRunMode):Promise<number>{
 const turbo=plan.rules.selectionPolicy==="turbo-tiered",planned=new Map(plan.sources.map(row=>[row.id,row.planned])),planById=new Map(plan.sources.map(row=>[row.id,row])),selectedSources=sources.filter(source=>turbo?["primary","fallback"].includes(planById.get(source.id)?.tier??""):(planned.get(source.id)??0)>0);
 const selected=new Map<string,DiscoveryCandidate>(),cursors=new Map(selectedSources.map(s=>[s.id,s.id==='known-netherlands'?0:store.discoveryCursor(s.id)])),exhausted=new Set<string>(),exhaustionTraced=new Set<string>(),accepted=new Map<string,number>(),duplicates=new Map<string,number>(),reassigned=new Map<string,number>(),fresh=new Map<string,number>(),recheck=new Map<string,number>(),continuation=new Map<string,number>(),forcedRefresh=new Map<string,number>(),skippedRecent=new Map<string,number>(),requested=new Map<string,number>(),returned=new Map<string,number>();
 const sourceById=new Map(selectedSources.map(source=>[source.id,source]));let errors=0;
 store.saveDiscoveryPlan(id,plan);
 const collect=async(source:DiscoverySource,wanted:number,extra=false)=>{
  let added=0,rounds=0;
  while(added<wanted&&!exhausted.has(source.id)&&selected.size<limit&&!signal?.aborted&&rounds++<100){
   const cursor=cursors.get(source.id)??0,request=Math.max(1,wanted-added);store.registerDiscoverySource(source);requested.set(source.id,(requested.get(source.id)??0)+request);
   try{
    store.updateDiscoveryPhase(id,"querying-sources",`Querying ${source.label}`);store.recordDiscoveryEvent(id,{phase:"querying-sources",type:"source-query",sourceId:source.id,cursor,message:`Requested up to ${request} candidates from ${source.label}`});
    const batch=await bounded(timeoutMs,signal,active=>source.discover(signaledContext(context,active),cursor,request));returned.set(source.id,(returned.get(source.id)??0)+batch.candidates.length);let eligible=0;
    for(const candidate of batch.candidates){
     if(candidate.benchmarkId&&!store.benchmarkBoardNeedsCheck(candidate.benchmarkId)&&mode!=="refresh-known")continue;const disposition=store.candidateDisposition(candidate,mode);if(disposition==="skipped-recent"){skippedRecent.set(source.id,(skippedRecent.get(source.id)??0)+1);continue;}eligible++;
     const key=candidate.boardUrl&&!candidate.jobs?'board:'+canonicalizeUrl(candidate.boardUrl):candidateId(candidate),prior=selected.get(key);
     if(prior){prior.contributingSources=[...new Set([...(prior.contributingSources??[prior.sourceId]),candidate.sourceId])];duplicates.set(source.id,(duplicates.get(source.id)??0)+1);continue;}
     if(selected.size<limit&&added<wanted){candidate.contributingSources=[candidate.sourceId];selected.set(key,candidate);added++;accepted.set(source.id,(accepted.get(source.id)??0)+1);const target=disposition==="fresh"?fresh:disposition==="recheck"?recheck:disposition==="continuation"?continuation:forcedRefresh;target.set(source.id,(target.get(source.id)??0)+1);if(extra)reassigned.set(source.id,(reassigned.get(source.id)??0)+1);}
    }
    cursors.set(source.id,batch.nextCursor);store.updateDiscoverySource(source.id,batch.nextCursor,batch.total,batch.candidates.length);
    if(!batch.candidates.length||batch.nextCursor===cursor||(batch.total!==undefined&&batch.nextCursor>=batch.total)||(!eligible&&rounds>4&&(mode==="balanced"||mode==="turbo")))exhausted.add(source.id);
   }catch(error){errors++;const failure=classifyError(error);store.updateDiscoverySource(source.id,cursor,undefined,0,failure.message);exhausted.add(source.id);progress('['+source.id+'] '+failure.message);}
  }
  if(exhausted.has(source.id)&&!exhaustionTraced.has(source.id)){exhaustionTraced.add(source.id);store.recordDiscoveryEvent(id,{phase:"querying-sources",type:"selected-source-exhausted",sourceId:source.id,message:`${source.label} exhausted: ${returned.get(source.id)??0} returned, ${skippedRecent.get(source.id)??0} recently skipped, ${duplicates.get(source.id)??0} duplicates merged, ${accepted.get(source.id)??0} queued`,metadata:{planned:planned.get(source.id)??0,returned:returned.get(source.id)??0,skippedRecent:skippedRecent.get(source.id)??0,duplicates:duplicates.get(source.id)??0,queued:accepted.get(source.id)??0}});}
  store.updateDiscoveryPlanSource(id,source.id,{queued:accepted.get(source.id)??0,duplicates:duplicates.get(source.id)??0,reassigned:reassigned.get(source.id)??0,exhausted:exhausted.has(source.id),fresh:fresh.get(source.id)??0,recheck:recheck.get(source.id)??0,continuation:continuation.get(source.id)??0,forcedRefresh:forcedRefresh.get(source.id)??0,skippedRecent:skippedRecent.get(source.id)??0,cursor:cursors.get(source.id),requested:requested.get(source.id)??0,returned:returned.get(source.id)??0});return added;
 };
 const initial=plan.sources.filter(row=>row.planned>0);if(turbo)await Promise.all(initial.map(row=>{const source=sourceById.get(row.id);return source?collect(source,row.planned):Promise.resolve(0)}));else for(const row of initial){const source=sourceById.get(row.id);if(source)await collect(source,row.planned);}
 const refill=async(eligible:(source:DiscoverySource)=>boolean)=>{while(selected.size<limit){const deprioritized=new Set(plan.sources.filter(row=>row.deprioritized).map(row=>row.id)),available=selectedSources.filter(source=>eligible(source)&&!exhausted.has(source.id)&&!deprioritized.has(source.id));if(!available.length)break;const remaining=limit-selected.size,weights=available.map(source=>Math.max(1,planned.get(source.id)??planById.get(source.id)?.turboScore??1)),shares=largestRemainderCounts(remaining,weights);let added=0;for(let index=0;index<available.length&&selected.size<limit;index++)added+=await collect(available[index],Math.max(1,shares[index]),true);if(!added)break;}};
 await refill(source=>!turbo||planById.get(source.id)?.tier==="primary");
 if(turbo)for(const row of plan.sources.filter(row=>row.tier==="fallback")){if(selected.size>=limit)break;const source=sourceById.get(row.id);if(source)await collect(source,limit-selected.size,true);}
 const ranked=[...selected.values()].sort((a,b)=>store.candidateLastChecked(a).localeCompare(store.candidateLastChecked(b)));
 store.enqueueDiscoveryCandidates(id,ranked.map(candidate=>({id:candidateId(candidate),candidate})));
 for(const source of sources)store.updateDiscoveryPlanSource(id,source.id,{queued:accepted.get(source.id)??0,duplicates:duplicates.get(source.id)??0,reassigned:reassigned.get(source.id)??0,exhausted:exhausted.has(source.id),fresh:fresh.get(source.id)??0,recheck:recheck.get(source.id)??0,continuation:continuation.get(source.id)??0,forcedRefresh:forcedRefresh.get(source.id)??0,skippedRecent:skippedRecent.get(source.id)??0,cursor:cursors.get(source.id),requested:requested.get(source.id)??0,returned:returned.get(source.id)??0});
 store.updateDiscoveryComposition(id,{queued:ranked.length,fresh:[...fresh.values()].reduce((a,b)=>a+b,0),recheck:[...recheck.values()].reduce((a,b)=>a+b,0),continuation:[...continuation.values()].reduce((a,b)=>a+b,0),forcedRefresh:[...forcedRefresh.values()].reduce((a,b)=>a+b,0),skippedRecent:[...skippedRecent.values()].reduce((a,b)=>a+b,0)});
 const selectedRows=plan.sources.filter(row=>row.planned>0),shortfall=selectedRows.map(row=>({sourceId:row.id,label:row.label,category:row.category,planned:row.planned,returned:returned.get(row.id)??0,skippedRecent:skippedRecent.get(row.id)??0,duplicates:duplicates.get(row.id)??0,queued:accepted.get(row.id)??0,unfilled:Math.max(0,row.planned-(accepted.get(row.id)??0))})),returnedTotal=[...returned.values()].reduce((a,b)=>a+b,0),duplicateTotal=[...duplicates.values()].reduce((a,b)=>a+b,0),unfilled=Math.max(0,limit-ranked.length);
 store.updateDiscoverySelectionSummary(id,{returned:returnedTotal,duplicates:duplicateTotal,unfilled,shortfall});
 if(unfilled>0)store.recordDiscoveryEvent(id,{phase:"querying-sources",type:turbo?"turbo-selection-underfilled":"strict-selection-underfilled",message:`${turbo?"Turbo":"Strict source"} selection queued ${ranked.length} of ${limit} requested; ${unfilled} slots remain unfilled`,metadata:{requested:limit,returned:returnedTotal,queued:ranked.length,unfilled,shortfall}});
 progress(`${turbo?"Turbo":"Strict source"} selection queued ${ranked.length} of ${limit} requested with ${duplicateTotal} duplicates merged and ${unfilled} unfilled slots.`);return errors;
}

export async function discover(
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const store = options.store ?? new Store(),
    owned = !options.store,
    progress = options.onProgress ?? (() => {});
  const adaptive=options.durationMinutes!==undefined||options.timeBudgetMs!==undefined,durationMinutes=adaptive?validateDiscoveryDuration(options.durationMinutes??10):undefined,timeBudgetMs=options.timeBudgetMs??(durationMinutes??10)*60_000;
  const limit = adaptive?5000:Math.min(Math.max(options.limit ?? 100, 1), 5000),
    timeoutMs = options.candidateTimeoutMs ?? 25_000;
  store.recoverStaleDiscoveryRuns();
  const prior = options.resume
    ? store.incompleteDiscoveryRun(options.source)
    : null;
  const mode:DiscoveryRunMode=adaptive?"adaptive":prior?validateDiscoveryMode(prior.row.mode):validateDiscoveryMode(options.mode),concurrency = adaptive?6:prior ? Math.min(Math.max(Number(prior.row.worker_count??4),1),8) : mode==="turbo"?8:validateDiscoveryWorkers(options.concurrency);
  const configuredSources=options.sources??(mode==="refresh-known"?refreshKnownSources(store):options.source?getDiscoverySources(options.source):prioritySources(store,getDiscoverySources()));
  const requestedPlan=!adaptive&&!options.sources&&!options.source?(mode==="turbo"?buildTurboDiscoveryPlan(limit,configuredSources,store):buildDiscoveryPlan(limit,configuredSources,mode==="refresh-known"?{linkedin:0,jobspy:0,priority:limit,native:0,directories:0}:options.allocations,store,mode==="balanced"||mode==="fresh")):undefined;
  const id = prior?.id ?? options.runId ?? randomUUID(),
    scanId = `discovery-${id}`,
    started = Date.now();
  if (!prior) {
    if(!options.claimedRun){const claimed=adaptive?store.claimTimedDiscoveryRun(id,timeBudgetMs):store.claimDiscoveryRun(id,options.source,limit,requestedPlan,mode,concurrency);if(!claimed.claimed)throw Object.assign(new Error("A discovery run is already active"),{statusCode:409,activeRun:claimed.activeRun});}
    else if(requestedPlan)store.saveDiscoveryPlan(id,requestedPlan);
    store.startRun(scanId, "discovery");
    if(requestedPlan){
      try{const forecast=store.discoveryForecast(limit,requestedPlan.allocations,mode,requestedPlan.sources.map(row=>({sourceId:row.id,label:row.label,category:row.category,planned:row.planned})));store.saveDiscoveryForecast(id,{limit,mode,allocations:requestedPlan.allocations,sources:requestedPlan.sources.map(row=>({id:row.id,planned:row.planned}))},forecast);}
      catch(error){store.recordDiscoveryEvent(id,{phase:"planning",type:"forecast-snapshot-failed",level:"error",message:error instanceof Error?error.message:String(error)});}
    }
  } else if(!options.claimedRun)store.resumeDiscoveryRun(id);
  store.recordDiscoveryEvent(id,{phase:"planning",type:prior?"run-resumed":"run-started",message:prior?`Resumed ${mode} discovery with its persisted queue`:adaptive?`Started adaptive discovery for ${durationMinutes} minutes`:`Started ${mode} discovery with a budget of ${limit}`});
  if(adaptive)store.recordDiscoveryEvent(id,{phase:"planning",type:"adaptive-sources-configured",message:`Configured ${configuredSources.length} sources, including ${configuredSources.filter(source=>source.id==='linkedin-guest'||source.id.startsWith('jobspy-')).map(source=>source.label).join(', ')||'no targeted job feeds'}`,metadata:{sourceIds:configuredSources.map(source=>source.id),targetedSourceIds:configuredSources.filter(source=>source.id==='linkedin-guest'||source.id.startsWith('jobspy-')).map(source=>source.id)}});
  const traceContext=new AsyncLocalStorage<{sourceId?:string;candidateId?:string;workerId?:string;phase:string}>();
  const context =
    options.context ??
    createHttpContext({
      cacheDir: resolve(dataDir, "cache/discovery"),
      cacheTtlMs: 30 * 60_000,
      timeoutMs: Math.min(10_000,timeoutMs),
      retries: 1,
      onEvent:event=>{try{const active=traceContext.getStore();store.recordDiscoveryEvent(id,{phase:active?.phase??"http",type:`http-${event.type}`,level:event.type==="error"?"error":"info",message:event.message??`${event.type} ${event.status??""}`.trim(),sourceId:active?.sourceId,candidateId:active?.candidateId,workerId:active?.workerId,url:event.url,attempt:event.attempt,httpStatus:event.status,durationMs:event.durationMs,metadata:event.retryAfterMs?{retryAfterMs:event.retryAfterMs}:undefined});}catch{/* Telemetry must never make a public-source request fail. */}},
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
  const heartbeat = setInterval(() => {
    store.db
      .prepare(
        "UPDATE discovery_runs SET heartbeat_at=? WHERE id=? AND status='running'",
      )
      .run(new Date().toISOString(), id);
  }, 5000);
  const deadlineAt=adaptive?started+timeBudgetMs:Number.POSITIVE_INFINITY,drainDeadlineAt=adaptive?deadlineAt+30_000:Number.POSITIVE_INFINITY;
  const adaptiveCursors=new Map(configuredSources.map(source=>[source.id,source.id==='known-netherlands'?0:store.discoveryCursor(source.id)])),adaptivePullCounts=new Map<string,number>(),adaptiveExhausted=new Set<string>(),adaptiveArmsBySource=new Map<string,DiscoverySourceArm[]>(),adaptivePulledArms=new Set<string>();
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
      else if(!adaptive)
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
          mode,
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
    if(adaptive)for(const source of configuredSources)if(source.listArms)adaptiveArmsBySource.set(source.id,await source.listArms());
    const employerIds = new Set<string>(),
      circuit = new Map<string, number>(),providerCircuit=new Map<string,number>(),reportedProviderCircuits=new Set<string>();
    counts.errors += sourceErrors;
    const pullAdaptive=async():Promise<Array<{ordinal:number;candidateId:string;candidate:DiscoveryCandidate}>>=>{
      if(!adaptive||Date.now()>=deadlineAt||adaptiveExhausted.size>=configuredSources.length)return [];
      const ranking=store.adaptiveArmRanking(configuredSources.map(source=>({id:source.id,label:source.label}))),rankBySource=new Map(ranking.map((row:any)=>[row.sourceId,row])),armChoice=new Map<string,{arm:DiscoverySourceArm;rank:any}>(),now=Date.now();
      for(const source of configuredSources){if(adaptiveExhausted.has(source.id))continue;const arms=adaptiveArmsBySource.get(source.id);if(!arms?.length)continue;const ranked=store.adaptiveSearchArmRanking(source.id,arms),available=ranked.filter((row:any)=>!adaptivePulledArms.has(row.armId)&&(!row.lastAt||now-Date.parse(row.lastAt)>=30*60_000));if(available[0]){const arm=arms.find(value=>value.id===available[0].armId);if(arm)armChoice.set(source.id,{arm,rank:available[0]});}else{adaptiveExhausted.add(source.id);const cooling=ranked.some((row:any)=>!adaptivePulledArms.has(row.armId)&&row.lastAt&&now-Date.parse(row.lastAt)<30*60_000);store.recordDiscoveryEvent(id,{phase:"querying-sources",type:"adaptive-source-exhausted",sourceId:source.id,message:cooling?`${source.label}: all remaining searches are cooling down`:`${source.label}: all search arms were queried`,metadata:{reason:cooling?'cooling-down':'all-arms-queried',armCount:arms.length}});}}
      const source=[...configuredSources].filter(row=>!adaptiveExhausted.has(row.id)).sort((a,b)=>{
        const minimumPulls=(source:DiscoverySource)=>source.id==='linkedin-guest'||source.id.startsWith('jobspy-')?3:0,aPulls=adaptivePullCounts.get(a.id)??0,bPulls=adaptivePullCounts.get(b.id)??0,aUnderMinimum=aPulls<minimumPulls(a),bUnderMinimum=bPulls<minimumPulls(b);
        if(aUnderMinimum!==bUnderMinimum)return aUnderMinimum?-1:1;
        if(aUnderMinimum&&bUnderMinimum&&aPulls!==bPulls)return aPulls-bPulls;
        const ar:any=armChoice.get(a.id)?.rank??rankBySource.get(a.id),br:any=armChoice.get(b.id)?.rank??rankBySource.get(b.id),as=(Number(ar?.score??0)+.001)/(1+(adaptivePullCounts.get(a.id)??0)),bs=(Number(br?.score??0)+.001)/(1+(adaptivePullCounts.get(b.id)??0));return bs-as||a.id.localeCompare(b.id);
      })[0];
      if(!source)return [];
      const cursor=adaptiveCursors.get(source.id)??0,request=source.id==='linkedin-guest'?25:source.id.startsWith('jobspy-')?20:10,pullStarted=Date.now(),startedAt=new Date().toISOString(),choice=armChoice.get(source.id),selectionRank=choice?.rank??rankBySource.get(source.id);store.registerDiscoverySource(source);adaptivePullCounts.set(source.id,(adaptivePullCounts.get(source.id)??0)+1);
      try{
        store.updateDiscoveryPhase(id,"querying-sources",`Adaptive pull from ${choice?.arm.label??source.label}`);store.recordDiscoveryEvent(id,{phase:"querying-sources",type:"adaptive-source-selected",sourceId:source.id,cursor,message:`Selected ${choice?.arm.label??source.label} using measured v2 efficiency and exploration confidence`,metadata:{priorityScore:selectionRank?.score??0,expectedRewardPerMinute:selectionRank?.expectedRewardPerMinute??0,duplicatePenalty:selectionRank?.duplicates??0,evidence:selectionRank?.evidence??'sparse',searchArm:choice?.arm.metadata}});
        const batch=await bounded(Math.min(timeoutMs,Math.max(1000,deadlineAt-Date.now())),controller.signal,active=>choice&&source.discoverArm?source.discoverArm(signaledContext(context,active),choice.arm,request):source.discover(signaledContext(context,active),cursor,request));
        const pullArm=batch.arm??choice?.arm;if(pullArm)adaptivePulledArms.add(pullArm.id);
        adaptiveCursors.set(source.id,batch.nextCursor);store.updateDiscoverySource(source.id,batch.nextCursor,batch.total,batch.candidates.length);
        if(!adaptiveArmsBySource.has(source.id)&&(!batch.candidates.length||batch.nextCursor===cursor||(batch.total!==undefined&&batch.nextCursor>=batch.total)))adaptiveExhausted.add(source.id);
        const eligible=batch.candidates.filter(candidate=>!candidate.boardUrl||store.candidateDisposition(candidate,"balanced")!=="skipped-recent"),priorIds=new Set(store.discoveryQueue(id,["pending","completed","expired"]).map(item=>item.candidateId));
        const enqueue=store.enqueueDiscoveryCandidates(id,eligible.map(candidate=>({id:candidateId(candidate),candidate:{...candidate,contributingSources:[candidate.sourceId]}})));
        const all=store.discoveryQueue(id),added=all.filter(item=>!priorIds.has(item.candidateId));
        store.db.prepare("UPDATE discovery_runs SET queued_count=? WHERE id=?").run(counts.processed+all.length,id);
        store.recordDiscoveryPull({runId:id,armId:pullArm?.id??`source:${source.id}`,sourceId:source.id,label:pullArm?.label??source.label,startedAt,durationMs:Date.now()-pullStarted,cursor,requested:request,returned:batch.candidates.length,eligible:eligible.length,duplicates:enqueue.duplicates,metadata:{priorityScore:selectionRank?.score??0,expectedRewardPerMinute:selectionRank?.expectedRewardPerMinute??0,queuedUnique:enqueue.queued,exhaustedReason:batch.exhaustedReason,searchArm:pullArm?.metadata}});
        return added;
      }catch(error){const failure=classifyError(error);sourceErrors++;if(choice)adaptivePulledArms.add(choice.arm.id);else adaptiveExhausted.add(source.id);store.updateDiscoverySource(source.id,cursor,undefined,0,failure.message);store.recordDiscoveryPull({runId:id,armId:choice?.arm.id??`source:${source.id}`,sourceId:source.id,label:choice?.arm.label??source.label,startedAt,durationMs:Date.now()-pullStarted,cursor,requested:request,returned:0,eligible:0,failures:1,metadata:{searchArm:choice?.arm.metadata}});store.recordDiscoveryEvent(id,{phase:"querying-sources",type:"adaptive-source-failed",sourceId:source.id,level:"error",message:`${choice?.arm.label??source.label}: ${failure.message}`});return [];}
    };
    if(adaptive)await pullAdaptive();
    const queue = store.discoveryQueue(id);
    store.db.prepare("UPDATE discovery_runs SET queued_count=MAX(queued_count,?) WHERE id=?").run(counts.processed+queue.length,id);
    store.updateDiscoveryPhase(id,"processing",`Processing ${queue.length} queued candidates with ${concurrency} workers`);
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
    const waiting=[...queue],active=new Set<Promise<any>>(),hostUse=new Map<string,number>(),providerUse=new Map<string,number>(),availableSlots=Array.from({length:adaptive?8:concurrency},(_,index)=>index+1),providerRecentFailures=new Map<string,boolean[]>(),adaptiveProviderLimits=new Map<string,number>();let currentConcurrency=concurrency;
    const baseProviderLimit=(provider:string)=>provider==="workday"||provider==="ashby"?2:currentConcurrency;
    const providerLimit=(provider:string)=>adaptive?adaptiveProviderLimits.get(provider)??baseProviderLimit(provider):baseProviderLimit(provider);
    const executeCandidate=(item:typeof queue[number],workerId:string):Promise<any>=>{
          const { candidateId: idValue } = item,
            startedAt = new Date().toISOString(),
            attemptStarted = Date.now(),
            key = destinationHost(item.candidate);
          const candidate = item.candidate;
          store.startDiscoveryTask(id,idValue,workerId,candidate,"resolving-board","Resolving candidate and ATS provider");
          store.recordDiscoveryEvent(id,{phase:"processing",type:"candidate-started",sourceId:candidate.sourceId,candidateId:idValue,workerId,url:candidate.boardUrl,message:`${workerId} started ${candidate.company} via ${candidate.provider??"embedded feed"}`});
          return traceContext.run({phase:"processing",sourceId:candidate.sourceId,candidateId:idValue,workerId},async()=>{try{
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
            refreshedJobs = 0,
            collectionDurationMs = 0;
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
                store.updateDiscoveryTask(id,idValue,"fetching-vacancies",{detail:`Fetching vacancies from ${candidate.provider??"embedded feed"}`});
                const collectionStarted=Date.now();try{collection = await fetchCandidate(candidate, activeContext, store, signal, timeoutMs);}finally{collectionDurationMs=Date.now()-collectionStarted;}
                return collection.jobs;
              })();
            store.updateDiscoveryTask(id,idValue,"evaluating",{detail:`Evaluating ${jobs.length} fetched vacancies`});
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
            collectionDurationMs,
            candidate: normalizedCandidate,
          };
          store.updateDiscoveryTask(id,idValue,"saving-results",{detail:`Saving ${jobs.length} vacancies and ${matches} matches`});
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
              const needsEnrichment=(job.description?.trim().length??0)<160;
              const processed=processJob(job,{store,profile,sourceId:candidate.sourceId,provider:candidate.provider??'browser',scanId,discoveryRunId:id,candidateId:idValue,boardUrl:candidate.boardUrl,candidate:normalizedCandidate,employerId,enrichmentStatus:needsEnrichment?'pending':'not-needed'});
              const netherlands=isNetherlandsJob(processed.job,profile);
              if(netherlands){store.observeVacancy(employerId,candidate.sourceId,processed.job,fingerprint(processed.job),processed.decision.retain);if(adaptive)store.recordDiscoveryOutcome(id,processed.id,normalizedCandidate,processed.job.postedAt,{isNew:processed.write==='new',matchState:processed.decision.matchState});}
              if(netherlands&&processed.decision.retain){matches++;processed.write==='new'?newJobs++:refreshedJobs++;if(needsEnrichment){counts.descriptionCandidates++;counts.deferredEnrichments++;}if(processed.decision.evidence?.matchedFrom==='description')counts.descriptionMatches++;}
              else counts.nonmatching++;
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
            {const provider=schedulingProvider(candidate);circuit.set(key, (circuit.get(key) ?? 0) + 1);providerCircuit.set(provider,(providerCircuit.get(provider)??0)+1);}
          else {circuit.set(key, 0);providerCircuit.set(schedulingProvider(candidate),0);}
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
          store.recordDiscoveryEvent(id,{phase:"processing",type:"candidate-completed",level:errorMessage?"error":"info",sourceId:candidate.sourceId,candidateId:idValue,workerId,url:candidate.boardUrl,durationMs:attempt.durationMs,httpStatus:status,message:`${actualCompany}: ${result}; ${jobs.length} fetched, ${matches} matches`,metadata:{provider:candidate.provider,netherlandsJobs:nlJobs.length,newJobs,refreshedJobs,error:errorMessage}});
          return outcome;
          }finally{store.finishDiscoveryTask(id,idValue);}});
    };
    const circuitAllows=(item:{candidate:DiscoveryCandidate})=>{
      const key=destinationHost(item.candidate),provider=schedulingProvider(item.candidate);
      return (circuit.get(key)??0)<5&&(providerCircuit.get(provider)??0)<5;
    };
    while((active.size||(!adaptive&&waiting.length)||(adaptive&&Date.now()<deadlineAt&&(waiting.length||adaptiveExhausted.size<configuredSources.length)))&&!controller.signal.aborted){
      const launchableWaiting=waiting.filter(circuitAllows).length;
      if(adaptive&&Date.now()<deadlineAt&&launchableWaiting<currentConcurrency*2&&adaptiveExhausted.size<configuredSources.length){const added=await pullAdaptive();const known=new Set(waiting.map(item=>item.candidateId));for(const item of added)if(!known.has(item.candidateId))waiting.push(item);}
      let launched=false;
      if(adaptive){const candidateScores=new Map(waiting.map(item=>[item.candidateId,store.adaptiveCandidateScore(item.candidate)]));waiting.sort((a,b)=>(candidateScores.get(b.candidateId)??0)-(candidateScores.get(a.candidateId)??0)||a.ordinal-b.ordinal);}
      while(active.size<currentConcurrency&&availableSlots.length&&(!adaptive||Date.now()<deadlineAt)){
        const index=waiting.findIndex(item=>{const key=destinationHost(item.candidate),provider=schedulingProvider(item.candidate);return (circuit.get(key)??0)<5&&(providerCircuit.get(provider)??0)<5&&(hostUse.get(key)??0)<hostLimit(item.candidate)&&(providerUse.get(provider)??0)<providerLimit(provider);});
        if(index<0)break;
        const [item]=waiting.splice(index,1),key=destinationHost(item.candidate),provider=schedulingProvider(item.candidate),slot=availableSlots.shift()!,promise=executeCandidate(item,`worker-${slot}`);
        hostUse.set(key,(hostUse.get(key)??0)+1);providerUse.set(provider,(providerUse.get(provider)??0)+1);active.add(promise);launched=true;
        const release=(outcome?:any)=>{hostUse.set(key,Math.max(0,(hostUse.get(key)??1)-1));providerUse.set(provider,Math.max(0,(providerUse.get(provider)??1)-1));active.delete(promise);availableSlots.push(slot);if(adaptive&&outcome){const recent=providerRecentFailures.get(provider)??[];recent.push(operationalFailures.has(outcome.result));if(recent.length>20)recent.shift();providerRecentFailures.set(provider,recent);const rate=recent.filter(Boolean).length/recent.length,priorLimit=providerLimit(provider),maximum=baseProviderLimit(provider),nextLimit=rate>.2?Math.max(1,priorLimit-1):recent.length>=5&&rate<.1?Math.min(maximum,priorLimit+1):priorLimit;if(nextLimit!==priorLimit){adaptiveProviderLimits.set(provider,nextLimit);store.recordDiscoveryEvent(id,{phase:"processing",type:"provider-concurrency-adjusted",level:nextLimit<priorLimit?"error":"info",message:`${provider} concurrency ${nextLimit<priorLimit?'reduced':'increased'} from ${priorLimit} to ${nextLimit}`,metadata:{provider,priorLimit,nextLimit,recentFailureRate:rate,sampleSize:recent.length}});}store.db.prepare("UPDATE discovery_runs SET current_concurrency=?,worker_count=? WHERE id=?").run(currentConcurrency,currentConcurrency,id);}};
        void promise.then(release,()=>release());
      }
      if(active.size){if(adaptive&&Date.now()>=drainDeadlineAt){controller.abort(new Error("Discovery drain deadline reached"));break;}await Promise.race(active);}
      else if(!launched){
        for(const [provider,failures] of providerCircuit)if(failures>=5&&!reportedProviderCircuits.has(provider)){
          reportedProviderCircuits.add(provider);
          store.recordDiscoveryEvent(id,{phase:"processing",type:"provider-circuit-open",level:"error",message:`${provider} paused after ${failures} consecutive transient failures`,metadata:{provider,failures,pending:waiting.filter(item=>schedulingProvider(item.candidate)===provider).length}});
        }
        if(adaptive&&Date.now()<deadlineAt&&adaptiveExhausted.size<configuredSources.length){
          // A provider circuit can leave queued candidates temporarily
          // unlaunchable. Yield before selecting another source so the API,
          // heartbeat, cancellation, and dashboard polling stay responsive.
          await new Promise<void>(resolve=>setTimeout(resolve,25));
          continue;
        }
        break;
      }
    }
    if(active.size)await Promise.all(active);
    if(adaptive)store.db.prepare("UPDATE discovery_queue SET status='expired',updated_at=? WHERE run_id=? AND status='pending'").run(new Date().toISOString(),id);
    store.updateDiscoveryPhase(id,"finalizing","Finalizing counters and persisted run history");
    const pending = store.pendingDiscoveryCount(id),selection=store.db.prepare("SELECT limit_count,queued_count,unfilled_count,selection_policy FROM discovery_runs WHERE id=?").get(id) as any,
      durationMs = Date.now() - started,
      interrupted = controller.signal.aborted;
    const status = interrupted
      ? "interrupted"
      : pending
        ? "partial"
        : counts.errors || counts.partialCollections
          ? "partial"
          : "completed";
    const adaptiveSummary=adaptive?store.db.prepare("SELECT new_strong_count,useful_match_count,weighted_reward FROM discovery_runs WHERE id=?").get(id) as any:undefined;
    store.recordDiscoveryEvent(id,{phase:"finalizing",type:"run-finished",level:counts.errors?"error":"info",message:adaptive?`Adaptive discovery ${status}: ${(durationMs/60_000).toFixed(1)} minutes · ${adaptiveSummary?.new_strong_count??0} new strong · ${adaptiveSummary?.useful_match_count??0} reward-eligible · ${Number(adaptiveSummary?.weighted_reward??0).toFixed(1)} weighted reward · ${counts.errors} errors`:`Discovery ${status}: ${counts.processed} processed of ${selection?.queued_count??counts.processed} queued (${selection?.limit_count??limit} requested), ${selection?.unfilled_count??0} unfilled, ${pending} pending, ${counts.newJobs} new jobs, ${counts.errors} errors`,durationMs,metadata:adaptive?{selectionPolicy:selection?.selection_policy,durationMinutes,queued:selection?.queued_count??counts.processed,newStrong:adaptiveSummary?.new_strong_count??0,rewardEligible:adaptiveSummary?.useful_match_count??0,weightedReward:adaptiveSummary?.weighted_reward??0}:{selectionPolicy:selection?.selection_policy,requested:selection?.limit_count??limit,queued:selection?.queued_count??counts.processed,unfilled:selection?.unfilled_count??0}});
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
  } catch(error) {
    const message=(error instanceof Error?error.message:String(error)).replace(/[\r\n\t]+/g,' ').slice(0,500);
    try{
      store.failDiscoveryRun(id,message);
      store.recordDiscoveryEvent(id,{phase:'failed',type:'run-failed',level:'error',message});
      store.finishRun(scanId,'failed');
    }catch{/* Preserve the original discovery failure. */}
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (options.handleSignals) process.removeListener("SIGINT", abort);
    options.signal?.removeEventListener("abort", abort);
    if (owned) store.close();
  }
}
