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
    assert.equal(forecastResponse.status,200);assert.equal((await forecastResponse.json() as any).unmodelledCandidates,100);
    const invalidForecast=await fetch(`${base}/api/v1/discovery/forecast`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:100,allocations:{linkedin:24,jobspy:25,priority:25,native:15,directories:10}})});
    assert.equal(invalidForecast.status,400);
    assert.equal((await fetch(`${base}/api/v1/nope`)).status, 404);
  } finally {
    server.close(); await once(server, "close"); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
