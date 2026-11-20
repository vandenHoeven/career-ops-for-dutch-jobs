import { Worker } from "node:worker_threads";
import type { DiscoveryDurationMinutes } from "./adaptive-discovery.js";

type ManagedWorker = { worker: Worker; reported: boolean; stopping: boolean };
type WorkerCallbacks = {
  onSettled?: (id: string) => void;
  onUnexpectedExit?: (id: string, message: string) => void;
  onForcedStop?: (id: string) => void;
};

export class DiscoveryWorkerManager {
  private readonly workers = new Map<string, ManagedWorker>();

  constructor(
    private readonly callbacks: WorkerCallbacks = {},
    private readonly workerUrl = new URL("./discovery-worker.js", import.meta.url),
  ) {}

  start(id: string, durationMinutes: DiscoveryDurationMinutes): void {
    if (this.workers.has(id)) throw new Error(`Discovery ${id} is already running`);
    const worker = new Worker(this.workerUrl, { workerData: { id, durationMinutes } });
    const managed: ManagedWorker = { worker, reported: false, stopping: false };
    this.workers.set(id, managed);
    worker.on("message", (message: any) => {
      if (message?.type === "completed" || message?.type === "failed") {
        managed.reported = true;
        if (message.type === "failed") {
          console.error(`Discovery ${id} failed: ${message.error ?? "Unknown worker error"}`);
          this.callbacks.onUnexpectedExit?.(id, message.error ?? "Unknown worker error");
        }
      }
    });
    worker.on("error", (error) => {
      if (!managed.stopping && !managed.reported) {
        managed.reported = true;
        this.callbacks.onUnexpectedExit?.(id, error.message);
      }
    });
    worker.on("exit", (code) => {
      this.workers.delete(id);
      if (!managed.stopping && !managed.reported)
        this.callbacks.onUnexpectedExit?.(id, `Discovery worker exited with code ${code}`);
      this.callbacks.onSettled?.(id);
    });
  }

  cancel(id: string, reason = "Cancelled from dashboard"): boolean {
    const managed = this.workers.get(id);
    if (!managed) return false;
    managed.worker.postMessage({ type: "cancel", reason });
    return true;
  }

  has(id: string): boolean {
    return this.workers.has(id);
  }

  async shutdown(graceMs = 5_000): Promise<void> {
    const entries = [...this.workers.entries()];
    for (const [, managed] of entries) {
      managed.stopping = true;
      managed.worker.postMessage({ type: "cancel", reason: "Dashboard server shutting down" });
    }
    await Promise.all(entries.map(async ([id, managed]) => {
      const exited = new Promise<boolean>(resolve => managed.worker.once("exit", () => resolve(true)));
      const graceful = await Promise.race([exited, new Promise<boolean>(resolve => setTimeout(() => resolve(false), graceMs))]);
      if (!graceful) {
        await managed.worker.terminate();
        this.callbacks.onForcedStop?.(id);
      }
    }));
  }
}
