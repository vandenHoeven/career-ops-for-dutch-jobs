import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/database.js';
import { loadProfile } from '../src/config.js';
import { assessLocation } from '../src/locations.js';
import { evaluateJob, stableJobId } from '../src/core.js';
import { processJob } from '../src/processing.js';
import { hardExclusion } from '../src/scoring.js';
import { collectSource, checkpointCollection } from '../src/collection.js';
import { resolveProvider } from '../src/providers.js';
import { buildDiscoveryPlan, buildQueue, buildTurboDiscoveryPlan, defaultDiscoveryAllocations, discover, validateDiscoveryAllocations, validateDiscoveryWorkers } from '../src/discovery.js';
import { scan } from '../src/scanner.js';
import { enrichPendingJobs, rescoreJobs } from '../src/quality.js';
import { enrichJob } from '../src/enrichment.js';
import { HttpError } from '../src/http.js';
import { createApi } from '../src/api.js';
import { createDashboardApi } from '../src/dashboard-api.js';
import { recallCheck } from '../src/recall.js';
import type { RawJob, DiscoveryAttempt, DiscoverySource, FetchContext } from '../src/types.js';

const base:RawJob={title:'Data Scientist',company:'Example',location:'Vught',url:'https://example.test/jobs/1',raw:{}};
const context:FetchContext={fetchJson:async()=>({}),fetchText:async()=>''};
function database(){const dir=mkdtempSync(join(tmpdir(),'diego-recall-')),store=new Store(join(dir,'test.sqlite'));return {store,dir,close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};}

test('recognizes nearby/locality-only postings and respects structured foreign countries',async()=>{
 const profile=await loadProfile();
 for(const location of ['Vught','Oss','Veghel','Rosmalen','Wageningen','Hilversum','Zoetermeer'])assert.equal(evaluateJob({...base,location},profile).matchState,'strong',location);
 assert.equal(assessLocation({...base,countryCode:'DE'},profile).state,'foreign');
 assert.equal(assessLocation({...base,raw:{jobLocation:{address:{addressCountry:{name:'Germany'}}}}},profile).state,'foreign');
 assert.equal(assessLocation({...base,countryCode:'US',workArrangement:'remote',raw:{jobLocationType:'TELECOMMUTE',applicantLocationRequirements:[{'@type':'Country',name:'Netherlands'}]}},profile).state,'netherlands');
 assert.equal(assessLocation({...base,countryCode:'US',workArrangement:'remote',raw:{jobLocationType:'TELECOMMUTE',applicantLocationRequirements:[{name:'Europe'}]}},profile).state,'unknown');
 for(const location of ['','Remote - Europe','Remote']){const result=evaluateJob({...base,location},profile);assert.equal(result.matchState,'possible');assert.ok(result.reasons.includes('unknown_location'));}
 assert.equal(evaluateJob({...base,location:'MI - Zeeland'},profile).retain,false);
 assert.equal(evaluateJob({...base,location:'Las Vegas, NV'},profile).retain,false);
});

test('word and phrase exclusions cannot confuse international/internal with internship',async()=>{
 const profile=await loadProfile();
 for(const title of ['International Data Scientist','Data Scientist - Internal Analytics','Data Scientist in Leadership Analytics'])assert.equal(hardExclusion({...base,title},profile),null,title);
 for(const title of ['Data Scientist Intern','Data Science Internship','Data Science Stage'])assert.match(hardExclusion({...base,title},profile)??'',/Excluded title/);
 assert.equal(hardExclusion({...base,title:'Senior Data Scientist'},{...profile,excludedSeniority:[]}),null);
 assert.match(hardExclusion({...base,title:'Senior Data Scientist'},profile)??'',/seniority/);
});

test('retains title variants but prevents company boilerplate and structured sales metadata from qualifying',async()=>{
 const profile=await loadProfile();
 for(const title of ['Analytics Engineer','AI Software Engineer','Machine Learning Scientist','Quantitative Developer','Optimalisatie Specialist'])assert.equal(evaluateJob({...base,title},profile).retain,true,title);
 const sales=evaluateJob({...base,title:'Enterprise Account Executive',description:'Our company builds artificial intelligence and data analytics using machine learning and SQL.',structuredRoleTerms:['Artificial Intelligence']},profile);
 assert.equal(sales.retain,false);
 const broad=evaluateJob({...base,title:'Researcher',description:'General laboratory research.'},profile);assert.equal(broad.matchState,'possible');
 const intro=evaluateJob({...base,title:'Platform Specialist',description:'Our company builds artificial intelligence and data analytics using machine learning and SQL.'},profile);assert.equal(intro.matchState,'possible');assert.equal(intro.evidence,null);
});

