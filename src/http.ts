import type { FetchContext } from "./types.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface HttpOptions { timeoutMs?: number; retries?: number; minDelayMs?: number; cacheDir?: string; cacheTtlMs?: number }
export class HttpError extends Error { constructor(message: string, public status?: number, public retryable = true, public retryAfterMs?: number) { super(message); this.name = "HttpError"; } }

export function createHttpContext(options: HttpOptions = {}): FetchContext {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retries = options.retries ?? 2;
  const minDelayMs = options.minDelayMs ?? 100;
  const cacheTtlMs = options.cacheTtlMs ?? 30 * 60_000;
  let lastRequest = 0;
  async function request(urlValue: string, init: RequestInit = {}, redirects = 0): Promise<Response> {
    init.signal?.throwIfAborted();
    const url = new URL(urlValue);
    if (url.protocol !== "https:") throw new Error(`Only HTTPS sources are allowed: ${urlValue}`);
    if (url.username || url.password || url.port) throw new Error(`Credentials and custom ports are not allowed: ${urlValue}`);
    const addresses = isIP(url.hostname) ? [{ address: url.hostname, family: isIP(url.hostname) }] : await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error(`Private or unresolved host is not allowed: ${url.hostname}`);
    let lastError: unknown;
    const cacheable = Boolean(options.cacheDir) && (!init.method || init.method === "GET") && !init.body;
    const cacheKey = createHash("sha256").update(url.toString()).digest("hex");
    const metaPath = options.cacheDir ? join(options.cacheDir, `${cacheKey}.json`) : "";
    const bodyPath = options.cacheDir ? join(options.cacheDir, `${cacheKey}.body`) : "";
    let cached: { fetchedAt: number; etag?: string; lastModified?: string; contentType?: string } | null = null;
    if (cacheable) {
      try { cached = JSON.parse(await readFile(metaPath, "utf8")); if (Date.now() - cached!.fetchedAt < cacheTtlMs) return new Response(await readFile(bodyPath), { status: 200, headers: { "content-type": cached!.contentType ?? "application/json" } }); } catch { cached = null; }
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
      const wait = Math.max(0, minDelayMs - (Date.now() - lastRequest));
      if (wait) await delay(wait, init.signal);
      lastRequest = Date.now();
      try {
        const conditional = cached ? { ...(cached.etag ? { "if-none-match": cached.etag } : {}), ...(cached.lastModified ? { "if-modified-since": cached.lastModified } : {}) } : {};
        const response = await fetch(url, {
          ...init,
          redirect: "manual",
          signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
          headers: { "user-agent": "DiegoCareerOps/0.1 (+local respectful job research)", accept: "application/json,text/plain,text/html", ...conditional, ...init.headers },
        });
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location || redirects >= 4) throw new HttpError('Redirect has no destination or exceeds four hops', response.status, false);
          const target = new URL(location, url);
          // Only the same hostname or its exact www alias is eligible. Every hop
          // is checked again for HTTPS, credentials, ports and private DNS addresses.
          if (target.protocol !== 'https:' || target.username || target.password || target.port) throw new HttpError('Redirect destination is not public HTTPS', response.status, false);
          if (target.hostname.replace(/^www\./,'') !== url.hostname.replace(/^www\./,'')) throw new HttpError('Cross-domain redirect requires an explicitly configured public board URL', response.status, false);
          const resolved = isIP(target.hostname) ? [{address:target.hostname}] : await lookup(target.hostname,{all:true,verbatim:true});
          if (!resolved.length || resolved.some(value=>isPrivateAddress(value.address))) throw new HttpError('Redirect destination resolves to a private address', response.status, false);
          await response.body?.cancel();
          return request(target.toString(), init, redirects + 1);
        }
        if (response.status === 304 && cached) { cached.fetchedAt = Date.now(); await atomicWrite(metaPath, JSON.stringify(cached)); return new Response(await readFile(bodyPath), { status: 200, headers: { "content-type": cached.contentType ?? "application/json" } }); }
        if (response.ok) {
          if (!cacheable) return response;
          const body = Buffer.from(await response.arrayBuffer());
          await mkdir(options.cacheDir!, { recursive: true });
          await atomicWrite(bodyPath, body);
          await atomicWrite(metaPath, JSON.stringify({ fetchedAt: Date.now(), etag: response.headers.get("etag") ?? undefined, lastModified: response.headers.get("last-modified") ?? undefined, contentType: response.headers.get("content-type") ?? undefined }));
          return new Response(body, { status: response.status, headers: response.headers });
        }
        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
        const retryAfter = response.headers.get("retry-after");
        const retryAfterMs = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : undefined;
        throw new HttpError(`HTTP ${response.status} for ${url.hostname}`, response.status, retryable, retryAfterMs);
      } catch (error) {
        init.signal?.throwIfAborted();
        lastError = error instanceof HttpError ? error : new HttpError(error instanceof Error ? error.message : String(error), undefined, true);
        if (lastError instanceof HttpError && !lastError.retryable) throw lastError;
      }
      if (attempt < retries) { const declared = lastError instanceof HttpError ? lastError.retryAfterMs : undefined; await delay(declared ?? (300 * 2 ** attempt + Math.random() * 150), init.signal); }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  return {
    async fetchJson(url, init) { return (await request(url, init)).json(); },
    async fetchText(url, init) { return (await request(url, init)).text(); },
  };
}

async function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!ms) return; signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); }; signal?.addEventListener("abort", abort, { once: true }); });
}

async function atomicWrite(path: string, value: string | Buffer): Promise<void> { const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, value); await rename(temp, path); }

export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (value === "::1" || value === "::" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ip = mapped ?? value;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}
