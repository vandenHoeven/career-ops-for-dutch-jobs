import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {Store} from './database.js';
import {dataDir,loadProfile} from './config.js';
import {createHttpContext} from './http.js';
import {enrichJob,withEnrichmentSource} from './enrichment.js';
import {processJob} from './processing.js';
import {createEnrichmentLimiter} from './enrichment-limiter.js';
import type {RawJob,FetchContext,ProviderId} from './types.js';
function raw(row:any):RawJob{const payload=JSON.parse(row.raw_json??'{}');return {countryCode:payload._diegoCountryCode??payload.countryCode,structuredRoleTerms:payload._diegoStructuredRoleTerms,workArrangement:row.work_arrangement,externalId:row.external_id??undefined,company:row.company,title:row.title,location:row.location,description:row.description??undefined,summary:row.summary??undefined,url:row.canonical_url,applyUrl:row.apply_url??undefined,postedAt:row.posted_at??undefined,firstObservedAt:row.provider_first_observed_at??undefined,raw:payload};}
function allRows(store:Store):any[]{const rows:any[]=[];for(let offset=0;;offset+=200){const batch=store.jobs({limit:200,offset,eligibility:'all',matchState:'all'}) as any[];rows.push(...batch);if(batch.length<200)return rows;}}
export async function rescoreJobs(options:{store?:Store;jobId?:string}={}):Promise<{updated:number}>{
 const store=options.store??new Store(),owned=!options.store,profile=await loadProfile();let updated=0;
 try{
  const rows=options.jobId?[store.job(options.jobId)].filter(Boolean):allRows(store);
  for(const row of rows as any[]){const board=store.db.prepare('SELECT board_url FROM source_observations WHERE job_id=? AND board_url IS NOT NULL ORDER BY observed_at DESC LIMIT 1').get(row.id) as any;processJob(raw(row),{store,profile,sourceId:row.source_id,provider:row.provider,existingId:row.id,enrichmentStatus:row.enrichment_status,enrichmentError:row.enrichment_error,candidate:{sourceId:row.source_id,company:row.company,provider:row.provider,boardUrl:board?.board_url}});updated++;}
  if(!options.jobId){
   const run='reevaluate-'+randomUUID();store.startRun(run,'reevaluation');
   try{
    const snapshots=store.db.prepare('SELECT d.* FROM job_decisions d WHERE d.id=(SELECT max(x.id) FROM job_decisions x WHERE x.canonical_url=d.canonical_url) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.canonical_url=d.canonical_url)').all() as any[];
    const seen=new Set<string>();
    for(const row of snapshots){const job=JSON.parse(row.job_json);processJob(job,{store,profile,sourceId:row.source_id,provider:'browser',scanId:run,firstSeenAt:row.observed_at});seen.add(job.url);}
    const observations=store.db.prepare('SELECT v.*,e.canonical_name FROM vacancy_observations v JOIN employers e ON e.id=v.employer_id WHERE NOT EXISTS(SELECT 1 FROM jobs j WHERE j.canonical_url=v.url)').all() as any[];
    for(const row of observations)if(!seen.has(row.url)){
     processJob({company:row.canonical_name,title:row.title,location:row.location,url:row.url,externalId:row.external_id??undefined,raw:{}},{store,profile,sourceId:row.source_id,provider:'browser',scanId:run,firstSeenAt:row.observed_at,candidate:{sourceId:row.source_id,company:row.canonical_name,provider:'browser',jobs:[]},employerId:row.employer_id});seen.add(row.url);
    }
    store.finishRun(run,'completed');
   }catch(error){store.finishRun(run,'partial');throw error;}
  }
  return {updated};
 }finally{if(owned)store.close();}
}
export async function enrichJobs(options:{store?:Store;jobId?:string;missing?:boolean}={}):Promise<{processed:number;enriched:number}>{
 const store=options.store??new Store(),owned=!options.store,profile=await loadProfile(),context=createHttpContext({cacheDir:resolve(dataDir,'cache/enrichment'),cacheTtlMs:86400000});let enriched=0,processed=0;
 try{const rows=(options.jobId?[store.job(options.jobId)].filter(Boolean):allRows(store)).filter((row:any)=>!options.missing||!(row.description?.length>=160)).slice(0,100);
  for(const row of rows as any[]){processed++;const result=await enrichJob(raw(row),context);
   processJob(result.job,{store,profile,sourceId:row.source_id,provider:row.provider,existingId:row.id,enrichmentStatus:result.status,enrichmentError:result.error,candidate:{sourceId:row.source_id,company:row.company,provider:row.provider}});
   store.recordEnrichment(row.id,result.status,row.canonical_url,result.error);if(result.status==='complete')enriched++;
  }return {processed,enriched};
 }finally{if(owned)store.close();}
}
export async function enrichPendingJobs(options:{store?:Store;limit?:number;context?:FetchContext}={}):Promise<{processed:number;stored:number;skipped:number;failed:number}>{
 const store=options.store??new Store(),owned=!options.store,profile=await loadProfile(),context=options.context??createHttpContext({cacheDir:resolve(dataDir,'cache/enrichment'),cacheTtlMs:86400000}),rows=store.pendingEnrichments(Math.min(options.limit??100,100)),run='enrichment-'+randomUUID(),limiter=createEnrichmentLimiter(),signal=new AbortController().signal;
 let stored=0,skipped=0,failed=0;store.startRun(run,'enrichment');
 try{
  for(let offset=0;offset<rows.length;offset+=2)await Promise.all(rows.slice(offset,offset+2).map(async row=>{
   try{const job=JSON.parse(row.job_json) as RawJob,candidate=JSON.parse(row.candidate_json),result=await limiter(job.url,signal,()=>enrichJob(withEnrichmentSource(job,candidate),context));
    const prior=store.db.prepare('SELECT id FROM jobs WHERE canonical_url=?').get(job.url) as any;
    const processed=processJob(result.job,{store,profile,sourceId:candidate.sourceId,provider:candidate.provider??'browser',scanId:run,existingId:prior?.id,discoveryRunId:row.discovery_run_id,boardUrl:candidate.boardUrl,candidate,employerId:row.employer_id,enrichmentStatus:result.status,enrichmentError:result.error});
    if(processed.id)store.recordEnrichment(processed.id,result.status,job.url,result.error);
    if(result.status==='failed'||result.status==='unavailable'){store.finishQueuedEnrichment(row.id,'failed',result.error,result.retryAfterMs);failed++;}
    else {store.finishQueuedEnrichment(row.id,processed.decision.retain?'complete':'skipped');processed.decision.retain?stored++:skipped++;}
   }catch(error){failed++;store.finishQueuedEnrichment(row.id,'failed',error instanceof Error?error.message:String(error));}
  }));
  store.finishRun(run,failed?'partial':'completed');return {processed:rows.length,stored,skipped,failed};
 }finally{if(owned)store.close();}
}
