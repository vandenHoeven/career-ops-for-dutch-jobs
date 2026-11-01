import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, date } from './api';

const labels:Record<string,string>={inferred_role:'Role inferred from the posting; review the fit',excluded_title:'Excluded title',excluded_seniority:'Outside preferred seniority',foreign_location:'Outside the Netherlands',unknown_location:'Netherlands eligibility is unconfirmed',unmatched_role:'Role needs review',insufficient_evidence:'More role evidence needed',deal_breaker:'Matches an excluded requirement'};
export const reasonLabel=(value:string)=>labels[value]??value;
export function MissingJobCheck(){
  const [url,setUrl]=useState(''),[id,setId]=useState(''),[result,setResult]=useState<any>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(!id)return;let live=true,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{const row=await api(`/api/v1/diagnostics/job/${id}`);if(!live)return;if(row.status==='running')timer=setTimeout(poll,1200);else{setResult(row);setBusy(false);}}catch(e){if(live){setError((e as Error).message);setBusy(false);}}};void poll();return()=>{live=false;clearTimeout(timer);};
  },[id]);
  return <section className="coverage-tool"><h2>Check a missing job</h2><p>Paste a public vacancy link to see whether it was found and why it appears or is excluded.</p>
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');setResult(undefined);setId('');try{const row=await api('/api/v1/diagnostics/job',{method:'POST',body:JSON.stringify({url})});setId(row.id);}catch(e){setError((e as Error).message);setBusy(false);}}}>
      <label htmlFor="missing-job-url">Vacancy URL</label><div className="coverage-form"><input id="missing-job-url" type="url" required placeholder="https://…" value={url} onChange={e=>setUrl(e.target.value)}/><button disabled={busy} type="submit">{busy?'Checking…':'Check job'}</button></div>
    </form>{error&&<p role="alert" className="error">{error}</p>}
    {result&&<div role="status"><strong>{result.result?.stage==='retained'?'This job is in your list':result.result?.stage==='excluded'?'This job is excluded':'This vacancy could not be resolved'}</strong><p>{result.error??result.result?.reason}</p>{result.result?.decision?.reasons?.map((r:string)=><p key={r}>{reasonLabel(r)}</p>)}{result.result?.jobId&&<Link to={`/jobs/${result.result.jobId}`}>View job and evidence →</Link>}</div>}
  </section>;
}
export function DecisionHistory({id}:{id:string}){
 const [rows,setRows]=useState<any[]>([]),[error,setError]=useState('');useEffect(()=>{let live=true;api(`/api/v1/jobs/${id}/decisions`).then(v=>{if(live)setRows(v.items);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[id]);
 return <section className="evidence-section"><h2>Decision history</h2>{error&&<p role="alert">{error}</p>}{!rows.length&&!error&&<p>No recorded decisions yet. Reevaluate your profile to add an explanation.</p>}<div className="decision-history">{rows.map(row=><article key={row.id}><strong>{row.match_state==='strong'?'Strong match':row.match_state==='possible'?'Possible match':'Excluded'}</strong><small>{date(row.observed_at)} · {row.source_id} · Rules {row.rule_version}</small><p>{JSON.parse(row.reasons_json).map(reasonLabel).join(' · ')||'Role and Netherlands location confirmed'}</p><small>Inspected: {JSON.parse(row.evidence_json).fieldsInspected?.join(', ')}</small></article>)}</div></section>;
}
export function CollectionCoverage(){
 const [data,setData]=useState<any>(),[queue,setQueue]=useState<any[]>([]),[error,setError]=useState(''),[version,setVersion]=useState(0),[message,setMessage]=useState('');
 useEffect(()=>{let live=true;Promise.all([api('/api/v1/coverage/trace'),api('/api/v1/enrichment/queue/items')]).then(([d,q])=>{if(live){setData(d);setQueue(q.items);}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[version]);
 return <section className="coverage-tool"><h2>Collection completeness</h2>{error&&<p role="alert">{error}</p>}{data&&<><div className="coverage-metrics"><article><span>Boards resolved</span><strong>{data.boardsResolved}</strong></article><article><span>Completely collected</span><strong>{data.boardsCompletelyCollected}</strong></article><article><span>Legacy completeness unknown</span><strong>{data.unknownCollectionBoards}</strong></article><article><span>Pending continuations</span><strong>{data.pendingContinuations}</strong></article><article><span>Unresolved benchmark employers</span><strong>{data.unresolvedEmployers}</strong></article><article><span>Netherlands vacancy observations</span><strong>{data.netherlandsVacanciesObserved}</strong></article></div>
 <h3>Why vacancies need review or were excluded</h3><div className="coverage-reasons">{data.rejectionReasons.map((r:any)=><span key={r.reason}>{reasonLabel(r.reason)}: <strong>{r.count}</strong></span>)}</div>
 <h3>Description backlog</h3><p>{data.enrichment.map((r:any)=>`${r.status}: ${r.count}`).join(' · ')||'No pending descriptions'}</p>
 <button onClick={async()=>{try{await api('/api/v1/enrichment/queue/process',{method:'POST'});setMessage('Description collection started. Refresh to see progress.');}catch(e){setError((e as Error).message);}}}>Process pending descriptions</button>{' '}<button onClick={()=>setVersion(v=>v+1)}>Refresh progress</button><p role="status">{message}</p>
 {queue.length>0&&<details className="description-queue"><summary>Inspect pending and failed descriptions ({queue.length} most recent)</summary><div className="table-wrap"><table><thead><tr><th>Vacancy</th><th>Status</th><th>Attempts</th><th>Next attempt</th><th/></tr></thead><tbody>{queue.map(row=><tr key={row.id}><td>{row.title}<small>{row.last_error}</small></td><td>{row.status}</td><td>{row.attempts}/4</td><td>{row.next_retry_at?date(row.next_retry_at):'On demand'}</td><td><button onClick={async()=>{try{await api(`/api/v1/enrichment/queue/${row.id}/retry`,{method:'POST'});setVersion(v=>v+1);}catch(e){setError((e as Error).message);}}}>Retry</button></td></tr>)}</tbody></table></div></details>}</>}
 </section>;
}
