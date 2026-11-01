import { loadProfile } from './config.js';
import type { DiscoveryCandidate, DiscoverySource, ProfileConfig, RawJob } from './types.js';

const SEARCH_URL='https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DETAIL_URL='https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';
const SOURCE_ID='linkedin-guest';

const decode=(value='')=>value.replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;|&#34;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,number)=>String.fromCodePoint(Number(number))).replace(/\s+/g,' ').trim();
const content=(html:string,classPart:string)=>decode(html.match(new RegExp(`<[^>]+class=["'][^"']*${classPart}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,'i'))?.[1]);
const attribute=(html:string,name:string)=>decode(html.match(new RegExp(`${name}=["']([^"']*)`,'i'))?.[1]);
const idFrom=(html:string)=>html.match(/urn:li:jobPosting:(\d+)/i)?.[1]??html.match(/\/jobs\/view\/(?:[^?"']*?-)?(\d+)(?:[/?"']|$)/i)?.[1];

export function parseLinkedInGuestSearch(html:string):RawJob[]{
 const rows:RawJob[]=[];
 for(const match of html.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi)){
  const block=match[1],externalId=idFrom(block);
  const href=decode(block.match(/<a[^>]+class=["'][^"']*(?:base-card__full-link|full-link)[^"']*["'][^>]+href=["']([^"']+)/i)?.[1]??block.match(/<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*(?:base-card__full-link|full-link)/i)?.[1]);
  const title=content(block,'(?:base-search-card__title|_title)'),company=content(block,'(?:base-search-card__subtitle|_subtitle)'),location=content(block,'(?:job-search-card__location|_location)');
  const time=block.match(/<time[^>]*>([\s\S]*?)<\/time>/i)?.[0]??'';
  if(!externalId||!href||!title||!company)continue;
  rows.push({externalId,company,title,location,postedAt:attribute(time,'datetime')||decode(time)||undefined,url:href.split('?')[0],raw:{source:SOURCE_ID,externalId}});
 }
 return rows;
}

export function parseLinkedInGuestDetail(html:string):{description?:string;criteria:Record<string,string>}{
 const descriptionHtml=html.match(/<div[^>]+class=["'][^"']*show-more-less-html__markup[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)?.[1]??html.match(/<div[^>]+class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
 const criteria:Record<string,string>={};
 for(const match of html.matchAll(/<li[^>]+class=["'][^"']*description__job-criteria-item[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)){
  const label=content(match[1],'description__job-criteria-subheader'),value=content(match[1],'description__job-criteria-text');if(label)criteria[label]=value;
 }
 return {description:decode(descriptionHtml)||undefined,criteria};
}

function candidate(job:RawJob):DiscoveryCandidate{return {sourceId:SOURCE_ID,company:job.company,headquarters:'unknown',jobs:[job]};}

export function parseLinkedInPocReport(payload:unknown):RawJob[]{
 const report=payload as any,details=new Map<string,any>((Array.isArray(report?.detailRuns)?report.detailRuns:[]).map((row:any)=>[String(row.id??''),row]));
 const jobs=new Map<string,RawJob>();
 for(const run of Array.isArray(report?.searchRuns)?report.searchRuns:[]){
  if(!String(run?.name??'').startsWith('page-')||!Array.isArray(run.jobs))continue;
  for(const row of run.jobs){
   const externalId=String(row?.id??'').trim(),url=String(row?.url??'').trim(),title=String(row?.title??'').trim(),company=String(row?.company??'').trim();if(!externalId||!url||!title||!company)continue;
   const detail=details.get(externalId),description=typeof detail?.description==='string'?detail.description:undefined;
   jobs.set(externalId,{externalId,company,title,location:String(row.location??'').trim(),postedAt:String(row.postedAt??'').trim()||undefined,url:url.split('?')[0],description,raw:{source:SOURCE_ID,criteria:detail?.criteria??{},capturedDescriptionLength:Number(detail?.descriptionLength)||undefined,capturedPoc:true}});
  }
 }
 return [...jobs.values()];
}

export function linkedInGuestSourceFromPocReport(payload:unknown):DiscoverySource{
 const jobs=parseLinkedInPocReport(payload);
 return {id:SOURCE_ID,label:'LinkedIn Guest (EXPERIMENTAL fixture)',license:'Saved local POC response',kind:'job-feed',experimental:true,async discover(_context,cursor,limit){const page=jobs.slice(cursor,cursor+limit);return {candidates:page.map(candidate),nextCursor:cursor+page.length,total:jobs.length};}};
}

export interface LinkedInGuestOptions {allowLiveCollection:boolean;keywords?:string;location?:string;maxPerCall?:number}
export function linkedInKeywordsFromProfile(profile:ProfileConfig):string{
 const families=[...(profile.preferredRoleFamilies??[]),...(profile.acceptableRoleFamilies??[]),...Object.keys(profile.roleFamilies)],seen=new Set<string>(),terms:string[]=[];
 for(const family of families){
  if(seen.has(family))continue;seen.add(family);
  const term=profile.roleFamilies[family]?.[0]?.trim();if(term)terms.push(term);
 }
 return terms.map(term=>term.includes(' ')?`"${term}"`:term).join(' OR ');
}
export function createLinkedInGuestSource(options:LinkedInGuestOptions):DiscoverySource{
 const location=options.location??'Netherlands',maxPerCall=Math.max(1,Math.min(options.maxPerCall??50,50));let profileKeywords:string|undefined,freshSampled=false;
 return {id:SOURCE_ID,label:'LinkedIn Guest (EXPERIMENTAL)',license:'Unofficial guest HTML; live collection requires LinkedIn permission',kind:'job-feed',experimental:true,async discover(context,cursor,limit){
  if(!options.allowLiveCollection)throw new Error('LinkedIn Guest live collection is disabled; confirm permission before enabling it');
  const keywords=options.keywords??(profileKeywords??=linkedInKeywordsFromProfile(await loadProfile()));if(!keywords)throw new Error('CareerOps profile has no role-family search terms');
  const wanted=Math.max(1,Math.min(limit,maxPerCall)),jobs=new Map<string,RawJob>();
  const collect=async(start:number,count:number)=>{let offset=start;
   while(jobs.size<wanted&&count>0&&offset<1000){
   const url=new URL(SEARCH_URL);url.searchParams.set('keywords',keywords);url.searchParams.set('location',location);url.searchParams.set('start',String(offset));
   const cards=parseLinkedInGuestSearch(await context.fetchText(url.toString()));if(!cards.length)break;
   const selected=cards.slice(0,Math.min(count,wanted-jobs.size));
   for(const card of selected){
    let detail:{description?:string;criteria:Record<string,string>}={criteria:{}};
    try{detail=parseLinkedInGuestDetail(await context.fetchText(`${DETAIL_URL}/${card.externalId}`));}catch(error){detail={criteria:{detailError:error instanceof Error?error.message:String(error)}};}
    jobs.set(card.externalId??card.url,{...card,description:detail.description,raw:{...(card.raw as object),criteria:detail.criteria}});
   }
   offset+=selected.length;count-=selected.length;if(cards.length<10||!selected.length)break;
   }return offset;
  };
  let continuation=Math.max(0,cursor),fresh=0;
  if(!freshSampled){fresh=Math.min(10,wanted);await collect(0,fresh);freshSampled=true;}
  const remaining=wanted-jobs.size;if(remaining>0)continuation=await collect(Math.max(continuation,fresh),remaining);
  return {candidates:[...jobs.values()].map(candidate),nextCursor:continuation};
 }};
}

export function linkedInGuestEnabled():boolean{return process.env.DIEGO_ENABLE_LINKEDIN_GUEST==='true'&&process.env.DIEGO_LINKEDIN_GUEST_PERMISSION_CONFIRMED==='true';}
export function configuredLinkedInGuestSource():DiscoverySource{return createLinkedInGuestSource({allowLiveCollection:linkedInGuestEnabled(),keywords:process.env.DIEGO_LINKEDIN_GUEST_KEYWORDS,location:process.env.DIEGO_LINKEDIN_GUEST_LOCATION});}
