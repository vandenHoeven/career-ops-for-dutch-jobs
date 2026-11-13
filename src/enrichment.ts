import type { FetchContext, RawJob } from './types.js';
import { postingObjects, parsePublicPostings, plainText } from './posting-parser.js';
import { HttpError } from './http.js';
export interface EnrichmentResult {job:RawJob;status:'complete'|'unavailable'|'failed'|'not-needed';error?:string;retryAfterMs?:number;retryable?:boolean}
export function withEnrichmentSource(job:RawJob,source:{provider?:string;boardUrl?:string;apiUrl?:string}):RawJob {
  if(source.provider!=='workday'||!source.boardUrl||(job.raw as any)?._diegoDetailApi)return job;
  try{const board=new URL(source.boardUrl),segments=board.pathname.split('/').filter(Boolean),at=segments.findIndex(s=>s==='job'||s==='jobs'),site=at>0?segments[at-1]:segments.at(-1)??'External',path=(job.raw as any)?.externalPath??new URL(job.url).pathname.match(/\/job\/.*/)?.[0];
    if(!path)return job;
    const api=source.apiUrl??board.origin+'/wday/cxs/'+board.hostname.split('.')[0]+'/'+site+'/jobs';
    return {...job,raw:{...(job.raw as any),_diegoDetailApi:api.replace(/\/jobs$/,'')+path}};
  }catch{return job;}
}
export async function enrichJob(job:RawJob,context:FetchContext):Promise<EnrichmentResult>{
  if((job.description?.trim().length??0)>=160)return {job,status:'not-needed'};
  try{
    const detailApi=(job.raw as any)?._diegoDetailApi;
    if(typeof detailApi==='string'){
      const detail:any=await context.fetchJson(detailApi),info=detail?.jobPostingInfo;
      if(typeof info?.jobDescription==='string')return {job:{...job,description:plainText(info.jobDescription),location:info.location??job.location,raw:{...(job.raw as any),country:info.country?.descriptor??info.country,detailEvidence:detailApi}},status:'complete'};
    }
    const html=await context.fetchText(job.url),objects=postingObjects(html),parsed=parsePublicPostings(html,job.url,job.company);
    const same=(url:string)=>{try{return new URL(url).pathname===new URL(job.url).pathname;}catch{return false;}};
    const posting=parsed.find(p=>same(p.url))??(parsed.length===1?parsed[0]:undefined);
    const object=objects.find(p=>same(p.url??''))??(objects.length===1?objects[0]:undefined);
    const scoped=html.match(/<[^>]+itemprop=["']description["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]??html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]??'';
    const description=posting?.description??(typeof object?.description==='string'?plainText(object.description):plainText(scoped.replace(/<(header|footer|nav)\b[^>]*>[\s\S]*?<\/\1>/gi,'')));
    const merged={...job,...(posting?{location:posting.location||job.location,countryCode:posting.countryCode??job.countryCode,structuredRoleTerms:posting.structuredRoleTerms,raw:{...(job.raw as any),jobLocation:(posting.raw as any)?.jobLocation}}:{}),description:description||job.description};
    return description.length>=160?{job:merged,status:'complete'}:{job:merged,status:'unavailable',error:'Public posting did not contain a usable job-specific description',retryable:false};
  }catch(error){return {job,status:'failed',error:(error instanceof Error?error.message:String(error)).replace(/[\r\n\t]+/g,' ').slice(0,500),retryAfterMs:error instanceof HttpError?error.retryAfterMs:undefined,retryable:error instanceof HttpError?error.retryable:true};}
}
