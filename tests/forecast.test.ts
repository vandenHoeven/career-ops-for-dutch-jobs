import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/database.js";
import { buildTransparentForecast, buildTransparentForecastSeries, type ForecastHistoryRow } from "../src/forecast.js";
import { scaleDiscoveryAllocations, validateDiscoveryAllocationWeights } from "../src/discovery.js";
import type { JobPosting } from "../src/types.js";

const allocations={linkedin:0,jobspy:0,priority:0,native:100,directories:0};
const plan=[{sourceId:"fixture-feed",label:"Fixture feed",category:"native",planned:100}];

function addRun(store:Store,id:string,started:string,strong:number,extra:{possible?:number;refreshed?:number;excluded?:number;undated?:number}={}) {
  const finished=new Date(Date.parse(started)+60_000).toISOString(),source="fixture-feed",scan=`discovery-${id}`;
  store.startDiscoveryRun(id,undefined,100,{sources:[{id:source,label:"Fixture feed",category:"native",planned:100}],allocations},"balanced");
  store.saveDiscoveryPlan(id,{sources:[{id:source,label:"Fixture feed",category:"native",planned:100}]});store.startRun(scan,"discovery");
  store.db.prepare("UPDATE discovery_runs SET started_at=?,finished_at=?,status='completed',processed_count=100 WHERE id=?").run(started,finished,id);
  for(let index=0;index<100;index++)store.recordDiscoveryAttempt({runId:id,sourceId:source,company:`Company ${id} ${index}`,startedAt:started,durationMs:1,result:"matched",retryable:false,jobsFetched:1,netherlandsJobs:1,profileMatches:0,candidate:{sourceId:source,company:`Company ${id} ${index}`}});
  let sequence=0;
  const add=(kind:"strong"|"possible"|"refreshed"|"excluded"|"undated")=>{
    const token=(id+String(sequence++)).replace(/[^a-f0-9]/g,"a").padEnd(24,"a").slice(0,24),firstSeen=kind==="refreshed"?new Date(Date.parse(started)-86_400_000).toISOString():new Date(Date.parse(started)+1_000).toISOString();
    const job:JobPosting={id:token,provider:"browser",sourceId:source,company:"Fixture",title:`Data Analyst ${sequence}`,location:"Utrecht, Netherlands",url:`https://example.test/${token}`,canonicalUrl:`https://example.test/${token}`,postedAt:kind==="undated"?undefined:new Date(Date.parse(started)-30*86_400_000).toISOString(),workArrangement:"onsite",roleFamily:"analytics",matchEvidence:{roleFamily:"analytics",roleTerm:"data analyst",locationTerm:"utrecht"},firstSeenAt:firstSeen,lastSeenAt:firstSeen,status:"active",raw:{}};
    store.upsertJob(job,token,scan,{discoveryRunId:id});
    const matchState=kind==="excluded"?"excluded":kind==="possible"?"possible":"strong";store.updateMatch(token,matchState,[]);store.recordDecision({jobId:token,url:job.url,sourceId:source,runId:scan,profileFingerprint:"fixture",decision:{matchState,retain:kind!=="excluded",reasons:[],evidence:{},fieldsInspected:[]},job});
  };
  for(let i=0;i<strong;i++)add("strong");for(let i=0;i<(extra.undated??0);i++)add("undated");for(let i=0;i<(extra.possible??0);i++)add("possible");for(let i=0;i<(extra.refreshed??0);i++)add("refreshed");for(let i=0;i<(extra.excluded??0);i++)add("excluded");
}

test("forecast target counts only new strong jobs regardless of posting date",()=>{
  const store=new Store(":memory:");try{addRun(store,"aaaa","2026-10-29T10:00:00.000Z",2,{undated:1,possible:2,refreshed:2,excluded:1});const forecast=store.discoveryForecast(100,allocations,"balanced",plan),source=forecast.sources[0];assert.equal(forecast.target,"new-strong-matches");assert.match(forecast.targetDefinition,/refreshed, possible, excluded/i);assert.equal(source.historicalNewStrong,3);assert.equal(source.historicalCandidates,100);assert.equal(source.yieldPer100,3);assert.ok(forecast.ml.point>=0);assert.ok(forecast.ml.lower<=forecast.ml.point);assert.ok(forecast.ml.upper>=forecast.ml.point);}finally{store.close();}
});

test("time-ordered ML forecast is deterministic, calibrated, and exposes both models",()=>{
  const rows:ForecastHistoryRow[]=[];for(let index=0;index<10;index++)rows.push({runId:`run-${index}`,startedAt:new Date(Date.UTC(2026,8,index+1)).toISOString(),mode:index%3===0?"fresh":"balanced",sourceId:"source",label:"Source",category:"native",planned:100,candidates:100,failures:index%4===0?2:0,newStrong:Math.max(0,12-index)});
  const first=buildTransparentForecast(rows,[{sourceId:"source",label:"Source",category:"native",planned:100}],"balanced",100,"2026-10-01T00:00:00.000Z"),second=buildTransparentForecast(rows,[{sourceId:"source",label:"Source",category:"native",planned:100}],"balanced",100,"2026-10-01T00:00:00.000Z");assert.deepEqual(first,second);assert.ok(first.ml.metrics.runs>=1);assert.ok(first.baseline.metrics.runs>=1);assert.ok(["ml","baseline"].includes(first.betterBacktest));assert.equal(first.ml.intervalLevel,.95);assert.ok(first.sources[0].factors.length>0);
});

