import { coverageRoutes } from './diagnostics.js';
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Store, type JobQuery } from "./database.js";
import { adaptiveDiscoveryPreview } from "./discovery.js";
import { validateDiscoveryDuration } from "./adaptive-discovery.js";
import { DiscoveryWorkerManager } from "./discovery-worker-manager.js";
import { dataDir, loadProfile, projectRoot, saveProfile } from "./config.js";
import { enrichJobs, rescoreJobs } from "./quality.js";
import { aiCacheKey, aiConfig, requestAiAssessment } from "./ai-scoring.js";
import { profileFingerprint } from "./scoring.js";
import type { ApplicationStage, ProfileConfig, ReviewState } from "./types.js";
import { importVacancyUrl } from "./manual-import.js";
import { createIdleEnrichmentRunner } from "./idle-enrichment.js";

const reviews = new Set<ReviewState>(["new", "reviewed", "declined", "archived"]);
const stages = new Set<ApplicationStage>(["saved", "preparing", "applied", "screening", "interview", "second_interview", "assessment", "offer", "hired", "rejected", "withdrawn"]);
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
const num = (url: URL, key: string) => { const raw = url.searchParams.get(key); if (raw === null) return undefined; const value = Number(raw); return Number.isFinite(value) ? value : undefined; };
async function input(req: IncomingMessage): Promise<any> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 1_000_000) throw new Error("Request body is too large"); chunks.push(chunk); } return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
async function fileInput(req: IncomingMessage): Promise<Buffer> { const chunks: Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>25*1024*1024)throw Object.assign(new Error("File exceeds the 25 MB limit"),{statusCode:413});chunks.push(chunk)}return Buffer.concat(chunks); }
function compact(row: any): any { const { raw_json, description, match_evidence_json, score_breakdown_json, location_access_json, ...rest } = row; const evidence=match_evidence_json?JSON.parse(match_evidence_json):null; return { ...rest, locationAccess:location_access_json?JSON.parse(location_access_json):null,matchState:row.match_state,uncertaintyReasons:JSON.parse(row.uncertainty_reasons_json??'[]'),matchedFrom:evidence?.matchedFrom??null, matchConfidence:evidence?.confidence??null, summary: row.summary ?? (description ? String(description).slice(0, 240) : null) }; }
function detail(row: any): any { return { ...row, raw: row.raw_json ? JSON.parse(row.raw_json) : null, matchEvidence: row.match_evidence_json ? JSON.parse(row.match_evidence_json) : null, scoreBreakdown: row.score_breakdown_json ? JSON.parse(row.score_breakdown_json) : null, locationAccess:row.location_access_json?JSON.parse(row.location_access_json):null,raw_json: undefined, match_evidence_json: undefined, score_breakdown_json: undefined,location_access_json:undefined }; }
function required(store: Store, id: string): any { const job = store.job(id); if (!job) throw Object.assign(new Error("Job not found"), { statusCode: 404 }); return job; }
function jobQuery(url: URL): JobQuery { const boolean = (key: string) => url.searchParams.has(key) ? url.searchParams.get(key) === "true" : undefined, list=(key:string)=>url.searchParams.getAll(key).flatMap(value=>value.split(",")).filter(Boolean); return { matchState: (url.searchParams.get("matchState")??undefined) as any, q: url.searchParams.get("q") ?? undefined, company: url.searchParams.get("company") ?? undefined, location: url.searchParams.get("location") ?? undefined, locationAccess: (url.searchParams.get("locationAccess")??undefined) as JobQuery["locationAccess"], provider: url.searchParams.get("provider") ?? undefined, sourceId: url.searchParams.get("sourceId") ?? undefined, roleFamily: url.searchParams.get("roleFamily") ?? undefined, status: url.searchParams.get("status") as any, remote: url.searchParams.get("workArrangement") ?? undefined, minScore: num(url, "minScore"), reviewStates: list("reviewState") as ReviewState[], applicationStages: list("applicationStage") as ApplicationStage[], seniority: url.searchParams.get("seniority") ?? undefined, eligibility: (url.searchParams.get("eligibility") ?? undefined) as any, postedFrom: url.searchParams.get("postedFrom") ?? undefined, postedTo: url.searchParams.get("postedTo") ?? undefined, firstSeenFrom: url.searchParams.get("firstSeenFrom") ?? undefined, firstSeenTo: url.searchParams.get("firstSeenTo") ?? undefined, postedAvailable: boolean("postedAvailable"), sort: url.searchParams.get("sort") ?? undefined, limit: num(url, "limit"), offset: num(url, "offset") }; }
async function asset(pathname: string, res: ServerResponse): Promise<boolean> { const root = resolve(projectRoot, "web/dist"), path = resolve(root, pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")); if (!path.startsWith(root)) return false; try { if ((await stat(path)).isDirectory()) return false; const content = await readFile(path); res.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" }); res.end(content); return true; } catch { try { const content = await readFile(resolve(root, "index.html")); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(content); return true; } catch { return false; } } }

