import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import App from "./AppV2";

describe("dashboard routes", () => {
  for (const [path, label] of [["/","Overview"],["/jobs","Jobs"],["/applications","Applications"],["/employers","Employers"],["/sources","Sources"],["/discovery","Discovery"],["/analytics","Analytics"],["/settings","Settings"]]) {
    it(`renders ${label}`, () => { vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); const html = renderToString(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>); expect(html).toContain("Diego"); expect(html).toContain(label); });
  }
  it("shows transparent default allocations and source scope", async()=>{
    const payload=(url:string)=>url.includes('/plan')?{limit:100,allocations:{linkedin:25,jobspy:25,priority:25,native:15,directories:10},rules:{candidateMeaning:'A candidate is not a vacancy.',redistribution:'Unused capacity is reassigned visibly.'},scope:{linkedin:{location:'Netherlands',terms:['data scientist'],strategy:'Newest then continuation.'},jobspy:{platforms:['indeed'],location:'Netherlands',preferredCities:['Utrecht'],queries:['data scientist'],broadQuery:'data scientist',version:'1.4.1'}},sources:[{id:'linkedin-guest',label:'LinkedIn Guest',category:'linkedin',enabled:true,status:'enabled'},{id:'jobspy-indeed',label:'JobSpy indeed',category:'jobspy',enabled:true,status:'enabled'},{id:'feashliaa-lever',label:'Feashliaa Lever directory',category:'directories',enabled:true,status:'enabled',deprioritized:true,originalPlanned:3,planned:1,yieldEvidence:{attempts:50,averageDurationMs:3000,matchYield:.01}}]}:url.includes('/coverage')?{employers:1,hiringEmployers:1,matchingVacancies:1,nonmatchingVacancies:0}:url.includes('/active')?null:{items:[]};
    vi.stubGlobal('fetch',vi.fn((input:any)=>Promise.resolve({ok:true,json:()=>Promise.resolve(payload(String(input)))})));const node=document.createElement('div'),root=createRoot(node);
    await act(async()=>{root.render(<MemoryRouter initialEntries={['/discovery']}><App/></MemoryRouter>);await new Promise(resolve=>setTimeout(resolve,20));});
    expect(node.textContent).toContain('All-time coverage');expect(node.textContent).toContain('LinkedIn Guest');expect(node.textContent).toContain('JobSpy');expect(node.textContent).toContain('Allocated 100 of 100');expect(node.textContent).toContain('Focused Netherlands searches');expect(node.textContent).toContain('For each preferred city, search these roles:');expect(node.textContent).toContain('data scientist');
    expect(node.textContent).toContain('Balanced rotation');expect(node.textContent).toContain('Fresh candidates');expect(node.textContent).toContain('Refresh known');expect(node.textContent).toContain('Same-day repeat behavior');
    expect(node.textContent).toContain('Workers');expect(node.textContent).toContain('Workday/Ashby: 1 per host');expect(node.textContent).toContain('deprioritized: 50 attempts');expect(node.textContent).toContain('3 to 1 initial candidates');
    expect(node.textContent).toContain('Strict source selection');expect(node.textContent).toContain('Only sources with a value above zero will run');expect(node.textContent).toContain('Included: LinkedIn Guest, JobSpy, Known & benchmark boards, Native Dutch feeds, Global ATS directories');
    await act(async()=>root.unmount());
  });
  it("shows queued progress, ETA, active workers and technical trace",async()=>{
    const plan={limit:100,allocations:{linkedin:25,jobspy:25,priority:25,native:15,directories:10},rules:{},scope:{linkedin:{terms:[]},jobspy:{platforms:[],preferredCities:[],queries:[]}},sources:[]};
    const running={id:"active-run",status:"running",display_status:"Running",phase:"processing",phase_message:"Processing queued candidates",mode:"balanced",selection_policy_label:"Strict source selection",limit_count:100,candidates_returned_count:12,queued_count:2,unfilled_count:98,duplicate_candidate_count:0,shortfall:[{sourceId:"linkedin-guest",label:"LinkedIn Guest",returned:10,skippedRecent:8,duplicates:0,queued:2}],processed_count:1,pending_count:1,fresh_candidate_count:1,recheck_candidate_count:1,eta:{seconds:120,lowerSeconds:60,upperSeconds:180,confidence:"medium",basis:"source timings"},active_tasks:[{candidate_id:"one",worker_id:"worker-1",stage:"enriching-description",company:"Acme",job_title:"Data Scientist",source_id:"job-board-directory",provider:"greenhouse",stage_elapsed_ms:1200,detail:"Fetching job-specific description",job_url:"https://example.test/job"}],attempts:[{started_at:"2026-01-01",company:"Example",source_id:"gigsignal",provider:"browser",result:"matched",duration_ms:900,jobs_fetched:1,netherlands_jobs:1,profile_matches:1}],sources:[]};
    vi.stubGlobal("fetch",vi.fn((input:any)=>{const url=String(input),value=url.includes("/trace")?{items:[{sequence:1,occurred_at:"2026-01-01",level:"info",phase:"processing",event_type:"http-response",source_id:"job-board-directory",message:"response 200",url:"https://example.test",http_status:200,duration_ms:50}],nextAfter:1,droppedCount:0}:url.endsWith("/active")?{id:"active-run"}:url.includes("/runs/active-run")?running:url.includes("/plan")?plan:url.includes("/coverage")?{}:url.includes("/forecast")?{freshnessDays:7,expectedRecentMatches:0,expectedUndatedMatches:0,confidence:"low",historicalRuns:0,historicalCandidates:0,unmodelledCandidates:100,categories:[]}:{items:[]};return Promise.resolve({ok:true,json:()=>Promise.resolve(value)});}));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const node=document.createElement("div"),root=createRoot(node);await act(async()=>{root.render(<MemoryRouter initialEntries={["/discovery"]}><App/></MemoryRouter>);await new Promise(resolve=>setTimeout(resolve,30));});
    expect(node.textContent).toContain("1of 2 queued");expect(node.textContent).toContain("About 2 min remaining");expect(node.textContent).toContain("Data Scientist");expect(node.textContent).toContain("Technical trace");expect(node.textContent).toContain("98 requested slots could not be filled");expect(node.textContent).toContain("10 returned → 8 recent skipped");
    await act(async()=>root.unmount());
  });
  it("shows the allocation-aware recent-match forecast",async()=>{
    const plan={limit:100,allocations:{linkedin:25,jobspy:25,priority:25,native:15,directories:10},rules:{candidateMeaning:"A candidate is not a vacancy.",redistribution:"Unused capacity is reassigned visibly."},scope:{linkedin:{location:"Netherlands",terms:[],strategy:"Newest first."},jobspy:{platforms:[],location:"Netherlands",preferredCities:[],queries:[],broadQuery:"",version:"1"}},sources:[]};
    vi.stubGlobal("fetch",vi.fn((input:any,init?:RequestInit)=>{const url=String(input);const value=url.includes("/forecast")?{freshnessDays:7,expectedRecentMatches:3.4,expectedUndatedMatches:.6,confidence:"medium",historicalRuns:3,historicalCandidates:240,unmodelledCandidates:10,categories:[{category:"linkedin",allocated:25,expectedRecentMatches:1.2,modelled:true},{category:"directories",allocated:10,expectedRecentMatches:0,modelled:false}]}:url.includes("/plan")?plan:url.includes("/coverage")?{}:url.includes("/active")?null:{items:[]};return Promise.resolve({ok:true,json:()=>Promise.resolve(value)});}));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const node=document.createElement("div"),root=createRoot(node);
    await act(async()=>{root.render(<MemoryRouter initialEntries={["/discovery"]}><App/></MemoryRouter>);});
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,380));});
    expect(node.textContent).toContain("~3 recent matches");expect(node.textContent).toContain("~1");expect(node.textContent).toContain("medium confidence");expect(node.textContent).toContain("10 allocated candidates lack enough history");expect(node.textContent).toContain("insufficient history");
    await act(async()=>root.unmount());
  });
  it("shows forecast loading and API error states",async()=>{
    const plan={limit:100,allocations:{linkedin:25,jobspy:25,priority:25,native:15,directories:10},rules:{},scope:{linkedin:{terms:[]},jobspy:{platforms:[],preferredCities:[],queries:[]}},sources:[]};let finishForecast:(value:any)=>void=()=>{};
    vi.stubGlobal("fetch",vi.fn((input:any)=>{const url=String(input);if(url.includes("/forecast"))return new Promise(resolve=>{finishForecast=resolve});const value=url.includes("/plan")?plan:url.includes("/active")?null:url.includes("/coverage")?{}:{items:[]};return Promise.resolve({ok:true,json:()=>Promise.resolve(value)});}));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const node=document.createElement("div"),root=createRoot(node);
    await act(async()=>{root.render(<MemoryRouter initialEntries={["/discovery"]}><App/></MemoryRouter>);});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,330));});
    expect(node.textContent).toContain("Estimating recent matches");
    await act(async()=>{finishForecast({ok:false,json:()=>Promise.resolve({error:"No forecast evidence"})});await Promise.resolve();});
    expect(node.textContent).toContain("Forecast unavailable: No forecast evidence");
    await act(async()=>root.unmount());
  });
});
