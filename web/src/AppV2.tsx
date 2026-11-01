import { MissingJobCheck, DecisionHistory, reasonLabel } from './CoverageTools';
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
}: {
  items: Job[];
  reload?: () => void;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const mutate = async (
    event: React.MouseEvent,
    job: Job,
    action: "save" | "ignore",
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
        body: JSON.stringify({ state: "ignored" }),
      });
    reload?.();
  };
  return (
    <div className="data-table-wrap" tabIndex={0} aria-label="Scrollable job results">
      <table className="job-table">
        <thead>
          <tr>
            <th>Score</th>
            <th>Role / company</th>
            <th>Location / mode</th>
            {!compact && (
              <>
                <th>Seniority</th>
                <th>Posted</th>
              </>
            )}
            <th>First seen</th>
            <th>Source</th>
            {!compact && <th>State</th>}
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {items.map((job) => (
            <tr
              key={job.id}
              onClick={() => navigate(`/jobs/${job.id}`)}
              tabIndex={0}
              onKeyDown={(e) =>
                e.key === "Enter" && navigate(`/jobs/${job.id}`)
              }
            >
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
                    <span className="meta-badge">
                      {job.seniority || "unspecified"}
                    </span>
                  </td>
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
                <DateCell value={job.first_seen_at} />
              </td>
              <td>
                <strong className="source-name">{job.source_id}</strong>
                <small>{job.provider}</small>
              </td>
              {!compact && (
                <td>
                  {job.application_stage ? (
                    <span className="state-badge">{job.application_stage}</span>
                  ) : (
                    job.review_state
                  )}
                </td>
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
                    title="Ignore job"
                    onClick={(e) => mutate(e, job, "ignore")}
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
  const location = useLocation(),
    params = new URLSearchParams(location.search),
    [q, setQ] = useState(params.get("q") ?? ""),
    [matchState, setEligibility] = useState(
      params.get("matchState") ?? "",
    ),
    [role, setRole] = useState(""),
    [seniority, setSeniority] = useState(""),
    [provider, setProvider] = useState(""),
    [work, setWork] = useState(""),
    [sort, setSort] = useState("score"),
    [page, setPage] = useState(0);
  const limit = 50;
  const query = useMemo(
    () =>
      new URLSearchParams({
        q,
        matchState: matchState || "all",
        eligibility: ["excluded","all"].includes(matchState)?"all":"eligible",
        roleFamily: role,
        seniority,
        provider,
        workArrangement: work,
        sort,
        limit: String(limit),
        offset: String(page * limit),
      }).toString(),
    [q, matchState, role, seniority, provider, work, sort, page],
  );
  const state = useData<any>(`/api/v1/jobs?${query}`);
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
      <MissingJobCheck/><div className="filter-grid">
        <input
          aria-label="Search"
          placeholder="Search role, company or skill…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
          }}
        />
        <select
          value={matchState}
          onChange={(e) => {
            setEligibility(e.target.value);
            setPage(0);
          }}
        >
          <option value="">Strong + possible</option><option value="strong">Strong matches</option><option value="possible">Possible matches</option>
          <option value="excluded">Excluded jobs</option>
          <option value="all">All jobs</option>
        </select>
        <select value={role} onChange={(e) => {setRole(e.target.value);setPage(0);}}>
          <option value="">All role families</option>
          <option value="data-science">Data science</option>
          <option value="machine-learning">Machine learning</option>
          <option value="data-analytics">Data analytics</option>
          <option value="quantitative">Quantitative</option>
          <option value="operations-research">Operations research</option>
          <option value="research">Research</option>
          <option value="model-risk">Model risk</option><option value="unclassified">Unclassified / needs review</option>
        </select>
        <select
          value={seniority}
          onChange={(e) => {setSeniority(e.target.value);setPage(0);}}
        >
          <option value="">All seniority</option>
          <option value="junior">Junior</option>
          <option value="mid">Mid</option>
          <option value="unspecified">Unspecified</option>
          <option value="senior">Senior/excluded</option>
        </select>
        <select value={work} onChange={(e) => {setWork(e.target.value);setPage(0);}}>
          <option value="">Any work mode</option>
          <option value="remote">Remote</option>
          <option value="hybrid">Hybrid</option>
          <option value="onsite">On-site</option>
          <option value="unknown">Unknown</option>
        </select>
        <select value={provider} onChange={(e) => {setProvider(e.target.value);setPage(0);}}>
          <option value="">All providers</option>
          <option>greenhouse</option>
          <option>lever</option>
          <option>ashby</option>
          <option>workday</option>
          <option>government</option>
          <option>browser</option>
        </select>
        <select value={sort} onChange={(e) => {setSort(e.target.value);setPage(0);}}>
          <option value="score">Score ↓</option>
          <option value="scoreAsc">Score ↑</option>
          <option value="posted">Posted date ↓</option>
          <option value="firstSeen">First seen ↓</option>
          <option value="company">Company A–Z</option>
        </select>
      </div>
      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <div className="error">{state.error}</div>
      ) : (
        <><p className="table-hint">Showing {state.data.total? page*limit+1:0}?{Math.min((page+1)*limit,state.data.total)} of {state.data.total} jobs. Scroll within the table to see all rows.</p><JobTable items={state.data.items} reload={state.reload} /></>
      )}
      <div className="pagination">
        <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
          ← Previous
        </button>
        <span>
          Page {page + 1} of{" "}
          {Math.max(1, Math.ceil((state.data?.total ?? 0) / limit))}
        </span>
        <button
          disabled={(page + 1) * limit >= (state.data?.total ?? 0)}
          onClick={() => setPage((p) => p + 1)}
        >
          Next →
        </button>
      </div>
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

function JobDetail() {
  const { id } = useParams(),
    job = useData<Job>(`/api/v1/jobs/${id}`),
    trace = useData<any>(`/api/v1/jobs/${id}/trace`),
    navigate = useNavigate();
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
          <button onClick={() => navigate(-1)}>← Back</button>
          <button onClick={() => review("ignored")}>Ignore</button>
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
      <DecisionHistory id={id!}/><p>{JSON.parse(j.uncertainty_reasons_json??'[]').map(reasonLabel).join(' ? ')}</p><section className="evidence-section">
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
          <span>Eligible jobs</span>
          <strong>{d.stats.active}</strong>
        </article>
        <article>
          <span>New to review</span>
          <strong>{d.stats.newJobs}</strong>
        </article>
        <article>
          <span>Applications</span>
          <strong>{d.applications.length}</strong>
        </article>
        <article>
          <span>Follow-ups due</span>
          <strong>{d.stats.followUpsDue}</strong>
        </article>
      </div>
      <section className="evidence-section">
        <div className="section-heading">
          <div>
            <p>Highest ranked</p>
            <h2>Recent matches</h2>
          </div>
          <Link to="/jobs">Open full table →</Link>
        </div>
        <JobTable items={d.recentJobs} compact />
      </section>
      <RunList runs={d.recentRuns} />
    </Page>
  );
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
              <span>{run.processed_count} processed</span>
              <span>{run.new_jobs} new jobs</span>
              <span>{run.error_count} errors</span>
              <time>{date(run.started_at)}</time>
            </summary>
            <div className="run-breakdown">
              <p>
                {run.status_reasons?.length
                  ? run.status_reasons.join(" · ")
                  : "No issues recorded."}
              </p>
              <dl>
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
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
const categoryLabels:Record<string,string>={linkedin:"LinkedIn Guest",jobspy:"JobSpy",priority:"Known & benchmark boards",native:"Native Dutch feeds",directories:"Global ATS directories"};
const expectedLabel=(value:number)=>value>0&&value<1?"<1":String(Math.round(value));
function SourceBreakdown({sources}:{sources:any[]}){
 return <div className="source-progress-wrap"><table className="source-progress"><thead><tr><th>Source</th><th>Planned</th><th>Reassigned</th><th>Queued</th><th>Processed</th><th>Fetched</th><th>Dutch</th><th>Matches</th><th>Duplicates</th><th>Errors</th></tr></thead><tbody>{sources.map(row=><tr key={row.source_id??row.id}><td><Link to={`/sources/${encodeURIComponent(row.source_id??row.id)}`}>{row.label??row.source_id??row.id}</Link></td><td>{row.planned_count??row.planned??0}</td><td>{row.reassigned_count??0}</td><td>{row.queued_count??0}</td><td>{row.processed_count??0}</td><td>{row.jobs_fetched??0}</td><td>{row.netherlands_jobs??0}</td><td>{row.profile_matches??0}</td><td>{row.duplicate_count??0}</td><td>{row.errors??0}</td></tr>)}</tbody></table></div>;
}
function Discovery() {
  const history = useData<any>("/api/v1/discovery/runs"),
    coverage = useData<any>("/api/v1/coverage"),
    [limit, setLimit] = useState(100),
    plan=useData<any>(`/api/v1/discovery/plan?limit=${limit}`),
    activeCheck=useData<any>("/api/v1/discovery/active"),
    [allocations,setAllocations]=useState<Record<string,number>>(),
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
  useEffect(()=>{
    if(!validAllocation||!allocations){setForecast({loading:false});return;}
    const controller=new AbortController(),timer=setTimeout(()=>{
      setForecast(current=>({...current,loading:true,error:undefined}));
      api<any>("/api/v1/discovery/forecast",{method:"POST",body:JSON.stringify({limit,allocations}),signal:controller.signal})
        .then(data=>setForecast({data,loading:false}))
        .catch(error=>{if(error?.name!=="AbortError")setForecast({loading:false,error:error instanceof Error?error.message:String(error)})});
    },300);
    return()=>{clearTimeout(timer);controller.abort()};
  },[limit,allocationKey,validAllocation]);
  const start = async (resume = false) => {
    setStartError(undefined);
    try{const result = await api<any>("/api/v1/discovery",{method:"POST",body:JSON.stringify(resume?{resume:true}:{limit,allocations})});setActive(result.id);}catch(error){setStartError(error instanceof Error?error.message:String(error));}
  };
  return (
    <Page
      eyebrow="Collection evidence"
      title="Discovery"
      actions={
        <button className="primary" disabled={!!active||!validAllocation} onClick={() => start()}>
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
       <div className="section-heading"><div><p>Before you run</p><h2>Run plan</h2></div><label>Candidate budget <input type="number" value={limit} min={1} max={5000} disabled={!!active} onChange={e=>setLimit(Math.min(5000,Math.max(1,Number(e.target.value))))}/></label></div>
       {plan.loading?<Loading/>:plan.error?<div className="error">{plan.error}</div>:<>
        <p className="plan-note">{plan.data?.rules?.candidateMeaning} {plan.data?.rules?.redistribution}</p>
        <div className="forecast-card" aria-live="polite">
          {forecast.loading?<div className="forecast-state">Estimating recent matches…</div>:forecast.error?<div className="forecast-state error">Forecast unavailable: {forecast.error}</div>:forecast.data?<>
            <div className="forecast-main"><span>Expected from this run</span><strong>~{expectedLabel(forecast.data.expectedRecentMatches)} recent matches</strong><small>Jobs posted within the last {forecast.data.freshnessDays} days</small></div>
            <div className="forecast-undated"><span>Potentially recent</span><strong>~{expectedLabel(forecast.data.expectedUndatedMatches)}</strong><small>New matches without a trustworthy posting date</small></div>
            <div className="forecast-evidence"><span className={`confidence ${forecast.data.confidence}`}>{forecast.data.confidence} confidence</span><small>Based on {forecast.data.historicalRuns} comparable runs and {forecast.data.historicalCandidates} candidates.</small>{forecast.data.unmodelledCandidates>0&&<small>{forecast.data.unmodelledCandidates} allocated candidates lack enough history and are not estimated.</small>}</div>
            <div className="forecast-categories">{forecast.data.categories.filter((row:any)=>row.allocated>0).map((row:any)=><span key={row.category}><b>{categoryLabels[row.category]??row.category}</b>{row.modelled?` ~${expectedLabel(row.expectedRecentMatches)} recent`:` insufficient history`}</span>)}</div>
          </>:<div className="forecast-state">Choose a valid allocation to estimate this run.</div>}
        </div>
        <div className="allocation-grid">{Object.entries(plan.data?.allocations??{}).map(([category]:any)=><label key={category} className={`allocation-card ${category}`}><span>{categoryLabels[category]??category}</span><input type="number" min={0} disabled={!!active} value={allocations?.[category]??0} onChange={e=>setAllocations(current=>({...current,[category]:Number(e.target.value)}))}/><small>{plan.data.sources.filter((source:any)=>source.category===category&&source.enabled).map((source:any)=>source.label).join(" · ")||"No enabled source"}</small></label>)}</div>
        <p className={validAllocation?"allocation-total valid":"allocation-total invalid"}>Allocated {allocationTotal} of {limit} candidates{validAllocation?"":" — totals must match before starting"}</p>
        <div className="scope-grid"><details open><summary>LinkedIn search scope</summary><p><strong>{plan.data.scope?.linkedin.location}</strong> · {plan.data.scope?.linkedin.strategy}</p><div className="scope-terms">{plan.data.scope?.linkedin.terms.map((term:string)=><span key={term}>{term}</span>)}</div></details><details open><summary>JobSpy search scope</summary><p><strong>{plan.data.scope?.jobspy.platforms.join(", ")||"No enabled platform"}</strong> · {plan.data.scope?.jobspy.location} · v{plan.data.scope?.jobspy.version}</p><p><strong>Focused Netherlands searches</strong></p><div className="scope-terms">{plan.data.scope?.jobspy.queries.map((query:string)=><span key={query}>{query}</span>)}</div><p><strong>For each preferred city, search these roles:</strong></p><div className="scope-query">{plan.data.scope?.jobspy.broadQuery||"none"}</div><p>Locations: {plan.data.scope?.jobspy.preferredCities.join(", ")||"none"}{plan.data.scope?.jobspy.hoursOld?` · Last ${plan.data.scope.jobspy.hoursOld} hours`:""}</p></details></div>
        <details className="configured-sources"><summary>Configured source status</summary>{plan.data.sources.map((source:any)=><div className="configured-source" key={source.id}><span className={`source-status ${source.status}`}/><strong>{source.label}</strong><small>{categoryLabels[source.category]} · {source.status}{source.lastError?` · ${source.lastError}`:""}</small></div>)}</details>
       </>}
       <div className="run-actions"><button disabled={!!active} onClick={() => start(true)}>Resume interrupted</button></div>
       {startError&&<div className="error">{startError}</div>}
        {active && (
          <div className="active-run">
            <strong>{run.data?.display_status || "Starting…"}</strong>
            <span>
              {run.data?.processed_count ?? 0} /{" "}
              {run.data?.limit_count ?? limit}
            </span>
            <progress
              value={run.data?.processed_count ?? 0}
              max={run.data?.limit_count ?? limit}
            />
            <small>{run.data?.pending_count ?? Math.max(0,(run.data?.limit_count??limit)-(run.data?.processed_count??0))} remaining · {run.data?.new_jobs ?? 0} new jobs · {run.data?.error_count ?? 0} errors · {run.data?.description_candidate_count ?? 0} description candidates · {run.data?.enriched_job_count ?? 0} enriched</small>
            <button
              onClick={() =>
                api(`/api/v1/discovery/runs/${active}/cancel`, {
                  method: "POST",
                })
              }
            >
              Cancel safely
            </button>
            <SourceBreakdown sources={run.data?.sources??[]} />
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