test('one pipeline preserves identities, applications, first-seen and append-only decisions on reevaluation',async()=>{
 const db=database(),profile=await loadProfile();try{
  db.store.startRun('run');const first=processJob(base,{store:db.store,profile,sourceId:'fixture',provider:'browser',scanId:'run'});assert.ok(first.id);
  const row=db.store.job(first.id!) as any;db.store.upsertApplication(first.id!,{stage:'applied',notes:'Keep these notes'});
  processJob({...base,location:''},{store:db.store,profile,sourceId:'fixture',provider:'browser',existingId:first.id});
  const changed=db.store.job(first.id!) as any;assert.equal(changed.match_state,'possible');assert.equal(changed.first_seen_at,row.first_seen_at);assert.equal(changed.last_seen_at,row.last_seen_at);assert.equal(changed.application.notes,'Keep these notes');assert.equal(db.store.decisions(first.id!).length,2);
  processJob({...base,countryCode:'DE'},{store:db.store,profile,sourceId:'fixture',provider:'browser',scanId:'run'});assert.equal((db.store.job(first.id!) as any).match_state,'excluded');assert.equal(db.store.jobCount(),0);
  await rescoreJobs({store:db.store,jobId:first.id});assert.equal((db.store.job(first.id!) as any).match_state,'excluded','structured country survives reevaluation');
  assert.equal(stableJobId('greenhouse',{...base,externalId:'7'})===stableJobId('greenhouse',{...base,company:'Different',externalId:'7'}),false);
 }finally{db.close();}
});

test('Workday continuation retrieves jobs after 200 and partial traversals do not expire jobs',async()=>{
 const db=database(),profile=await loadProfile(),source={id:'workday-board',company:'Example',careersUrl:'https://example.wd3.myworkdayjobs.com/External',provider:'workday' as const};
 const ctx:FetchContext={fetchText:async()=>'',fetchJson:async(_url,init)=>{const {offset}=JSON.parse(String(init?.body));return {total:220,jobPostings:Array.from({length:Math.min(20,220-offset)},(_,i)=>({title:'Data Scientist '+(offset+i),externalPath:'/jobs/'+(offset+i),locationsText:'Vught',bulletFields:['REQ-'+(offset+i)]}))};}};
 try{
  db.store.startRun('old');const prior=processJob({...base,url:source.careersUrl+'/old'},{store:db.store,profile,sourceId:source.id,provider:'workday',scanId:'old',boardUrl:source.careersUrl});
  db.store.db.prepare("UPDATE jobs SET last_seen_at='2020-01-01T00:00:00Z' WHERE id=?").run(prior.id!);
  const first=await collectSource(db.store,source,ctx);assert.equal(first.jobs.length,200);assert.equal(first.complete,false);assert.ok(first.nextCursor);checkpointCollection(db.store,source,first);
  assert.equal((db.store.job(prior.id!) as any).missed_scans,0);
  const second=await collectSource(db.store,source,ctx);assert.equal(second.jobs.length,20);assert.equal(second.jobs.at(-1)?.title,'Data Scientist 219');assert.equal(second.complete,true);checkpointCollection(db.store,source,second);
  db.store.ageUnseenBoard(source.careersUrl,db.store.collection(source.careersUrl).snapshot_started_at,3);assert.equal((db.store.job(prior.id!) as any).missed_scans,1);
 }finally{db.close();}
});

test('collection commits successful Workday pages on timeout and detects repeated pages',async()=>{
 const db=database(),source={id:'workday',company:'Example',careersUrl:'https://example.wd3.myworkdayjobs.com/External'};let calls=0;
 const page={total:1000,jobPostings:Array.from({length:20},(_,i)=>({title:'Data Scientist '+i,externalPath:'/jobs/'+i,locationsText:'Vught'}))};
 try{
  const first=await collectSource(db.store,source,{fetchText:async()=>'',fetchJson:async()=>{if(++calls===1)return page;return new Promise(()=>{});}},undefined,undefined,20);
  assert.equal(first.jobs.length,20);assert.equal(first.complete,false);assert.match(first.error??'',/timeout/i);assert.ok(first.nextCursor);
  const repeated=await resolveProvider(source).collect(source,{fetchText:async()=>'',fetchJson:async()=>page});assert.equal(repeated.jobs.length,20);assert.match(repeated.error??'',/Repeated/);
 }finally{db.close();}
});

test('public-page collector follows details, parses graph locations and does not invent location',async()=>{
 const source={id:'public',company:'Example',careersUrl:'https://example.test/careers'},description='Build Python predictive models and evaluate statistics. '.repeat(5);
 const ctx:FetchContext={fetchJson:async()=>({}),fetchText:async url=>url.endsWith('/careers')?'<a href="/jobs/scientist">Data Scientist</a>':`<script type="application/ld+json">${JSON.stringify({'@graph':[{'@type':['JobPosting'],title:'Data Scientist',description,jobLocation:{address:{addressLocality:'Vught',addressCountry:'NL'}},url}]})}</script>`};
 const result=await resolveProvider(source).collect(source,ctx);assert.equal(result.complete,true);assert.equal(result.jobs.length,1);assert.match(result.jobs[0].location,/Vught/);assert.equal(result.jobs[0].countryCode,'NL');
 const enriched=await enrichJob({...base,description:undefined},{...ctx,fetchText:async()=>`<body><nav>Our artificial intelligence company</nav><footer>${description}</footer></body>`});assert.equal(enriched.status,'unavailable');
});

