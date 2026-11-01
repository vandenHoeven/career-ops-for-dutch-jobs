import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDashboardApi } from "../src/dashboard-api.js";
import { Store } from "../src/database.js";
import type { JobPosting } from "../src/types.js";

test("dashboard API validates review and application writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-dashboard-")), store = new Store(join(dir, "test.sqlite"));
  store.startRun("run"); const job: JobPosting = { id: "aaaaaaaaaaaaaaaaaaaaaaaa", provider: "greenhouse", sourceId: "fixture", company: "Acme", title: "Data Scientist", location: "Amsterdam", description: "Python machine learning", url: "https://example.com/job", canonicalUrl: "https://example.com/job", workArrangement: "hybrid", roleFamily: "data-science", matchEvidence: { roleFamily: "data-science", roleTerm: "data scientist", locationTerm: "amsterdam" }, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), status: "active", raw: {} };
  store.upsertJob(job, "bbbbbbbbbbbbbbbbbbbbbbbb", "run"); const server = createDashboardApi(store); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("No address"); const base = `http://127.0.0.1:${address.port}`;
  try {
    const review = await fetch(`${base}/api/v1/jobs/${job.id}/review`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "reviewed" }) }); assert.equal(review.status, 200);
    const bad = await fetch(`${base}/api/v1/jobs/${job.id}/application`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "invented" }) }); assert.equal(bad.status, 400);
    const saved = await fetch(`${base}/api/v1/jobs/${job.id}/application`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "saved", notes: "Review later" }) }); assert.equal(saved.status, 200);
    const applications: any = await (await fetch(`${base}/api/v1/applications`)).json(); assert.equal(applications.items[0].stage, "saved");
    const list: any = await (await fetch(`${base}/api/v1/jobs?eligibility=all`)).json(); assert.equal(list.total, 1); assert.equal(list.items.length, 1);
    const trace: any = await (await fetch(`${base}/api/v1/jobs/${job.id}/trace`)).json();
    const posted = trace.dates.find((entry: any) => entry.key === "posted");
    assert.equal(posted.value, undefined); assert.equal(posted.source, "not supplied"); assert.equal(posted.precision, "unknown");
    assert.equal(trace.observations.length, 1); assert.equal(trace.observations[0].observed_url, job.canonicalUrl);
    const employers: any = await (await fetch(`${base}/api/v1/employers?limit=10`)).json(); assert.equal(typeof employers.total, "number");
    const benchmark: any = await (await fetch(`${base}/api/v1/coverage/benchmark`)).json(); assert.equal(benchmark.total, 120); assert.match(benchmark.label, /not total Dutch-market coverage/i);
    const sources: any = await (await fetch(`${base}/api/v1/source-performance?type=discovery&window=30d`)).json(); assert.equal(sources.type, "discovery");
    const providers: any = await (await fetch(`${base}/api/v1/source-performance?type=provider&window=lifetime`)).json(); assert.equal(providers.type, "provider");
    const overlap = await fetch(`${base}/api/v1/coverage/overlap?window=lifetime`); assert.equal(overlap.status, 200); assert.equal((await overlap.json() as any).window, "lifetime");
    const forecast=await fetch(`${base}/api/v1/discovery/forecast`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:100,allocations:{linkedin:25,jobspy:25,priority:25,native:15,directories:10}})});assert.equal(forecast.status,200);assert.equal((await forecast.json() as any).freshnessDays,7);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
