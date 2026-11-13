import { Store } from "./database.js";
import { enrichPendingJobs } from "./quality.js";

export interface IdleEnrichmentStatus {
  state: "idle" | "running" | "paused" | "waiting";
  activeBatch: number;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastResult?: { processed: number; stored: number; skipped: number; failed: number; cancelled: number };
}

/** Processes persistent enrichment work only while discovery is idle. */
export function createIdleEnrichmentRunner(store: Store, discoveryActive: () => boolean) {
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const status: IdleEnrichmentStatus = { state: "idle", activeBatch: 0 };

  const schedule = (delay = 30_000) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
    timer.unref?.();
  };
  const run = async () => {
    if (stopped || controller) return;
    if (discoveryActive()) { status.state = "paused"; schedule(); return; }
    const pending = store.eligibleEnrichmentCount();
    if (!pending) { status.state = store.pendingEnrichmentCount() ? "waiting" : "idle"; status.activeBatch = 0; schedule(); return; }
    controller = new AbortController();
    status.state = "running";
    status.activeBatch = Math.min(20, pending);
    status.lastStartedAt = new Date().toISOString();
    try { status.lastResult = await enrichPendingJobs({ store, limit: 20, signal: controller.signal }); }
    catch (error) { if (!controller.signal.aborted) console.error("Idle enrichment failed:", error); }
    finally {
      status.lastFinishedAt = new Date().toISOString();
      controller = undefined;
      status.activeBatch = 0;
      status.state = discoveryActive() ? "paused" : store.eligibleEnrichmentCount() ? "idle" : store.pendingEnrichmentCount() ? "waiting" : "idle";
      schedule(status.lastResult?.processed ? 1_000 : 30_000);
    }
  };
  const pause = () => { status.state = "paused"; controller?.abort(new Error("Paused for discovery")); };
  const kick = () => {
    if (discoveryActive()) { status.state="paused"; return {status:"paused" as const,eligibleCount:store.eligibleEnrichmentCount()}; }
    if (controller) return {status:"running" as const,eligibleCount:status.activeBatch};
    const eligibleCount=store.eligibleEnrichmentCount();
    if (!eligibleCount) { status.state=store.pendingEnrichmentCount()?"waiting":"idle";return {status:status.state,eligibleCount:0}; }
    schedule(0);return {status:"scheduled" as const,eligibleCount};
  };
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); controller?.abort(new Error("Server stopped")); };
  schedule(1_000);
  return { status: () => ({ ...status }), pause, kick, stop };
}
