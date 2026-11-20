import test from "node:test";
import assert from "node:assert/strict";
import { DiscoveryWorkerManager } from "../src/discovery-worker-manager.js";

test("CPU-heavy discovery work does not block the server event loop",async()=>{
  let settled!:()=>void;const done=new Promise<void>(resolve=>{settled=resolve}),manager=new DiscoveryWorkerManager({onSettled:()=>settled()},new URL("./fixtures/cpu-worker.js",import.meta.url));
  const started=Date.now();manager.start("cpu-fixture",5);await new Promise<void>(resolve=>setTimeout(resolve,25));const elapsed=Date.now()-started;
  assert.ok(elapsed<200,`main event loop was delayed ${elapsed} ms`);await done;await manager.shutdown();
});
