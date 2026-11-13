export const FORECAST_MODEL_VERSION = "poisson-source-v1";
export const FORECAST_TARGET = "Distinct jobs first discovered during the run and eventually classified as a strong match after any queued description enrichment; refreshed, possible, excluded, and duplicate jobs do not count.";

export type ForecastMode = "balanced" | "fresh" | "refresh-known" | "turbo" | "adaptive";
export interface ForecastHistoryRow {
  runId:string; startedAt:string; mode:ForecastMode; sourceId:string; label:string; category:string;
  planned:number; candidates:number; failures:number; newStrong:number;
}
export interface ForecastPlanRow {sourceId:string;label:string;category:string;planned:number}
export interface ForecastMetrics {runs:number;mae:number|null;wape:number|null;coverage95:number|null}
export interface ForecastEstimate {point:number;lower:number;upper:number;intervalLevel:.95;metrics:ForecastMetrics}
export interface ForecastSourceResult {
  sourceId:string;label:string;category:string;planned:number;mlExpected:number;baselineExpected:number;
  historicalRuns:number;historicalCandidates:number;historicalNewStrong:number;yieldPer100:number;evidence:"sparse"|"limited"|"established";
  factors:Array<{label:string;value:number;effect:number}>;
}
export interface TransparentForecast {
  target:"new-strong-matches";targetDefinition:string;modelVersion:string;mode:ForecastMode;limit:number;asOf:string;
  reliability:"experimental"|"limited"|"validated";trainingRuns:number;trainingCandidates:number;
  ml:ForecastEstimate;baseline:ForecastEstimate;betterBacktest:"ml"|"baseline"|"insufficient-data";
  sources:ForecastSourceResult[];warnings:string[];
  calculation:{model:string;baseline:string;interval:string;features:string[]};
  history:Array<{runId:string;startedAt:string;actual:number;ml:number;baseline:number}>;
}
export interface ForecastSeriesInput {limit:number;plan:ForecastPlanRow[]}

const categories=["linkedin","jobspy","priority","native","directories"];
const featureNames=["intercept",...categories.map(value=>`category:${value}`),"mode:fresh","mode:refresh-known","prior source yield","prior category yield","failure rate","days since source run","source saturation"];
const round1=(value:number)=>Math.round(Math.max(0,value)*10)/10;
const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value));
const days=(from:string,to:string)=>Math.max(0,(Date.parse(to)-Date.parse(from))/86_400_000);

interface Totals {candidates:number;matches:number;failures:number;runs:number;lastAt?:string}
interface Features {x:number[];source:Totals;category:Totals}
function priorFeatures(rows:ForecastHistoryRow[],row:Pick<ForecastHistoryRow,"sourceId"|"category"|"mode"|"startedAt">):Features{
  const before=rows.filter(value=>Date.parse(value.startedAt)<Date.parse(row.startedAt));
  const total=(items:ForecastHistoryRow[]):Totals=>items.reduce<Totals>((acc,value)=>({candidates:acc.candidates+value.candidates,matches:acc.matches+value.newStrong,failures:acc.failures+value.failures,runs:acc.runs+1,lastAt:!acc.lastAt||value.startedAt>acc.lastAt?value.startedAt:acc.lastAt}),{candidates:0,matches:0,failures:0,runs:0});
  const source=total(before.filter(value=>value.sourceId===row.sourceId)),category=total(before.filter(value=>value.category===row.category));
  const global=total(before),globalRate=(global.matches+1)/(global.candidates+20),categoryRate=(category.matches+globalRate*25)/(category.candidates+25),sourceRate=(source.matches+categoryRate*20)/(source.candidates+20);
  const failureRate=(source.failures+1)/(source.candidates+10),recency=source.lastAt?Math.min(days(source.lastAt,row.startedAt),90)/90:1,saturation=Math.min(Math.log1p(source.candidates)/Math.log(5001),1);
  return {source,category,x:[1,...categories.map(value=>value===row.category?1:0),row.mode==="fresh"?1:0,row.mode==="refresh-known"?1:0,Math.log1p(sourceRate*100)/5,Math.log1p(categoryRate*100)/5,failureRate,recency,saturation]};
}

