import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/database.js";
import type { JobPosting } from "../src/types.js";

const allocations={linkedin:0,jobspy:0,priority:0,native:100,directories:0};

function addRun(store:Store,id:string,started:string,recent:number,undated:number,extra:{old?:number;refreshed?:number;excluded?:number}={}) {
  const finished=new Date(Date.parse(started)+60_000).toISOString(),source="fixture-feed",scan=`discovery-${id}`;
  store.startDiscoveryRun(id,undefined,100);
  store.saveDiscoveryPlan(id,{sources:[{id:source,label:"Fixture",category:"native",planned:100}]});
  store.startRun(scan,"discovery");
  store.db.prepare("UPDATE discovery_runs SET started_at=?,finished_at=?,status='completed',processed_count=100 WHERE id=?").run(started,finished,id);
  for(let index=0;index<25;index++)store.recordDiscoveryAttempt({runId:id,sourceId:source,company:`Company ${id} ${index}`,startedAt:started,durationMs:1,result:"matched",retryable:false,jobsFetched:1,netherlandsJobs:1,profileMatches:0,candidate:{sourceId:source,company:`Company ${id} ${index}`}});
  let sequence=0;
  const add=(kind:"recent"|"undated"|"old"|"refreshed"|"excluded")=>{
    const token=(id+String(sequence++)).replace(/[^a-f0-9]/g,"a").padEnd(24,"a").slice(0,24),firstSeen=kind==="refreshed"?new Date(Date.parse(started)-86_400_000).toISOString():new Date(Date.parse(started)+1_000).toISOString(),postedAt=kind==="undated"?undefined:kind==="old"?new Date(Date.parse(started)-8*86_400_000).toISOString():new Date(Date.parse(started)-7*86_400_000).toISOString();
    const job:JobPosting={id:token,provider:"browser",sourceId:source,company:"Fixture",title:`Data Analyst ${sequence}`,location:"Utrecht, Netherlands",url:`https://example.test/${token}`,canonicalUrl:`https://example.test/${token}`,postedAt,workArrangement:"onsite",roleFamily:"analytics",matchEvidence:{roleFamily:"analytics",roleTerm:"data analyst",locationTerm:"utrecht"},firstSeenAt:firstSeen,lastSeenAt:firstSeen,status:"active",raw:{}};
    store.upsertJob(job,token,scan,{discoveryRunId:id});
    store.recordDecision({jobId:token,url:job.url,sourceId:source,runId:scan,profileFingerprint:"fixture",decision:{matchState:kind==="excluded"?"excluded":"strong",retain:kind!=="excluded",reasons:[],evidence:{},fieldsInspected:[]},job});
  };
  for(let i=0;i<recent;i++)add("recent");for(let i=0;i<undated;i++)add("undated");for(let i=0;i<(extra.old??0);i++)add("old");for(let i=0;i<(extra.refreshed??0);i++)add("refreshed");for(let i=0;i<(extra.excluded??0);i++)add("excluded");
}

test("forecast weights recent runs and separates undated new matches",()=>{
  const store=new Store(":memory:");
  try{
    addRun(store,"older","2026-10-29T10:00:00.000Z",10,0);
    addRun(store,"newer","2026-10-30T10:00:00.000Z",2,1,{old:2,refreshed:1,excluded:1});
    const forecast=store.discoveryForecast(100,allocations),native=forecast.categories.find(row=>row.category==="native")!;
    assert.equal(forecast.expectedRecentMatches,20);
    assert.equal(forecast.expectedUndatedMatches,2.5);
    assert.equal(native.historicalRuns,2);
    assert.equal(native.historicalCandidates,50);
    assert.equal(forecast.confidence,"low");
    assert.equal(forecast.unmodelledCandidates,0);
  }finally{store.close();}
});

test("forecast marks allocated categories without comparable history as unmodelled",()=>{
  const store=new Store(":memory:");
  try{
    const forecast=store.discoveryForecast(100,{linkedin:25,jobspy:25,priority:25,native:15,directories:10});
    assert.equal(forecast.expectedRecentMatches,0);
    assert.equal(forecast.unmodelledCandidates,100);
    assert.equal(forecast.confidence,"low");
    assert.ok(forecast.categories.every(row=>!row.modelled));
  }finally{store.close();}
});
