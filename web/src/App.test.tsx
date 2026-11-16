import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import App,{countdownSeconds} from "./AppV2";

const preview={durationMinutes:10,durations:[5,10,20,30],deadlinePolicy:"Stop launching at the selected time; drain active work for up to 30 seconds.",objective:{weights:{"0-7":1,"8-30":.4,"31-60":.1,unknown:0}},forecast:{expectedUsefulMatches:{point:3.2,lower:1,upper:7},confidence:"experimental",warnings:["Evidence is still sparse."],arms:[{armId:"feed:linkedin-guest:embedded",label:"LinkedIn Guest",reason:"Strong recent-match efficiency",evidence:"limited",expectedRewardPerMinute:1.25}]},sources:[]};

describe("discovery countdown",()=>{
  it("keeps moving from the deadline when the API fallback is stale",()=>{
    const deadline="2026-11-16T15:30:00.000Z";
    expect(countdownSeconds(deadline,1473,Date.parse("2026-11-16T15:05:27.000Z"))).toBe(1473);
    expect(countdownSeconds(deadline,1473,Date.parse("2026-11-16T15:05:28.000Z"))).toBe(1472);
  });
});
const response=(value:any,status=200)=>Promise.resolve({ok:status>=200&&status<300,status,json:()=>Promise.resolve(value)});

