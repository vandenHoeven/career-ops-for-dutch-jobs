import { readFile } from 'node:fs/promises';
import { evaluateJob } from './core.js';
import { loadProfile } from './config.js';
import { createHttpContext } from './http.js';
import { parsePublicPostings } from './posting-parser.js';
import type { RawJob } from './types.js';

export interface RecallFixture {id:string;job:RawJob;expected:'retained'|'excluded';evidence:string;capturedAt?:string}
export async function recallCheck(path:string,live=false):Promise<any>{
  const payload=JSON.parse(await readFile(path,'utf8')),fixtures:RecallFixture[]=Array.isArray(payload)?payload:payload.cases;
  if(!Array.isArray(fixtures)||!fixtures.length)throw new Error('Recall fixture file must contain a nonempty cases array');
  for(const row of fixtures)if(!row.id||!row.job?.url||!row.job?.title||!['retained','excluded'].includes(row.expected)||!row.evidence)throw new Error('Each fixture needs id, job, expected and evidence');
  const profile=await loadProfile(),context=createHttpContext({timeoutMs:15000,retries:0}),items:any[]=[];
  for(const row of fixtures){
    let job=row.job,retrieved=!live,error:string|undefined;
    if(live)try{const html=await context.fetchText(job.url),parsed=parsePublicPostings(html,job.url,job.company),match=parsed.find(p=>new URL(p.url).pathname===new URL(job.url).pathname)??(parsed.length===1?parsed[0]:undefined);if(match){job=match;retrieved=true;}else error='Unsupported or inaccessible public posting structure';}catch(e){error=e instanceof Error?e.message:String(e);}
    const decision=retrieved?evaluateJob(job,profile):undefined,actual=decision?(decision.retain?'retained':'excluded'):'unresolved';
    items.push({id:row.id,url:row.job.url,expected:row.expected,actual,matchState:decision?.matchState,reasons:decision?.reasons,locationEvidence:decision?.location,liveLocation:live&&retrieved?job.location:undefined,structuredLocation:live&&retrieved?{jobLocation:(job.raw as any)?.jobLocation,jobLocationType:(job.raw as any)?.jobLocationType,applicantLocationRequirements:(job.raw as any)?.applicantLocationRequirements}:undefined,retrieved,passed:retrieved?actual===row.expected:false,error});
  }
  const retrieved=items.filter(x=>x.retrieved).length,correct=items.filter(x=>x.passed).length,positive=items.filter(x=>x.expected==='retained'),retainedPositives=positive.filter(x=>x.actual==='retained').length;
  return {mode:live?'live-public-page-retrieval':'captured-fixtures',total:items.length,retrieved,retrievalCoverage:retrieved/items.length,matchingAccuracy:retrieved?correct/retrieved:null,positiveRecall:positive.length?retainedPositives/positive.length:null,unresolved:items.length-retrieved,passed:correct,failed:items.length-correct,items,note:'Fixture results measure processing correctness. Live unresolved URLs remain in the retrieval denominator; neither result measures Dutch-market coverage.'};
}