function train(rows:ForecastHistoryRow[]):number[]{
  const usable=rows.filter(row=>row.candidates>0).sort((a,b)=>a.startedAt.localeCompare(b.startedAt)),width=featureNames.length,coefficients=Array(width).fill(0);
  const rate=(usable.reduce((sum,row)=>sum+row.newStrong,0)+1)/(usable.reduce((sum,row)=>sum+row.candidates,0)+20);coefficients[0]=Math.log(rate);
  if(usable.length<2)return coefficients;
  const samples=usable.map(row=>({row,x:priorFeatures(usable,row).x}));
  for(let iteration=0;iteration<1600;iteration++){
    const gradient=Array(width).fill(0);
    for(const {row,x} of samples){const eta=clamp(Math.log(Math.max(1,row.candidates))+x.reduce((sum,value,index)=>sum+value*coefficients[index],0),-10,10),predicted=Math.exp(eta),error=predicted-row.newStrong;for(let index=0;index<width;index++)gradient[index]+=error*x[index];}
    const step=.025/Math.sqrt(1+iteration/80),scale=Math.max(1,usable.length);
    for(let index=0;index<width;index++){const ridge=index===0?0:.08*coefficients[index];coefficients[index]-=step*(gradient[index]/scale+ridge);coefficients[index]=clamp(coefficients[index],-5,5);}
  }
  return coefficients;
}

function mlPrediction(history:ForecastHistoryRow[],coefficients:number[],row:ForecastPlanRow,mode:ForecastMode,asOf:string){
  if(row.planned<=0)return {point:0,features:priorFeatures(history,{...row,mode,startedAt:asOf})};
  const features=priorFeatures(history,{...row,mode,startedAt:asOf}),eta=clamp(Math.log(row.planned)+features.x.reduce((sum,value,index)=>sum+value*coefficients[index],0),-10,10);
  return {point:Math.exp(eta),features};
}
function baselinePrediction(history:ForecastHistoryRow[],row:ForecastPlanRow,mode:ForecastMode,asOf:string):number{
  if(row.planned<=0)return 0;
  const turboRuns=new Set(history.filter(value=>value.startedAt<asOf&&value.mode==="turbo").map(value=>value.runId)).size,baselineMode=mode==="turbo"&&turboRuns<3?"balanced":mode;
  const prior=history.filter(value=>value.startedAt<asOf&&value.mode===baselineMode),source=prior.filter(value=>value.sourceId===row.sourceId),category=prior.filter(value=>value.category===row.category);
  const weighted=(items:ForecastHistoryRow[])=>items.reduce((acc,value)=>{const weight=Math.exp(-days(value.startedAt,asOf)/30);return {c:acc.c+weight*value.candidates,m:acc.m+weight*value.newStrong}}, {c:0,m:0});
  const all=weighted(prior),cat=weighted(category),src=weighted(source),globalRate=(all.m+1)/(all.c+20),categoryRate=(cat.m+globalRate*25)/(cat.c+25),sourceRate=(src.m+categoryRate*20)/(src.c+20);
  return row.planned*sourceRate;
}
function quantile(values:number[],level:number):number{if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b),index=Math.min(sorted.length-1,Math.max(0,Math.ceil(level*(sorted.length+1))-1));return sorted[index];}
function interval(point:number,residuals:number[]):[number,number]{const radius=residuals.length>=3?quantile(residuals,.95):Math.max(2,1.96*Math.sqrt(point+1));return [round1(Math.max(0,point-radius)),round1(point+radius)];}
function metrics(actual:number[],predicted:number[],residuals:number[]):ForecastMetrics{
  if(!actual.length)return {runs:0,mae:null,wape:null,coverage95:null};
  const absolute=actual.map((value,index)=>Math.abs(value-predicted[index])),mae=absolute.reduce((a,b)=>a+b,0)/actual.length,wape=absolute.reduce((a,b)=>a+b,0)/Math.max(1,actual.reduce((a,b)=>a+b,0));
  const covered=actual.filter((value,index)=>{const [lower,upper]=interval(predicted[index],residuals.slice(0,index));return value>=lower&&value<=upper}).length;
  return {runs:actual.length,mae:round1(mae),wape:round1(wape),coverage95:round1(covered/actual.length)};
}

