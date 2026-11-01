import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './database.js';
import { createHttpContext } from './http.js';
import { parsePublicPostings } from './posting-parser.js';
import { processJob } from './processing.js';
import { loadProfile } from './config.js';
import { canonicalizeUrl } from './core.js';
import { enrichPendingJobs } from './quality.js';
const activeEnrichment=new WeakSet<Store>();

export function publicUrl(value:unknown):string {
  if(typeof value!=='string')throw new Error('A public vacancy URL is required');
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port)throw new Error('Use a public HTTPS vacancy URL without credentials or custom ports');
  return canonicalizeUrl(url.toString());
}
export async function inspectVacancy(store:Store,url:string):Promise<any>{
  const existing=store.db.prepare('SELECT * FROM jobs WHERE canonical_url=?').get(url) as any;
  if(existing)return {stage:existing.hard_excluded?'excluded':'retained',jobId:existing.id,matchState:existing.match_state,decisions:store.decisions(existing.id),provenance:store.jobTrace(existing.id)};
  const profile=await loadProfile(),context=createHttpContext({timeoutMs:20000,retries:0});
  const html=await context.fetchText(url),jobs=parsePublicPostings(html,url,new URL(url).hostname);
  const same=jobs.filter(j=>canonicalizeUrl(j.url)===url),job=same[0]??(jobs.length===1?jobs[0]:undefined);
  if(!job)return {stage:'unresolved',reason:'No unambiguous public JobPosting could be extracted',observations:store.db.prepare('SELECT source_id,observed_at,match_state,reasons_json,evidence_json FROM job_decisions WHERE canonical_url=? ORDER BY id DESC LIMIT 10').all(url)};
  const run='diagnostic-'+randomUUID();store.startRun(run,'diagnostic');
  try{const result=processJob(job,{store,profile,sourceId:'diagnostic',provider:'browser',scanId:run,candidate:{sourceId:'diagnostic',company:job.company,boardUrl:url,provider:'browser'}});store.finishRun(run,'completed');return {stage:result.decision.retain?'retained':'excluded',jobId:result.id,decision:result.decision};}
  catch(error){store.finishRun(run,'failed');throw error;}
}
export function startDiagnostic(store:Store,url:string):string{
  const id=randomUUID();store.db.prepare("INSERT INTO job_diagnostics(id,url,status,created_at) VALUES(?,?,'running',?)").run(id,url,new Date().toISOString());
  void inspectVacancy(store,url).then(result=>store.db.prepare("UPDATE job_diagnostics SET status='completed',result_json=? WHERE id=?").run(JSON.stringify(result),id)).catch(error=>{try{store.db.prepare("UPDATE job_diagnostics SET status='failed',error=?,result_json=? WHERE id=?").run(error instanceof Error?error.message:String(error),JSON.stringify({stage:'unresolved',reason:'Public vacancy could not be retrieved'}),id);}catch{/* Application shutting down. */}});
  return id;
}
export async function coverageRoutes(req:IncomingMessage,res:ServerResponse,url:URL,store:Store):Promise<boolean>{
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const decisions=url.pathname.match(/^\/api\/v1\/jobs\/([a-f0-9]{24})\/decisions$/);
  if(req.method==='GET'&&decisions){if(!store.job(decisions[1]))send(404,{error:'Job not found'});else send(200,{items:store.decisions(decisions[1])});return true;}
  if(req.method==='POST'&&url.pathname==='/api/v1/diagnostics/job'){
    try{let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)throw new Error('Request too large');}const value=JSON.parse(body),target=publicUrl(value.url),id=startDiagnostic(store,target);send(202,{id,status:'running'});}catch(error){send(400,{error:error instanceof Error?error.message:String(error)});}return true;
  }
  const diagnostic=url.pathname.match(/^\/api\/v1\/diagnostics\/job\/([a-f0-9-]+)$/);
  if(req.method==='GET'&&diagnostic){const row=store.db.prepare('SELECT * FROM job_diagnostics WHERE id=?').get(diagnostic[1]) as any;send(row?200:404,row?{...row,result:row.result_json?JSON.parse(row.result_json):null,result_json:undefined}:{error:'Diagnostic not found'});return true;}
  const retry=url.pathname.match(/^\/api\/v1\/enrichment\/queue\/([a-f0-9]{24})\/retry$/);
  if(req.method==='POST'&&retry){const row=store.db.prepare('SELECT id FROM enrichment_queue WHERE id=?').get(retry[1]);if(!row)send(404,{error:'Enrichment not found'});else{store.retryEnrichment(retry[1]);send(202,{id:retry[1],status:'pending'});}return true;}
  if(req.method==='GET'&&url.pathname==='/api/v1/coverage/trace'){send(200,store.coverageTrace());return true;}
  if(req.method==='GET'&&url.pathname==='/api/v1/enrichment/queue/items'){send(200,{items:store.db.prepare("SELECT id,json_extract(job_json,'$.title') title,status,attempts,last_error,next_retry_at FROM enrichment_queue WHERE status IN ('pending','failed') ORDER BY updated_at DESC LIMIT 50").all()});return true;}
  if(req.method==='POST'&&url.pathname==='/api/v1/enrichment/queue/process'){
    const active=store.db.prepare("SELECT id FROM scan_runs WHERE requested_provider='enrichment' AND status='running' LIMIT 1").get();
    if(active||activeEnrichment.has(store)){send(409,{error:'Description collection is already running'});return true;}
    activeEnrichment.add(store);void enrichPendingJobs({store}).catch(()=>{}).finally(()=>activeEnrichment.delete(store));send(202,{status:'running'});return true;
  }
  return false;
}
