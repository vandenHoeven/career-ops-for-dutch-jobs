#!/usr/bin/env node
import { recallCheck } from './recall.js';
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { databasePath, loadProfile, loadSources, projectRoot } from "./config.js";
import { Store } from "./database.js";
import { providerIds, resolveProvider } from "./providers.js";
import { startDashboardApi } from "./dashboard-api.js";
import { isProviderId, scan } from "./scanner.js";
import { discover } from "./discovery.js";
import { enrichJobs, enrichPendingJobs, rescoreJobs } from "./quality.js";

const [command = "help", ...args] = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };

async function main(): Promise<void> {
  if(command==='recall-check'){const path=flag('--file')??'tests/fixtures/recall-30.json';const result=await recallCheck(path,args.includes('--live'));console.log(JSON.stringify(result,null,2));if(result.failed)process.exitCode=1;return;}
  if (command === "scan") {
    const provider = flag("--provider");
    if (provider && !isProviderId(provider)) throw new Error(`Unknown provider '${provider}'. Use: ${providerIds.join(", ")}`);
    console.log(JSON.stringify(await scan({ provider, resume: args.includes("--resume") }), null, 2)); return;
  }
  if (command === "discover") { console.log(JSON.stringify(await discover({ limit: Number(flag("--limit") ?? 100), source: flag("--source"), resume: args.includes("--resume"), retryFailures: args.includes("--retry-failures"), handleSignals: true, onProgress: message => console.error(message) }), null, 2)); return; }
  if (command === "serve") { const port = Number(flag("--port") ?? process.env.PORT ?? 4310); startDashboardApi(port); return; }
  const store = new Store();
  try {
    if (command === "jobs") {
      const rows = store.jobs({ q: flag("--search"), company: flag("--company"), provider: flag("--provider"), roleFamily: flag("--role"), status: flag("--status") as any, minScore: flag("--min-score") ? Number(flag("--min-score")) : undefined, reviewState: flag("--review") as any, applicationStage: flag("--stage") as any, seniority: flag("--seniority"), remote: flag("--work-arrangement"), sort: flag("--sort"), limit: Number(flag("--limit") ?? 50) }) as any[];
      if (args.includes("--summary")) console.table(rows.map(row => ({ score: row.overall_score ?? "-", company: row.company, title: row.title, location: row.location, seen: String(row.last_seen_at).slice(0, 10), review: row.review_state, stage: row.application_stage ?? "-" })));
      else console.log(JSON.stringify(rows, null, 2)); return;
    }
    if (command === "sources") { console.log(JSON.stringify(store.sources(), null, 2)); return; }
    if (command === "stats") { console.log(JSON.stringify(store.stats(), null, 2)); return; }
    if (command === "employers") { console.log(JSON.stringify(store.employers({ name: flag("--name"), headquarters: flag("--headquarters"), provider: flag("--provider"), boardStatus: flag("--board-status"), limit: Number(flag("--limit") ?? 50) }), null, 2)); return; }
    if (command === "coverage") { console.log(JSON.stringify(store.coverage(), null, 2)); return; }
    if (command === "discovery-failures") { console.log(JSON.stringify(store.discoveryFailures({ retryable: args.includes("--retryable") ? true : undefined, source: flag("--source"), limit: Number(flag("--limit") ?? 100), history: args.includes("--history"), includeMissing: args.includes("--include-missing") }), null, 2)); return; }
    if (command === "rescore") { console.log(JSON.stringify(await rescoreJobs({ store, jobId: flag("--job") }), null, 2)); return; }
    if (command === "enrich") { console.log(JSON.stringify(args.includes("--pending") ? await enrichPendingJobs({store,limit:Number(flag("--limit")??100)}) : await enrichJobs({ store, jobId: flag("--job"), missing: args.includes("--missing") }), null, 2)); return; }
    if (command === "doctor") {
      const sources = await loadSources(), profile = await loadProfile();
      await access(resolve(projectRoot, "config/profile.json"));
      console.log(JSON.stringify({ ok: true, node: process.version, databasePath, enabledSources: sources.length, providers: [...new Set(sources.map(source => resolveProvider(source).id))], roleFamilies: Object.keys(profile.roleFamilies) }, null, 2)); return;
    }
  } finally { store.close(); }
  console.log(`Diego Career Ops\n\nCommands:\n  recall-check [--file PATH] [--live]\n  discover [--limit N] [--source ID] [--resume] [--retry-failures]\n  discovery-failures [--retryable] [--source ID] [--limit N] [--include-missing] [--history]\n  scan [--provider ID] [--resume]\n  serve [--port 4310]\n  jobs [--search TEXT] [--company NAME] [--provider ID] [--role FAMILY] [--status STATUS]\n  employers [--name TEXT] [--headquarters VALUE] [--provider ID] [--board-status STATUS]\n  coverage\n  sources\n  stats\n  doctor`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
