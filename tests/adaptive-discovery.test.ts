import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rankAdaptiveArms, recencyReward, validateDiscoveryDuration } from "../src/adaptive-discovery.js";
import { Store } from "../src/database.js";
import { discover } from "../src/discovery.js";
import type { DiscoverySource } from "../src/types.js";

test("recency rewards only verified recent posting dates",()=>{
  const now=Date.parse("2026-11-13T12:00:00Z"),days=(value:number)=>new Date(now-value*86_400_000).toISOString();
  assert.deepEqual(recencyReward(days(7),now),{reward:1,band:"0-7"});
  assert.deepEqual(recencyReward(days(8),now),{reward:0,band:"8-30"});
  assert.deepEqual(recencyReward(days(31),now),{reward:0,band:"31-60"});
  assert.deepEqual(recencyReward(days(61),now),{reward:0,band:"older"});
  assert.deepEqual(recencyReward(new Date(now+86_400_000).toISOString(),now),{reward:0,band:"unknown"});
  assert.deepEqual(recencyReward(undefined,now),{reward:0,band:"unknown"});
});

test("adaptive ranking favors fast useful arms while retaining exploration",()=>{
  const rows=rankAdaptiveArms([
    {armId:"board:https://fast.test/jobs",sourceId:"fast",label:"Fast",pulls:40,workerMs:600_000,reward:20,failures:0,duplicates:1,lastAt:"2026-11-12T12:00:00Z"},
    {armId:"board:https://slow.test/jobs",sourceId:"slow",label:"Slow",pulls:40,workerMs:2_400_000,reward:4,failures:9,duplicates:21,lastAt:"2026-11-12T12:00:00Z"},
    {armId:"feed:new:embedded",sourceId:"new",label:"New",pulls:0,workerMs:0,reward:0,failures:0,duplicates:0},
  ],Date.parse("2026-11-13T12:00:00Z"));
  assert.ok(rows.find(row=>row.sourceId==="fast")!.score>rows.find(row=>row.sourceId==="slow")!.score);
  assert.ok(rows.find(row=>row.sourceId==="new")!.score>0,"untried sources retain an exploration score");
  assert.match(rows.find(row=>row.sourceId==="slow")!.reason,/failures|repeated results/);
});

test("discovery duration accepts only dashboard presets",()=>{
  assert.equal(validateDiscoveryDuration(20),20);
  assert.throws(()=>validateDiscoveryDuration(7),/5, 10, 20, or 30/);
});