function backtest(rows:ForecastHistoryRow[]){
  const runIds=[...new Set(rows.map(row=>row.runId))].sort((a,b)=>rows.find(x=>x.runId===a)!.startedAt.localeCompare(rows.find(x=>x.runId===b)!.startedAt)).slice(-16),history:Array<{runId:string;startedAt:string;actual:number;ml:number;baseline:number}>=[];
  for(let index=3;index<runIds.length;index++){
    const id=runIds[index],test=rows.filter(row=>row.runId===id),startedAt=test[0]?.startedAt;if(!startedAt)continue;
    const training=rows.filter(row=>row.startedAt<startedAt),coefficients=train(training),plan=test.map(row=>({sourceId:row.sourceId,label:row.label,category:row.category,planned:row.candidates}));
    const actual=test.reduce((sum,row)=>sum+row.newStrong,0),ml=plan.reduce((sum,row)=>sum+mlPrediction(training,coefficients,row,test[0].mode,startedAt).point,0),baseline=plan.reduce((sum,row)=>sum+baselinePrediction(training,row,test[0].mode,startedAt),0);
    history.push({runId:id,startedAt,actual,ml:round1(ml),baseline:round1(baseline)});
  }
  const actual=history.map(row=>row.actual),ml=history.map(row=>row.ml),baseline=history.map(row=>row.baseline),mlResiduals=history.map(row=>Math.abs(row.actual-row.ml)),baselineResiduals=history.map(row=>Math.abs(row.actual-row.baseline));
  return {history,mlResiduals,baselineResiduals,mlMetrics:metrics(actual,ml,mlResiduals),baselineMetrics:metrics(actual,baseline,baselineResiduals)};
}