test('failed enrichment persists cooldown, Retry-After, four-attempt stop and manual retry',async()=>{
 const db=database(),profile=await loadProfile();try{
  db.store.startRun('run');processJob(base,{store:db.store,profile,sourceId:'fixture',provider:'browser',scanId:'run',candidate:{sourceId:'fixture',company:'Example',provider:'browser'}});
  const result=await enrichPendingJobs({store:db.store,context:{...context,fetchText:async()=>{throw new HttpError('Rate limited',429,true,120000);}}});assert.equal(result.failed,1);
  const row=db.store.db.prepare('SELECT * FROM enrichment_queue').get() as any;assert.equal(row.attempts,1);assert.equal(row.retry_after_ms,120000);assert.ok(Date.parse(row.next_retry_at)>Date.now());assert.equal(db.store.pendingEnrichments().length,0);
  db.store.db.prepare('UPDATE enrichment_queue SET attempts=4,next_retry_at=NULL').run();assert.equal(db.store.pendingEnrichments().length,0);
  db.store.retryEnrichment(row.id);assert.equal(db.store.pendingEnrichments().length,1);
 }finally{db.close();}
});

test('permanent enrichment failures become terminal without a cooldown',async()=>{
 const db=database(),profile=await loadProfile();try{
  db.store.startRun('run');processJob(base,{store:db.store,profile,sourceId:'fixture',provider:'browser',scanId:'run',candidate:{sourceId:'fixture',company:'Example',provider:'browser'}});
  const result=await enrichPendingJobs({store:db.store,context:{...context,fetchText:async()=>{throw new HttpError('Not found',404,false);}}});
  const row=db.store.db.prepare('SELECT status,attempts,next_retry_at FROM enrichment_queue').get() as any,summary=db.store.enrichmentQueueSummary();
  assert.equal(result.failed,1);assert.equal(row.status,'terminal');assert.equal(row.attempts,1);assert.equal(row.next_retry_at,null);
  assert.equal(summary.terminal,1);assert.equal(summary.eligibleNow,0);assert.equal(summary.coolingDown,0);
 }finally{db.close();}
});

test('cancelled idle enrichment remains pending without consuming an attempt',async()=>{
 const db=database(),profile=await loadProfile(),controller=new AbortController();try{
  db.store.startRun('run');processJob(base,{store:db.store,profile,sourceId:'fixture',provider:'browser',scanId:'run',discoveryRunId:'origin-run',candidate:{sourceId:'fixture',company:'Example',provider:'browser'}});
  const pending=enrichPendingJobs({store:db.store,signal:controller.signal,context:{fetchJson:async()=>({}),fetchText:async(_url,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true}))}});
  setTimeout(()=>controller.abort(new Error('Discovery started')),5);const result=await pending,row=db.store.db.prepare('SELECT status,attempts FROM enrichment_queue').get() as any;
  assert.equal(result.cancelled,1);assert.equal(row.status,'pending');assert.equal(row.attempts,0);
 }finally{db.close();}
});

test('discovery, scan and profile reevaluation agree on possible matches',async()=>{
 const db=database();try{
  const source:DiscoverySource={id:'fixture',label:'Fixture',license:'test',kind:'job-feed',discover:async()=>({nextCursor:0,total:1,candidates:[{sourceId:'fixture',company:'Example',jobs:[{...base,location:'Remote - Europe',description:'A role in predictive analytics using Python. '.repeat(5)}]}]})};
  await discover({store:db.store,sources:[source],limit:1,context});const row=db.store.jobs({matchState:'possible'})[0] as any;assert.ok(row);
  await rescoreJobs({store:db.store,jobId:row.id});assert.equal((db.store.job(row.id) as any).match_state,'possible');
  const candidate={sourceId:'fixture',company:'Example',boardUrl:'https://job-boards.greenhouse.io/example',provider:'greenhouse' as const};const employer=db.store.upsertEmployer(candidate,'example','example',1);db.store.upsertEmployerBoard(employer,candidate,'board','healthy');db.store.observeVacancy(employer,'fixture',base,'known-nl-fixture',true);
  await scan({store:db.store,provider:'greenhouse',context:{...context,fetchJson:async()=>({jobs:[{id:'1',title:'Data Scientist',location:{name:'Remote - Europe'},content:'A role in predictive analytics using Python. '.repeat(5),absolute_url:base.url}]})}});
  assert.equal((db.store.job(row.id) as any).match_state,'possible');assert.ok(db.store.decisions(row.id).length>=3);
 }finally{db.close();}
});

test('discovery queues 300 missing descriptions without waiting for enrichment',async()=>{
 const db=database(),count=300,source:DiscoverySource={id:'fast-fixture',label:'Fast fixture',license:'test',kind:'job-feed',discover:async(_ctx,cursor,limit)=>({nextCursor:count,total:count,candidates:Array.from({length:Math.min(limit,count-cursor)},(_,index)=>{const id=cursor+index;return {sourceId:'fast-fixture',company:'Example',jobs:[{...base,url:`https://example.test/jobs/${id}`,description:undefined}]};})})};
 try{
  const started=Date.now(),result=await discover({store:db.store,sources:[source],limit:count,context:{fetchJson:async()=>{throw new Error('discovery must not enrich')},fetchText:async()=>{throw new Error('discovery must not enrich')}}});
  assert.equal(result.processed,count);assert.equal(result.deferredEnrichments,count);assert.equal(db.store.pendingEnrichmentCount(),count);assert.ok(Date.now()-started<30_000);
 }finally{db.close();}
});

