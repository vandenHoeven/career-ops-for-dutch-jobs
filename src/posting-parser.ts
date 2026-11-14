import type { RawJob } from './types.js';
function scalarText(value:unknown):string|undefined {
  return typeof value==='string'&&value.trim()?value.trim():undefined;
}
export function plainText(value:string):string {
  for(let pass=0;pass<3;pass++)value=value.replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&apos;|&#39;/gi,"'").replace(/&nbsp;/gi,' ').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,code:string)=>{const n=code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';});
  return value.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<\/?[a-z][^>]*>/gi,' ').replace(/\s+/g,' ').trim();
}
export function postingObjects(html:string):any[] {
  const result:any[]=[];
  const visit=(node:any)=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}if([node['@type']].flat().includes('JobPosting'))result.push(node);if(node['@graph'])visit(node['@graph']);if(node.mainEntity)visit(node.mainEntity);};
  for(const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi))try{visit(JSON.parse(match[1]));}catch{/* Other valid blocks remain usable. */}
  return result;
}
export function parsePublicPostings(html:string,url:string,company:string):RawJob[] {
  return postingObjects(html).filter(p=>typeof p.title==='string').map(p=>{
    const locations=[p.jobLocation].flat().filter(Boolean), addresses=locations.map((x:any)=>x.address??x), countries=addresses.map((x:any)=>typeof x.addressCountry==='object'?x.addressCountry.name:x.addressCountry).filter(Boolean);
    const remote=[p.applicantLocationRequirements].flat().filter(Boolean).map((x:any)=>x.name).filter(Boolean);
    let resolved=url;try{const target=new URL(p.url??p['@id']??url,url);if(target.protocol==='https:'&&!target.username&&!target.password&&!target.port)resolved=target.toString();}catch{/* Current posting URL is the fallback. */}
    return {title:p.title,company:scalarText(p.hiringOrganization?.name)??company,url:resolved,externalId:scalarText(typeof p.identifier==='string'?p.identifier:p.identifier?.value),location:[...addresses.map((a:any)=>[a.addressLocality,a.addressRegion,typeof a.addressCountry==='object'?a.addressCountry.name:a.addressCountry].filter(Boolean).join(', ')),...remote].join(' · '),countryCode:countries.length===1?scalarText(countries[0]):undefined,description:typeof p.description==='string'?plainText(p.description):undefined,postedAt:scalarText(p.datePosted),validThrough:scalarText(p.validThrough),workArrangement:p.jobLocationType==='TELECOMMUTE'?'remote':undefined,structuredRoleTerms:[p.occupationalCategory,p.industry].flat().filter((x:any)=>typeof x==='string'),raw:p};
  });
}

export function parseVisiblePosting(html:string,url:string,company:string):RawJob|undefined {
  const title=html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const description=html.match(/<[^>]+itemprop=["']description["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]??html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if(!title||!description||plainText(description).length<160||!/apply|solliciteer|solliciteren/i.test(html)||!/(?:\/jobs?\/|\/vacatures?\/|\/o\/|\/positions?\/|\/careers\/[^/]+)/i.test(new URL(url).pathname))return;
  const locality=html.match(/<[^>]+itemprop=["']addressLocality["'][^>]*>([^<]+)</i)?.[1]??html.match(/<[^>]+(?:data-testid|class)=["'][^"']*(?:job-location|jobLocation|vacancy-location)[^"']*["'][^>]*>([^<]+)</i)?.[1]??'';
  const country=html.match(/<[^>]+itemprop=["']addressCountry["'][^>]*>([^<]+)</i)?.[1];
  return {title:plainText(title),company,url,location:plainText(locality),countryCode:country?plainText(country):undefined,description:plainText(description),raw:{extraction:'visible-job-page'}};
}
