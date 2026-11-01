import { canonicalizeUrl, detectWorkArrangement, evaluateJob, fingerprint, stableJobId } from './core.js';
import { profileFingerprint, SCORING_VERSION, scoreJob } from './scoring.js';
import { Store } from './database.js';
import type { DiscoveryCandidate, JobPosting, ProfileConfig, ProviderId, RawJob } from './types.js';
import { plainText } from './posting-parser.js';

export interface ProcessingOptions {
  store: Store; profile: ProfileConfig; sourceId: string; provider: ProviderId;
  scanId?: string; discoveryRunId?: string; candidateId?: string; boardUrl?: string;
  existingId?: string; enrichmentStatus?: string; enrichmentError?: string;
  firstSeenAt?:string;
  candidate?: DiscoveryCandidate; employerId?: string;
}
/** All ingestion and reevaluation paths use this decision, persistence and scoring boundary. */
export function processJob(job: RawJob, options: ProcessingOptions) {
  if(job.description)job={...job,description:plainText(job.description)};
  if(job.countryCode||job.structuredRoleTerms)job={...job,raw:{...(job.raw as any),...(job.countryCode?{_diegoCountryCode:job.countryCode}:{}),...(job.structuredRoleTerms?{_diegoStructuredRoleTerms:job.structuredRoleTerms}:{})}};
  const {store,profile}=options, decision=evaluateJob(job,profile), print=fingerprint(job), url=canonicalizeUrl(job.url);
  const now=new Date().toISOString(), posting: JobPosting={...job,id:stableJobId(options.provider,job),provider:options.provider,sourceId:options.sourceId,canonicalUrl:url,workArrangement:job.workArrangement??detectWorkArrangement(job),roleFamily:decision.roleFamily,matchEvidence:decision.evidence,matchState:decision.matchState,firstSeenAt:options.firstSeenAt??now,lastSeenAt:now,status:'active'};
  // Lightweight audit rows share job identities so excluded/all views remain inspectable.
  const snapshot=decision.retain?job:{company:job.company,title:job.title,location:job.location,countryCode:job.countryCode,url:job.url,externalId:job.externalId,summary:job.summary?.slice(0,2000),structuredRoleTerms:job.structuredRoleTerms,raw:{countryCode:job.countryCode??(job.raw as any)?._diegoCountryCode??(job.raw as any)?.countryCode,country:(job.raw as any)?.country,jobLocation:(job.raw as any)?.jobLocation,jobLocationType:(job.raw as any)?.jobLocationType,applicantLocationRequirements:(job.raw as any)?.applicantLocationRequirements,_diegoStructuredRoleTerms:job.structuredRoleTerms??(job.raw as any)?._diegoStructuredRoleTerms}};
  const prior=store.db.prepare('SELECT id,record_kind FROM jobs WHERE canonical_url=? OR fingerprint=? LIMIT 1').get(url,print) as any;
  const full=decision.retain||prior?.record_kind==='posting';
  let id=options.existingId??prior?.id, write:'new'|'refreshed'|undefined;
  if(options.scanId && !options.existingId) {
    write=store.upsertJob(full?posting:{...posting,...snapshot,description:undefined},print,options.scanId,{discoveryRunId:options.discoveryRunId,candidateId:options.candidateId,boardUrl:options.boardUrl});
    id=store.jobIdFor(posting.id,url,print);
    for(const sourceId of options.candidate?.contributingSources??[])if(sourceId!==options.sourceId)store.db.prepare('INSERT OR IGNORE INTO source_observations(job_id,scan_id,source_id,provider,observed_url,observed_at,board_url) VALUES(?,?,?,?,?,?,?)').run(id,options.scanId,sourceId,options.provider,job.url,now,options.boardUrl??null);
  }
  if(id) {
    store.db.prepare('UPDATE jobs SET location=?,role_family=?,match_evidence_json=?,raw_json=?,record_kind=? WHERE id=?').run(job.location,decision.roleFamily,JSON.stringify(decision.evidence),JSON.stringify(full?job.raw??{}:snapshot.raw),full?'posting':'observation',id);
    const quality=scoreJob({...posting,matchEvidence:posting.matchEvidence??undefined},profile);
    if(decision.matchState==='excluded') {
      quality.score=0; quality.breakdown.hardExcluded=true; quality.breakdown.exclusionReason??=decision.reasons.includes('foreign_location')?'Outside the Netherlands':'Role is outside the current search profile'; quality.breakdown.overallScore=0; quality.breakdown.ruleScore=0;quality.breakdown.components=[];quality.breakdown.formula='Excluded by eligibility rules → not ranked';
    }
    const ai=(store.job(id) as any)?.ai_score,overall=decision.matchState==='excluded'?0:ai==null?quality.score:Math.round(quality.score*.7+Number(ai)*.3);
    quality.breakdown.overallScore=overall;if(ai!=null)quality.breakdown.aiScore=Number(ai);
    store.updateJobQuality(id,{description:full?job.description:undefined,enrichmentStatus:options.enrichmentStatus??'not-needed',enrichmentError:options.enrichmentError,ruleScore:quality.score,overallScore:overall,breakdown:quality.breakdown,scoringVersion:SCORING_VERSION,profileFingerprint:profileFingerprint(profile),seniority:quality.seniority,workArrangement:posting.workArrangement});
    store.updateMatch(id,decision.matchState,decision.reasons);
  }
  // Unrelated/excluded records keep identity and compact evidence, not whole page bodies.
  store.recordDecision({jobId:id,url,sourceId:options.sourceId,runId:options.scanId,profileFingerprint:profileFingerprint(profile),decision,job:snapshot});
  if(options.candidate && decision.retain && (!job.description || job.description.length<160) && options.enrichmentStatus!=='complete') {
    store.queueEnrichment(stableJobId('enrichment',job),job,options.candidate,options.employerId,options.discoveryRunId??options.scanId??'reevaluation');
  }
  return {decision,id,write};
}
