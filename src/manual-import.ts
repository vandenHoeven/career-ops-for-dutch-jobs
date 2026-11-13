import { randomUUID } from "node:crypto";
import { loadProfile } from "./config.js";
import { canonicalizeUrl } from "./core.js";
import { Store } from "./database.js";
import { createHttpContext } from "./http.js";
import { parsePublicPostings, parseVisiblePosting } from "./posting-parser.js";
import { processJob } from "./processing.js";
import type { FetchContext, RawJob } from "./types.js";

export interface ManualImportOptions {
  store: Store;
  url: string;
  saveToPipeline?: boolean;
  context?: FetchContext;
}

function validatedPublicUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw Object.assign(new Error("Enter a complete vacancy URL, including https://"), { statusCode: 400 }); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw Object.assign(new Error("Only public HTTPS vacancy URLs without credentials or custom ports are supported"), { statusCode: 400 });
  }
  url.hash = "";
  return url.toString();
}

function companyFallback(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const label = host.split(".")[0].replace(/^werkenbij/i, "").replace(/[-_]+/g, " ").trim();
  return label ? label.replace(/\b\w/g, character => character.toUpperCase()) : host;
}

function choosePosting(jobs: RawJob[], requestedUrl: string): RawJob | undefined {
  const requested = canonicalizeUrl(requestedUrl);
  return jobs.find(job => canonicalizeUrl(job.url) === requested) ?? (jobs.length === 1 ? jobs[0] : undefined);
}

/** Import one public vacancy page through the same scoring and persistence boundary as discovery. */
export async function importVacancyUrl(options: ManualImportOptions) {
  const url = validatedPublicUrl(options.url);
  const context = options.context ?? createHttpContext({ retries: 1, timeoutMs: 20_000 });
  const html = await context.fetchText(url);
  const fallback = companyFallback(url);
  const job = choosePosting(parsePublicPostings(html, url, fallback), url) ?? parseVisiblePosting(html, url, fallback);
  if (!job) {
    throw Object.assign(new Error("This page did not expose a recognizable vacancy. Check that the link opens a single public job posting."), { statusCode: 422 });
  }

  const profile = await loadProfile();
  const scanId = randomUUID();
  options.store.startRun(scanId, "browser");
  try {
    const processed = processJob(job, {
      store: options.store,
      profile,
      sourceId: "manual-url",
      provider: "browser",
      scanId,
      boardUrl: url,
    });
    if (!processed.id) throw new Error("The vacancy could not be stored");
    if (options.saveToPipeline !== false) options.store.upsertApplication(processed.id, { stage: "saved" });
    options.store.updateRun(scanId, { checkpoint: [url], found: 1, accepted: processed.decision.retain ? 1 : 0, duplicates: processed.write === "refreshed" ? 1 : 0, errors: 0 });
    options.store.finishRun(scanId, "completed");
    return { jobId: processed.id, importStatus: processed.write, savedToPipeline: options.saveToPipeline !== false, matchState: processed.decision.matchState };
  } catch (error) {
    options.store.recordFailure(scanId, "manual-url", "browser", error);
    options.store.updateRun(scanId, { checkpoint: [], found: 1, accepted: 0, duplicates: 0, errors: 1 });
    options.store.finishRun(scanId, "failed");
    throw error;
  }
}
