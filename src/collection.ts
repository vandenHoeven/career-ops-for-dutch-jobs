import { createHash } from 'node:crypto';
import { HttpError } from './http.js';
import { Store } from './database.js';
import { resolveProvider } from './providers.js';
import type { CollectionResult, DiscoveryCandidate, FetchContext, SourceConfig } from './types.js';

const hosts=new Map<string,number>(),waiters=new Set<()=>void>();
async function acquire(host:string,limit:number,signal:AbortSignal):Promise<()=>void>{
  while((hosts.get(host)??0)>=limit){
    await new Promise<void>((resolve,reject)=>{const cleanup=()=>{waiters.delete(wake);signal.removeEventListener('abort',abort);};const wake=()=>{cleanup();resolve();};const abort=()=>{cleanup();reject(signal.reason);};if(signal.aborted){reject(signal.reason);return;}waiters.add(wake);signal.addEventListener('abort',abort,{once:true});});
  }
  signal.throwIfAborted();hosts.set(host,(hosts.get(host)??0)+1);
  return ()=>{hosts.set(host,Math.max(0,(hosts.get(host)??1)-1));for(const wake of [...waiters])wake();};
}

export async function collectSource(store:Store,source:SourceConfig,context:FetchContext,signal?:AbortSignal,candidate?:DiscoveryCandidate,timeoutMs=45_000):Promise<CollectionResult> {
  const prior=store.collection(source.careersUrl), provider=resolveProvider(source);
  const cursor=source.cursor??(prior?.state!=='complete'?prior?.cursor:undefined);
  if(!prior || prior.state==='complete')store.saveCollection(source.careersUrl,source.id,provider.id,{complete:false,count:0,benchmarkId:candidate?.benchmarkId,candidate});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('Collection timeout')),timeoutMs);
  const active=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const wrap=(init?:RequestInit)=>({...init,signal:init?.signal?AbortSignal.any([init.signal,active]):active});
  const request=<T>(task:()=>Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
    const abort=()=>reject(active.reason??new Error('Collection cancelled'));
    if(active.aborted){abort();return;}
    active.addEventListener('abort',abort,{once:true});
    task().then(resolve,reject).finally(()=>active.removeEventListener('abort',abort));
  });
  let result:CollectionResult;
  let release:(()=>void)|undefined;
  try {
    const host=provider.id==='greenhouse'?'boards-api.greenhouse.io':provider.id==='ashby'?'api.ashbyhq.com':provider.id==='lever'?'api.lever.co':new URL(source.apiUrl??source.careersUrl).hostname;
    release=await acquire(host,['ashby','workday'].includes(provider.id)?1:2,active);
    result=await provider.collect({...source,cursor},{fetchJson:(url,init)=>request(()=>context.fetchJson(url,wrap(init))),fetchText:(url,init)=>request(()=>context.fetchText(url,wrap(init)))});
  }
  catch(error) { result={jobs:[],complete:false,nextCursor:cursor,error:error instanceof Error?error.message:String(error),httpStatus:error instanceof HttpError?error.status:undefined,retryable:error instanceof HttpError?error.retryable:true,retryAfterMs:error instanceof HttpError?error.retryAfterMs:undefined}; }
  finally {release?.();clearTimeout(timer);}
  const signature=result.jobs.length?createHash('sha256').update(result.jobs.map(j=>j.url).join('|')).digest('hex'):undefined;
  let samePhase=true;try{samePhase=JSON.parse(cursor??'{}').phase===JSON.parse(result.nextCursor??'{}').phase;}catch{/* Numeric/provider-specific cursors have no phases. */}
  if(signature && prior?.last_signature===signature && cursor && result.nextCursor && samePhase)result={...result,complete:false,nextCursor:cursor,error:'Repeated collection page'};
  if(result.nextCursor===cursor && result.nextCursor && !result.error)result.error='Collection cursor did not advance';
  // Persist the cursor only after callers commit these jobs via checkpointCollection.
  return result;
}
export function checkpointCollection(store:Store,source:SourceConfig,result:CollectionResult,candidate?:DiscoveryCandidate):void {
  store.saveCollection(source.careersUrl,source.id,resolveProvider(source).id,{cursor:result.nextCursor,complete:result.complete,total:result.total,count:result.jobs.length,error:result.error,benchmarkId:candidate?.benchmarkId,candidate});
  if(result.jobs.length)store.db.prepare('UPDATE collection_checkpoints SET last_signature=? WHERE board_url=?').run(createHash('sha256').update(result.jobs.map(j=>j.url).join('|')).digest('hex'),source.careersUrl);
}
