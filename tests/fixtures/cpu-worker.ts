import { parentPort } from "node:worker_threads";

const until = Date.now() + 350;
while (Date.now() < until) Math.sqrt(Math.random());
parentPort?.postMessage({ type: "completed" });
parentPort?.close();
