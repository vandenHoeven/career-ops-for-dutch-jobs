import { MissingJobCheck, DecisionHistory, reasonLabel } from './CoverageTools';
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import LegacyApp from "./App";
import { api, date } from "./api";
import "./dense.css";
import "./action-column.css";
import LocationSettings from "./LocationSettings";
import "./location-settings.css";
import { EmployerDetail, EmployersPage } from "./EmployerIntelligence";
import { SourceDetail, SourcesPage } from "./SourceIntelligence";

type Job = Record<string, any>;
const navigation = [
  ["/", "Overview", "⌂"],
  ["/jobs", "Jobs", "◇"],
  ["/applications", "Applications", "▤"],
  ["/employers", "Employers", "◉"],
  ["/sources", "Sources", "◎"],
  ["/discovery", "Discovery", "↻"],
  ["/analytics", "Analytics", "▥"],
  ["/settings", "Settings", "⚙"],
];
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="shell dense-shell">
      <aside>
        <div className="brand">
          <span className="mark">D</span>
          <div>
            <strong>Diego</strong>
            <small>Career Ops</small>
          </div>
        </div>
        <nav>
          {navigation.map(([to, label, icon]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              <span>{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="local">
          <i />
          Local & private
        </div>
      </aside>
      <main>{children}</main>
      <div className="mobile-nav">
        {navigation.slice(0, 6).map(([to, label, icon]) => (
          <NavLink key={to} to={to} end={to === "/"}>
            <span>{icon}</span>
            <small>{label}</small>
          </NavLink>
        ))}
      </div>
    </div>
  );
}
function Page({
  eyebrow,
  title,
  actions,
  children,
}: {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <header className="page-head dense-head">
        <div>
          <p>{eyebrow}</p>
          <h1>{title}</h1>
        </div>
        {actions}
      </header>
      {children}
    </>
  );
}
function useData<T>(path: string) {
  const [tick, setTick] = useState(0),
    [state, setState] = useState<{
      data?: T;
      loading: boolean;
      error?: string;
    }>({ loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    api<T>(path)
      .then((data) => live && setState({ data, loading: false }))
      .catch(
        (error) => live && setState({ loading: false, error: error.message }),
      );
    return () => {
      live = false;
    };
  }, [path, tick]);
  return { ...state, reload: () => setTick((x) => x + 1) };
}
const Loading = () => <div className="dense-empty">Loading evidence…</div>;
const DateCell = ({
  value,
  missing = "Not supplied",
}: {
  value?: string | null;
  missing?: string;
}) => (
  <span className={value ? "date-value" : "unknown"}>
    {value ? date(value) : missing}
  </span>
);
const Score = ({ job }: { job: Job }) => (
  <span
    className={`score-pill ${job.hard_excluded ? "excluded" : job.overall_score >= 75 ? "high" : job.overall_score >= 55 ? "medium" : "low"}`}
  >
    {job.hard_excluded ? "Excluded" : (job.overall_score ?? "—")}
  </span>
);

function JobTable({
  items,
  reload,
  compact = false,
  selected,
  onSelected,
  returnTo,
}: {
  items: Job[];
  reload?: () => void;
  compact?: boolean;
  selected?: Set<string>;
  onSelected?: (ids:Set<string>)=>void;
  returnTo?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const mutate = async (
    event: React.MouseEvent,
    job: Job,
    action: "save" | "decline",
  ) => {
    event.stopPropagation();
    if (action === "save")
      await api(`/api/v1/jobs/${job.id}/application`, {
        method: "PUT",
        body: JSON.stringify({ stage: "saved" }),
      });
    else
      await api(`/api/v1/jobs/${job.id}/review`, {
        method: "PATCH",
        body: JSON.stringify({ state: "declined" }),
      });
    reload?.();
  };
  return (
    <div className="data-table-wrap" tabIndex={0} aria-label="Scrollable job results">
      <table className="job-table">
        <thead>
          <tr>
            {selected&&<th><input aria-label="Select all visible jobs" type="checkbox" checked={items.length>0&&items.every(job=>selected.has(job.id))} onChange={e=>{const next=new Set(selected);items.forEach(job=>e.target.checked?next.add(job.id):next.delete(job.id));onSelected?.(next)}}/></th>}
            <th>Score</th>
            <th>Role / company</th>
            <th>Location / mode</th>
            {!compact && (
              <>
                <th>Posted</th>
              </>
            )}
            <th>Source</th>
            {!compact && <><th>Review</th><th>Application</th></>}
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {items.map((job) => (
            <tr
              key={job.id}
              data-job-id={job.id}
              tabIndex={-1}
              onClick={() => {sessionStorage.setItem("jobs:focus",job.id);navigate(`/jobs/${job.id}`,{state:{returnTo:returnTo??location.pathname+location.search}})}}
            >
              {selected&&<td onClick={e=>e.stopPropagation()}><input aria-label={`Select ${job.title}`} type="checkbox" checked={selected.has(job.id)} onChange={e=>{const next=new Set(selected);e.target.checked?next.add(job.id):next.delete(job.id);onSelected?.(next)}}/></td>}
              <td>
                <Score job={job} />
              </td>
              <td>
                <strong>{job.title}</strong>
                <small>{job.company}</small><span className={`match-label ${job.match_state==='possible'?'possible':'strong'}`}>{job.hard_excluded?'Excluded':job.match_state==='possible'?'Possible match':'Strong match'}</span>
                {job.matchedFrom && job.matchedFrom !== 'title' && <small title="This role qualified through evidence beyond its title; the points ledger explains the confidence deduction.">{job.matchedFrom} match · {job.matchConfidence} confidence</small>}
              </td>
              <td>
                {job.location || "Location unconfirmed"}
                <small>{job.work_arrangement || "unknown mode"}</small>
              </td>
              {!compact && (
                <>
                  <td>
                    <DateCell value={job.posted_at} />
                    <small>
                      {job.posted_at
                        ? job.posted_date_precision
                        : "Provider did not supply"}
                    </small>
                  </td>
                </>
              )}
              <td>
                <strong className="source-name">{job.source_id}</strong>
                <small>{job.provider}</small>
              </td>
              {!compact && (
                <><td><span className={`review-badge ${job.review_state}`}>{job.review_state}</span></td><td>{job.application_stage?<span className="state-badge">{job.application_stage}</span>:<span className="unknown">Not started</span>}</td></>
              )}
              <td>
                <div className="row-actions">
                  <button
                    title="Save job"
                    onClick={(e) => mutate(e, job, "save")}
                  >
                    ＋
                  </button>
                  <button
                    title="Decline job"
                    onClick={(e) => mutate(e, job, "decline")}
                  >
                    ×
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <div className="dense-empty">No jobs match this view.</div>
      )}
    </div>
  );
}

function Jobs() {
  const location=useLocation(),navigate=useNavigate(),params=new URLSearchParams(location.search),
    q=params.get("q")??"",matchState=params.get("matchState")??"",role=params.get("roleFamily")??"",provider=params.get("provider")??"",work=params.get("workArrangement")??"",locationGroup=params.get("locationGroup")??"",sort=params.get("sort")??"score",view=params.get("view")??"new",reviewStates=(params.get("reviewState")??"").split(",").filter(Boolean),applicationStages=(params.get("applicationStage")??"").split(",").filter(Boolean),size=params.get("size")??"50",page=Number(params.get("page")??0);
  const [selected,setSelected]=useState<Set<string>>(()=>new Set(JSON.parse(sessionStorage.getItem("jobs:selected")??"[]"))),[loaded,setLoaded]=useState(Number(sessionStorage.getItem("jobs:loaded")??50));
  const update=(values:Record<string,string>,keepPage=false)=>{const next=new URLSearchParams(location.search);Object.entries(values).forEach(([key,value])=>value?next.set(key,value):next.delete(key));if(!keepPage)next.delete("page");setSelected(new Set());setLoaded(50);navigate(`/jobs?${next}`)};
  const viewDefaults:Record<string,Record<string,string>>={new:{reviewState:"new",applicationStage:"",status:"active"},saved:{reviewState:"",applicationStage:"saved,preparing",status:""},submitted:{reviewState:"",applicationStage:"applied,screening,interview,assessment,offer",status:""},declined:{reviewState:"declined",applicationStage:"",status:""},active:{reviewState:"new,reviewed",applicationStage:"",status:"active"},expired:{reviewState:"",applicationStage:"",status:"expired"}};
  const chooseView=(name:string)=>{const next=new URLSearchParams();next.set("view",name);Object.entries(viewDefaults[name]).forEach(([k,v])=>v&&next.set(k,v));next.set("size",size);navigate(`/jobs?${next}`);setSelected(new Set());setLoaded(50)};
  const limit=size==="continuous"?loaded:Number(size),offset=size==="continuous"?0:page*limit;
  const query=new URLSearchParams(location.search);query.delete("view");query.delete("size");query.delete("page");query.set("matchState",matchState||"all");query.set("eligibility",["excluded","all"].includes(matchState)?"all":"eligible");query.set("limit",String(limit));query.set("offset",String(offset));
  const state=useData<any>(`/api/v1/jobs?${query}`);
  useEffect(()=>{sessionStorage.setItem("jobs:selected",JSON.stringify([...selected]));sessionStorage.setItem("jobs:loaded",String(loaded))},[selected,loaded]);
  useEffect(()=>{if(state.loading)return;const saved=Number(sessionStorage.getItem(`jobs:scroll:${location.search}`)??0),focused=sessionStorage.getItem("jobs:focus");if(!navigator.userAgent.includes("jsdom"))requestAnimationFrame(()=>{scrollTo(0,saved);if(focused)(document.querySelector(`[data-job-id="${focused}"]`) as HTMLElement|null)?.focus({preventScroll:true})});return()=>sessionStorage.setItem(`jobs:scroll:${location.search}`,String(scrollY))},[location.search,state.loading]);
  const toggle=(key:string,value:string,current:string[])=>update({[key]:current.includes(value)?current.filter(x=>x!==value).join(","):[...current,value].join(",")});
  const bulk=async(action:string)=>{if(!selected.size)return;const rows=(state.data?.items??[]).filter((row:Job)=>selected.has(row.id));if(["declined","archived"].includes(action)&&rows.some((row:Job)=>row.application_stage&&!['saved','preparing'].includes(row.application_stage))){alert("Submitted applications must be Withdrawn from Applications; they cannot be declined or archived.");return}if(selected.size>1&&!confirm(`${action} ${selected.size} jobs?`))return;await Promise.all([...selected].map(id=>action==="save"?api(`/api/v1/jobs/${id}/application`,{method:"PUT",body:JSON.stringify({stage:"saved"})}):api(`/api/v1/jobs/${id}/review`,{method:"PATCH",body:JSON.stringify({state:action})})));setSelected(new Set());state.reload()};
  return (
    <Page
      eyebrow="Decision workspace"
      title="Jobs"
      actions={
        <div className="result-count">
          <strong>{state.data?.total ?? 0}</strong> results
        </div>
      }
    >
      <div className="quick-views">{Object.entries({new:"New matches",saved:"Saved / preparing",submitted:"Submitted",declined:"Declined",active:"Active",expired:"Expired"}).map(([key,label])=><button className={view===key?"active":""} key={key} onClick={()=>chooseView(key)}>{label}</button>)}</div>
      <div className="location-focus" aria-label="Location focus"><span>Location</span><button className={!locationGroup?"active":""} onClick={()=>update({locationGroup:""})}>All</button><button className={locationGroup==="amsterdam"?"active":""} onClick={()=>update({locationGroup:"amsterdam"})}>Amsterdam only</button><button className={locationGroup==="outside-amsterdam"?"active":""} onClick={()=>update({locationGroup:"outside-amsterdam"})}>Outside Amsterdam</button></div>
      <div className="jobs-toolbar filter-grid">
        <input
          aria-label="Search"
          placeholder="Search role, company or skill…"
          value={q} onChange={e=>update({q:e.target.value})}
        />
        <select
          value={matchState} onChange={e=>update({matchState:e.target.value})}
        >
          <option value="">Strong + possible</option><option value="strong">Strong matches</option><option value="possible">Possible matches</option>
          <option value="excluded">Excluded jobs</option>
          <option value="all">All jobs</option>
        </select>
        <select value={role} onChange={e=>update({roleFamily:e.target.value})}>
          <option value="">All role families</option>
          <option value="data-science">Data science</option>
          <option value="machine-learning">Machine learning</option>
          <option value="data-analytics">Data analytics</option>
          <option value="quantitative">Quantitative</option>
          <option value="operations-research">Operations research</option>
          <option value="research">Research</option>
          <option value="model-risk">Model risk</option><option value="unclassified">Unclassified / needs review</option>
        </select>
        <select value={work} onChange={e=>update({workArrangement:e.target.value})}>
          <option value="">Any work mode</option>
          <option value="remote">Remote</option>
          <option value="hybrid">Hybrid</option>
          <option value="onsite">On-site</option>
          <option value="unknown">Unknown</option>
        </select>
        <select value={provider} onChange={e=>update({provider:e.target.value})}>
          <option value="">All providers</option>
          <option>greenhouse</option>
          <option>lever</option>
          <option>ashby</option>
          <option>workday</option>
          <option>government</option>
          <option>browser</option>
        </select>
        <select value={sort} onChange={e=>update({sort:e.target.value})}>
          <option value="score">Score ↓</option>
          <option value="scoreAsc">Score ↑</option>
          <option value="posted">Posted date ↓</option>
          <option value="firstSeen">First seen ↓</option>
          <option value="company">Company A–Z</option>
        </select>
        <details className="multi-filter"><summary>Review state ({reviewStates.length||"all"})</summary>{["new","reviewed","declined","archived"].map(value=><label key={value}><input type="checkbox" checked={reviewStates.includes(value)} onChange={()=>toggle("reviewState",value,reviewStates)}/>{value}</label>)}</details>
        <details className="multi-filter"><summary>Application ({applicationStages.length||"all"})</summary>{["saved","preparing","applied","screening","interview","assessment","offer","hired","rejected","withdrawn"].map(value=><label key={value}><input type="checkbox" checked={applicationStages.includes(value)} onChange={()=>toggle("applicationStage",value,applicationStages)}/>{value}</label>)}</details>
        <select aria-label="Rows per page" value={size} onChange={e=>update({size:e.target.value})}><option>25</option><option>50</option><option>100</option><option>250</option><option value="continuous">Continuous scroll</option></select>
      </div>
      <div className="bulk-bar"><span>{selected.size} selected</span><button disabled={!selected.size} onClick={()=>bulk("save")}>Save</button><button disabled={!selected.size} onClick={()=>bulk("reviewed")}>Reviewed</button><button disabled={!selected.size} onClick={()=>bulk("declined")}>Decline</button><button disabled={!selected.size} onClick={()=>bulk("archived")}>Archive</button></div>
      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <div className="error">{state.error}</div>
      ) : (
        <><p className="table-hint">Showing {state.data.total? offset+1:0}–{Math.min(offset+state.data.items.length,state.data.total)} of {state.data.total} jobs.</p><JobTable items={state.data.items} reload={state.reload} selected={selected} onSelected={setSelected} returnTo={`${location.pathname}${location.search}`} /></>
      )}
      {size==="continuous"?<div className="pagination"><button disabled={loaded>=(state.data?.total??0)} onClick={()=>setLoaded(value=>value+50)}>Load 50 more</button></div>:<div className="pagination">
        <button disabled={!page} onClick={() => update({page:String(page-1)},true)}>
          ← Previous
        </button>
        <span>
          Page {page + 1} of{" "}
          {Math.max(1, Math.ceil((state.data?.total ?? 0) / Number(size)))}
        </span>
        <button
          disabled={(page + 1) * limit >= (state.data?.total ?? 0)}
          onClick={() => update({page:String(page+1)},true)}
        >
          Next →
        </button>
      </div>}
    </Page>
  );
}

function Ledger({ ledger }: { ledger: any }) {
  if (!ledger)
    return (
      <div className="dense-empty">
        This job has not been scored with the evidence ledger yet.
      </div>
    );
  return (
    <>
      <div className="formula">
        <span>Scoring v{ledger.version}</span>
        <strong>{ledger.formula}</strong>
        <small>Calculated {date(ledger.calculatedAt)}</small>
      </div>
      {ledger.hardExcluded && (
        <div className="exclusion">
          <strong>Hard excluded</strong>
          <span>{ledger.exclusionReason}</span>
          <code>{ledger.exclusionEvidence}</code>
        </div>
      )}
      <table className="ledger">
        <thead>
          <tr>
            <th>Component</th>
            <th>Points</th>
            <th>Rule</th>
            <th>Evidence and explanation</th>
          </tr>
        </thead>
        <tbody>
          {ledger.components?.map((c: any) => (
            <tr key={c.key}>
              <td>
                <strong>{c.label}</strong>
              </td>
              <td>
                <b className={c.awarded < 0 ? "negative" : ""}>
                  {c.awarded} / {c.maximum}
                </b>
              </td>
              <td>{c.rule}</td>
              <td>
                {c.explanation}
                {c.evidence?.length > 0 && (
                  <div className="evidence-list">
                    {c.evidence.map((x: string) => (
                      <span key={x}>{x}</span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Rules score</td>
            <td>
              <strong>{ledger.ruleScore} / 100</strong>
            </td>
            <td colSpan={2}>
              {ledger.aiScore == null
                ? "Overall score equals deterministic rules score"
                : "Overall uses 70% rules and 30% AI"}
            </td>
          </tr>
        </tfoot>
      </table>
      <div className="skill-columns">
        <div>
          <h4>Matched skills</h4>
          {ledger.matchedSkills?.map((x: string) => (
            <span className="skill yes" key={x}>
              {x}
            </span>
          ))}
        </div>
        <div>
          <h4>Missing configured skills</h4>
          {ledger.missingSkills?.map((x: string) => (
            <span className="skill" key={x}>
              {x}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

const applicationStages=["saved","preparing","applied","screening","interview","assessment","offer","hired","rejected","withdrawn"];
const stageGroups=[{key:"interested",label:"Interested",stages:["saved","preparing"]},{key:"applied",label:"Applied",stages:["applied","screening"]},{key:"interviewing",label:"Interviewing",stages:["interview","assessment"]},{key:"offer",label:"Offer",stages:["offer"]},{key:"closed",label:"Closed",stages:["hired","rejected","withdrawn"]}];
const firstStage:Record<string,string>={interested:"saved",applied:"applied",interviewing:"interview",offer:"offer",closed:"withdrawn"};
const stageRank=(stage:string)=>applicationStages.indexOf(stage);

function ApplicationWorkspace({job,reload}:{job:Job;reload:()=>void}){
  const current=job.application,[notes,setNotes]=useState(current?.notes??""),[appliedAt,setAppliedAt]=useState(current?.applied_at?.slice(0,10)??""),[followUp,setFollowUp]=useState(current?.next_follow_up_at?.slice(0,10)??""),[saveState,setSaveState]=useState("Saved"),[category,setCategory]=useState("cv"),[label,setLabel]=useState(""),[uploading,setUploading]=useState(false);
  useEffect(()=>{setNotes(job.application?.notes??"");setAppliedAt(job.application?.applied_at?.slice(0,10)??"");setFollowUp(job.application?.next_follow_up_at?.slice(0,10)??"")},[job.application?.updated_at]);
  const save=async(value:Record<string,unknown>)=>{setSaveState("Saving…");try{await api(`/api/v1/jobs/${job.id}/application`,{method:current?"PATCH":"PUT",body:JSON.stringify({stage:current?.stage??"saved",...value})});setSaveState("Saved");reload()}catch{setSaveState("Error saving")}};
  const changeStage=async(stage:string)=>{const old=current?.stage;if(old&&stageRank(stage)<stageRank(old)&&!confirm(`Move this application back from ${old} to ${stage}?`))return;await save({stage})};
  const upload=async(file?:File)=>{if(!file)return;if(file.size>25*1024*1024){alert("File exceeds the 25 MB limit");return}setUploading(true);try{const query=new URLSearchParams({category,label});await api(`/api/v1/jobs/${job.id}/application/documents?${query}`,{method:"POST",headers:{"content-type":file.type||"application/octet-stream","x-file-name":encodeURIComponent(file.name)},body:file});reload()}catch(error:any){alert(error.message)}finally{setUploading(false)}};
  const remove=async(id:string)=>{if(!confirm("Permanently delete this local file? This cannot be undone."))return;await api(`/api/v1/application-documents/${id}`,{method:"DELETE"});reload()};
  return <section className="application-workspace evidence-section"><div className="section-heading"><div><p>Application workspace</p><h2>Track what you submitted</h2></div><span className={`save-state ${saveState.startsWith("Error")?"error":""}`}>{saveState}</span></div>
    <div className="application-fields"><label>Exact stage<select value={current?.stage??"saved"} onChange={e=>changeStage(e.target.value)}>{applicationStages.map(stage=><option key={stage}>{stage}</option>)}</select></label><label>Applied date<input type="date" value={appliedAt} onChange={e=>setAppliedAt(e.target.value)} onBlur={()=>save({appliedAt:appliedAt||null})}/></label><label>Next follow-up<input type="date" value={followUp} onChange={e=>setFollowUp(e.target.value)} onBlur={()=>save({nextFollowUpAt:followUp||null})}/></label></div>
    <label className="notes-field">Notes<textarea value={notes} placeholder="Contacts, preparation notes, status…" onChange={e=>setNotes(e.target.value)} onBlur={()=>save({notes})}/></label>
    <div className="documents-head"><div><h3>Submitted documents</h3><p>PDF, DOCX, or TXT · up to 25 MB · previous versions are retained</p></div><select value={category} onChange={e=>setCategory(e.target.value)}><option value="cv">CV</option><option value="motivation">Motivation letter</option><option value="other">Other</option></select><input aria-label="Document label" placeholder="Version label (optional)" value={label} onChange={e=>setLabel(e.target.value)}/><label className="button">{uploading?"Uploading…":"Upload file"}<input hidden type="file" accept=".pdf,.docx,.txt" disabled={uploading} onChange={e=>upload(e.target.files?.[0])}/></label></div>
    <div className="document-list">{job.documents?.map((doc:any)=><article key={doc.id}><div><strong>{doc.original_name}</strong><small>{doc.category}{doc.label?` · ${doc.label}`:""} · {(doc.size_bytes/1024).toFixed(0)} KB · {date(doc.created_at)}</small></div><a href={`/api/v1/application-documents/${doc.id}`}>Download</a><button onClick={()=>remove(doc.id)}>Delete</button></article>)}{!job.documents?.length&&<p className="unknown">No submitted files stored yet.</p>}</div>
    {!!job.transitions?.length&&<details className="stage-history"><summary>Stage history ({job.transitions.length})</summary>{job.transitions.map((item:any)=><p key={item.id}><b>{item.from_stage||"Started"} → {item.to_stage}</b><span>{date(item.occurred_at)}</span></p>)}</details>}
  </section>
}

function Applications(){
  const state=useData<any>("/api/v1/applications"),[layout,setLayout]=useState<"kanban"|"table">("kanban"),[q,setQ]=useState(""),[scope,setScope]=useState("all"),[closedOpen,setClosedOpen]=useState(false);
  const items=(state.data?.items??[]).filter((item:any)=>(!q||`${item.title} ${item.company}`.toLowerCase().includes(q.toLowerCase()))&&(scope==="all"||(scope==="to-apply"?["saved","preparing"].includes(item.stage):["applied","screening","interview","assessment","offer"].includes(item.stage))));
  const move=async(item:any,stage:string)=>{if(stageRank(stage)<stageRank(item.stage)&&!confirm(`Move ${item.title} back from ${item.stage} to ${stage}?`))return;await api(`/api/v1/jobs/${item.job_id}/application`,{method:"PATCH",body:JSON.stringify({stage})});state.reload()};
  return <Page eyebrow="Application pipeline" title="Applications" actions={<div className="layout-switch"><button className={layout==="kanban"?"active":""} onClick={()=>setLayout("kanban")}>Board</button><button className={layout==="table"?"active":""} onClick={()=>setLayout("table")}>Table</button></div>}>
    <div className="application-filters"><input placeholder="Search applications…" value={q} onChange={e=>setQ(e.target.value)}/><button className={scope==="all"?"active":""} onClick={()=>setScope("all")}>All</button><button className={scope==="to-apply"?"active":""} onClick={()=>setScope("to-apply")}>To apply</button><button className={scope==="submitted"?"active":""} onClick={()=>setScope("submitted")}>Submitted</button></div>
    {state.loading?<Loading/>:state.error?<div className="error">{state.error}</div>:layout==="kanban"?<div className="kanban">{stageGroups.map(group=><section className={group.key==="closed"?"closed":""} key={group.key} onDragOver={e=>e.preventDefault()} onDrop={e=>{const item=items.find((x:any)=>x.job_id===e.dataTransfer.getData("text/job"));if(item)void move(item,firstStage[group.key])}}><header><h2>{group.label}</h2><span>{items.filter((x:any)=>group.stages.includes(x.stage)).length}</span></header><div>{items.filter((x:any)=>group.stages.includes(x.stage)).map((item:any)=><article className="application-card" draggable onDragStart={e=>e.dataTransfer.setData("text/job",item.job_id)} key={item.job_id}><Link to={`/jobs/${item.job_id}`}><strong>{item.title}</strong><span>{item.company}</span></Link><div><span className="state-badge">{item.stage}</span><Score job={item}/></div><dl><dt>Applied</dt><dd>{date(item.applied_at)}</dd><dt>Follow-up</dt><dd>{date(item.next_follow_up_at)}</dd><dt>Documents</dt><dd>{item.document_count}</dd></dl><select aria-label={`Exact stage for ${item.title}`} value={item.stage} onChange={e=>move(item,e.target.value)}>{applicationStages.map(stage=><option key={stage}>{stage}</option>)}</select></article>)}</div></section>)}</div>:<div className="application-table"><table><thead><tr><th>Role</th><th>Stage</th><th>Score</th><th>Applied</th><th>Follow-up</th><th>Documents</th><th>Updated</th></tr></thead><tbody>{items.map((item:any)=><tr key={item.job_id}><td><Link to={`/jobs/${item.job_id}`}><strong>{item.title}</strong><small>{item.company}</small></Link></td><td><select value={item.stage} onChange={e=>move(item,e.target.value)}>{applicationStages.map(stage=><option key={stage}>{stage}</option>)}</select></td><td>{item.overall_score??"—"}</td><td>{date(item.applied_at)}</td><td>{date(item.next_follow_up_at)}</td><td>{item.document_count}</td><td>{date(item.updated_at)}</td></tr>)}</tbody></table></div>}
  </Page>
}

function JobDetail() {
  const { id } = useParams(),
    job = useData<Job>(`/api/v1/jobs/${id}`),
    trace = useData<any>(`/api/v1/jobs/${id}/trace`),
    navigate = useNavigate(),location=useLocation();
  if (job.loading || trace.loading)
    return (
      <Page eyebrow="Evidence" title="Job detail">
        <Loading />
      </Page>
    );
  if (job.error || trace.error)
    return <div className="error">{job.error || trace.error}</div>;
  const j = job.data!,
    t = trace.data;
  const review = async (state: string) => {
    await api(`/api/v1/jobs/${id}/review`, {
      method: "PATCH",
      body: JSON.stringify({ state }),
    });
    job.reload();
  };
  return (
    <Page
      eyebrow="Evidence record"
      title={j.title}
      actions={
        <div className="detail-actions">
          <button onClick={() => navigate((location.state as any)?.returnTo??-1)}>← Back</button>
          <button onClick={() => review("declined")}>Decline</button>
          <button onClick={() => review("archived")}>Archive</button>
          <button onClick={() => review("reviewed")}>Reviewed</button>
          <button
            className="primary"
            onClick={() =>
              api(`/api/v1/jobs/${id}/application`, {
                method: "PUT",
                body: JSON.stringify({ stage: "saved" }),
              }).then(job.reload)
            }
          >
            Save
          </button>
        </div>
      }
    >
      <div className="job-summary">
        <Score job={j} />
        <div>
          <h2>{j.company}</h2>
          <p>
            {j.location} · {j.work_arrangement} · {j.seniority}
          </p>
        </div>
        <a
          href={j.apply_url || j.canonical_url}
          target="_blank"
          rel="noreferrer"
        >
          Open original ↗
        </a>
      </div>
      <ApplicationWorkspace job={j} reload={job.reload}/>
      {j.application&&<section className="application-activity evidence-section"><div className="section-heading"><div><p>Application trace</p><h2>Status history</h2></div><span className="state-badge">Current: {j.application.stage}</span></div><div className="application-timeline">{j.transitions?.map((item:any,index:number)=><article key={item.id}><i/><div><strong>{item.to_stage}</strong><p>{item.from_stage?`Changed from ${item.from_stage}`:"Application tracking started"}</p><time>{new Date(item.occurred_at).toLocaleString("en-NL",{dateStyle:"medium",timeStyle:"short"})}</time>{index===0&&<span>Current status</span>}</div></article>)}</div></section>}
      <DecisionHistory id={id!}/><p>{JSON.parse(j.uncertainty_reasons_json??'[]').map(reasonLabel).join(' · ')}</p><section className="evidence-section">
        <div className="section-heading">
          <div><p>{j.match_state==='possible'?'Possible match ? evidence needs review':'Qualification evidence'}</p><h2>Why this job entered the ranked list</h2></div>
        </div>
        <div className="date-grid">
          <article><span>Matched from</span><strong>{j.matchEvidence?.matchedFrom || (j.match_state==='possible'?"Pending evidence":"Historical title match")}</strong><small>{j.matchEvidence?.confidence || "Confidence unavailable"}</small></article>
          <article><span>Role evidence</span><strong>{j.matchEvidence?.roleTerm || j.role_family}</strong><small>{j.matchEvidence?.roleFamily || j.role_family}</small></article>
          <article><span>Technical evidence</span><strong>{j.matchEvidence?.technicalTerms?.join(", ") || (j.match_state==='possible'?"Not yet confirmed":"Not required for exact title match")}</strong><small>{j.matchEvidence?.fieldsInspected?.join(", ") || "Historical evidence unavailable"}</small></article>
        </div>
      </section>
      <section className="evidence-section">
        <div className="section-heading">
          <div>
            <p>Dates</p>
            <h2>What we know—and from whom</h2>
          </div>
        </div>
        <div className="date-grid">
          {t.dates.map((d: any) => (
            <article key={d.key}>
              <span>{d.label}</span>
              <strong>{d.value ? date(d.value) : "Not supplied"}</strong>
              <small>
                {d.source} · {d.precision}
              </small>
            </article>
          ))}
        </div>
      </section>
      <section className="evidence-section">
        <div className="section-heading">
          <div>
            <p>Ranking</p>
            <h2>Complete points ledger</h2>
          </div>
          <span className="version">
            Profile {j.profile_fingerprint?.slice(0, 8)} · {j.scoring_version}
          </span>
        </div>
        <Ledger ledger={t.score} />
      </section>
      <section className="evidence-section">
        <div className="section-heading">
          <div>
            <p>Provenance</p>
            <h2>How Diego found this</h2>
          </div>
        </div>
        <div className="timeline">
          {t.observations.map((o: any, index: number) => (
            <article key={o.id}>
              <i />
              <div>
                <strong>
                  {index === 0 ? "First discovered" : "Observed again"} through{" "}
                  {o.source_id}
                </strong>
                <p>
                  {o.provider} · {o.board_url || "Board URL unavailable"}
                </p>
                <small>
                  {date(o.observed_at)} · Run {o.discovery_run_id || o.scan_id}{" "}
                  · {o.run_status || "historical"}
                </small>
                <a href={o.observed_url} target="_blank" rel="noreferrer">
                  Observed URL ↗
                </a>
              </div>
            </article>
          ))}
          {t.enrichmentEvents.map((e: any) => (
            <article key={`e${e.id}`}>
              <i className="enrich" />
              <div>
                <strong>Description enrichment: {e.status}</strong>
                <p>
                  {e.error_message ||
                    "Public description collected without error"}
                </p>
                <small>{date(e.occurred_at)}</small>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="evidence-section">
        <div className="section-heading">
          <div>
            <p>Posting</p>
            <h2>Description</h2>
          </div>
        </div>
        <p className="full-description">
          {j.description ||
            j.summary ||
            "No description was supplied or could be enriched."}
        </p>
      </section>
      <details className="diagnostics">
        <summary>Technical identifiers and diagnostics</summary>
        <dl>
          <dt>Job ID</dt>
          <dd>{j.id}</dd>
          <dt>External ID</dt>
          <dd>{j.external_id || "Not supplied"}</dd>
          <dt>Fingerprint</dt>
          <dd>{j.fingerprint}</dd>
          <dt>Provider/source</dt>
          <dd>
            {j.provider} / {j.source_id}
          </dd>
          <dt>Canonical URL</dt>
          <dd>{j.canonical_url}</dd>
          <dt>Enrichment</dt>
          <dd>
            {j.enrichment_status}
            {j.enrichment_error ? ` — ${j.enrichment_error}` : ""}
          </dd>
        </dl>
      </details>
    </Page>
  );
}

function Overview() {
  const state = useData<any>("/api/v1/overview");
  if (state.loading) return <Loading />;
  if (state.error) return <div className="error">{state.error}</div>;
  const d = state.data;
  return (
    <Page
      eyebrow="Today"
      title="Decision overview"
      actions={
        <Link className="button primary" to="/discovery">
          Run discovery
        </Link>
      }
    >
      <div className="dense-stats">
        <article>
          <span>Needs review</span>
          <strong>{d.stats.needsReview}</strong>
        </article>
        <article>
          <span>Saved / preparing</span>
          <strong>{d.stats.savedPreparing}</strong>
        </article>
        <article>
          <span>Active applications</span>
          <strong>{d.stats.recentlyApplied}</strong>
        </article>
        <article>
          <span>Follow-ups due</span>
          <strong>{d.stats.followUpsDue}</strong>
        </article>
      </div>
      <section className="evidence-section overview-legacy-matches">
        <div className="section-heading">
          <div>
            <p>Highest ranked</p>
            <h2>Recent matches</h2>
          </div>
          <Link to="/jobs">Open full table →</Link>
        </div>
        <JobTable items={d.recentJobs} compact />
      </section>
      <div className="inbox-grid">
        <Inbox title="Needs review" eyebrow="Decide next" items={d.sections.needsReview} href="/jobs?view=new&reviewState=new&status=active" empty="No new matches need a decision."/>
        <Inbox title="Saved / preparing" eyebrow="Finish applications" items={d.sections.saved} href="/jobs?view=saved&applicationStage=saved,preparing" empty="Nothing is waiting to be submitted."/>
        <Inbox title="Follow-ups due" eyebrow="Act today" items={d.sections.followUps} href="/applications" empty="No follow-ups are overdue."/>
        <Inbox title="Recently applied" eyebrow="Track progress" items={d.sections.recentlyApplied} href="/applications" empty="No active submitted applications yet."/>
      </div>
      <RunList runs={d.recentRuns} />
    </Page>
  );
}

function Inbox({title,eyebrow,items,href,empty}:{title:string;eyebrow:string;items:Job[];href:string;empty:string}){
  return <section className="inbox-section"><header><div><p>{eyebrow}</p><h2>{title}</h2></div><Link to={href}>View all →</Link></header><div>{items.map(job=><Link className="inbox-row" key={job.id} to={`/jobs/${job.id}`}><Score job={job}/><span><strong>{job.title}</strong><small>{job.company} · {job.application_stage??job.review_state}</small></span><b>›</b></Link>)}{!items.length&&<p className="inbox-empty">{empty}</p>}</div></section>
}

function RunList({ runs }: { runs: any[] }) {
  return (
    <section className="evidence-section">
      <div className="section-heading">
        <div>
          <p>Collection health</p>
          <h2>Recent discovery runs</h2>
        </div>
      </div>
      <div className="run-list">
        {runs?.map((run) => (
          <details key={run.id} className={`run-detail ${run.status}`}>
            <summary>
              <span className="run-state">
                {run.display_status || run.status}
              </span>
              <span>{run.processed_count} / {run.queued_count} queued · {run.mode??"balanced"}</span>
              <span>{run.new_jobs} new jobs</span>
              <span>{run.error_count} errors</span>
              <time>{date(run.started_at)}</time>
            </summary>
            <div className="run-breakdown">
              <p className="selection-policy"><strong>{run.selection_policy_label}</strong> · requested {run.limit_count}, returned {run.candidates_returned_count??0}, queued {run.queued_count??0}, unfilled {run.unfilled_count??0}</p>
              {run.completion_summary&&<p className="completion-summary">{run.completion_summary}</p>}
              <p>
                {run.status_reasons?.length
                  ? run.status_reasons.join(" · ")
                  : "No issues recorded."}
              </p>
              <dl>
                <dt>Requested budget</dt><dd>{run.limit_count}</dd>
                <dt>Eligible queued</dt><dd>{run.queued_count}</dd>
                <dt>Unfilled</dt><dd>{run.unfilled_count??0}</dd>
                <dt>Duplicates merged</dt><dd>{run.duplicate_candidate_count??0}</dd>
                <dt>Vacancies fetched</dt>
                <dd>{run.fetched_jobs}</dd>
                <dt>Employers</dt>
                <dd>{run.employer_count}</dd>
                <dt>No Netherlands jobs</dt>
                <dd>{run.no_nl_count}</dd>
                <dt>Missing boards</dt>
                <dd>{run.missing_board_count}</dd>
                <dt>Partial collections</dt>
                <dd>{run.partial_collection_count}</dd>
                <dt>Pending</dt>
                <dd>{run.pending_count}</dd>
                <dt>Description candidates</dt><dd>{run.description_candidate_count ?? 0}</dd>
                <dt>Descriptions enriched</dt><dd>{run.enriched_job_count ?? 0}</dd>
                <dt>Deferred descriptions</dt><dd>{run.deferred_enrichment_count ?? 0}</dd>
                <dt>Description-derived matches</dt><dd>{run.description_match_count ?? 0}</dd>
                <dt>Enrichment failures</dt><dd>{run.enrichment_failure_count ?? 0}</dd>
              </dl>
              {run.plan ? <SourceBreakdown sources={run.sources ?? []} /> : <p className="legacy-plan">Legacy allocation unavailable.</p>}
              <HistoricalTrace runId={run.id}/>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
const categoryLabels:Record<string,string>={linkedin:"LinkedIn Guest",jobspy:"JobSpy",priority:"Known & benchmark boards",native:"Native Dutch feeds",directories:"Global ATS directories"};
const expectedLabel=(value:number)=>value>0&&value<1?"<1":String(Math.round(value));
const duration=(ms:number)=>ms<1000?`${Math.max(0,Math.round(ms))} ms`:ms<60000?`${Math.round(ms/100)/10} sec`:`${Math.round(ms/6000)/10} min`;
const etaLabel=(eta:any)=>eta?.seconds===null||eta?.seconds===undefined?"Estimating…":eta.seconds<60?"Less than a minute remaining":`About ${Math.max(1,Math.round(eta.seconds/60))} min remaining`;
function SourceBreakdown({sources}:{sources:any[]}){
 return <div className="source-progress-wrap"><table className="source-progress"><thead><tr><th>Source / active stage</th><th>Allocated</th><th>Queried</th><th>Returned</th><th>Skipped recent</th><th>Duplicates</th><th>Queued</th><th>Fresh</th><th>Recheck</th><th>Continued</th><th>Forced</th><th>Active</th><th>Processed</th><th>Fetched</th><th>Dutch</th><th>Matches</th><th>Avg.</th><th>Errors</th></tr></thead><tbody>{sources.map(row=><tr key={row.source_id??row.id} className={(row.planned_count??row.planned??0)===0?"excluded-source":""}><td><Link to={`/sources/${encodeURIComponent(row.source_id??row.id)}`}>{row.label??row.source_id??row.id}</Link><small>{(row.planned_count??row.planned??0)===0?"Excluded by allocation":row.active_stages||row.category}{row.current_cursor?` · cursor ${row.current_cursor}`:""}</small></td><td>{row.planned_count??row.planned??0}{row.reassigned_count?` +${row.reassigned_count} within selection`:""}</td><td>{row.requested_count??0}</td><td>{row.returned_count??0}</td><td>{row.skipped_recent_count??0}</td><td>{row.duplicate_count??0}</td><td>{row.queued_count??0}</td><td>{row.fresh_count??0}</td><td>{row.recheck_count??0}</td><td>{row.continuation_count??0}</td><td>{row.forced_refresh_count??0}</td><td>{row.active_workers??0}</td><td>{row.processed_count??0}</td><td>{row.jobs_fetched??0}</td><td>{row.netherlands_jobs??0}</td><td>{row.profile_matches??0}</td><td>{row.avg_duration_ms?duration(row.avg_duration_ms):"—"}</td><td>{row.errors??0}</td></tr>)}</tbody></table></div>;
}
function TechnicalTrace({runId}:{runId:string}){
 const [events,setEvents]=useState<any[]>([]),[dropped,setDropped]=useState(0);
 useEffect(()=>{let live=true,cursor=0;const poll=async()=>{try{const value=await api<any>(`/api/v1/discovery/runs/${runId}/trace?after=${cursor}&limit=200`);if(!live)return;if(value.items?.length){cursor=value.nextAfter;setEvents(current=>[...current,...value.items].slice(-500));}setDropped(value.droppedCount??0);}catch{/* The run summary remains usable if trace polling fails. */}};void poll();const timer=setInterval(poll,1500);return()=>{live=false;clearInterval(timer)}},[runId]);
 return <details className="technical-trace"><summary>Technical trace <span>{events.length} visible{dropped?` · ${dropped} older events dropped`:""}</span></summary><div className="trace-list">{events.map(event=><article key={event.sequence} className={event.level}><time>{new Date(event.occurred_at).toLocaleTimeString()}</time><strong>{event.event_type}</strong><span>{event.source_id||event.phase}{event.worker_id?` · ${event.worker_id}`:""}</span><p>{event.message}</p>{event.url&&<a href={event.url} target="_blank" rel="noreferrer">{event.url}</a>}<small>{[event.http_status&&`HTTP ${event.http_status}`,event.attempt&&`attempt ${event.attempt}`,event.cursor&&`cursor ${event.cursor}`,event.duration_ms!==null&&event.duration_ms!==undefined&&duration(event.duration_ms)].filter(Boolean).join(" · ")}</small></article>)}</div>{!events.length&&<p className="trace-empty">Waiting for trace events…</p>}</details>;
}
function HistoricalTrace({runId}:{runId:string}){const [open,setOpen]=useState(false);return <div className="historical-trace"><button onClick={()=>setOpen(value=>!value)}>{open?"Hide technical trace":"Load technical trace"}</button>{open&&<TechnicalTrace runId={runId}/>}</div>}
function Discovery() {
  const history = useData<any>("/api/v1/discovery/runs"),
    coverage = useData<any>("/api/v1/coverage"),
    [limit, setLimit] = useState(100),[workers,setWorkers]=useState(6),
    plan=useData<any>(`/api/v1/discovery/plan?limit=${limit}`),
    activeCheck=useData<any>("/api/v1/discovery/active"),
    [allocations,setAllocations]=useState<Record<string,number>>(),[mode,setMode]=useState<"balanced"|"fresh"|"refresh-known">("balanced"),
    [forecast,setForecast]=useState<{data?:any;loading:boolean;error?:string}>({loading:false}),
    [active, setActive] = useState<string>(),[startError,setStartError]=useState<string>();
  const run = useData<any>(
    active ? `/api/v1/discovery/runs/${active}` : "/api/v1/discovery/runs/none",
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(run.reload, 1500);
    if (
      run.data &&
      ["completed", "partial", "interrupted", "failed"].includes(
        run.data.status,
      )
    ) {
      clearInterval(timer);
      history.reload();
      coverage.reload();
      setActive(undefined);
    }
    return () => clearInterval(timer);
  }, [active, run.data?.status]);
  useEffect(()=>{if(plan.data?.allocations)setAllocations(plan.data.allocations)},[plan.data?.limit]);
  useEffect(()=>{if(activeCheck.data?.id)setActive(activeCheck.data.id)},[activeCheck.data?.id]);
  const allocationTotal=Object.values(allocations??{}).reduce((sum,value)=>sum+Number(value||0),0),validAllocation=allocationTotal===limit&&Object.values(allocations??{}).every(value=>Number.isInteger(value)&&value>=0);
  const allocationKey=JSON.stringify(allocations??{});
  const includedCategories=Object.entries(allocations??{}).filter(([,value])=>Number(value)>0).map(([key])=>categoryLabels[key]??key),excludedCategories=Object.entries(allocations??{}).filter(([,value])=>Number(value)===0).map(([key])=>categoryLabels[key]??key);
  useEffect(()=>{
    if(mode==="refresh-known"){setForecast({loading:false});return;}
    if(!validAllocation||!allocations){setForecast({loading:false});return;}
    const controller=new AbortController(),timer=setTimeout(()=>{
      setForecast(current=>({...current,loading:true,error:undefined}));
      api<any>("/api/v1/discovery/forecast",{method:"POST",body:JSON.stringify({limit,allocations}),signal:controller.signal})
        .then(data=>setForecast({data,loading:false}))
        .catch(error=>{if(error?.name!=="AbortError")setForecast({loading:false,error:error instanceof Error?error.message:String(error)})});
    },300);
    return()=>{clearTimeout(timer);controller.abort()};
  },[limit,allocationKey,validAllocation,mode]);
  const start = async (resume = false) => {
    setStartError(undefined);
    try{const result = await api<any>("/api/v1/discovery",{method:"POST",body:JSON.stringify(resume?{resume:true}:{limit,workers,mode,...(mode==="refresh-known"?{}:{allocations})})});setActive(result.id);}catch(error){setStartError(error instanceof Error?error.message:String(error));}
  };
  return (
    <Page
      eyebrow="Collection evidence"
      title="Discovery"
      actions={
        <button className="primary" disabled={!!active||(mode!=="refresh-known"&&!validAllocation)} onClick={() => start()}>
          Start discovery
        </button>
      }
    >
      <div className="section-heading coverage-heading"><div><p>Stored evidence</p><h2>All-time coverage</h2></div><small>These totals include every discovery run.</small></div>
      <div className="dense-stats">
        <article>
          <span>Employers</span>
          <strong>{coverage.data?.employers ?? "—"}</strong>
        </article>
        <article>
          <span>Hiring in NL</span>
          <strong>{coverage.data?.hiringEmployers ?? "—"}</strong>
        </article>
        <article>
          <span>Matches observed</span>
          <strong>{coverage.data?.matchingVacancies ?? "—"}</strong>
        </article>
        <article>
          <span>Other NL vacancies</span>
          <strong>{coverage.data?.nonmatchingVacancies ?? "—"}</strong>
        </article>
      </div>
      <section className="evidence-section discovery-plan">
       <div className="section-heading"><div><p>Before you run</p><h2>Run plan</h2></div><div className="run-controls"><label>Candidate budget <input type="number" value={limit} min={1} max={5000} disabled={!!active} onChange={e=>setLimit(Math.min(5000,Math.max(1,Number(e.target.value))))}/></label><label>Workers <select value={workers} disabled={!!active} onChange={e=>setWorkers(Number(e.target.value))}>{[1,2,3,4,5,6,7,8].map(value=><option key={value} value={value}>{value}{value===6?" · recommended":""}</option>)}</select><small>Up to {workers} candidates. Workday/Ashby: 1 per host; other hosts: 2.</small></label></div></div>
       <div className="run-mode-grid" role="radiogroup" aria-label="Discovery run mode">
        <label className={mode==="balanced"?"selected":""}><input type="radio" name="run-mode" checked={mode==="balanced"} disabled={!!active} onChange={()=>setMode("balanced")}/><strong>Balanced rotation</strong><span>Recommended · advance through sources and revisit work only when due.</span><details><summary>Same-day repeat behavior</summary><p>Diego continues source cursors, resumes unfinished boards, skips successful matches for 24 hours and other resolved candidates for 7 days. Live feeds can change, so runs are not expected to be identical.</p></details></label>
        <label className={mode==="fresh"?"selected":""}><input type="radio" name="run-mode" checked={mode==="fresh"} disabled={!!active} onChange={()=>setMode("fresh")}/><strong>Fresh candidates</strong><span>Only candidates Diego has never processed before.</span><details><summary>What counts as fresh?</summary><p>Source cursors continue forward and candidates with prior health history are skipped. A run can finish below its budget when sources cannot supply enough unseen candidates.</p></details></label>
        <label className={mode==="refresh-known"?"selected":""}><input type="radio" name="run-mode" checked={mode==="refresh-known"} disabled={!!active} onChange={()=>setMode("refresh-known")}/><strong>Refresh known</strong><span>Recheck stored employer and ATS boards immediately.</span><details><summary>What is refreshed?</summary><p>Known boards are ordered least-recently checked first and normal freshness windows are bypassed. Feed and directory allocations do not apply.</p></details></label>
       </div>
       {plan.loading?<Loading/>:plan.error?<div className="error">{plan.error}</div>:<>
        <div className="strict-selection-note"><strong>Strict source selection</strong><p>Only sources with a value above zero will run. If they cannot fill the budget, the run finishes early instead of querying excluded sources.</p>{mode!=="refresh-known"&&<div><span>Included: {includedCategories.join(", ")||"none"}</span><span>Excluded: {excludedCategories.join(", ")||"none"}</span></div>}</div>
        <p className="plan-note">{plan.data?.rules?.candidateMeaning} {plan.data?.rules?.redistribution}</p>
        <div className="forecast-card" aria-live="polite">
          {mode==="refresh-known"?<div className="forecast-state"><strong>Known-board refresh</strong><br/>The full budget is assigned to stored employer and ATS boards; allocation forecasting does not apply.</div>:forecast.loading?<div className="forecast-state">Estimating recent matches…</div>:forecast.error?<div className="forecast-state error">Forecast unavailable: {forecast.error}</div>:forecast.data?<>
            <div className="forecast-main"><span>Expected from this run</span><strong>~{expectedLabel(forecast.data.expectedRecentMatches)} recent matches</strong><small>Jobs posted within the last {forecast.data.freshnessDays} days</small></div>
            <div className="forecast-undated"><span>Potentially recent</span><strong>~{expectedLabel(forecast.data.expectedUndatedMatches)}</strong><small>New matches without a trustworthy posting date</small></div>
            <div className="forecast-evidence"><span className={`confidence ${forecast.data.confidence}`}>{forecast.data.confidence} confidence</span><small>Based on {forecast.data.historicalRuns} comparable runs and {forecast.data.historicalCandidates} candidates.</small>{forecast.data.unmodelledCandidates>0&&<small>{forecast.data.unmodelledCandidates} allocated candidates lack enough history and are not estimated.</small>}</div>
            <div className="forecast-categories">{forecast.data.categories.filter((row:any)=>row.allocated>0).map((row:any)=><span key={row.category}><b>{categoryLabels[row.category]??row.category}</b>{row.modelled?` ~${expectedLabel(row.expectedRecentMatches)} recent`:` insufficient history`}</span>)}</div>
          </>:<div className="forecast-state">Choose a valid allocation to estimate this run.</div>}
        </div>
        <div className={`allocation-grid ${mode==="refresh-known"?"inactive":""}`}>{Object.entries(plan.data?.allocations??{}).map(([category]:any)=><label key={category} className={`allocation-card ${category}`}><span>{categoryLabels[category]??category}</span><input type="number" min={0} disabled={!!active||mode==="refresh-known"} value={allocations?.[category]??0} onChange={e=>setAllocations(current=>({...current,[category]:Number(e.target.value)}))}/><small>{plan.data.sources.filter((source:any)=>source.category===category&&source.enabled).map((source:any)=>source.label).join(" · ")||"No enabled source"}</small></label>)}</div>
        <p className={validAllocation?"allocation-total valid":"allocation-total invalid"}>Allocated {allocationTotal} of {limit} candidates{validAllocation?"":" — totals must match before starting"}</p>
        <div className="scope-grid"><details open><summary>LinkedIn search scope</summary><p><strong>{plan.data.scope?.linkedin.location}</strong> · {plan.data.scope?.linkedin.strategy}</p><div className="scope-terms">{plan.data.scope?.linkedin.terms.map((term:string)=><span key={term}>{term}</span>)}</div></details><details open><summary>JobSpy search scope</summary><p><strong>{plan.data.scope?.jobspy.platforms.join(", ")||"No enabled platform"}</strong> · {plan.data.scope?.jobspy.location} · v{plan.data.scope?.jobspy.version}</p><p><strong>Focused Netherlands searches</strong></p><div className="scope-terms">{plan.data.scope?.jobspy.queries.map((query:string)=><span key={query}>{query}</span>)}</div><p><strong>For each preferred city, search these roles:</strong></p><div className="scope-query">{plan.data.scope?.jobspy.broadQuery||"none"}</div><p>Locations: {plan.data.scope?.jobspy.preferredCities.join(", ")||"none"}{plan.data.scope?.jobspy.hoursOld?` · Last ${plan.data.scope.jobspy.hoursOld} hours`:""}</p></details></div>
        <details className="configured-sources"><summary>Configured source status</summary>{plan.data.sources.map((source:any)=><div className="configured-source" key={source.id}><span className={`source-status ${source.status}`}/><strong>{source.label}</strong><small>{categoryLabels[source.category]} · {source.status}{source.lastError?` · ${source.lastError}`:""}{mode!="refresh-known"&&source.deprioritized?` · deprioritized: ${source.yieldEvidence.attempts} attempts, ${duration(source.yieldEvidence.averageDurationMs)} average, ${(source.yieldEvidence.matchYield*100).toFixed(1)}% match yield · ${source.originalPlanned} to ${source.planned} initial candidates`:""}</small></div>)}</details>
       </>}
       <div className="run-actions"><button disabled={!!active} onClick={() => start(true)}>Resume interrupted</button></div>
       {startError&&<div className="error">{startError}</div>}
        {active && (
          <div className="active-run">
            <div className="run-status"><span className="phase-label">{String(run.data?.phase??"planning").replaceAll("-"," ")}</span><strong>{run.data?.phase_message || run.data?.display_status || "Starting…"}</strong><small>{run.data?.selection_policy_label??"Strict source selection"} · {run.data?.mode||mode} mode · requested budget {run.data?.limit_count??limit} · {run.data?.active_tasks?.length??0}/{run.data?.worker_count??workers} workers active</small></div>
            <div className="run-count"><strong>{run.data?.processed_count??0}</strong><span>of {run.data?.queued_count??0} queued</span><small>{(run.data?.queued_count??0)<(run.data?.limit_count??limit)?`${(run.data?.limit_count??limit)-(run.data?.queued_count??0)} budget slots unavailable or still being selected`:"Full candidate budget queued"}</small></div>
            <div className="eta-card" aria-live="polite"><strong>{etaLabel(run.data?.eta)}</strong><span>{run.data?.eta&&run.data.eta.lowerSeconds!==null&&run.data.eta.upperSeconds!==null?`Likely ${Math.max(0,Math.round(run.data.eta.lowerSeconds/60))}–${Math.max(1,Math.round(run.data.eta.upperSeconds/60))} min · ${run.data.eta.confidence} confidence`:run.data?.eta?.basis}</span></div>
            <progress value={run.data?.processed_count??0} max={Math.max(1,run.data?.queued_count??run.data?.limit_count??limit)}/>
            <button
              onClick={() =>
                api(`/api/v1/discovery/runs/${active}/cancel`, {
                  method: "POST",
                })
              }
            >
              Cancel safely
            </button>
            <div className="run-composition"><span><b>{run.data?.candidates_returned_count??0}</b> returned by selected sources</span><span><b>{run.data?.queued_count??0}</b> eligible queued</span><span><b>{run.data?.unfilled_count??0}</b> unfilled</span><span><b>{run.data?.fresh_candidate_count??0}</b> fresh</span><span><b>{run.data?.recheck_candidate_count??0}</b> due rechecks</span><span><b>{run.data?.continuation_candidate_count??0}</b> continued</span><span><b>{run.data?.forced_refresh_count??0}</b> forced refresh</span><span><b>{run.data?.skipped_recent_count??0}</b> skipped as recent</span><span><b>{run.data?.duplicate_candidate_count??0}</b> duplicates merged</span><span><b>{run.data?.new_jobs??0}</b> new jobs</span><span><b>{run.data?.error_count??0}</b> errors</span></div>
            {(run.data?.unfilled_count??0)>0&&<div className="shortfall-card"><strong>{run.data.unfilled_count} requested slots could not be filled</strong><p>Excluded sources will not run. The selected sources returned fewer eligible candidates than the requested budget.</p>{run.data?.shortfall?.map((item:any)=><span key={item.sourceId}><b>{item.label}</b>: {item.returned} returned → {item.skippedRecent} recent skipped → {item.duplicates} duplicates → {item.queued} queued</span>)}</div>}
            <section className="worker-section"><h3>Active workers</h3><div className="worker-grid">{(run.data?.active_tasks??[]).map((task:any)=><article key={task.candidate_id}><div><span>{task.worker_id}</span><b>{String(task.stage).replaceAll("-"," ")}</b></div><strong>{task.job_title||task.company}</strong><small>{task.source_id} · {task.provider||"embedded feed"} · {duration(task.stage_elapsed_ms??0)}</small><p>{task.detail}</p>{(task.job_url||task.board_url)&&<a href={task.job_url||task.board_url} target="_blank" rel="noreferrer">Open public source</a>}</article>)}</div>{!(run.data?.active_tasks??[]).length&&<p className="worker-empty">Workers will appear when the candidate queue starts processing.</p>}</section>
            <section className="completion-section"><h3>Recent completions</h3><div className="completion-list">{(run.data?.attempts??[]).slice(0,8).map((attempt:any,index:number)=><article key={`${attempt.started_at}-${index}`}><strong>{attempt.company}</strong><span>{attempt.source_id} · {attempt.provider||"feed"}</span><b className={attempt.error_message?"error":""}>{attempt.result}</b><small>{duration(attempt.duration_ms??0)} · {attempt.jobs_fetched} fetched · {attempt.netherlands_jobs} Dutch · {attempt.profile_matches} matches</small></article>)}</div></section>
            <SourceBreakdown sources={run.data?.sources??[]} />
            <TechnicalTrace runId={active}/>
          </div>
        )}
      </section>
      {history.loading ? (
        <Loading />
      ) : (
        <RunList runs={history.data?.items ?? []} />
      )}
    </Page>
  );
}

export default function AppV2() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <Shell>
            <Overview />
          </Shell>
        }
      />
      <Route
        path="/jobs"
        element={
          <Shell>
            <Jobs />
          </Shell>
        }
      />
      <Route
        path="/jobs/:id"
        element={
          <Shell>
            <JobDetail />
          </Shell>
        }
      />
      <Route
        path="/applications"
        element={
          <Shell>
            <Applications />
          </Shell>
        }
      />
      <Route
        path="/employers"
        element={
          <Shell>
            <EmployersPage />
          </Shell>
        }
      />
      <Route
        path="/employers/:id"
        element={
          <Shell>
            <EmployerDetail />
          </Shell>
        }
      />
      <Route
        path="/sources"
        element={
          <Shell>
            <SourcesPage />
          </Shell>
        }
      />
      <Route
        path="/sources/:id"
        element={
          <Shell>
            <SourceDetail />
          </Shell>
        }
      />
      <Route
        path="/discovery"
        element={
          <Shell>
            <Discovery />
          </Shell>
        }
      />
      <Route
        path="/settings"
        element={
          <Shell>
            <LocationSettings />
          </Shell>
        }
      />
      <Route path="*" element={<LegacyApp />} />
    </Routes>
  );
}
