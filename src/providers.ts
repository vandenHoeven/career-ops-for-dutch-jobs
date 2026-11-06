import { HttpError } from './http.js';
import { createHash } from 'node:crypto';
import { renderPublicPage } from './browser-public.js';
import { parsePublicPostings,parseVisiblePosting,plainText } from './posting-parser.js';
type LegacyProvider = Omit<Provider, 'collect'|'fetch'> & {fetch(source:SourceConfig,ctx:FetchContext):Promise<RawJob[]>};
import type { CollectionResult, FetchContext, Provider, RawJob, SourceConfig } from "./types.js";
import {
  parseAcademicTransferDetail,
  parseWerkenVoorNederlandDetail,
} from "./discovery-sources.js";

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
const date = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
};
const stripHtml = (value: unknown): string => plainText(text(value));
const decodeXml = (value: string): string =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
const xmlValue = (xml: string, tag: string): string =>
  decodeXml(
    xml.match(
      new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"),
    )?.[1] ?? "",
  ).trim();
const xmlRows = (xml: string, tag: string): string[] =>
  [
    ...xml.matchAll(
      new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi"),
    ),
  ].map((match) => match[1]);
const expectArray = (value: unknown, provider: string): any[] => {
  if (!Array.isArray(value))
    throw new Error(`${provider} returned an unexpected response shape`);
  return value;
};
const validUrl = (value: unknown, base?: string): string => {
  try {
    const url = new URL(text(value), base);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
};

function host(source: SourceConfig): string {
  try {
    return new URL(source.careersUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}
function pathPart(source: SourceConfig, index = 0): string {
  try {
    return (
      new URL(source.careersUrl).pathname.split("/").filter(Boolean)[index] ??
      ""
    );
  } catch {
    return "";
  }
}

const greenhouse: LegacyProvider = {
  id: "greenhouse",
  detect: (source) =>
    /(^|\.)greenhouse\.io$/.test(host(source)) ||
    /greenhouse\.io/.test(source.apiUrl ?? ""),
  async fetch(source, ctx) {
    const original = new URL(source.apiUrl ?? source.careersUrl);
    const token = original.searchParams.get("for") || pathPart(source);
    if (!token) throw new Error("Greenhouse board token is missing");
    const payload: any = await ctx.fetchJson(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
    );
    return expectArray(payload?.jobs, "Greenhouse")
      .map(
        (job: any): RawJob => ({
          externalId: String(job.id ?? ""),
          company: source.company,
          title: text(job.title),
          location: text(job.location?.name),
          description: stripHtml(job.content),
          url: validUrl(job.absolute_url),
          postedAt: date(job.updated_at),
          raw: job,
        }),
      )
      .filter((job: RawJob) => job.title && job.url);
  },
};

const lever: LegacyProvider = {
  id: "lever",
  detect: (source) => /(^|\.)lever\.co$/.test(host(source)),
  async fetch(source, ctx) {
    const sourceUrl = new URL(source.careersUrl);
    const slug = pathPart(source);
    const apiHost =
      sourceUrl.hostname === "jobs.eu.lever.co"
        ? "api.eu.lever.co"
        : "api.lever.co";
    const payload: any = await ctx.fetchJson(
      `https://${apiHost}/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    );
    return expectArray(payload, "Lever")
      .map(
        (job: any): RawJob => ({
          externalId: text(job.id),
          company: source.company,
          title: text(job.text),
          location: text(job.categories?.location),
          description: text(job.descriptionPlain) || stripHtml(job.description),
          url: validUrl(job.hostedUrl),
          applyUrl: validUrl(job.applyUrl),
          postedAt: date(job.createdAt),
          raw: job,
        }),
      )
      .filter((job: RawJob) => job.title && job.url);
  },
};

const ashby: LegacyProvider = {
  id: "ashby",
  detect: (source) => host(source) === "jobs.ashbyhq.com",
  async fetch(source, ctx) {
    const slug = pathPart(source);
    const payload: any = await ctx.fetchJson(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
    );
    return expectArray(payload?.jobs, "Ashby")
      .map(
        (job: any): RawJob => ({
          externalId: text(job.id),
          company: source.company,
          title: text(job.title),
          location: [
            text(job.location),
            ...(Array.isArray(job.secondaryLocations)
              ? job.secondaryLocations.map((x: any) => text(x.location))
              : []),
          ]
            .filter(Boolean)
            .join(" · "),
          description:
            text(job.descriptionPlain) || stripHtml(job.descriptionHtml),
          url: validUrl(job.jobUrl),
          applyUrl: validUrl(job.applyUrl),
          postedAt: date(job.publishedAt),
          raw: job,
        }),
      )
      .filter((job: RawJob) => job.title && job.url);
  },
};

const workable: LegacyProvider = {
  id: "workable",
  detect: (source) => host(source) === "apply.workable.com",
  async fetch(source, ctx) {
    const slug = pathPart(source);
    const payload: any = await ctx.fetchJson(
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`,
      { headers: { referer: source.careersUrl } },
    );
    return (Array.isArray(payload?.jobs) ? payload.jobs : [])
      .map(
        (job: any): RawJob => ({
          externalId: String(job.id ?? job.shortcode ?? ""),
          company: source.company,
          title: text(job.title),
          location: text(job.location?.location_str) || text(job.location),
          description: stripHtml(job.description),
          url: validUrl(job.url, source.careersUrl),
          postedAt: date(job.published_on),
          raw: job,
        }),
      )
      .filter((job: RawJob) => job.title && job.url);
  },
};

const recruitee: LegacyProvider = {
  id: "recruitee",
  detect: (source) => /^[a-z0-9-]+\.recruitee\.com$/.test(host(source)),
  async fetch(source, ctx) {
    const configured =
      source.apiUrl && /recruitee\.com/i.test(source.apiUrl)
        ? new URL(source.apiUrl)
        : new URL(source.careersUrl);
    const base = `${configured.protocol}//${configured.hostname}`;
    let payload: any;
    try {
      payload = await ctx.fetchJson(`${base}/api/offers`);
      if (!Array.isArray(payload?.offers))
        throw new Error("Recruitee JSON feed had an invalid structure");
    } catch (error: any) {
      if (
        error?.name === "AbortError" ||
        error?.status === 429 ||
        error?.status >= 500
      )
        throw error;
      const xml = await ctx.fetchText(`${base}/api/offers.xml`);
      if (!/<offers(?:\s|>)/i.test(xml))
        throw new Error("Recruitee XML feed had an invalid structure");
      payload = { offers: parseRecruiteeXml(xml, source.company, base) };
    }
    return (Array.isArray(payload?.offers) ? payload.offers : [])
      .filter((job: any) => !/\(sample\)/i.test(text(job.title)))
      .map(
        (job: any): RawJob => ({
          externalId: String(job.id ?? job.slug ?? ""),
          company: source.company,
          title: text(job.title),
          location:
            text(job.location) ||
            [text(job.city), text(job.country), job.remote ? "Remote" : ""]
              .filter(Boolean)
              .join(", "),
          description: stripHtml(job.description),
          url: validUrl(job.careers_url || job.url, base),
          applyUrl: validUrl(job.apply_url || job.applyUrl, base) || undefined,
          postedAt: date(job.published_at),
          structuredRoleTerms: [
            text(job.department),
            text(job.employment_type),
          ].filter(Boolean),
          raw: job,
        }),
      )
      .filter((job: RawJob) => job.title && job.url);
  },
};

export function parseRecruiteeXml(
  xml: string,
  company: string,
  base: string,
): any[] {
  return xmlRows(xml, "offer")
    .map((row) => ({
      id: xmlValue(row, "id"),
      slug: xmlValue(row, "slug"),
      title: xmlValue(row, "title"),
      city: xmlValue(row, "city"),
      country: xmlValue(row, "country"),
      location: xmlValue(row, "location"),
      description: xmlValue(row, "description"),
      careers_url: xmlValue(row, "careers_url") || xmlValue(row, "url"),
      apply_url: xmlValue(row, "apply_url"),
      published_at: xmlValue(row, "published_at"),
      department: xmlValue(row, "department"),
      company,
    }))
    .filter((row) => row.title && validUrl(row.careers_url, base));
}

export function parsePersonioXml(
  xml: string,
  company: string,
  base: string,
): RawJob[] {
  if (!/<(?:workzag-jobs|positions)[\s>]/i.test(xml))
    throw new Error("Personio returned invalid XML feed structure");
  return xmlRows(xml, "position")
    .map((row) => {
      const id = xmlValue(row, "id"),
        descriptions = xmlRows(row, "jobDescription")
          .map((block) => stripHtml(xmlValue(block, "value")))
          .filter(Boolean);
      const office = xmlValue(row, "office"),
        keywords = xmlValue(row, "keywords"),
        occupation = xmlValue(row, "occupation"),
        category = xmlValue(row, "occupationCategory");
      return {
        externalId: id,
        company: xmlValue(row, "subcompany") || company,
        title: xmlValue(row, "name"),
        location: office,
        description: descriptions.join("\n\n"),
        url: `${base}/job/${encodeURIComponent(id)}?display=en`,
        structuredRoleTerms: [
          xmlValue(row, "department"),
          xmlValue(row, "recruitingCategory"),
          occupation,
          category,
          keywords,
        ].filter(Boolean),
        raw: {
          provider: "personio",
          id,
          office,
          createdAt: xmlValue(row, "createdAt") || undefined,
          employmentType: xmlValue(row, "employmentType"),
          seniority: xmlValue(row, "seniority"),
          schedule: xmlValue(row, "schedule"),
          keywords,
        },
      } satisfies RawJob;
    })
    .filter((job) => job.externalId && job.title && job.url);
}

const personio: LegacyProvider = {
  id: "personio",
  detect: (source) => /(^|\.)jobs\.personio\.(de|com)$/.test(host(source)),
  async fetch(source, ctx) {
    const url = new URL(source.careersUrl),
      base = `${url.protocol}//${url.hostname}`;
    return parsePersonioXml(
      await ctx.fetchText(`${base}/xml?language=en`),
      source.company,
      base,
    );
  },
};

const smartrecruiters: LegacyProvider = {
  id: "smartrecruiters",
  detect: (source) => /(^|\.)(smartrecruiters\.com)$/.test(host(source)),
  async fetch(source, ctx) {
    const slug = pathPart(source);
    const results: any[] = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const payload: any = await ctx.fetchJson(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100&offset=${offset}&status=PUBLIC`,
      );
      const page = Array.isArray(payload?.content) ? payload.content : [];
      results.push(...page);
      if (page.length < 100) break;
    }
    return results
      .map(
        (job: any): RawJob => ({
          externalId: text(job.id),
          company: source.company,
          title: text(job.name),
          location:
            text(job.location?.fullLocation) ||
            [
              text(job.location?.city),
              text(job.location?.region),
              text(job.location?.country),
            ]
              .filter(Boolean)
              .join(", "),
          url: validUrl(job.ref),
          postedAt: date(job.releasedDate),
          raw: job,
        }),
      )
      .filter((job: RawJob) => job.title && job.url);
  },
};

async function collectSmartRecruiters(source:SourceConfig,ctx:FetchContext):Promise<CollectionResult>{
  const slug=pathPart(source);let offset=Number(source.cursor??0)||0;const jobs:RawJob[]=[];
  try{
    const payload:any=await ctx.fetchJson('https://api.smartrecruiters.com/v1/companies/'+encodeURIComponent(slug)+'/postings?limit=100&offset='+offset+'&status=PUBLIC');
    if(!Array.isArray(payload.content))throw new Error('SmartRecruiters response has no content array');
    for(const job of payload.content)jobs.push({externalId:text(job.id),company:source.company,title:text(job.name),location:text(job.location?.fullLocation)||[job.location?.city,job.location?.region,job.location?.country].filter(Boolean).join(', '),countryCode:job.location?.country,url:validUrl(job.ref),postedAt:date(job.releasedDate),raw:job});
    const total=Number.isFinite(Number(payload.totalFound))?Number(payload.totalFound):undefined;
    const complete=jobs.length<100||(total!==undefined&&offset+jobs.length>=total);
    return {jobs,complete,total,nextCursor:complete?undefined:String(offset+jobs.length)};
  }catch(error){return {jobs,complete:false,nextCursor:String(offset),error:error instanceof Error?error.message:String(error),httpStatus:error instanceof HttpError?error.status:undefined,retryable:error instanceof HttpError?error.retryable:true,retryAfterMs:error instanceof HttpError?error.retryAfterMs:undefined};}
}

async function collectWorkday(source:SourceConfig,ctx:FetchContext):Promise<CollectionResult> {
  const page=new URL(source.careersUrl), segments=page.pathname.split('/').filter(Boolean),tenant=page.hostname.split('.')[0],jobIndex=segments.findIndex(s=>s==='job'||s==='jobs'),site=jobIndex>0?segments[jobIndex-1]:segments.at(-1)??'External';
  const boardPath=jobIndex>0?'/'+segments.slice(0,jobIndex).join('/'):'/'+segments.join('/');
  const endpoint=source.apiUrl??page.origin+'/wday/cxs/'+tenant+'/'+site+'/jobs';
  let offset=0,previous='',phase='all',nlDone=false,facet:{key:string;value:string}|undefined;
  if(source.cursor)try{const c=JSON.parse(source.cursor);offset=c.offset??0;previous=c.previous??'';phase=c.phase??'all';nlDone=c.nlDone??false;facet=c.facet;}catch{offset=Number(source.cursor.replace('offset=',''))||0;}
  const cursor=()=>JSON.stringify({offset,previous,phase,nlDone,facet});
  const jobs:RawJob[]=[];let total:number|undefined;
  for(let count=0;count<10;count++) {
    try {
      const payload:any=await ctx.fetchJson(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appliedFacets:phase==='nl'&&facet?{[facet.key]:[facet.value]}:{},limit:20,offset,searchText:''})});
      const rows=Array.isArray(payload?.jobPostings)?payload.jobPostings:[];
      if(!Array.isArray(payload?.jobPostings))throw new Error('Workday response has no jobPostings array');
      total=Number.isFinite(Number(payload.total))?Number(payload.total):undefined;
      if(!source.cursor && !nlDone && phase==='all' && offset===0){
        for(const f of payload.facets??[]){const value=f.values?.find((v:any)=>/^(netherlands|nederland|the netherlands|nl)$/i.test(v.descriptor??v.name??''));if(value?.id&&f.facetParameter){facet={key:f.facetParameter,value:value.id};break;}}
        if(facet){phase='nl';previous='';continue;}nlDone=true;
      }
      const signature=createHash('sha256').update(JSON.stringify(rows.map((r:any)=>r.externalPath))).digest('hex');
      if(rows.length && signature===previous)return {jobs,complete:false,nextCursor:cursor(),total,error:'Repeated Workday page'};
      // bulletFields is display metadata and can start with a shared value such
      // as "Application Deadline: 11/11/2026". externalPath is Workday's
      // per-posting stable key and therefore the safe identity input.
      for(const row of rows)jobs.push({externalId:text(row.externalPath),company:source.company,title:text(row.title),location:text(row.locationsText),url:validUrl(typeof row.externalPath==='string'&&/^\/job\//.test(row.externalPath)?page.origin+boardPath+row.externalPath:row.externalPath,page.origin),postedAt:date(row.postedOn),raw:{...row,_diegoDetailApi:endpoint.replace(/\/jobs$/,'')+row.externalPath}});
      offset+=rows.length;previous=signature;
      if(rows.length<20||(total!==undefined&&offset>=total)){if(phase==='nl')return {jobs,complete:false,nextCursor:JSON.stringify({offset:0,previous:'',phase:'all',nlDone:true}),total};return {jobs,complete:true,total};}
    }catch(error){return {jobs,complete:false,nextCursor:cursor(),total,error:error instanceof Error?error.message:String(error),httpStatus:error instanceof HttpError?error.status:undefined,retryable:error instanceof HttpError?error.retryable:true,retryAfterMs:error instanceof HttpError?error.retryAfterMs:undefined};}
  }
  return {jobs,complete:false,nextCursor:cursor(),total};
}
const workday:LegacyProvider={id:'workday',experimental:true,detect:source=>/(^|\.)(myworkdayjobs\.com|wd\d+\.myworkdaysite\.com)$/.test(host(source)),fetch:async(source,ctx)=>(await collectWorkday(source,ctx)).jobs};

const icims: LegacyProvider = {
  id: "icims",
  experimental: true,
  detect: (source) => /(^|\.)icims\.com$/.test(host(source)),
  async fetch(source, ctx) {
    if (!source.apiUrl)
      throw new Error(
        "iCIMS requires an explicit public apiUrl in config/sources.json",
      );
    const payload: any = await ctx.fetchJson(source.apiUrl);
    const rows =
      payload?.jobs ?? payload?.items ?? payload?.searchResults ?? [];
    return (Array.isArray(rows) ? rows : [])
      .map(
        (job: any): RawJob => ({
          externalId: String(job.id ?? job.jobId ?? job.jobNumber ?? ""),
          company: source.company,
          title: text(job.title ?? job.jobTitle),
          location: text(job.location ?? job.jobLocation),
          description: stripHtml(job.description),
          url: validUrl(job.url ?? job.jobUrl, source.careersUrl),
          postedAt: date(job.postedDate ?? job.datePosted),
          raw: job,
        }),
      )
      .filter((job: RawJob) => job.title && job.url);
  },
};

const government: LegacyProvider = {
  id: "government",
  detect: (source) =>
    host(source) === "www.werkenvoornederland.nl" ||
    host(source) === "werkenvoornederland.nl",
  async fetch(source, ctx) {
    const html = await ctx.fetchText(source.careersUrl);
    const parsed = parseWerkenVoorNederlandDetail(html, source.careersUrl);
    if (!parsed.length || !parsed[0].jobs?.length)
      throw new Error(
        "Werken voor Nederland detail page had an unexpected response shape",
      );
    return parsed[0].jobs;
  },
};

const academictransfer: LegacyProvider = {
  id: "academictransfer",
  detect: (source) => /(^|\.)academictransfer\.com$/.test(host(source)),
  async fetch(source, context) {
    const rows = parseAcademicTransferDetail(
      await context.fetchText(source.careersUrl),
      source.careersUrl,
    );
    if (!rows.length)
      throw new Error(
        "AcademicTransfer detail contained no valid vacancy record",
      );
    return rows.flatMap((row) => row.jobs ?? []);
  },
};

async function collectPublic(source:SourceConfig,ctx:FetchContext):Promise<CollectionResult>{
  let pending=[source.careersUrl], visited:string[]=[];
  if(source.cursor)try{({pending,visited}=JSON.parse(source.cursor));}catch{/* Fresh traversal. */}
  const jobs:RawJob[]=[];
  for(let step=0;step<20&&pending.length;step++) {
    const url=pending.shift()!;
    if(visited.includes(url))continue;
    try {
      let html=await ctx.fetchText(url);visited.push(url);
      let parsed=parsePublicPostings(html,url,source.company);
      const visible=!parsed.length?parseVisiblePosting(html,url,source.company):undefined;if(visible)parsed=[visible];
      if(!parsed.length && /(?:id=["'](?:root|__next|app)["']|__NEXT_DATA__|enable JavaScript)/i.test(html)){
        const rendered=await renderPublicPage(url,ctx);if(rendered){html=rendered;parsed=parsePublicPostings(html,url,source.company);const detail=!parsed.length?parseVisiblePosting(html,url,source.company):undefined;if(detail)parsed=[detail];}
      }
      jobs.push(...parsed);
      if(!parsed.length || /sitemap/i.test(url)) {
        const links=[...html.matchAll(/href=["']([^"']+)["']/gi)].map(m=>m[1]);
        for(const m of html.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi))links.push(m[1]);
        for(const link of links)try{const target=new URL(link.replaceAll('&amp;','&'),url);target.hash='';if(target.protocol==='https:' && !visited.includes(target.toString())&&!pending.includes(target.toString())&&/job|vacatur|career|position|werken.?bij|sitemap/i.test(target.pathname)&&target.hostname.replace(/^www\./,'')===new URL(source.careersUrl).hostname.replace(/^www\./,''))pending.push(target.toString());}catch{/* malformed link */}
      }
    }catch(error){pending.unshift(url);return {jobs,complete:false,nextCursor:JSON.stringify({pending,visited}),error:error instanceof Error?error.message:String(error),httpStatus:error instanceof HttpError?error.status:undefined,retryable:error instanceof HttpError?error.retryable:true,retryAfterMs:error instanceof HttpError?error.retryAfterMs:undefined};}
  }
  const complete=pending.length===0;
  return {jobs,complete:complete&&jobs.length>0,nextCursor:complete?undefined:JSON.stringify({pending,visited}),error:complete&&!jobs.length?'No public JobPosting records found; collection unresolved':undefined};
}
const browser:LegacyProvider={id:'browser',experimental:true,detect:()=>true,fetch:async(source,ctx)=>(await collectPublic(source,ctx)).jobs};

const legacyProviders: LegacyProvider[] = [
  greenhouse,
  lever,
  ashby,
  workable,
  recruitee,
  personio,
  smartrecruiters,
  workday,
  icims,
  government,
  academictransfer,
  browser,
];

export const providers:Provider[]=legacyProviders.map(provider=>{const collect=async(source:SourceConfig,ctx:FetchContext):Promise<CollectionResult>=>{
  if(provider.id==='workday')return collectWorkday(source,ctx);
  if(provider.id==='browser')return collectPublic(source,ctx);
  if(provider.id==='smartrecruiters')return collectSmartRecruiters(source,ctx);
  return {jobs:await provider.fetch(source,ctx),complete:true};
};return {...provider,collect,fetch:collect};});

export function resolveProvider(source: SourceConfig): Provider {
  if (source.provider) {
    const explicit = providers.find(
      (provider) => provider.id === source.provider,
    );
    if (!explicit) throw new Error(`Unknown provider: ${source.provider}`);
    return explicit;
  }
  return (
    providers.find(
      (provider) => provider.id !== "browser" && provider.detect(source),
    ) ?? providers.find(p=>p.id==='browser')!
  );
}

export const providerIds = providers.map((provider) => provider.id);
