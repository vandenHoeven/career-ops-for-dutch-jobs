import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApi } from "../src/api.js";
import { Store } from "../src/database.js";

test("local API exposes health, jobs and stats", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-api-test-"));
  const store = new Store(join(dir, "test.sqlite"));
  const server = createApi(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const landing = await fetch(`${base}/`);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Diego Career Ops API/);
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
    const jobs: any = await (await fetch(`${base}/api/v1/jobs?limit=10`)).json();
    assert.deepEqual(jobs.items, []);
    const stats: any = await (await fetch(`${base}/api/v1/stats`)).json();
    assert.equal(stats.total, 0);
    assert.deepEqual((await (await fetch(`${base}/api/v1/employers`)).json() as any).items, []);
    assert.equal((await (await fetch(`${base}/api/v1/coverage`)).json() as any).employers, 0);
    assert.deepEqual((await (await fetch(`${base}/api/v1/discovery/sources`)).json() as any).items, []);
    assert.deepEqual((await (await fetch(`${base}/api/v1/discovery/failures`)).json() as any).items, []);
    const overlap: any = await (await fetch(`${base}/api/v1/coverage/overlap?window=lifetime`)).json();
    assert.equal(overlap.window, "lifetime"); assert.deepEqual(overlap.summaries, []);
    const forecastResponse=await fetch(`${base}/api/v1/discovery/forecast`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:100,allocations:{linkedin:25,jobspy:25,priority:25,native:15,directories:10}})});
    assert.equal(forecastResponse.status,200);const forecast:any=await forecastResponse.json();assert.equal(forecast.target,"new-strong-matches");assert.equal(forecast.mode,"balanced");assert.ok(forecast.ml.lower<=forecast.ml.point&&forecast.ml.point<=forecast.ml.upper);assert.equal(forecast.curve.minLimit,1);assert.equal(forecast.curve.maxLimit,1000);assert.ok(forecast.curve.points.length>=20);const currentPoint=forecast.curve.points.find((point:any)=>point.limit===100);assert.ok(currentPoint);assert.equal(currentPoint.ml.point,forecast.ml.point);
    const weightedForecast=await fetch(`${base}/api/v1/discovery/forecast`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:1200,allocations:{linkedin:300,jobspy:300,priority:300,native:180,directories:120},allocationWeights:{linkedin:1,jobspy:1,priority:1,native:0,directories:0}})});assert.equal(weightedForecast.status,200);const weighted:any=await weightedForecast.json();assert.equal(weighted.curve.maxLimit,1200);assert.equal(weighted.curve.allocationWeights.native,0);
    const invalidWeights=await fetch(`${base}/api/v1/discovery/forecast`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:100,allocations:{linkedin:25,jobspy:25,priority:25,native:15,directories:10},allocationWeights:{linkedin:-1}})});assert.equal(invalidWeights.status,400);
    const refreshForecast=await fetch(`${base}/api/v1/discovery/forecast`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:100,mode:"refresh-known",allocations:{linkedin:25,jobspy:25,priority:25,native:15,directories:10},allocationWeights:{linkedin:1,jobspy:0,priority:0,native:0,directories:0}})});assert.equal(refreshForecast.status,200);const refresh:any=await refreshForecast.json();assert.deepEqual(refresh.curve.allocationWeights,{linkedin:0,jobspy:0,priority:1,native:0,directories:0});
    const turboPlan:any=await (await fetch(`${base}/api/v1/discovery/plan?limit=9&mode=turbo`)).json();assert.equal(turboPlan.rules.selectionPolicy,"turbo-tiered");assert.equal(turboPlan.sources.reduce((sum:number,row:any)=>sum+row.planned,0),9);
    const turboForecastResponse=await fetch(`${base}/api/v1/discovery/forecast`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:9,mode:"turbo",workers:1,allocations:{bad:true}})});assert.equal(turboForecastResponse.status,200);const turboForecast:any=await turboForecastResponse.json();assert.equal(turboForecast.mode,"turbo");assert.equal(turboForecast.curve.points.find((point:any)=>point.limit===9).ml.point,turboForecast.ml.point);
    const invalidForecast=await fetch(`${base}/api/v1/discovery/forecast`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:100,allocations:{linkedin:24,jobspy:25,priority:25,native:15,directories:10}})});
    assert.equal(invalidForecast.status,400);
    assert.equal((await fetch(`${base}/api/v1/nope`)).status, 404);
  } finally {
    server.close(); await once(server, "close"); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