test("dynamic pulls append queue ordinals and count only real candidate duplicates",()=>{
  const dir=mkdtempSync(join(tmpdir(),"diego-adaptive-queue-")),store=new Store(join(dir,"test.sqlite"));
  try{assert.equal(store.claimTimedDiscoveryRun("run",300_000).claimed,true);const candidate=(company:string)=>({sourceId:"fixture",company,jobs:[]});
    assert.deepEqual(store.enqueueDiscoveryCandidates("run",[{id:"a",candidate:candidate("A")},{id:"b",candidate:candidate("B")}]),{queued:2,duplicates:0});
    assert.deepEqual(store.enqueueDiscoveryCandidates("run",[{id:"b",candidate:candidate("B")},{id:"c",candidate:candidate("C")}]),{queued:1,duplicates:1});
    assert.deepEqual((store.db.prepare("SELECT ordinal,candidate_id FROM discovery_queue WHERE run_id='run' ORDER BY ordinal").all() as any[]).map(row=>[row.ordinal,row.candidate_id]),[[0,"a"],[1,"b"],[2,"c"]]);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("run outcomes separate new strong matches from reward-eligible matches",()=>{
  const dir=mkdtempSync(join(tmpdir(),"diego-adaptive-outcome-")),store=new Store(join(dir,"test.sqlite"));
  try{store.claimTimedDiscoveryRun("run",300_000);const candidate={sourceId:"jobspy-indeed",company:"Example",provider:"browser" as const,searchArmId:"jobspy:indeed:test"};
    store.recordDiscoveryOutcome("run","fresh",candidate,new Date(Date.now()-2*86_400_000).toISOString(),{isNew:true,matchState:"strong"});
    store.recordDiscoveryOutcome("run","unknown",candidate,undefined,{isNew:true,matchState:"strong"});
    const row=store.db.prepare("SELECT new_strong_count,useful_match_count,weighted_reward,unknown_date_count,metrics_version FROM discovery_runs WHERE id='run'").get() as any;assert.equal(row.new_strong_count,2);assert.equal(row.useful_match_count,1);assert.equal(row.weighted_reward,1);assert.equal(row.unknown_date_count,1);assert.equal(row.metrics_version,2);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("only strong matches posted within seven days earn discovery value",()=>{
  const dir=mkdtempSync(join(tmpdir(),"diego-adaptive-seven-day-")),store=new Store(join(dir,"test.sqlite"));
  try{store.claimTimedDiscoveryRun("run",300_000);const candidate={sourceId:"feed",company:"Example"},now=Date.now();
    store.recordDiscoveryOutcome("run","fresh",candidate,new Date(now-6*86_400_000).toISOString(),{isNew:true,matchState:"strong"});
    store.recordDiscoveryOutcome("run","stale",candidate,new Date(now-8*86_400_000).toISOString(),{isNew:true,matchState:"strong"});
    const outcomes=store.db.prepare("SELECT job_id,reward FROM discovery_outcomes WHERE run_id='run' ORDER BY job_id").all() as any[],run=store.db.prepare("SELECT strategy_version,new_strong_count,useful_match_count,weighted_reward FROM discovery_runs WHERE id='run'").get() as any;
    assert.deepEqual(outcomes.map(row=>[row.job_id,row.reward]),[["fresh",1],["stale",0]]);assert.deepEqual({...run},{strategy_version:3,new_strong_count:2,useful_match_count:1,weighted_reward:1});
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("adaptive forecast includes interrupted exposure and produces nonlinear duration choices",()=>{
  const dir=mkdtempSync(join(tmpdir(),"diego-adaptive-forecast-")),store=new Store(join(dir,"test.sqlite")),source={id:"feed",label:"Feed"};
  try{const now=new Date().toISOString(),fresh=new Date(Date.now()-86_400_000).toISOString();
    for(const [id,status,duration,count] of [["complete","completed",300_000,3],["interrupted","interrupted",120_000,1]] as const){store.claimTimedDiscoveryRun(id,1_200_000);store.recordDiscoveryPull({runId:id,armId:"source:feed",sourceId:"feed",label:"Feed",startedAt:now,durationMs:10_000,cursor:0,requested:10,returned:10,eligible:10});for(let index=0;index<count;index++)store.recordDiscoveryOutcome(id,`${id}-${index}`,{sourceId:"feed",company:"Example"},fresh,{isNew:true,matchState:"strong"});store.db.prepare("UPDATE discovery_runs SET status=?,finished_at=?,duration_ms=? WHERE id=?").run(status,now,duration,id);}
    const forecast=store.adaptiveForecast(10,[source]),rows=forecast.durations;
    assert.equal(forecast.trainingRuns,2);assert.equal(forecast.target,"new-strong-posted-within-7-days");assert.equal(forecast.selectedForecast.durationMinutes,10);assert.equal(rows.filter((row:any)=>row.bestValue).length,1);assert.ok(rows[3].expectedFreshStrongMatches<rows[0].expectedFreshStrongMatches*6,"long runs saturate instead of scaling linearly");assert.ok(rows.every((row:any)=>row.probabilityAtLeastOne>=0&&row.probabilityAtLeastOne<=100&&row.probabilityAtLeastFive>=0&&row.probabilityAtLeastFive<=100));
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("a later observation cannot erase new and strong run attribution",()=>{
  const dir=mkdtempSync(join(tmpdir(),"diego-adaptive-monotonic-")),store=new Store(join(dir,"test.sqlite"));
  try{store.claimTimedDiscoveryRun("run",300_000);const candidate={sourceId:"jobspy-indeed",company:"Example",provider:"browser" as const,searchArmId:"jobspy:indeed:test"},posted=new Date(Date.now()-2*86_400_000).toISOString();
    store.recordDiscoveryOutcome("run","job",candidate,posted,{isNew:true,matchState:"strong"});
    store.recordDiscoveryOutcome("run","job",candidate,undefined,{isNew:false,matchState:"strong"});
    const outcome=store.db.prepare("SELECT is_new,new_strong,reward FROM discovery_outcomes WHERE run_id='run' AND job_id='job'").get() as any,row=store.db.prepare("SELECT new_strong_count,useful_match_count,weighted_reward FROM discovery_runs WHERE id='run'").get() as any;
    assert.deepEqual({...outcome},{is_new:1,new_strong:1,reward:1});assert.deepEqual({...row},{new_strong_count:1,useful_match_count:1,weighted_reward:1});
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("source ranking charges downstream candidate processing time",()=>{
  const dir=mkdtempSync(join(tmpdir(),"diego-adaptive-cost-")),store=new Store(join(dir,"test.sqlite"));
  try{store.claimTimedDiscoveryRun("run",300_000);const now=new Date().toISOString();
    for(const sourceId of ["fast","slow"]){store.recordDiscoveryPull({runId:"run",armId:`source:${sourceId}`,sourceId,label:sourceId,startedAt:now,durationMs:10,cursor:0,requested:10,returned:10,eligible:10});store.recordDiscoveryOutcome("run",`${sourceId}-job`,{sourceId,company:sourceId},new Date(Date.now()-86_400_000).toISOString(),{isNew:true,matchState:"strong"});}
    const insert=store.db.prepare("INSERT INTO discovery_attempts(run_id,source_id,company,started_at,duration_ms,result,retryable,jobs_fetched,netherlands_jobs,profile_matches,candidate_json) VALUES(?,?,?,?,?,'matched',0,1,1,1,?)");
    insert.run("run","fast","Fast",now,1_000,JSON.stringify({sourceId:"fast",company:"Fast"}));insert.run("run","slow","Slow",now,60_000,JSON.stringify({sourceId:"slow",company:"Slow"}));
    const ranks=store.adaptiveArmRanking([{id:"fast",label:"Fast"},{id:"slow",label:"Slow"}]),fast=ranks.find((row:any)=>row.sourceId==="fast"),slow=ranks.find((row:any)=>row.sourceId==="slow");
    assert.ok(fast.expectedRewardPerMinute>slow.expectedRewardPerMinute);assert.ok(fast.workerMs<slow.workerMs);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("candidate scoring batches shared source history instead of repeating full rankings",()=>{
  const dir=mkdtempSync(join(tmpdir(),"diego-adaptive-batch-")),store=new Store(join(dir,"test.sqlite"));
  try{store.claimTimedDiscoveryRun("run",300_000);const now=new Date().toISOString(),candidates=[{sourceId:"feed",company:"One",jobs:[]},{sourceId:"feed",company:"Two",jobs:[]},{sourceId:"boards",company:"Board",boardUrl:"https://example.test/jobs",provider:"browser" as const}];
    store.recordDiscoveryPull({runId:"run",armId:"source:feed",sourceId:"feed",label:"Feed",startedAt:now,durationMs:100,cursor:0,requested:2,returned:2,eligible:2});
    const insert=store.db.prepare("INSERT INTO discovery_attempts(run_id,source_id,company,board_url,started_at,duration_ms,result,retryable,jobs_fetched,netherlands_jobs,profile_matches,candidate_json) VALUES(?,?,?,?,?,?,'matched',0,1,1,1,?)");insert.run("run","boards","Board","https://example.test/jobs",now,500,JSON.stringify(candidates[2]));
    const original=store.adaptiveArmRanking.bind(store);let rankingCalls=0;(store as any).adaptiveArmRanking=(rows:any[])=>{rankingCalls++;return original(rows)};
    const scores=store.adaptiveCandidateScores(candidates);assert.equal(scores.length,3);assert.equal(scores[0],scores[1]);assert.ok(scores.every(Number.isFinite));assert.equal(rankingCalls,1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("adaptive discovery does not repeat a JobSpy search arm inside its cooldown",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"diego-adaptive-cooldown-")),store=new Store(join(dir,"test.sqlite")),arm={id:"jobspy:indeed:one",label:"indeed · Netherlands · data",metadata:{query:"data",location:"Netherlands"}};let called=0;
  const source:DiscoverySource={id:"jobspy-indeed",label:"JobSpy indeed",license:"fixture",kind:"job-feed",listArms:async()=>[arm],discoverArm:async()=>{called++;return {candidates:[],nextCursor:1,total:1,arm}},discover:async()=>({candidates:[],nextCursor:1,total:1})};
  try{store.claimTimedDiscoveryRun("prior",300_000);store.recordDiscoveryPull({runId:"prior",armId:arm.id,sourceId:source.id,label:arm.label,startedAt:new Date().toISOString(),durationMs:10,cursor:0,requested:10,returned:0,eligible:0});store.db.prepare("UPDATE discovery_runs SET status='completed',finished_at=? WHERE id='prior'").run(new Date().toISOString());
    const result=await discover({store,sources:[source],durationMinutes:5,timeBudgetMs:25,context:{fetchJson:async()=>({}),fetchText:async()=>""}});assert.equal(result.processed,0);assert.equal(called,0);const trace:any=store.discoveryTrace(result.id);assert.ok(trace.items.some((event:any)=>event.event_type==='adaptive-source-exhausted'&&event.metadata?.reason==='cooling-down'));
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
