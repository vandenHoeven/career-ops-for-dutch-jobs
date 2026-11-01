import { CollectionCoverage } from './CoverageTools';
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, date } from "./api";
import "./source-intelligence.css";

function useData<T>(path: string) {
  const [state, setState] = useState<{
    data?: T;
    loading: boolean;
    error?: string;
  }>({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    api<T>(path)
      .then((data) => live && setState({ data, loading: false }))
      .catch(
        (error) => live && setState({ loading: false, error: error.message }),
      );
    return () => {
      live = false;
    };
  }, [path]);
  return state;
}

type SourceOverlap = { sourceId: string; intersection: number; jaccard: number };
export type SourceSummary = {
  id: string;
  totalVacancies: number;
  uniqueVacancies: number;
  sharedVacancies: number;
  overlaps: SourceOverlap[];
};
type OverlapPair = {
  sourceA: string;
  sourceB: string;
  intersection: number;
  sourceACount: number;
  sourceBCount: number;
  jaccard: number;
};
type OverlapResponse = {
  window: "30d" | "lifetime";
  sources: string[];
  summaries: SourceSummary[];
  pairs: OverlapPair[];
};

const PRIMARY_SOURCES = [
  "linkedin-guest",
  "jobspy-indeed",
  "jobspy-glassdoor",
];
const SOURCE_LABELS: Record<string, string> = {
  "linkedin-guest": "LinkedIn",
  "jobspy-indeed": "Indeed",
  "jobspy-glassdoor": "Glassdoor",
};
export function sourceLabel(id: string) {
  if (SOURCE_LABELS[id]) return SOURCE_LABELS[id];
  return id
    .replace(/^jobspy-/, "")
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
export function selectHighlightedSources(summaries: SourceSummary[]) {
  const primary = PRIMARY_SOURCES.map((id) =>
    summaries.find((summary) => summary.id === id),
  ).filter((summary): summary is SourceSummary => Boolean(summary));
  const primaryIds = new Set(PRIMARY_SOURCES);
  const additional = summaries
    .filter((summary) => !primaryIds.has(summary.id) && summary.totalVacancies > 0)
    .sort(
      (a, b) =>
        b.totalVacancies - a.totalVacancies ||
        sourceLabel(a.id).localeCompare(sourceLabel(b.id)),
    )
    .slice(0, 3);
  return [...primary, ...additional];
}

const percent = (a: number, b: number) =>
  b ? `${Math.round((a * 1000) / b) / 10}%` : "—";

export function SourcesPage() {
  const [type, setType] = useState<"discovery" | "provider">("discovery"),
    [window, setWindow] = useState<"30d" | "lifetime">("30d"),
    performance = useData<any>(
      `/api/v1/source-performance?type=${type}&window=${window}`,
    ),
    benchmark = useData<any>("/api/v1/coverage/benchmark"),
    overlap = useData<OverlapResponse>(
      `/api/v1/coverage/overlap?window=${window}`,
    );
  const highlightedSources = selectHighlightedSources(
      overlap.data?.summaries ?? [],
    ),
    highlightedIds = new Set(highlightedSources.map((source) => source.id)),
    highlightedPairs = (overlap.data?.pairs ?? [])
      .filter(
        (pair) =>
          pair.intersection > 0 &&
          highlightedIds.has(pair.sourceA) &&
          highlightedIds.has(pair.sourceB),
      )
      .sort(
        (a, b) =>
          b.intersection - a.intersection ||
          b.jaccard - a.jaccard ||
          a.sourceA.localeCompare(b.sourceA),
      );
  return (
    <>
      <header className="page-head dense-head">
        <div>
          <p>Coverage evidence</p>
          <h1>Sources</h1>
        </div>
        <div className="segmented">
          <button
            className={window === "30d" ? "active" : ""}
            onClick={() => setWindow("30d")}
          >
            Last 30 days
          </button>
          <button
            className={window === "lifetime" ? "active" : ""}
            onClick={() => setWindow("lifetime")}
          >
            Lifetime
          </button>
        </div>
      </header>
      <div className="source-tabs">
        <button
          className={type === "discovery" ? "active" : ""}
          onClick={() => setType("discovery")}
        >
          Discovery sources
        </button>
        <button
          className={type === "provider" ? "active" : ""}
          onClick={() => setType("provider")}
        >
          ATS providers
        </button>
      </div>
      <p className="coverage-note">
        Dimensions are shown independently. This dashboard does not claim one
        overall source grade or total Dutch-market completeness.
      </p>
      <CollectionCoverage/>
      {performance.loading ? (
        <div className="dense-empty">Calculating source evidence…</div>
      ) : performance.error ? (
        <div className="error">{performance.error}</div>
      ) : (
        <div className="data-table-wrap source-wrap">
          {type === "discovery" ? (
            <table className="source-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Rotation</th>
                  <th>Attempts</th>
                  <th>Record validity</th>
                  <th>NL employer yield</th>
                  <th>NL vacancies</th>
                  <th>Profile matches</th>
                  <th>Unique contribution</th>
                  <th>Operational health</th>
                  <th>Freshness</th>
                </tr>
              </thead>
              <tbody>
                {performance.data.items.map((r: any) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/sources/${encodeURIComponent(r.id)}`}>
                        {r.label || r.id}
                      </Link>
                      <small>{r.license || r.kind || "internal"}</small>
                    </td>
                    <td>
                      {r.cycle_percent == null
                        ? "Not cyclical"
                        : `${r.cycle_percent}%`}
                      <small>
                        {r.cursor ?? 0} / {r.total_items ?? "?"}
                      </small>
                    </td>
                    <td>{r.attempts}</td>
                    <td>
                      {percent(r.valid_records, r.attempts)}
                      <small>{r.missing_boards} missing boards</small>
                    </td>
                    <td>{percent(r.nl_candidates, r.attempts)}</td>
                    <td>{r.nl_vacancies}</td>
                    <td>{r.profile_matches}</td>
                    <td>
                      {r.unique_vacancies}
                      <small>{r.employers_contributed} employers</small>
                    </td>
                    <td>
                      {percent(r.reliable_attempts, r.attempts)}
                      <small>
                        {r.operational_failures} operational failures
                      </small>
                    </td>
                    <td>
                      {date(r.last_success_at)}
                      <small>{r.last_error || "No current error"}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="source-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Boards</th>
                  <th>Fetch reliability</th>
                  <th>Fetched</th>
                  <th>NL eligible</th>
                  <th>Profile matches</th>
                  <th>Description</th>
                  <th>Posted date</th>
                  <th>External ID</th>
                  <th>URLs</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {performance.data.items.map((r: any) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/sources/${encodeURIComponent(r.id)}`}>
                        {r.id}
                      </Link>
                    </td>
                    <td>
                      {r.healthy_boards}/{r.boards}
                      <small>healthy</small>
                    </td>
                    <td>
                      {percent(r.reliable_attempts, r.attempts)}
                      <small>{r.operational_failures} failures</small>
                    </td>
                    <td>{r.fetched_vacancies}</td>
                    <td>{percent(r.nl_vacancies, r.fetched_vacancies)}</td>
                    <td>{r.profile_matches}</td>
                    <td>{r.description_percent ?? "—"}%</td>
                    <td>{r.posted_date_percent ?? "—"}%</td>
                    <td>{r.external_id_percent ?? "—"}%</td>
                    <td>{r.url_percent ?? "—"}%</td>
                    <td>{Math.round(r.avg_duration_ms)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <section className="evidence-section">
        <div className="section-heading">
          <div>
            <p>Representative panel</p>
            <h2>Dutch coverage indicators</h2>
          </div>
          <span className="version">{benchmark.data?.version}</span>
        </div>
        {benchmark.loading ? (
          <div className="dense-empty">Loading benchmark…</div>
        ) : (
          benchmark.data && (
            <>
              <p className="coverage-note strong">{benchmark.data.label}</p><div className="coverage-reasons">{Object.entries(benchmark.data.states??{}).map(([state,count])=><span key={state}>{state.replaceAll("-"," ")}: <strong>{String(count)}</strong></span>)}</div>
              <div className="intel-summary">
                <article>
                  <span>Panel employers</span>
                  <strong>{benchmark.data.total}</strong>
                </article>
                <article>
                  <span>Board discovered</span>
                  <strong>{benchmark.data.matched}</strong>
                </article>
                <article>
                  <span>Checked in 30d</span>
                  <strong>{benchmark.data.checked30d}</strong>
                </article>
                <article>
                  <span>Hiring signal in 30d</span>
                  <strong>{benchmark.data.hiringSignals30d}</strong>
                </article>
              </div>
              <div className="gap-grid">
                <Gap title="Regions" rows={benchmark.data.byRegion} />
                <Gap title="Sectors" rows={benchmark.data.bySector} />
                <Gap title="Employer size" rows={benchmark.data.bySize} />
                <Gap title="Ownership" rows={benchmark.data.byOwnership} />
              </div>
            </>
          )
        )}
      </section>
      <section className="evidence-section">
        <div className="section-heading">
          <div>
            <p>Cross-source evidence</p>
            <h2>High-yield job boards</h2>
          </div>
        </div>
        <p className="coverage-note">
          Distinct vacancies observed from the main job boards and the strongest
          additional sources in the selected time range.
        </p>
        {overlap.loading ? (
          <div className="dense-empty">Loading cross-source evidence…</div>
        ) : overlap.error ? (
          <div className="error">{overlap.error}</div>
        ) : highlightedSources.length ? (
          <>
            <div className="source-evidence-grid">
              {highlightedSources.map((source) => {
                const strongestOverlap = source.overlaps[0];
                return (
                  <article key={source.id}>
                    <span>{sourceLabel(source.id)}</span>
                    <strong>{source.totalVacancies}</strong>
                    <b>distinct vacancies</b>
                    <small>
                      {source.uniqueVacancies} unique · {source.sharedVacancies}{" "}
                      shared
                    </small>
                    {strongestOverlap && (
                      <small>
                        Most overlap: {sourceLabel(strongestOverlap.sourceId)} ({strongestOverlap.intersection})
                      </small>
                    )}
                  </article>
                );
              })}
            </div>
            <div className="section-heading overlap-heading">
              <div>
                <p>Observed overlap</p>
                <h3>Shared vacancy pairs</h3>
              </div>
            </div>
            {highlightedPairs.length ? (
              <div className="overlap-list">
                {highlightedPairs.map((pair) => (
                  <div key={`${pair.sourceA}-${pair.sourceB}`}>
                    <strong>
                      {sourceLabel(pair.sourceA)} ↔ {sourceLabel(pair.sourceB)}
                    </strong>
                    <span>
                      {pair.intersection} shared · {pair.jaccard}% Jaccard
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="dense-empty compact-empty">
                No shared vacancies have been observed between these highlighted
                sources yet.
              </div>
            )}
          </>
        ) : (
          <div className="dense-empty">
            No source vacancy observations are available for this time range.
          </div>
        )}
      </section>
    </>
  );
}
function Gap({ title, rows }: { title: string; rows: any[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {rows.map((row) => (
        <div className="gap-row" key={row.value}>
          <span>{row.value}</span>
          <div>
            <i
              style={{
                width: `${row.total ? (row.matched * 100) / row.total : 0}%`,
              }}
            />
          </div>
          <b>
            {row.matched}/{row.total}
          </b>
        </div>
      ))}
    </div>
  );
}

export function SourceDetail() {
  const { id } = useParams(),
    [window, setWindow] = useState<"30d" | "lifetime">("30d"),
    state = useData<any>(
      `/api/v1/source-performance/${encodeURIComponent(id ?? "")}?window=${window}`,
    );
  if (state.loading)
    return <div className="dense-empty">Loading source evidence…</div>;
  if (state.error) return <div className="error">{state.error}</div>;
  const d = state.data!;
  return (
    <>
      <header className="page-head dense-head">
        <div>
          <p>Source evidence</p>
          <h1>{d.id}</h1>
        </div>
        <div className="detail-actions">
          <button
            onClick={() => setWindow(window === "30d" ? "lifetime" : "30d")}
          >
            {window === "30d" ? "Show lifetime" : "Show 30 days"}
          </button>
          <Link className="button" to="/sources">
            ← Sources
          </Link>
        </div>
      </header>
      {(d.discovery || d.provider) && (
        <div className="intel-summary">
          <article>
            <span>Attempts</span>
            <strong>{(d.discovery || d.provider).attempts}</strong>
          </article>
          <article>
            <span>NL vacancies</span>
            <strong>{(d.discovery || d.provider).nl_vacancies}</strong>
          </article>
          <article>
            <span>Profile matches</span>
            <strong>{(d.discovery || d.provider).profile_matches}</strong>
          </article>
          <article>
            <span>Operational failures</span>
            <strong>{(d.discovery || d.provider).operational_failures}</strong>
          </article>
        </div>
      )}
      <section className="evidence-section">
        <div className="section-heading">
          <div>
            <p>Recent evidence</p>
            <h2>Candidate attempts</h2>
          </div>
        </div>
        <div className="data-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Directory</th>
                <th>Provider</th>
                <th>Result</th>
                <th>Fetched / NL / matches</th>
                <th>Duration</th>
                <th>Observed</th>
              </tr>
            </thead>
            <tbody>
              {d.attempts.map((a: any, index: number) => (
                <tr key={index}>
                  <td>{a.company}</td>
                  <td>{a.source_id}</td>
                  <td>{a.provider || "unknown"}</td>
                  <td>
                    <span className={`health ${a.result}`}>{a.result}</span>
                    <small>{a.error_message}</small>
                  </td>
                  <td>
                    {a.jobs_fetched} / {a.netherlands_jobs} /{" "}
                    {a.profile_matches}
                  </td>
                  <td>{a.duration_ms} ms</td>
                  <td>{date(a.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="evidence-section">
        <div className="section-heading">
          <div>
            <p>Contribution</p>
            <h2>Employers and stored matches</h2>
          </div>
        </div>
        <div className="two-lists">
          <div>
            {d.employers.map((e: any) => (
              <Link key={e.id} to={`/employers/${e.id}`}>
                {e.canonical_name}
                <small>{date(e.last_hiring_signal_at)}</small>
              </Link>
            ))}
          </div>
          <div>
            {d.jobs.map((j: any) => (
              <Link key={j.id} to={`/jobs/${j.id}`}>
                {j.title}
                <small>
                  {j.company} · score {j.overall_score ?? "—"}
                </small>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
