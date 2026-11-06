import { coverageRoutes } from './diagnostics.js';
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Store, type JobQuery } from "./database.js";
import { scan } from "./scanner.js";
import { discover, discoveryPlanForUi, validateDiscoveryAllocations, validateDiscoveryMode, validateDiscoveryWorkers, type DiscoveryAllocations } from "./discovery.js";

async function input(request:IncomingMessage):Promise<any>{const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "http://localhost" });
  response.end(JSON.stringify(value));
};

const landingPage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diego Career Ops API</title>
<style>body{font:16px system-ui;max-width:760px;margin:64px auto;padding:0 24px;color:#18202a}h1{margin-bottom:8px}p{color:#52606d}li{margin:12px 0}a{color:#075985}code{background:#eef2f6;padding:3px 6px;border-radius:5px}</style></head>
<body><h1>Diego Career Ops API</h1><p>The local scraper API is running. The visual dashboard will be added later.</p>
<h2>Available endpoints</h2><ul>
<li><a href="/health"><code>GET /health</code></a> — server health</li>
<li><a href="/api/v1/jobs"><code>GET /api/v1/jobs</code></a> — collected jobs</li>
<li><a href="/api/v1/sources"><code>GET /api/v1/sources</code></a> — configured sources</li>
<li><a href="/api/v1/scans"><code>GET /api/v1/scans</code></a> — scan history</li>
<li><a href="/api/v1/stats"><code>GET /api/v1/stats</code></a> — scraper analytics</li>
<li><a href="/api/v1/employers"><code>GET /api/v1/employers</code></a> — discovered employers</li>
<li><a href="/api/v1/coverage"><code>GET /api/v1/coverage</code></a> — discovery coverage</li>
<li><a href="/api/v1/discovery/sources"><code>GET /api/v1/discovery/sources</code></a> — discovery sources</li>
<li><a href="/api/v1/discovery/runs"><code>GET /api/v1/discovery/runs</code></a> — discovery history</li>
<li><a href="/api/v1/discovery/failures"><code>GET /api/v1/discovery/failures</code></a> — retryable and permanent failures</li>
</ul><p>Start a scan from the terminal with <code>npm.cmd run dev -- scan</code>.</p></body></html>`;

export function createApi(store = new Store()) {
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if(await coverageRoutes(request,response,url,store))return;
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(landingPage);
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true });
      if (request.method === "GET" && url.pathname === "/api/v1/jobs") {
        const number = (name: string) => { const value = Number(url.searchParams.get(name)); return Number.isFinite(value) ? value : undefined; };
        const query: JobQuery = {
          matchState:(url.searchParams.get("matchState")??undefined) as any,eligibility:(url.searchParams.get("eligibility")??undefined) as any,
          company: url.searchParams.get("company") ?? undefined, roleFamily: url.searchParams.get("roleFamily") ?? undefined,
          location: url.searchParams.get("location") ?? undefined, provider: url.searchParams.get("provider") ?? undefined,
          status: (url.searchParams.get("status") as JobQuery["status"]) ?? undefined, q: url.searchParams.get("q") ?? undefined,
          from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined,
          remote: url.searchParams.get("remote") ?? undefined, limit: number("limit"), offset: number("offset"),
        };
        return json(response, 200, { items: store.jobs(query), total:store.jobCount(query), limit: query.limit ?? 50, offset: query.offset ?? 0 });
      }
      const match = url.pathname.match(/^\/api\/v1\/jobs\/([a-f0-9]{24})$/);
      if (request.method === "GET" && match) { const job = store.job(match[1]); return job ? json(response, 200, job) : json(response, 404, { error: "Job not found" }); }
      if (request.method === "GET" && url.pathname === "/api/v1/sources") return json(response, 200, { items: store.sources() });
      if (request.method === "GET" && url.pathname === "/api/v1/scans") return json(response, 200, { items: store.scans() });
      if (request.method === "GET" && url.pathname === "/api/v1/stats") return json(response, 200, store.stats());
      if (request.method === "GET" && url.pathname === "/api/v1/employers") {
        const hiringValue = url.searchParams.get("hiring");
        const query={ name: url.searchParams.get("name") ?? undefined, headquarters: url.searchParams.get("headquarters") ?? undefined, hiring: hiringValue === null ? undefined : hiringValue === "true", sizeBand: url.searchParams.get("sizeBand") ?? undefined, provider: url.searchParams.get("provider") ?? undefined,source:url.searchParams.get("source")??undefined, boardStatus: url.searchParams.get("boardStatus") ?? undefined, since: url.searchParams.get("since") ?? undefined,sort:url.searchParams.get("sort")??undefined,limit: Number(url.searchParams.get("limit") ?? 50), offset: Number(url.searchParams.get("offset") ?? 0) }; return json(response,200,{items:store.employers(query),total:store.employerCount(query),limit:query.limit,offset:query.offset});
      }
      const employerMatch = url.pathname.match(/^\/api\/v1\/employers\/([a-f0-9]{24})$/);
      if (request.method === "GET" && employerMatch) { const employer = store.employer(employerMatch[1]); return employer ? json(response, 200, employer) : json(response, 404, { error: "Employer not found" }); }
      if (request.method === "GET" && url.pathname === "/api/v1/discovery/sources") return json(response, 200, { items: store.discoverySourceRows() });
      if (request.method === "GET" && url.pathname === "/api/v1/discovery/plan") {const limit=Math.min(Math.max(Number(url.searchParams.get('limit')??100),1),5000);return json(response,200,await discoveryPlanForUi(store,limit));}
      if (request.method === "POST" && url.pathname === "/api/v1/discovery/forecast") {const body=await input(request),requested=Number(body.limit??100),limit=Number.isFinite(requested)?Math.min(Math.max(requested,1),5000):100,allocations=validateDiscoveryAllocations(limit,body.allocations as Partial<DiscoveryAllocations>|undefined);return json(response,200,store.discoveryForecast(limit,allocations));}
      if (request.method === "GET" && url.pathname === "/api/v1/discovery/active") return json(response,200,store.activeDiscoveryRun());
      if (request.method === "GET" && url.pathname === "/api/v1/discovery/runs") return json(response, 200, { items: store.discoveryRuns() });
      const discoveryRun=url.pathname.match(/^\/api\/v1\/discovery\/runs\/([a-f0-9-]+)$/);if(request.method==="GET"&&discoveryRun){const value=store.discoveryRun(discoveryRun[1]);return value?json(response,200,value):json(response,404,{error:"Discovery run not found"});}
      const discoveryTrace=url.pathname.match(/^\/api\/v1\/discovery\/runs\/([a-f0-9-]+)\/trace$/);if(request.method==="GET"&&discoveryTrace){const value=store.discoveryTrace(discoveryTrace[1],Number(url.searchParams.get("after")??0),Number(url.searchParams.get("limit")??200));return value?json(response,200,value):json(response,404,{error:"Discovery run not found"});}
      if (request.method === "GET" && url.pathname === "/api/v1/discovery/failures") return json(response, 200, { items: store.discoveryFailures({ retryable: url.searchParams.has("retryable") ? url.searchParams.get("retryable") === "true" : undefined, source: url.searchParams.get("source") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 100), history: url.searchParams.get("history") === "true", includeMissing: url.searchParams.get("includeMissing") === "true" }) });
      if (request.method === "GET" && url.pathname === "/api/v1/coverage") return json(response, 200, {...(store.coverage() as any),...store.coverageTrace()});
      if(request.method==="GET"&&url.pathname==="/api/v1/source-performance")return json(response,200,store.sourcePerformance(url.searchParams.get("type")==="provider"?"provider":"discovery",url.searchParams.get("window")==="lifetime"?"lifetime":"30d"));
      if(request.method==="GET"&&url.pathname==="/api/v1/enrichment/queue")return json(response,200,{items:store.enrichmentQueueCounts()});
      if(request.method==="GET"&&url.pathname==="/api/v1/coverage/benchmark")return json(response,200,store.benchmarkCoverage());
      if(request.method==="GET"&&url.pathname==="/api/v1/coverage/overlap")return json(response,200,store.coverageOverlap(url.searchParams.get("window")==="lifetime"?"lifetime":"30d"));
      if (request.method === "POST" && url.pathname === "/api/v1/scans") {
        const result = await scan({ provider: url.searchParams.get("provider") ?? undefined, resume: url.searchParams.get("resume") === "true", store });
        return json(response, 202, result);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/discovery") {
        const body=await input(request),requested = Number(body.limit??url.searchParams.get("limit") ?? 100),limit=Number.isFinite(requested)?Math.min(Math.max(requested,1),5000):100,allocations=body.allocations?validateDiscoveryAllocations(limit,body.allocations as Partial<DiscoveryAllocations>):undefined;
        return json(response, 202, await discover({ limit, mode:validateDiscoveryMode(body.mode), concurrency:validateDiscoveryWorkers(body.workers), allocations, source: url.searchParams.get("source") ?? undefined, resume: body.resume===true||url.searchParams.get("resume") === "true", retryFailures: url.searchParams.get("retryFailures") === "true", store }));
      }
      return json(response, 404, { error: "Not found" });
    } catch (error:any) { return json(response, error?.statusCode??500, { error: error instanceof Error ? error.message : String(error) }); }
  });
}

export function startApi(port = 4310): void {
  const server = createApi();
  server.listen(port, "127.0.0.1", () => console.log(`Diego Career Ops API: http://127.0.0.1:${port}`));
}