test('existing databases get a consistent backup before a versioned migration',()=>{
 const dir=mkdtempSync(join(tmpdir(),'diego-backup-')),path=join(dir,'test.sqlite');let store=new Store(path);
 try{store.db.exec('PRAGMA user_version=0');store.close();store=new Store(path);const files=readdirSync(join(dir,'backups'));assert.equal(files.length,1);const backup=new DatabaseSync(join(dir,'backups',files[0]),{readOnly:true});assert.equal((backup.prepare('PRAGMA integrity_check').get() as any).integrity_check,'ok');backup.close();assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version,1);}
 finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

for(const [name,create] of [['legacy',createApi],['dashboard',createDashboardApi]] as const)test(name+' API filters broad matches and exposes decisions, diagnostics and coverage',async()=>{
 const db=database(),profile=await loadProfile();db.store.startRun('run');const strong=processJob(base,{store:db.store,profile,sourceId:'fixture',provider:'browser',scanId:'run'});processJob({...base,url:base.url+'/possible',location:''},{store:db.store,profile,sourceId:'fixture',provider:'browser',scanId:'run'});
 const excluded=processJob({...base,url:base.url+'/senior',title:'Senior Data Scientist',description:'Private full posting content should not be kept for a lightweight exclusion.'},{store:db.store,profile,sourceId:'fixture',provider:'browser',scanId:'run'});assert.equal((db.store.job(excluded.id!) as any).record_kind,'observation');assert.equal((db.store.job(excluded.id!) as any).description,null);
 const server=create(db.store);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as any,url='http://127.0.0.1:'+address.port;
 try{
  const broad=await fetch(url+'/api/v1/jobs').then(r=>r.json()) as any;assert.equal(broad.total,2);
  const possible=await fetch(url+'/api/v1/jobs?matchState=possible').then(r=>r.json()) as any;assert.equal(possible.total,1);assert.equal(possible.items[0].match_state,'possible');
  assert.equal((await fetch(url+'/api/v1/jobs?matchState=excluded').then(r=>r.json()) as any).total,1);assert.equal((await fetch(url+'/api/v1/jobs?matchState=all').then(r=>r.json()) as any).total,3);
  assert.equal((await fetch(url+'/api/v1/jobs/'+strong.id+'/decisions').then(r=>r.json()) as any).items.length,1);
  const bad=await fetch(url+'/api/v1/diagnostics/job',{method:'POST',body:JSON.stringify({url:'file:///secret'})});assert.equal(bad.status,400);
  const started=await fetch(url+'/api/v1/diagnostics/job',{method:'POST',body:JSON.stringify({url:base.url})});assert.equal(started.status,202);const job=await started.json() as any;
  let diagnostic:any;for(let i=0;i<20;i++){diagnostic=await fetch(url+'/api/v1/diagnostics/job/'+job.id).then(r=>r.json());if(diagnostic.status!=='running')break;await new Promise(r=>setTimeout(r,5));}assert.equal(diagnostic.result.stage,'retained');
  const coverage=await fetch(url+'/api/v1/coverage').then(r=>r.json()) as any;assert.ok(Array.isArray(coverage.collectionStates));assert.ok(Array.isArray(coverage.rejectionReasons));
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();}
});

test('30 captured public vacancies retain every positive and exclude every explicit negative',async()=>{
 const result=await recallCheck('tests/fixtures/recall-30.json');assert.equal(result.total,30);assert.equal(result.failed,0,JSON.stringify(result.items.filter((x:any)=>!x.passed)));assert.equal(result.positiveRecall,1);
});

test('weighted discovery reserves 50/30/20 budgets and merges duplicate board provenance',async()=>{
 const db=database();try{
  db.store.startDiscoveryRun('weighted',undefined,20);
  const sources:DiscoverySource[]=['benchmark-employers','known-netherlands','feed-a','feed-b','directory-a','directory-b','directory-c','directory-d'].map(id=>({id,label:id,license:'test',kind:id.startsWith('feed')?'job-feed':'board-directory',discover:async(_ctx,cursor,limit)=>({candidates:Array.from({length:limit},(_,i)=>({sourceId:id,company:id+' '+(cursor+i),provider:'greenhouse',boardUrl:'https://job-boards.greenhouse.io/'+id+'-'+(cursor+i)})),nextCursor:cursor+limit,total:1000})}));
  await buildQueue('weighted',20,sources,db.store,context,1000,undefined,()=>{},true);
  const queue=db.store.discoveryQueue('weighted').map(r=>r.candidate),priority=queue.filter(c=>['benchmark-employers','known-netherlands'].includes(c.sourceId)),feeds=queue.filter(c=>c.sourceId.startsWith('feed'));
  assert.equal(priority.length,10);assert.equal(feeds.length,6);assert.equal(queue.length-priority.length-feeds.length,4);
  db.store.startDiscoveryRun('duplicate',undefined,2);
  const duplicates:DiscoverySource[]=['one','two'].map(id=>({id,label:id,license:'test',kind:'board-directory',discover:async()=>({candidates:[{sourceId:id,company:'Same',boardUrl:'https://job-boards.greenhouse.io/same',provider:'greenhouse'}],nextCursor:0,total:1})}));
  await buildQueue('duplicate',2,duplicates,db.store,context,1000,undefined,()=>{});
  const merged=db.store.discoveryQueue('duplicate');assert.equal(merged.length,1);assert.deepEqual(new Set(merged[0].candidate.contributingSources),new Set(['one','two']));
  db.store.startRun('provenance');const saved=processJob(base,{store:db.store,profile:await loadProfile(),sourceId:'one',provider:'greenhouse',scanId:'provenance',boardUrl:merged[0].candidate.boardUrl,candidate:merged[0].candidate});assert.equal((db.store.db.prepare('SELECT count(*) n FROM source_observations WHERE job_id=?').get(saved.id!) as any).n,2);
 }finally{db.close();}
});

test('transparent discovery plan reserves 25/25/25/15/10 and validates edits',()=>{
 const allocations=defaultDiscoveryAllocations(100);assert.deepEqual(allocations,{linkedin:25,jobspy:25,priority:25,native:15,directories:10});
 const sources:DiscoverySource[]=[['linkedin-guest','job-feed'],['jobspy-indeed','job-feed'],['benchmark-employers','board-directory'],['gigsignal','job-feed'],['job-board-directory','board-directory']].map(([id,kind])=>({id,label:id,license:'test',kind:kind as any,discover:async()=>({candidates:[],nextCursor:0})}));
 const plan=buildDiscoveryPlan(100,sources);assert.deepEqual(Object.fromEntries(plan.sources.map(row=>[row.id,row.planned])),{'linkedin-guest':25,'jobspy-indeed':25,'benchmark-employers':25,gigsignal:15,'job-board-directory':10});
 assert.throws(()=>validateDiscoveryAllocations(100,{...allocations,linkedin:24}),/totalling 100/);
});

test('worker counts validate and source yield policy redistributes only qualifying low-yield capacity',()=>{
 const db=database();try{
  assert.equal(validateDiscoveryWorkers(undefined),6);assert.equal(validateDiscoveryWorkers('8'),8);assert.throws(()=>validateDiscoveryWorkers(9),/1 to 8/);assert.throws(()=>validateDiscoveryWorkers(2.5),/integer/);
  const now=new Date().toISOString();db.store.db.prepare("INSERT INTO discovery_runs(id,started_at,status,limit_count) VALUES(?,?,?,?)").run('history',now,'completed',100);
  const record=db.store.db.prepare("INSERT INTO discovery_attempts(run_id,source_id,company,provider,started_at,duration_ms,result,retryable,jobs_fetched,netherlands_jobs,profile_matches,candidate_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  for(let index=0;index<50;index++)record.run('history','slow-low','Low yield','lever',now,3000,'no-netherlands-jobs',0,1,0,0,'{}');
  for(let index=0;index<50;index++)record.run('history','slow-productive','Productive','workday',now,3000,'matched',0,1,1,1,'{}');
  const sources:DiscoverySource[]=['slow-low','slow-productive'].map(id=>({id,label:id,license:'test',kind:'board-directory',discover:async()=>({candidates:[],nextCursor:0,total:0})}));
  const allocations={linkedin:0,jobspy:0,priority:0,native:0,directories:10},plan=buildDiscoveryPlan(10,sources,allocations,db.store,true);
  const low=plan.sources.find(row=>row.id==='slow-low')!,productive=plan.sources.find(row=>row.id==='slow-productive')!;
  assert.equal(low.deprioritized,true);assert.equal(low.originalPlanned,5);assert.equal(low.planned,1);assert.equal(low.yieldEvidence?.attempts,50);assert.equal(productive.deprioritized,false);assert.equal(productive.planned,9);assert.equal(plan.sources.reduce((sum,row)=>sum+row.planned,0),10);
  const regular=buildDiscoveryPlan(10,sources,allocations,db.store,false);assert.equal(regular.sources.find(row=>row.id==='slow-low')?.planned,5);
 }finally{db.close();}
});

test('turbo plan allocates exact budgets to fast feeds and keeps proven boards as ordered fallback',async()=>{
 const db=database();try{
  const guardrailPlan=buildTurboDiscoveryPlan(100,Array.from({length:5},(_,index)=>({id:`guardrail-${index}`,label:`Guardrail ${index}`,license:'test',kind:'job-feed' as const,discover:async()=>({candidates:[],nextCursor:0})})),db.store);assert.ok(guardrailPlan.sources.every(row=>row.planned>=5&&row.planned<=40));assert.equal(guardrailPlan.sources.reduce((sum,row)=>sum+row.planned,0),100);
  db.store.startDiscoveryRun('poor-evidence',undefined,20);for(let index=0;index<20;index++)db.store.recordDiscoveryAttempt({runId:'poor-evidence',sourceId:'poor-board',company:`Poor ${index}`,startedAt:new Date().toISOString(),durationMs:3000,result:'network-error',retryable:true,jobsFetched:0,netherlandsJobs:0,profileMatches:0,candidate:{sourceId:'poor-board',company:`Poor ${index}`}});
  let release!:()=>void,started=0,fallbackCalls=0;const gate=new Promise<void>(resolve=>{release=resolve});
  const feed=(id:string):DiscoverySource=>({id,label:id,license:'test',kind:'job-feed',discover:async(_context,_cursor,limit)=>{started++;await gate;return {candidates:Array.from({length:limit},(_,index)=>({sourceId:id,company:`${id}-${index}`,jobs:[{...base,url:`https://example.test/${id}/${index}`}]})),nextCursor:limit,total:limit}}});
  const sources:DiscoverySource[]=[feed('fast-a'),feed('fast-b'),{id:'fallback-board',label:'Fallback',license:'test',kind:'board-directory',discover:async()=>{fallbackCalls++;return {candidates:[],nextCursor:0,total:0}}},{id:'poor-board',label:'Poor',license:'test',kind:'board-directory',discover:async()=>({candidates:[],nextCursor:0,total:0})}];
  const plan=buildTurboDiscoveryPlan(3,sources,db.store);assert.equal(plan.rules.selectionPolicy,'turbo-tiered');assert.equal(plan.sources.reduce((sum,row)=>sum+row.planned,0),3);assert.ok(plan.sources.filter(row=>row.tier==='primary').every(row=>row.kind==='job-feed'));assert.equal(plan.sources.find(row=>row.id==='fallback-board')?.tier,'fallback');assert.equal(plan.sources.find(row=>row.id==='poor-board')?.tier,'excluded');
  db.store.startDiscoveryRun('turbo-plan',undefined,3,plan,'turbo',8);const building=buildQueue('turbo-plan',3,sources,db.store,context,1000,undefined,()=>{},false,plan,'turbo');for(let index=0;index<20&&started<2;index++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(started,2,'primary feeds begin concurrently');release();await building;assert.equal(fallbackCalls,0,'fallback is untouched when primary feeds fill the budget');assert.equal(db.store.discoveryQueue('turbo-plan').length,3);const run:any=db.store.discoveryRun('turbo-plan');assert.equal(run.selection_policy,'turbo-tiered');assert.equal(run.sources.find((row:any)=>row.source_id==='fallback-board').tier,'fallback');
 }finally{db.close();}
});

test('turbo always records eight workers even when a lower count is supplied',async()=>{
 const db=database();try{const result=await discover({store:db.store,mode:'turbo',concurrency:1,limit:1,sources:[{id:'empty-fast',label:'Empty',license:'test',kind:'job-feed',discover:async()=>({candidates:[],nextCursor:0,total:0})}],context});assert.equal((db.store.discoveryRun(result.id) as any).worker_count,8);}finally{db.close();}
});

test('turbo consults a proven fallback only after fast feeds underfill',async()=>{
 const db=database();try{let fallbackCalls=0;const sources:DiscoverySource[]=[{id:'empty-feed',label:'Empty feed',license:'test',kind:'job-feed',discover:async()=>({candidates:[],nextCursor:0,total:0})},{id:'fallback-directory',label:'Fallback directory',license:'test',kind:'board-directory',discover:async(_context,_cursor,limit)=>{fallbackCalls++;return {candidates:Array.from({length:limit},(_,index)=>({sourceId:'fallback-directory',company:`Fallback ${index}`,jobs:[{...base,url:`https://example.test/fallback/${index}`}]})),nextCursor:limit,total:limit}}}];const plan=buildTurboDiscoveryPlan(2,sources,db.store);db.store.startDiscoveryRun('turbo-fallback',undefined,2,plan,'turbo',8);await buildQueue('turbo-fallback',2,sources,db.store,context,1000,undefined,()=>{},false,plan,'turbo');assert.equal(fallbackCalls,1);assert.equal(db.store.discoveryQueue('turbo-fallback').length,2);assert.equal((db.store.discoveryRun('turbo-fallback') as any).sources.find((row:any)=>row.source_id==='fallback-directory').reassigned_count,2);}finally{db.close();}
});

test('fresh and refresh-known modes classify repeat candidates transparently',async()=>{
 const db=database();try{
  const old={sourceId:'known-netherlands',company:'Seen company',provider:'greenhouse' as const,boardUrl:'https://job-boards.greenhouse.io/seen'},fresh={sourceId:'known-netherlands',company:'Fresh company',provider:'greenhouse' as const,boardUrl:'https://job-boards.greenhouse.io/fresh'};
  const prior:DiscoveryAttempt={runId:'prior',sourceId:old.sourceId,company:old.company,provider:old.provider,boardUrl:old.boardUrl,startedAt:new Date().toISOString(),durationMs:100,result:'matched',retryable:false,jobsFetched:1,netherlandsJobs:1,profileMatches:1,candidate:old};
  db.store.updateCandidateHealth('seen-candidate',prior);
  const source:DiscoverySource={id:'known-netherlands',label:'Mode source',license:'test',kind:'board-directory',discover:async(_ctx,cursor,limit)=>({candidates:[old,fresh].slice(cursor,cursor+limit),nextCursor:Math.min(2,cursor+limit),total:2})};
  db.store.startDiscoveryRun('fresh-run',undefined,2,undefined,'fresh');await buildQueue('fresh-run',2,[source],db.store,context,1000,undefined,()=>{},false,undefined,'fresh');
  assert.deepEqual(db.store.discoveryQueue('fresh-run').map(row=>row.candidate.company),['Fresh company']);
  const freshRun:any=db.store.discoveryRun('fresh-run');assert.equal(freshRun.fresh_candidate_count,1);assert.equal(freshRun.skipped_recent_count,1);assert.equal(freshRun.queued_count,1);
  db.store.startDiscoveryRun('refresh-run',undefined,2,undefined,'refresh-known');await buildQueue('refresh-run',2,[source],db.store,context,1000,undefined,()=>{},false,undefined,'refresh-known');
  assert.equal(db.store.discoveryQueue('refresh-run').length,2);const refreshRun:any=db.store.discoveryRun('refresh-run');assert.equal(refreshRun.forced_refresh_count,1);assert.equal(refreshRun.fresh_candidate_count,1);
 }finally{db.close();}
});

test('run tasks and capped technical trace are exposed without request bodies or headers',()=>{
 const db=database();try{
  db.store.startDiscoveryRun('trace-run',undefined,1,undefined,'balanced');const candidate={sourceId:'trace-source',company:'Example',provider:'greenhouse' as const,boardUrl:'https://job-boards.greenhouse.io/example'};
  db.store.startDiscoveryTask('trace-run','candidate','worker-1',candidate);db.store.updateDiscoveryTask('trace-run','candidate','enriching-description',{jobTitle:'Data Scientist',jobUrl:'https://example.test/job'});
  for(let index=0;index<2005;index++)db.store.recordDiscoveryEvent('trace-run',{phase:'processing',type:'request',message:`event ${index}`,url:'https://example.test/jobs'});
  const run:any=db.store.discoveryRun('trace-run');assert.equal(run.active_tasks[0].stage,'enriching-description');assert.ok(run.eta);
  const trace:any=db.store.discoveryTrace('trace-run',0,500);assert.equal(trace.items.length,500);assert.equal(trace.items[0].url,'https://example.test/jobs');assert.equal(trace.droppedCount,5);
 }finally{db.close();}
});

test('planned discovery visibly redistributes unused source capacity',async()=>{
 const db=database();try{
  db.store.startDiscoveryRun('planned',undefined,10);
  const ids:[string,DiscoverySource['kind']][]=[['linkedin-guest','job-feed'],['jobspy-indeed','job-feed'],['benchmark-employers','board-directory'],['gigsignal','job-feed'],['job-board-directory','board-directory']];
  const sources:DiscoverySource[]=ids.map(([id,kind])=>({id,label:id,license:'test',kind,discover:async(_ctx,cursor,limit)=>id==='linkedin-guest'?{candidates:Array.from({length:limit},(_,i)=>({sourceId:id,company:`Company ${cursor+i}`,jobs:[{...base,externalId:`${cursor+i}`,url:`https://example.test/${cursor+i}`}]})),nextCursor:cursor+limit,total:100}:{candidates:[],nextCursor:cursor,total:0}}));
  const allocations={linkedin:4,jobspy:2,priority:2,native:1,directories:1},plan=buildDiscoveryPlan(10,sources,allocations);
  await buildQueue('planned',10,sources,db.store,context,1000,undefined,()=>{},false,plan);
  assert.equal(db.store.discoveryQueue('planned').length,10);const rows=db.store.discoveryRunSources('planned') as any[],linkedin=rows.find(row=>row.source_id==='linkedin-guest');
  assert.equal(linkedin.planned_count,4);assert.equal(linkedin.reassigned_count,6);assert.equal(linkedin.queued_count,10);assert.ok(rows.filter(row=>row.source_id!=='linkedin-guest').every(row=>row.exhausted===1));
 }finally{db.close();}
});

test('strict allocations never query zero-allocation sources when LinkedIn and Indeed are recent-only',async()=>{
 const db=database();try{
  const linkedin=Array.from({length:10},(_,index)=>({sourceId:'linkedin-guest',company:`LinkedIn ${index}`,jobs:[{...base,url:`https://linkedin.test/${index}`}]}));
  const indeed=Array.from({length:72},(_,index)=>({sourceId:'jobspy-indeed',company:`Indeed ${index}`,jobs:[{...base,url:`https://indeed.test/${index}`}]}));
  for(const candidate of [...linkedin,...indeed])db.store.updateCandidateHealth(`recent-${candidate.sourceId}-${candidate.company}`,{runId:'prior',sourceId:candidate.sourceId,company:candidate.company,startedAt:new Date().toISOString(),durationMs:1,result:'matched',retryable:false,jobsFetched:1,netherlandsJobs:1,profileMatches:1,candidate});
  let excludedCalls=0;
  const feed=(id:string,candidates:any[]):DiscoverySource=>({id,label:id,license:'test',kind:'job-feed',discover:async(_ctx,cursor,limit)=>({candidates:candidates.slice(cursor,cursor+limit),nextCursor:Math.min(candidates.length,cursor+limit),total:candidates.length})});
  const sources:DiscoverySource[]=[feed('linkedin-guest',linkedin),feed('jobspy-indeed',indeed),{id:'job-board-directory',label:'ATS directory',license:'test',kind:'board-directory',discover:async()=>{excludedCalls++;return {candidates:[{sourceId:'job-board-directory',company:'Forbidden fallback',provider:'greenhouse',boardUrl:'https://job-boards.greenhouse.io/forbidden'}],nextCursor:1,total:1};}}];
  const allocations={linkedin:100,jobspy:100,priority:0,native:0,directories:0},plan=buildDiscoveryPlan(200,sources,allocations);
  db.store.startDiscoveryRun('strict',undefined,200,plan);await buildQueue('strict',200,sources,db.store,context,1000,undefined,()=>{},false,plan,'balanced');
  const run:any=db.store.discoveryRun('strict'),rows=run.sources as any[];
  assert.equal(excludedCalls,0);assert.equal(db.store.discoveryQueue('strict').length,0);assert.equal(run.selection_policy,'strict');assert.equal(run.candidates_returned_count,82);assert.equal(run.skipped_recent_count,82);assert.equal(run.unfilled_count,200);assert.equal(run.shortfall.length,2);
  assert.equal(rows.find(row=>row.source_id==='job-board-directory').requested_count,0);assert.equal(rows.find(row=>row.source_id==='job-board-directory').queued_count,0);
  const trace:any=db.store.discoveryTrace('strict',0,200);assert.ok(trace.items.some((event:any)=>event.event_type==='strict-selection-underfilled'));assert.ok(!trace.items.some((event:any)=>event.source_id==='job-board-directory'&&event.event_type==='source-query'));
 }finally{db.close();}
});

test('provider circuit pauses repeated transient failures and partial queues resume',async()=>{
 const db=database();try{
  const distinct:DiscoverySource={id:'distinct',label:'distinct',license:'test',kind:'board-directory',discover:async()=>({nextCursor:0,total:10,candidates:Array.from({length:10},(_,i)=>({sourceId:'distinct',company:'Example '+i,provider:'browser',boardUrl:'https://employer-'+i+'.test/jobs'}))})};
  const fail:FetchContext={fetchJson:async()=>{throw new HttpError('Network error',503,true);},fetchText:async()=>{throw new HttpError('Network error',503,true);}};
  const result=await discover({store:db.store,sources:[distinct],limit:10,context:fail});assert.ok(result.processed>=5&&result.processed<10);assert.ok(result.pending>0);
  const same:DiscoverySource={...distinct,id:'same',discover:async()=>({nextCursor:0,total:10,candidates:Array.from({length:10},(_,i)=>({sourceId:'same',company:'Example '+i,provider:'greenhouse',boardUrl:'https://job-boards.greenhouse.io/failure-'+i}))})};
  const first=await discover({store:db.store,source:'same',sources:[same],limit:10,context:fail});assert.ok(first.pending>0);
  const resumed=await discover({store:db.store,source:'same',sources:[same],limit:10,resume:true,context:{...context,fetchJson:async()=>({jobs:[]})}});assert.equal(resumed.id,first.id);assert.equal(resumed.pending,0);assert.equal(resumed.processed,10);
 }finally{db.close();}
});

test('Workday prioritizes an explicitly supplied Netherlands facet then resumes the full board',async()=>{
 const source={id:'workday',company:'Example',careersUrl:'https://example.wd3.myworkdayjobs.com/en-US/External'},requests:any[]=[];
 const ctx:FetchContext={fetchText:async()=>'',fetchJson:async(_url,init)=>{const body=JSON.parse(String(init?.body));requests.push(body);return {total:1,facets:[{facetParameter:'locationCountry',values:[{id:'nl-country-id',descriptor:'Netherlands'}]}],jobPostings:[{title:'Data Scientist',locationsText:body.appliedFacets.locationCountry?'Vught':'Berlin',externalPath:'/job/scientist',bulletFields:['REQ-1']}]};}};
 const provider=resolveProvider(source),first=await provider.collect(source,ctx);assert.equal(first.complete,false);assert.equal(first.jobs[0].location,'Vught');assert.equal(requests[1].appliedFacets.locationCountry[0],'nl-country-id');assert.match(first.jobs[0].url,/en-US\/External\/job\/scientist/);
 const second=await provider.collect({...source,cursor:first.nextCursor},ctx);assert.equal(second.complete,true);assert.deepEqual(requests.at(-1).appliedFacets,{});
});

test('Workday uses the posting path instead of shared display metadata as external ID',async()=>{
 const source={id:'workday',company:'Example',careersUrl:'https://example.wd3.myworkdayjobs.com/External'};
 const provider=resolveProvider(source),result=await provider.collect(source,{fetchText:async()=>'',fetchJson:async()=>({total:2,jobPostings:[
  {title:'Data Scientist',locationsText:'Vught',externalPath:'/job/data-scientist/REQ-1',bulletFields:['Application Deadline: 11/11/2026']},
  {title:'Analytics Engineer',locationsText:'Amsterdam',externalPath:'/job/analytics-engineer/REQ-2',bulletFields:['Application Deadline: 11/11/2026']}
 ]})});
 assert.deepEqual(result.jobs.map(job=>job.externalId),['/job/data-scientist/REQ-1','/job/analytics-engineer/REQ-2']);
 assert.equal(new Set(result.jobs.map(job=>job.externalId)).size,2);
});

test('Workday details supply descriptions and HTML entities become readable text',async()=>{
 const result=await enrichJob({...base,raw:{_diegoDetailApi:'https://example.wd3.myworkdayjobs.com/wday/cxs/example/External/job/1'}},{fetchText:async()=>{throw new Error('Detail API should be preferred');},fetchJson:async()=>({jobPostingInfo:{jobDescription:'&lt;p&gt;Build &lt;strong&gt;Python&lt;/strong&gt; models.&lt;/p&gt;',location:'Vught',country:{descriptor:'Netherlands'}}})});
 assert.equal(result.status,'complete');assert.equal(result.job.description,'Build Python models.');assert.equal(assessLocation(result.job,await loadProfile()).state,'netherlands');
});