describe("dashboard routes",()=>{
  for(const [path,label] of [["/","Overview"],["/jobs","Jobs"],["/applications","Applications"],["/employers","Employers"],["/sources","Sources"],["/discovery","Discovery"],["/analytics","Analytics"],["/settings","Settings"]])it(`renders ${label}`,()=>{vi.stubGlobal("fetch",vi.fn(()=>new Promise(()=>{})));const html=renderToString(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>);expect(html).toContain("Diego");expect(html).toContain(label)});

  it("places manual vacancy collection on Discovery",()=>{vi.stubGlobal("fetch",vi.fn(()=>new Promise(()=>{})));const html=renderToString(<MemoryRouter initialEntries={["/discovery"]}><App/></MemoryRouter>);expect(html).toContain("Add a vacancy by URL");expect(html).toContain("Add &amp; save")});

  it("shows timed adaptive controls and their freshness objective",async()=>{
    vi.stubGlobal("fetch",vi.fn((input:any)=>{const url=String(input),value=url.includes("/plan")?preview:url.includes("/active")?null:url.includes("/enrichment/queue")?{summary:{eligibleNow:0,coolingDown:0},runnerStatus:{state:"idle",activeBatch:0}}:{items:[]};return response(value)}));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const node=document.createElement("div"),root=createRoot(node);await act(async()=>{root.render(<MemoryRouter initialEntries={["/discovery"]}><App/></MemoryRouter>);await new Promise(resolve=>setTimeout(resolve,20))});
    expect(node.textContent).toContain("Choose processing time");expect(node.textContent).toContain("5 minutes");expect(node.textContent).toContain("30 minutes");expect(node.textContent).toContain("unknown dates earn zero");expect(node.textContent).toContain("LinkedIn Guest");expect(node.textContent).toContain("1.25 reward/min");expect(node.textContent).not.toContain("Candidate budget");await act(async()=>root.unmount());
  });

  it("starts discovery with duration only and renders the live scheduler",async()=>{
    let startBody:any;const running={id:"run-1",status:"running",phase:"processing",phase_message:"Adaptive processing",processed_count:6,useful_match_count:2,recent_7_count:1,recent_30_count:1,recent_60_count:0,unknown_date_count:1,weighted_reward:1.4,adaptive:{durationMinutes:10,remainingSeconds:420,currentConcurrency:6,deadlineAt:"2026-11-13T12:00:00.000Z",pulls:[{started_at:"2026-11-13",label:"Indeed",returned:10,eligible:4,duration_ms:500}]},active_tasks:[]};
    vi.stubGlobal("fetch",vi.fn((input:any,init?:RequestInit)=>{const url=String(input);if(url.endsWith("/api/v1/discovery")&&init?.method==="POST"){startBody=JSON.parse(String(init.body));return response({id:"run-1",status:"starting"},202)}const value=url.includes("/runs/run-1/trace")?{items:[],nextAfter:0,droppedCount:0}:url.includes("/runs/run-1")?running:url.includes("/plan")?preview:url.includes("/active")?null:url.includes("/enrichment/queue")?{summary:{eligibleNow:0,coolingDown:0},runnerStatus:{state:"idle"}}:{items:[]};return response(value)}));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const node=document.createElement("div"),root=createRoot(node);await act(async()=>{root.render(<MemoryRouter initialEntries={["/discovery"]}><App/></MemoryRouter>);await new Promise(resolve=>setTimeout(resolve,20))});const button=Array.from(node.querySelectorAll("button")).find(item=>item.textContent?.includes("Start 10-minute"))!;await act(async()=>{button.click();await new Promise(resolve=>setTimeout(resolve,20))});
    expect(startBody).toEqual({durationMinutes:10});expect(node.textContent).toContain("Adaptive processing");expect(node.textContent).toContain("6 adaptive workers");expect(node.textContent).toContain("1.4");expect(node.textContent).toContain("Recent scheduler decisions");expect(node.textContent).toContain("Indeed");await act(async()=>root.unmount());
  });

  it("shows enrichment status and allows manually running due work",async()=>{
    let processCalls=0;vi.stubGlobal("fetch",vi.fn((input:any)=>{const url=String(input);if(url.includes("/enrichment/queue/process")){processCalls++;return response({status:"scheduled",eligibleCount:3},202)}const value=url.includes("/plan")?preview:url.includes("/active")?null:url.includes("/enrichment/queue")?{summary:{eligibleNow:3,coolingDown:7},runnerStatus:{state:"waiting"}}:{items:[]};return response(value)}));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const node=document.createElement("div"),root=createRoot(node);await act(async()=>{root.render(<MemoryRouter initialEntries={["/discovery"]}><App/></MemoryRouter>);await new Promise(resolve=>setTimeout(resolve,20))});expect(node.textContent).toContain("waiting");expect(node.textContent).toContain("3 ready");const button=Array.from(node.querySelectorAll("button")).find(item=>item.textContent==="Run due now")!;await act(async()=>{button.click();await new Promise(resolve=>setTimeout(resolve,10))});expect(processCalls).toBe(1);expect(node.textContent).toContain("Starting 3 due descriptions.");await act(async()=>root.unmount());
  });

  it("labels adaptive history outcomes and source yield without an ambiguous slash",async()=>{
    const history={id:"history-1",status:"completed",display_status:"Completed",started_at:"2026-11-13T10:00:00Z",time_budget_ms:300000,processed_count:12,queued_count:12,new_strong_count:3,useful_match_count:2,weighted_reward:1.4,error_count:0,metrics_version:2,selection_policy_label:"Adaptive time window",completion_summary:"5 minutes · 3 new strong · 2 reward-eligible · 1.4 weighted reward",status_reasons:[]},detail={...history,sources:[{source_id:"jobspy-indeed",label:"Indeed · Netherlands · data analyst",pulls:2,returned_count:18,queued_count:7,duplicate_count:11,acquisition_ms:16000,processed_candidates:7,jobs_fetched:7,new_strong_count:3,useful_match_count:2,weighted_reward:1.4}]};
    vi.stubGlobal("fetch",vi.fn((input:any)=>{const url=String(input),value=url.includes("/runs/history-1")?detail:url.endsWith("/discovery/runs")?{items:[history]}:url.includes("/plan")?preview:url.includes("/active")?null:url.includes("/enrichment/queue")?{summary:{eligibleNow:0,coolingDown:0},runnerStatus:{state:"idle"}}:{items:[]};return response(value)}));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const node=document.createElement("div"),root=createRoot(node);await act(async()=>{root.render(<MemoryRouter initialEntries={["/discovery"]}><App/></MemoryRouter>);await new Promise(resolve=>setTimeout(resolve,25))});expect(node.textContent).toContain("5 minutes · 3 new strong · 2 reward-eligible · 1.4 reward");expect(node.textContent).toContain("Unique queued");expect(node.textContent).toContain("True duplicates");expect(node.textContent).not.toContain("5 min / 1.4");await act(async()=>root.unmount());
  });
});
