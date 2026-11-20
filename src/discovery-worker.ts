import { parentPort, workerData } from "node:worker_threads";
import { discover } from "./discovery.js";
import type { DiscoveryDurationMinutes } from "./adaptive-discovery.js";

type WorkerInput = { id: string; durationMinutes: DiscoveryDurationMinutes };
type WorkerCommand = { type: "cancel"; reason?: string };

const port = parentPort;
if (!port) throw new Error("Discovery worker requires a parent port");
const input = workerData as WorkerInput;
const controller = new AbortController();

const onMessage = (message: WorkerCommand) => {
  if (message?.type === "cancel" && !controller.signal.aborted)
    controller.abort(new Error(message.reason ?? "Cancelled from dashboard"));
};
port.on("message", onMessage);

try {
  await discover({
    runId: input.id,
    durationMinutes: input.durationMinutes,
    signal: controller.signal,
    claimedRun: true,
  });
  port.postMessage({ type: "completed", id: input.id });
} catch (error) {
  port.postMessage({
    type: "failed",
    id: input.id,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  port.off("message", onMessage);
  port.close();
}
