import type { DiscoveryCandidate } from "./types.js";

export const DISCOVERY_DURATIONS = [5, 10, 20, 30] as const;
export type DiscoveryDurationMinutes = typeof DISCOVERY_DURATIONS[number];
export const ADAPTIVE_STRATEGY_VERSION = 3;
export const ADAPTIVE_FORECAST_MODEL_VERSION = "fresh-strong-7d-v3";
export const ADAPTIVE_TARGET = "new-strong-posted-within-7-days";

export function validateDiscoveryDuration(value: unknown): DiscoveryDurationMinutes {
  const minutes = Number(value ?? 10);
  if (!DISCOVERY_DURATIONS.includes(minutes as DiscoveryDurationMinutes))
    throw Object.assign(new Error("Discovery duration must be 5, 10, 20, or 30 minutes"), { statusCode: 400 });
  return minutes as DiscoveryDurationMinutes;
}

export function discoveryArmId(candidate: Pick<DiscoveryCandidate,"sourceId"|"boardUrl"|"company"|"provider">): string {
  if ((candidate as DiscoveryCandidate).searchArmId) return (candidate as DiscoveryCandidate).searchArmId!;
  if (candidate.boardUrl) { try { const url=new URL(candidate.boardUrl);return `board:${url.origin}${url.pathname.replace(/\/$/,"")}`; } catch {/* fall through */} }
  return `feed:${candidate.sourceId}:${candidate.provider??"embedded"}`;
}

export function recencyReward(postedAt?: string, asOf = Date.now()): { reward:number; band:"0-7"|"8-30"|"31-60"|"older"|"unknown" } {
  if (!postedAt || !Number.isFinite(Date.parse(postedAt))) return { reward:0,band:"unknown" };
  const posted=Date.parse(postedAt);
  if(posted>asOf)return {reward:0,band:"unknown"};
  const days=(asOf-posted)/86_400_000;
  if(days<=7)return {reward:1,band:"0-7"};
  if(days<=30)return {reward:0,band:"8-30"};
  if(days<=60)return {reward:0,band:"31-60"};
  return {reward:0,band:"older"};
}

export interface AdaptiveEvidence { armId:string;sourceId:string;label:string;pulls:number;workerMs:number;reward:number;failures:number;duplicates:number;lastAt?:string; }
export interface AdaptiveRank extends AdaptiveEvidence { expectedRewardPerMinute:number;confidenceBonus:number;score:number;reason:string;evidence:"sparse"|"limited"|"established" }

export interface AdaptiveDurationForecast {
  durationMinutes: DiscoveryDurationMinutes;
  expectedFreshStrongMatches: number;
  likelyRange: { lower:number; upper:number; level:0.8 };
  probabilityAtLeastOne: number;
  probabilityAtLeastFive: number;
  expectedPerMinute: number;
  marginalMatches: number;
  marginalPerMinute: number;
  bestValue: boolean;
}

export function negativeBinomialCdf(maximum:number,mean:number,dispersion:number):number{
  if(maximum<0)return 0;
  if(mean<=0)return 1;
  const shape=Math.max(.5,dispersion),success=shape/(shape+mean),failure=1-success;
  let probability=Math.pow(success,shape),total=probability;
  for(let value=1;value<=maximum;value++){
    probability*=((value-1+shape)/value)*failure;
    total+=probability;
  }
  return Math.min(1,Math.max(0,total));
}

export function negativeBinomialQuantile(fraction:number,mean:number,dispersion:number):number{
  if(mean<=0)return 0;
  const shape=Math.max(.5,dispersion),success=shape/(shape+mean),failure=1-success;
  let probability=Math.pow(success,shape),total=probability,value=0;
  const ceiling=Math.max(100,Math.ceil(mean*20+100));
  while(total<fraction&&value<ceiling){value++;probability*=((value-1+shape)/value)*failure;total+=probability;}
  return value;
}

export function rankAdaptiveArms(rows:AdaptiveEvidence[],now=Date.now()):AdaptiveRank[]{
  const totalPulls=rows.reduce((sum,row)=>sum+row.pulls,0),globalMs=rows.reduce((sum,row)=>sum+row.workerMs,0),globalReward=rows.reduce((sum,row)=>sum+row.reward,0),globalRate=globalReward/Math.max(60_000,globalMs);
  return rows.map(row=>{
    const priorMs=5*15_000,priorReward=globalRate*priorMs,rate=(row.reward+priorReward)/Math.max(1,row.workerMs+priorMs),confidenceBonus=globalRate*Math.sqrt(2*Math.log(totalPulls+2)/(row.pulls+1));
    const failureRate=Math.min(1,row.failures/Math.max(1,row.pulls)),duplicateRate=Math.min(1,row.duplicates/Math.max(1,row.pulls)),hours=row.lastAt?Math.max(0,(now-Date.parse(row.lastAt))/3_600_000):168,recovery=1-Math.exp(-hours/(row.armId.startsWith("feed:")?6:24));
    const score=Math.max(0,(rate+confidenceBonus)*(1-failureRate)*Math.max(.15,1-duplicateRate)*Math.max(.15,recovery));
    const evidence:AdaptiveRank["evidence"]=row.pulls>=50?"established":row.pulls>=10?"limited":"sparse";
    const reason=evidence==="sparse"?"Exploration: limited evidence":failureRate>.2?"Deprioritized by failures":duplicateRate>.5?"Deprioritized by repeated results":hours<2?"Recently searched; yield has not recovered":"Strong recent-match efficiency";
    return {...row,expectedRewardPerMinute:Number((rate*60_000).toFixed(3)),confidenceBonus:Number((confidenceBonus*60_000).toFixed(3)),score:Number((score*60_000).toFixed(6)),reason,evidence};
  }).sort((a,b)=>b.score-a.score||a.armId.localeCompare(b.armId));
}
