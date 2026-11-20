import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDashboardApi } from "../src/dashboard-api.js";
import { Store } from "../src/database.js";
import type { JobPosting } from "../src/types.js";
import { loadProfile } from "../src/config.js";

test("dashboard API validates review and application writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-dashboard-")), store = new Store(join(dir, "test.sqlite"));
  store.startRun("run"); const job: JobPosting = { id: "aaaaaaaaaaaaaaaaaaaaaaaa", provider: "greenhouse", sourceId: "fixture", company: "Acme", title: "Data Scientist", location: "Amsterdam", description: "Python machine learning", url: "https://example.com/job", canonicalUrl: "https://example.com/job", workArrangement: "hybrid", roleFamily: "data-science", matchEvidence: { roleFamily: "data-science", roleTerm: "data scientist", locationTerm: "amsterdam" }, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), status: "active", raw: {} };
  store.upsertJob(job, "bbbbbbbbbbbbbbbbbbbbbbbb", "run");store.backfillLocationAccess(await loadProfile()); const server = createDashboardApi(store); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("No address"); const base = `http://127.0.0.1:${address.port}`;
  try {
    const review = await fetch(`${base}/api/v1/jobs/${job.id}/review`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "reviewed" }) }); assert.equal(review.status, 200);
    const bad = await fetch(`${base}/api/v1/jobs/${job.id}/application`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "invented" }) }); assert.equal(bad.status, 400);
    const saved = await fetch(`${base}/api/v1/jobs/${job.id}/application`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "saved", notes: "Review later" }) }); assert.equal(saved.status, 200);
    const partial = await fetch(`${base}/api/v1/jobs/${job.id}/application`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "preparing" }) }); assert.equal(partial.status, 200);
    assert.equal((await partial.json() as any).notes, "Review later", "partial application updates preserve omitted fields");
    const applications: any = await (await fetch(`${base}/api/v1/applications`)).json(); assert.equal(applications.items[0].stage, "preparing");
    const applied = await fetch(`${base}/api/v1/jobs/${job.id}/application`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "applied" }) });
    const appliedRecord: any = await applied.json(); assert.equal(applied.status, 200); assert.ok(appliedRecord.appliedAt, "entering a submitted stage records its date automatically");
    const secondInterview = await fetch(`${base}/api/v1/jobs/${job.id}/application`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "second_interview" }) });
    const secondInterviewRecord: any = await secondInterview.json(); assert.equal(secondInterview.status, 200); assert.equal(secondInterviewRecord.stage, "second_interview"); assert.equal(secondInterviewRecord.appliedAt, appliedRecord.appliedAt, "later submitted stages preserve the original applied date");
    const withdrawn = await fetch(`${base}/api/v1/jobs/${job.id}/application`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "withdrawn" }) }); assert.equal(withdrawn.status, 200);
    const history: any = await (await fetch(`${base}/api/v1/jobs/${job.id}/application/history`)).json(); assert.equal(history.items[0].to_stage, "withdrawn"); assert.equal(history.items[1].to_stage, "second_interview"); assert.ok(history.items[0].occurred_at);
    const list: any = await (await fetch(`${base}/api/v1/jobs?eligibility=all`)).json(); assert.equal(list.total, 1); assert.equal(list.items.length, 1);assert.equal(list.items[0].location_access_tier,'medium');assert.equal(list.items[0].locationAccess.matchedCity,'Amsterdam');
    const medium:any=await (await fetch(`${base}/api/v1/jobs?eligibility=all&locationAccess=medium`)).json();assert.equal(medium.total,1);
    const easy:any=await (await fetch(`${base}/api/v1/jobs?eligibility=all&locationAccess=easy`)).json();assert.equal(easy.total,0);
    const trace: any = await (await fetch(`${base}/api/v1/jobs/${job.id}/trace`)).json();
    const posted = trace.dates.find((entry: any) => entry.key === "posted");
    assert.equal(posted.value, undefined); assert.equal(posted.source, "not supplied"); assert.equal(posted.precision, "unknown");
    assert.equal(trace.observations.length, 1); assert.equal(trace.observations[0].observed_url, job.canonicalUrl);
    const employers: any = await (await fetch(`${base}/api/v1/employers?limit=10`)).json(); assert.equal(typeof employers.total, "number");
    const benchmark: any = await (await fetch(`${base}/api/v1/coverage/benchmark`)).json(); assert.equal(benchmark.total, 120); assert.match(benchmark.label, /not total Dutch-market coverage/i);
    const sources: any = await (await fetch(`${base}/api/v1/source-performance?type=discovery&window=30d`)).json(); assert.equal(sources.type, "discovery");
    const providers: any = await (await fetch(`${base}/api/v1/source-performance?type=provider&window=lifetime`)).json(); assert.equal(providers.type, "provider");
    const overlap = await fetch(`${base}/api/v1/coverage/overlap?window=lifetime`); assert.equal(overlap.status, 200); assert.equal((await overlap.json() as any).window, "lifetime");
    const forecast=await fetch(`${base}/api/v1/discovery/forecast`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({durationMinutes:5})});assert.equal(forecast.status,200);const forecastBody:any=await forecast.json();assert.equal(forecastBody.durationMinutes,5);assert.equal(forecastBody.forecast.target,"new-strong-posted-within-7-days");assert.equal(forecastBody.objective.weights.unknown,0);assert.equal(forecastBody.objective.weights["8-30"],0);assert.deepEqual(forecastBody.durations,[5,10,20,30]);assert.equal(forecastBody.forecast.durations.length,4);assert.equal(forecastBody.waitingOptions.length,4);
    const plan:any=await (await fetch(`${base}/api/v1/discovery/plan?durationMinutes=10`)).json();assert.equal(plan.durationMinutes,10);assert.match(plan.deadlinePolicy,/Stop launching/);assert.ok(plan.sources.length>0);assert.ok(plan.sources.every((row:any)=>typeof row.score==="number"));
    const invalidDuration=await fetch(`${base}/api/v1/discovery`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({durationMinutes:7})});assert.equal(invalidDuration.status,400);
    const discoveryId="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";store.startDiscoveryRun(discoveryId,undefined,10,undefined,"fresh");store.recordDiscoveryEvent(discoveryId,{phase:"planning",type:"run-started",message:"Fresh run started"});
    const status:any=await (await fetch(`${base}/api/v1/discovery/status`)).json();assert.equal(status.active,true);assert.equal(status.run.id,discoveryId);assert.equal("sources" in status.run,false);
    const duplicate=await fetch(`${base}/api/v1/discovery`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({durationMinutes:10})});assert.equal(duplicate.status,409);const duplicateBody:any=await duplicate.json();assert.equal(duplicateBody.activeRun.id,discoveryId);
    const enrichment:any=await (await fetch(`${base}/api/v1/enrichment/queue`)).json();assert.equal(typeof enrichment.total,"number");assert.equal(typeof enrichment.summary.eligibleNow,"number");assert.equal(enrichment.runnerStatus.state,"paused");
    const processEnrichment=await fetch(`${base}/api/v1/enrichment/queue/process`,{method:"POST"});assert.equal(processEnrichment.status,409);assert.equal((await processEnrichment.json() as any).status,"paused");
    const run:any=await (await fetch(`${base}/api/v1/discovery/runs/${discoveryId}`)).json();assert.equal(run.mode,"fresh");assert.equal(run.phase,"planning");assert.ok("eta" in run);
    const runTrace:any=await (await fetch(`${base}/api/v1/discovery/runs/${discoveryId}/trace?after=0`)).json();assert.equal(runTrace.items[0].event_type,"run-started");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("dashboard startup recovers an orphaned discovery as interrupted",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"diego-dashboard-recovery-")),store=new Store(join(dir,"test.sqlite"));store.claimTimedDiscoveryRun("orphan",300_000);const server=createDashboardApi(store);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("No address");
  try{const status:any=await (await fetch(`http://127.0.0.1:${address.port}/api/v1/discovery/status`)).json(),row=store.db.prepare("SELECT status,phase FROM discovery_runs WHERE id='orphan'").get() as any;assert.deepEqual(status,{active:false,run:null});assert.equal(row.status,"interrupted");assert.equal(row.phase,"cancelled");}
  finally{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(dir,{recursive:true,force:true});}
});