export function createDashboardApi(store = new Store()) {
  store.recoverOrphanedDiscoveryRuns();
  let open=true;
  const idleEnrichment=createIdleEnrichmentRunner(store,()=>store.hasActiveDiscoveryRun());
  const runner=new DiscoveryWorkerManager({
    onUnexpectedExit:(id,message)=>store.failDiscoveryRun(id,message),
    onForcedStop:id=>store.interruptDiscoveryRun(id),
    onSettled:()=>{if(open)idleEnrichment.kick();},
  });
  const server=createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost"), method = req.method ?? "GET";
      if(await coverageRoutes(req,res,url,store,{processEnrichment:()=>{
        if(store.hasActiveDiscoveryRun())return {statusCode:409,body:{error:"Description enrichment is paused while discovery is active",status:"paused"}};
        const result=idleEnrichment.kick(),summary=store.enrichmentQueueSummary();
        return {statusCode:result.status==="scheduled"?202:200,body:{...result,runnerStatus:idleEnrichment.status(),summary}};
      }}))return;
      if (method === "GET" && url.pathname === "/health") { const ai = aiConfig(); return json(res, 200, { ok: true, ai: { enabled: ai.enabled, ready: Boolean(ai.baseUrl && ai.apiKey && ai.model) } }); }
      if (method === "GET" && url.pathname === "/api/v1/overview") return json(res, 200, store.overview());
      if (method === "GET" && url.pathname === "/api/v1/jobs") { const query = jobQuery(url); return json(res, 200, { items: (store.jobs(query) as any[]).map(compact), total: store.jobCount(query), limit: query.limit ?? 50, offset: query.offset ?? 0 }); }
      const job = url.pathname.match(/^\/api\/v1\/jobs\/([a-f0-9]{24})$/); if (method === "GET" && job) return json(res, 200, detail(required(store, job[1])));
      const trace = url.pathname.match(/^\/api\/v1\/jobs\/([a-f0-9]{24})\/trace$/); if (method === "GET" && trace) { const value = store.jobTrace(trace[1]); return value ? json(res, 200, value) : json(res, 404, { error: "Job not found" }); }
      const review = url.pathname.match(/^\/api\/v1\/jobs\/([a-f0-9]{24})\/review$/); if (method === "PATCH" && review) { required(store, review[1]); const value = await input(req),state=value.state==="ignored"?"declined":value.state; if (!reviews.has(state)) return json(res, 400, { error: "Invalid review state" }); store.updateReviewState(review[1], state); return json(res, 200, detail(required(store, review[1]))); }
      const application = url.pathname.match(/^\/api\/v1\/jobs\/([a-f0-9]{24})\/application$/); if ((method === "PUT" || method === "PATCH") && application) { const current:any=required(store, application[1]); const value = await input(req),stage=value.stage??current.application?.stage; if (!stage||!stages.has(stage)) return json(res, 400, { error: "Invalid application stage" }); return json(res, 200, store.upsertApplication(application[1], {...value,stage})); }
      const history = url.pathname.match(/^\/api\/v1\/jobs\/([a-f0-9]{24})\/application\/history$/); if (method === "GET" && history) { required(store, history[1]); return json(res, 200, { items: store.applicationHistory(history[1]) }); }
      const documents = url.pathname.match(/^\/api\/v1\/jobs\/([a-f0-9]{24})\/application\/documents$/);
      if(method==="GET"&&documents){required(store,documents[1]);return json(res,200,{items:store.applicationDocuments(documents[1])});}
      if(method==="POST"&&documents){required(store,documents[1]);const category=url.searchParams.get("category")??"other",categories=new Set(["cv","motivation","other"]);if(!categories.has(category))return json(res,400,{error:"Invalid document category"});const originalName=basename(decodeURIComponent(req.headers["x-file-name"] as string||"document")),extension=extname(originalName).toLowerCase();if(![".pdf",".docx",".txt"].includes(extension))return json(res,400,{error:"Only PDF, DOCX, and TXT files are supported"});const content=await fileInput(req);if(!content.length)return json(res,400,{error:"File is empty"});const id=randomUUID(),folder=resolve(dataDir,"application-files",documents[1]);await mkdir(folder,{recursive:true});const storedName=`${id}${extension}`,absolute=resolve(folder,storedName);await writeFile(absolute,content);const value=store.addApplicationDocument({id,jobId:documents[1],category,label:url.searchParams.get("label")||undefined,originalName,storedName,mimeType:req.headers["content-type"]||"application/octet-stream",sizeBytes:content.length,checksum:createHash("sha256").update(content).digest("hex"),relativePath:`application-files/${documents[1]}/${storedName}`,submissionDate:url.searchParams.get("submissionDate")||undefined,replacesId:url.searchParams.get("replacesId")||undefined});return json(res,201,value);}
      const document = url.pathname.match(/^\/api\/v1\/application-documents\/([a-f0-9-]+)$/);
      if(method==="GET"&&document){const row=store.applicationDocument(document[1]);if(!row)return json(res,404,{error:"Document not found"});const absolute=resolve(dataDir,row.relative_path);if(!absolute.startsWith(resolve(dataDir,"application-files")))return json(res,400,{error:"Invalid document path"});const file=await stat(absolute);res.writeHead(200,{"content-type":row.mime_type,"content-length":file.size,"content-disposition":`attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`});try{await pipeline(createReadStream(absolute),res);}catch(error){res.destroy(error instanceof Error?error:undefined);}return;}
      if(method==="DELETE"&&document){const row=store.applicationDocument(document[1]);if(!row)return json(res,404,{error:"Document not found"});const absolute=resolve(dataDir,row.relative_path);if(!absolute.startsWith(resolve(dataDir,"application-files")))return json(res,400,{error:"Invalid document path"});await unlink(absolute).catch(()=>undefined);store.deleteApplicationDocument(document[1]);return json(res,200,{deleted:true});}
      const rescore = url.pathname.match(/^\/api\/v1\/jobs\/([a-f0-9]{24})\/rescore$/); if (method === "POST" && rescore) { required(store, rescore[1]); return json(res, 200, await rescoreJobs({ store, jobId: rescore[1] })); }
      const enrich = url.pathname.match(/^\/api\/v1\/jobs\/([a-f0-9]{24})\/enrich$/); if (method === "POST" && enrich) { required(store, enrich[1]); return json(res, 200, await enrichJobs({ store, jobId: enrich[1] })); }
      const aiRoute = url.pathname.match(/^\/api\/v1\/jobs\/([a-f0-9]{24})\/ai-score$/); if (method === "POST" && aiRoute) { const row: any = required(store, aiRoute[1]), profile = await loadProfile(), config = aiConfig(); if (!config.model) return json(res, 409, { error: "AI model is not configured" }); const safe = { title: row.title, company: row.company, location: row.location, description: row.description, summary: row.summary }, key = aiCacheKey(safe, profile, config.model, profileFingerprint(profile)); const cached = store.aiCache(key), assessment: any = cached ?? await requestAiAssessment(safe, profile); if (!cached) store.saveAiCache(key, row.id, config.model, assessment); store.updateAiScore(row.id, assessment.score, Math.round(Number(row.rule_score ?? 0) * .7 + assessment.score * .3)); return json(res, 200, { ...assessment, cached: Boolean(cached) }); }
      if (method === "GET" && url.pathname === "/api/v1/applications") return json(res, 200, { items: store.applications() });
      if (method === "GET" && url.pathname === "/api/v1/profile") return json(res, 200, await loadProfile());
      if (method === "PUT" && url.pathname === "/api/v1/profile") { const profile = await input(req) as ProfileConfig; await saveProfile(profile); const result = await rescoreJobs({ store }); return json(res, 200, { profile, ...result }); }
      if (method === "GET" && url.pathname === "/api/v1/stats") return json(res, 200, store.stats());
      if (method === "GET" && url.pathname === "/api/v1/employers") { const hiring = url.searchParams.get("hiring"), matches=url.searchParams.get("matches"), benchmark=url.searchParams.get("benchmark"); const query={ name: url.searchParams.get("name") || undefined, headquarters: url.searchParams.get("headquarters") || undefined, hiring: !hiring ? undefined : hiring === "true", matches:!matches?undefined:matches==="true", benchmark:!benchmark?undefined:benchmark==="true", provider: url.searchParams.get("provider") || undefined, source:url.searchParams.get("source")||undefined, boardStatus: url.searchParams.get("boardStatus") || undefined, since:url.searchParams.get("since")||undefined,sort:url.searchParams.get("sort")||undefined,limit: num(url, "limit"), offset: num(url, "offset") }; return json(res, 200, { items: store.employers(query), total:store.employerCount(query),limit:query.limit??50,offset:query.offset??0 }); }
      const employer = url.pathname.match(/^\/api\/v1\/employers\/([a-f0-9]{24})$/); if (method === "GET" && employer) { const value = store.employer(employer[1]); return value ? json(res, 200, value) : json(res, 404, { error: "Employer not found" }); }
      if (method === "GET" && url.pathname === "/api/v1/discovery/sources") return json(res, 200, { items: store.discoverySourceRows() });
      if (method === "POST" && url.pathname === "/api/v1/discovery/manual") {
        const body = await input(req);
        if (typeof body.url !== "string" || !body.url.trim()) return json(res, 400, { error: "Vacancy URL is required" });
        const result = await importVacancyUrl({ store, url: body.url, saveToPipeline: body.saveToPipeline !== false });
        return json(res, result.importStatus === "new" ? 201 : 200, { ...result, job: detail(required(store, result.jobId)) });
      }
      if (method === "GET" && url.pathname === "/api/v1/discovery/plan") return json(res,200,await adaptiveDiscoveryPreview(store,url.searchParams.get("durationMinutes")??10));
      if (method === "POST" && url.pathname === "/api/v1/discovery/forecast") { const body=await input(req);return json(res,200,await adaptiveDiscoveryPreview(store,body.durationMinutes)); }
      if (method === "GET" && url.pathname === "/api/v1/discovery/status") { const run=store.activeDiscoverySummary();return json(res,200,{active:Boolean(run),run}); }
      if (method === "GET" && url.pathname === "/api/v1/discovery/active") return json(res,200,store.activeDiscoveryRun());
      if (method === "GET" && url.pathname === "/api/v1/discovery/runs") return json(res, 200, { items: store.discoveryRuns() });
      const run = url.pathname.match(/^\/api\/v1\/discovery\/runs\/([a-f0-9-]+)$/); if (method === "GET" && run) { const value = store.discoveryRun(run[1]); return value ? json(res, 200, value) : json(res, 404, { error: "Discovery run not found" }); }
      const runTrace = url.pathname.match(/^\/api\/v1\/discovery\/runs\/([a-f0-9-]+)\/trace$/); if (method === "GET" && runTrace) { const value=store.discoveryTrace(runTrace[1],num(url,"after")??0,num(url,"limit")??200);return value?json(res,200,value):json(res,404,{error:"Discovery run not found"}); }
      const cancel = url.pathname.match(/^\/api\/v1\/discovery\/runs\/([a-f0-9-]+)\/cancel$/); if (method === "POST" && cancel) { if (!runner.cancel(cancel[1])) return json(res, 409, { error: "Run is not active" }); return json(res, 202, { id: cancel[1], status: "cancelling" }); }
      if (method === "GET" && url.pathname === "/api/v1/discovery/failures") return json(res, 200, { items: store.discoveryFailures({ retryable: url.searchParams.has("retryable") ? url.searchParams.get("retryable") === "true" : undefined, source: url.searchParams.get("source") ?? undefined, limit: num(url, "limit"), includeMissing: url.searchParams.get("includeMissing") === "true" }) });
      if (method === "GET" && url.pathname === "/api/v1/coverage") return json(res, 200, {...(store.coverage() as any),...store.coverageTrace()});
      if (method === "GET" && url.pathname === "/api/v1/source-performance") { const type=url.searchParams.get("type")==="provider"?"provider":"discovery",window=url.searchParams.get("window")==="lifetime"?"lifetime":"30d"; return json(res,200,store.sourcePerformance(type,window)); }
      if (method === "GET" && url.pathname === "/api/v1/enrichment/queue") {const runnerStatus=idleEnrichment.status(),activeDiscovery=store.hasActiveDiscoveryRun(),summary=store.enrichmentQueueSummary();return json(res,200,{items:store.enrichmentQueueCounts(),total:summary.eligibleNow+summary.coolingDown,summary,runnerStatus:{...runnerStatus,state:activeDiscovery?'paused':runnerStatus.state}});}
      const sourcePerformance=url.pathname.match(/^\/api\/v1\/source-performance\/([^/]+)$/); if(method==="GET"&&sourcePerformance){const window=url.searchParams.get("window")==="lifetime"?"lifetime":"30d";return json(res,200,store.sourcePerformanceDetail(decodeURIComponent(sourcePerformance[1]),window));}
      if(method==="GET"&&url.pathname==="/api/v1/coverage/benchmark")return json(res,200,store.benchmarkCoverage());
      if(method==="GET"&&url.pathname==="/api/v1/coverage/overlap")return json(res,200,store.coverageOverlap(url.searchParams.get("window")==="lifetime"?"lifetime":"30d"));
      if (method === "POST" && url.pathname === "/api/v1/discovery") { const body=await input(req),durationMinutes=validateDiscoveryDuration(body.durationMinutes);store.recoverStaleDiscoveryRuns();const id=randomUUID(),claim=store.claimTimedDiscoveryRun(id,durationMinutes*60_000);if(!claim.claimed)return json(res,409,{error:"A discovery run is already active",activeRun:claim.activeRun});idleEnrichment.pause();try{runner.start(id,durationMinutes);}catch(error){store.failDiscoveryRun(id,error instanceof Error?error.message:String(error));idleEnrichment.kick();throw error;}return json(res,202,{id,status:"starting",mode:"adaptive",durationMinutes,deadlineAt:new Date(Date.now()+durationMinutes*60_000).toISOString()}); }
      if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found" });
      if (method === "GET" && await asset(url.pathname, res)) return;
      return json(res, 404, { error: "Not found" });
    } catch (error: any) { return json(res, error?.statusCode ?? (/JSON/.test(error?.message ?? "") ? 400 : 500), { error: error instanceof Error ? error.message : String(error) }); }
  });
  void loadProfile().then(async profile=>{await new Promise<void>(resolve=>setTimeout(resolve,250));while(open){const updated=store.backfillLocationAccess(profile,100);if(updated<100)break;await new Promise<void>(resolve=>setTimeout(resolve,25));}}).catch(error=>open&&console.error('Location accessibility backfill failed:',error));
  server.on("close",()=>{open=false;idleEnrichment.stop();void runner.shutdown();});
  return server;
}

export function startDashboardApi(port = 4310): void {
  const server=createDashboardApi(),shutdown=()=>server.close();
  process.once("SIGINT",shutdown);process.once("SIGTERM",shutdown);
  server.on("close",()=>{process.removeListener("SIGINT",shutdown);process.removeListener("SIGTERM",shutdown);});
  server.listen(port,"127.0.0.1",()=>console.log(`Diego Career Ops: http://127.0.0.1:${port}`));
}