test("sparse unseen sources use category evidence instead of returning zero",()=>{
  const rows:ForecastHistoryRow[]=[{runId:"prior",startedAt:"2026-09-01T00:00:00.000Z",mode:"balanced",sourceId:"known",label:"Known",category:"jobspy",planned:50,candidates:50,failures:0,newStrong:5}],forecast=buildTransparentForecast(rows,[{sourceId:"unseen",label:"Unseen",category:"jobspy",planned:25}],"balanced",25,"2026-10-01T00:00:00.000Z");assert.ok(forecast.ml.point>0);assert.ok(forecast.baseline.point>0);assert.equal(forecast.sources[0].evidence,"sparse");assert.ok(forecast.warnings.some(value=>/sparse history/i.test(value)));
});

test("allocation weights scale deterministically without reviving excluded categories",()=>{
  const weights=validateDiscoveryAllocationWeights({linkedin:25,jobspy:25,priority:25,native:15,directories:10},allocations),tiny=scaleDiscoveryAllocations(1,weights),restored=scaleDiscoveryAllocations(100,weights),excluded=validateDiscoveryAllocationWeights({linkedin:0,jobspy:0,priority:3,native:2,directories:0},allocations),scaled=scaleDiscoveryAllocations(17,excluded);
  assert.deepEqual(tiny,{linkedin:1,jobspy:0,priority:0,native:0,directories:0});assert.deepEqual(restored,{linkedin:25,jobspy:25,priority:25,native:15,directories:10});assert.equal(Object.values(scaled).reduce((a,b)=>a+b,0),17);assert.equal(scaled.linkedin,0);assert.equal(scaled.jobspy,0);assert.equal(scaled.directories,0);
});

test("forecast series shares one prepared model and matches a single projection",()=>{
  const rows:ForecastHistoryRow[]=[];for(let index=0;index<8;index++)rows.push({runId:`run-${index}`,startedAt:new Date(Date.UTC(2026,8,index+1)).toISOString(),mode:"balanced",sourceId:"source",label:"Source",category:"native",planned:100,candidates:100,failures:0,newStrong:index+1});
  const asOf="2026-10-01T00:00:00.000Z",plans=[{limit:50,plan:[{sourceId:"source",label:"Source",category:"native",planned:50}]},{limit:100,plan:[{sourceId:"source",label:"Source",category:"native",planned:100}]}],series=buildTransparentForecastSeries(rows,plans,"balanced",asOf),single=buildTransparentForecast(rows,plans[1].plan,"balanced",100,asOf);
  assert.equal(series.length,2);assert.deepEqual(series[1],single);assert.ok(series[0].ml.lower<=series[0].ml.point&&series[0].ml.point<=series[0].ml.upper);
});

test("authoritative forecast snapshot reconciles the completed run outcome",()=>{
  const store=new Store(":memory:");try{const id="snapshot",now=new Date().toISOString(),scan=`discovery-${id}`;store.startDiscoveryRun(id,undefined,1,{sources:[{id:"fixture-feed",label:"Fixture",category:"native",planned:1}],allocations},"balanced");store.startRun(scan,"discovery");const forecast=store.discoveryForecast(1,{...allocations,native:1},"balanced",[{sourceId:"fixture-feed",label:"Fixture",category:"native",planned:1}]);store.saveDiscoveryForecast(id,{limit:1},forecast);
    const job:JobPosting={id:"aaaaaaaaaaaaaaaaaaaaaaaa",provider:"browser",sourceId:"fixture-feed",company:"Fixture",title:"Data Scientist",location:"Netherlands",url:"https://example.test/snapshot",canonicalUrl:`https://example.test/snapshot`,workArrangement:"onsite",roleFamily:"data-science",matchEvidence:{roleFamily:"data-science",roleTerm:"data scientist",locationTerm:"netherlands"},firstSeenAt:now,lastSeenAt:now,status:"active",raw:{}};store.upsertJob(job,job.id!,scan,{discoveryRunId:id});store.updateMatch(job.id,"strong",[]);store.recordDecision({jobId:job.id,url:job.url,sourceId:"fixture-feed",runId:scan,profileFingerprint:"fixture",decision:{matchState:"strong",retain:true,reasons:[],evidence:{},fieldsInspected:[]},job});store.queueEnrichment("queue-1",job,{sourceId:"fixture-feed",company:"Fixture",provider:"browser"},undefined,id);store.finishDiscoveryRun(id,{status:"completed",processed:1,employers:1,matching:1,nonmatching:0,errors:0});let snapshot=store.discoveryForecastSnapshot(id) as any;assert.equal(snapshot.actual_new_strong,1);assert.equal(snapshot.prediction.target,"new-strong-matches");assert.equal(snapshot.reconciliationStatus,"provisional");assert.equal(snapshot.reconciled_at,null);store.finishQueuedEnrichment("queue-1","complete");store.reconcileDiscoveryForecast(id);snapshot=store.discoveryForecastSnapshot(id) as any;assert.equal(snapshot.reconciliationStatus,"final");assert.ok(snapshot.reconciled_at);}finally{store.close();}
});