interface PreparedForecast {history:ForecastHistoryRow[];coefficients:number[];validation:ReturnType<typeof backtest>;asOf:string}
function prepareForecast(historyRows:ForecastHistoryRow[],asOf:string):PreparedForecast{
  const history=historyRows.filter(row=>row.candidates>0&&row.startedAt<asOf).sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
  return {history,coefficients:train(history),validation:backtest(history),asOf};
}
function buildPreparedForecast(prepared:PreparedForecast,plan:ForecastPlanRow[],mode:ForecastMode,limit:number):TransparentForecast{
  const {history,coefficients,validation,asOf}=prepared;
  const sources=plan.filter(row=>row.planned>0).map(row=>{
    const predicted=mlPrediction(history,coefficients,row,mode,asOf),baseline=baselinePrediction(history,row,mode,asOf),sourceRows=history.filter(value=>value.sourceId===row.sourceId),candidates=sourceRows.reduce((sum,value)=>sum+value.candidates,0),matches=sourceRows.reduce((sum,value)=>sum+value.newStrong,0);
    const factors=predicted.features.x.map((value,index)=>({label:featureNames[index],value:round1(value),effect:round1(value*coefficients[index])})).filter(value=>value.label!=="intercept").sort((a,b)=>Math.abs(b.effect)-Math.abs(a.effect)).slice(0,3);
    return {sourceId:row.sourceId,label:row.label,category:row.category,planned:row.planned,mlExpected:round1(predicted.point),baselineExpected:round1(baseline),historicalRuns:sourceRows.length,historicalCandidates:candidates,historicalNewStrong:matches,yieldPer100:round1(matches/Math.max(1,candidates)*100),evidence:candidates>=200&&sourceRows.length>=5?"established":candidates>=50&&sourceRows.length>=2?"limited":"sparse",factors} as ForecastSourceResult;
  });
  const mlPoint=sources.reduce((sum,row)=>sum+row.mlExpected,0),baselinePoint=sources.reduce((sum,row)=>sum+row.baselineExpected,0),[mlLower,mlUpper]=interval(mlPoint,validation.mlResiduals),[baselineLower,baselineUpper]=interval(baselinePoint,validation.baselineResiduals),trainingRuns=new Set(history.map(row=>row.runId)).size,trainingCandidates=history.reduce((sum,row)=>sum+row.candidates,0);
  const reliability=validation.mlMetrics.runs>=8&&trainingCandidates>=500&&(validation.mlMetrics.coverage95??0)>=.85&&(validation.mlMetrics.wape??Infinity)<=.5?"validated":validation.mlMetrics.runs>=4&&trainingCandidates>=100?"limited":"experimental";
  const warnings:string[]=[];if(mode==="turbo"&&new Set(history.filter(row=>row.mode==="turbo").map(row=>row.runId)).size<3)warnings.push("Turbo has fewer than three completed runs, so its recent-history baseline uses comparable Balanced runs.");if(sources.some(row=>row.evidence==="sparse"))warnings.push("One or more planned sources have sparse history; their estimates are shrunk toward category experience.");if(validation.mlMetrics.mae!==null&&validation.baselineMetrics.mae!==null&&validation.baselineMetrics.mae<validation.mlMetrics.mae)warnings.push("The recent-history baseline has lower walk-forward error than the ML model; both estimates are shown.");if(history.length&&days(history.at(-1)!.startedAt,asOf)>30)warnings.push("The newest comparable training evidence is more than 30 days old.");if(plan.reduce((sum,row)=>sum+row.planned,0)<limit)warnings.push("Configured sources cannot fill the requested candidate budget, so the forecast uses the smaller planned total.");
  const betterBacktest=validation.mlMetrics.mae===null||validation.baselineMetrics.mae===null?"insufficient-data":validation.mlMetrics.mae<=validation.baselineMetrics.mae?"ml":"baseline";
  return {target:"new-strong-matches",targetDefinition:FORECAST_TARGET,modelVersion:FORECAST_MODEL_VERSION,mode,limit,asOf,reliability,trainingRuns,trainingCandidates,ml:{point:round1(mlPoint),lower:mlLower,upper:mlUpper,intervalLevel:.95,metrics:validation.mlMetrics},baseline:{point:round1(baselinePoint),lower:baselineLower,upper:baselineUpper,intervalLevel:.95,metrics:validation.baselineMetrics},betterBacktest,sources,warnings,calculation:{model:"Regularized Poisson count model trained on time-ordered source/run outcomes.",baseline:"Recency-weighted source yield, shrunk toward category and global history.",interval:"95% conformal interval from walk-forward absolute forecast errors; a conservative count interval is used until enough residuals exist.",features:["source and category","run mode","planned candidates","prior source/category yield","prior failure rate","source recency","source saturation"]},history:validation.history.slice(-8)};
}
export function buildTransparentForecast(historyRows:ForecastHistoryRow[],plan:ForecastPlanRow[],mode:ForecastMode,limit:number,asOf=new Date().toISOString()):TransparentForecast{
  return buildPreparedForecast(prepareForecast(historyRows,asOf),plan,mode,limit);
}
export function buildTransparentForecastSeries(historyRows:ForecastHistoryRow[],inputs:ForecastSeriesInput[],mode:ForecastMode,asOf=new Date().toISOString()):TransparentForecast[]{
  const prepared=prepareForecast(historyRows,asOf);
  return inputs.map(input=>buildPreparedForecast(prepared,input.plan,mode,input.limit));
}
