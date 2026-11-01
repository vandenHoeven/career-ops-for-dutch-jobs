import { processJob } from "./processing.js";
import { collectSource, checkpointCollection } from "./collection.js";
import { enrichJob } from "./enrichment.js";
import { assessLocation } from "./locations.js";
import { isPlausibleRecallCandidate } from "./core.js";
import { randomUUID } from "node:crypto";
import { canonicalizeUrl, deduplicate, fingerprint, stableJobId } from "./core.js";
import { loadProfile, loadSources } from "./config.js";
import { Store } from "./database.js";
import { createHttpContext } from "./http.js";
import { resolveProvider } from "./providers.js";
import type { ProviderId } from "./types.js";

export interface ScanOptions { provider?: string; resume?: boolean; store?: Store; context?: import("./types.js").FetchContext }
export interface ScanResult { id: string; status: string; found: number; accepted: number; duplicates: number; errors: number }

export async function scan(options: ScanOptions = {}): Promise<ScanResult> {
  const ownedStore = !options.store;
  const store = options.store ?? new Store();
  try {
    const profile = await loadProfile();
    const manual = await loadSources();
    const discovered = store.discoveredSources();
    let sources = [...manual, ...discovered].filter((source, index, all) => all.findIndex(other => other.careersUrl === source.careersUrl) === index);
    if (options.provider) sources = sources.filter(source => resolveProvider(source).id === options.provider);
    store.syncSources(sources, source => resolveProvider(source).id);
    const prior = options.resume ? store.incompleteRun(options.provider) : null;
    const id = prior?.id ?? randomUUID();
    if (!prior) store.startRun(id, options.provider);
    const completed = prior?.checkpoint ?? [];
    let found = 0, accepted = 0, duplicates = 0, errors = 0, partial = false, enrichmentUsed = 0;
    const context = options.context ?? createHttpContext();
    
    for (const source of sources) {
      if (completed.includes(source.id)) continue;
      const provider = resolveProvider(source);
      try {
        const result=await collectSource(store,source,context), raw=result.jobs;
        found+=raw.length;
        const unique=deduplicate(raw);duplicates+=unique.duplicateCount;
        store.transaction(()=>{
          for(const job of unique.jobs) {
            const processed=processJob(job,{store,profile,sourceId:source.id,provider:provider.id,scanId:id,boardUrl:source.careersUrl,candidate:{sourceId:source.id,company:source.company,boardUrl:source.careersUrl,provider:provider.id}});
            if(processed.decision.retain)accepted++;
          }
          checkpointCollection(store,source,result);
          if(result.complete)store.ageUnseenBoard(source.careersUrl,store.collection(source.careersUrl).snapshot_started_at,profile.expiryAfterMissedScans);
        });
        for(const job of unique.jobs)if(enrichmentUsed<100 && assessLocation(job,profile).state!=='foreign' && isPlausibleRecallCandidate(job,profile) && (job.description?.length??0)<160) {
          enrichmentUsed++;
          const enriched=await enrichJob(job,context);
          const existingId=store.jobIdFor(stableJobId(provider.id,job),canonicalizeUrl(job.url),fingerprint(job));
          if(store.job(existingId))processJob(enriched.job,{store,profile,sourceId:source.id,provider:provider.id,existingId,enrichmentStatus:enriched.status,enrichmentError:enriched.error});
          const queueId=stableJobId('enrichment',job);
          store.finishQueuedEnrichment(queueId,enriched.status==='failed'||enriched.status==='unavailable'?'failed':'complete',enriched.error,enriched.retryAfterMs);
        }
        if(!result.complete){partial=true;if(result.error){errors++;store.recordFailure(id,source.id,provider.id,new Error(result.error));}}
        else completed.push(source.id);
        store.markSource(source, provider.id, result.error);
      } catch (error) {
        errors++;
        store.recordFailure(id, source.id, provider.id, error);
        store.markSource(source, provider.id, error instanceof Error ? error.message : String(error));
      }

      store.updateRun(id, { checkpoint: completed, found, accepted, duplicates, errors });
    }
    const status = errors === 0 && !partial ? "completed" : partial || accepted > 0 || sources.length > 1 ? "partial" : "failed";
    store.finishRun(id, status as "completed" | "partial" | "failed");
    return { id, status, found, accepted, duplicates, errors };
  } finally { if (ownedStore) store.close(); }
}

export function isProviderId(value: string): value is ProviderId {
  return ["greenhouse", "lever", "ashby", "workable", "recruitee", "personio", "smartrecruiters", "workday", "icims", "government", "academictransfer", "browser"].includes(value);
}
