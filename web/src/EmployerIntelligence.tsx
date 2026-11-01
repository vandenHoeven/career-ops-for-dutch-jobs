import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, date } from "./api";
import "./intelligence.css";

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
const tags = (value?: string) => (value ?? "").split(",").filter(Boolean);

export function EmployersPage() {
  const [q, setQ] = useState(""),
    [hiring, setHiring] = useState(""),
    [matches, setMatches] = useState(""),
    [provider, setProvider] = useState(""),
    [source, setSource] = useState(""),
    [health, setHealth] = useState(""),
    [benchmark, setBenchmark] = useState(""),
    [sort, setSort] = useState("lastHiring"),
    [page, setPage] = useState(0),
    navigate = useNavigate(),
    limit = 50;
  const query = useMemo(
    () =>
      new URLSearchParams({
        name: q,
        hiring,
        matches,
        provider,
        source,
        boardStatus: health,
        benchmark,
        sort,
        limit: String(limit),
        offset: String(page * limit),
      }).toString(),
    [q, hiring, matches, provider, source, health, benchmark, sort, page],
  );
  const state = useData<any>(`/api/v1/employers?${query}`);
  return (
    <>
      <header className="page-head dense-head">
        <div>
          <p>Market map</p>
          <h1>Employers</h1>
        </div>
        <div className="result-count">
          <strong>{state.data?.total ?? 0}</strong> discovered
        </div>
      </header>
      <div className="intel-filters">
        <input
          placeholder="Search employer…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
          }}
        />
        <select value={hiring} onChange={(e) => setHiring(e.target.value)}>
          <option value="">Any hiring signal</option>
          <option value="true">NL vacancies observed in 30d</option>
          <option value="false">No recent NL observation</option>
        </select>
        <select value={matches} onChange={(e) => setMatches(e.target.value)}>
          <option value="">Any profile yield</option>
          <option value="true">Has Diego matches</option>
          <option value="false">No Diego matches</option>
        </select>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">All providers</option>
          {[
            "greenhouse",
            "lever",
            "ashby",
            "recruitee",
            "personio",
            "workday",
            "academictransfer",
            "government",
            "browser",
          ].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <input
          placeholder="Discovery source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <select value={health} onChange={(e) => setHealth(e.target.value)}>
          <option value="">Any board health</option>
          <option>healthy</option>
          <option>failing</option>
          <option>unsupported</option>
        </select>
        <select
          value={benchmark}
          onChange={(e) => setBenchmark(e.target.value)}
        >
          <option value="">All employers</option>
          <option value="true">Benchmark panel</option>
          <option value="false">Outside benchmark</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="lastHiring">Latest hiring signal</option>
          <option value="vacancies">NL observations</option>
          <option value="matches">Profile matches</option>
          <option value="company">Company A–Z</option>
          <option value="firstDiscovered">Newest discovery</option>
        </select>
      </div>
      {state.loading ? (
        <div className="dense-empty">Loading employers…</div>
      ) : state.error ? (
        <div className="error">{state.error}</div>
      ) : (
        <div className="data-table-wrap employer-wrap">
          <table className="employer-table">
            <thead>
              <tr>
                <th>Employer</th>
                <th>HQ evidence</th>
                <th title="Distinct Netherlands vacancies observed during the last 30 days">
                  NL observed · 30d
                </th>
                <th>Diego matches</th>
                <th>Providers / boards</th>
                <th>Discovery sources</th>
                <th>Last hiring signal</th>
              </tr>
            </thead>
            <tbody>
              {state.data.items.map((row: any) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  onClick={() => navigate(`/employers/${row.id}`)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && navigate(`/employers/${row.id}`)
                  }
                >
                  <td>
                    <strong>{row.canonical_name}</strong>
                    <small>
                      {row.domain || "Domain unavailable"}
                      {row.benchmark_member ? " · benchmark panel" : ""}
                    </small>
                  </td>
                  <td>
                    <span className="meta-badge">{row.headquarters}</span>
                    <small>{row.size_confidence} size evidence</small>
                  </td>
                  <td>
                    <b>{row.vacancies_30d}</b>
                  </td>
                  <td>
                    <b>{row.profile_matches_30d}</b>
                  </td>
                  <td>
                    <div className="mini-tags">
                      {tags(row.providers).map((x) => (
                        <span key={x}>{x}</span>
                      ))}
                    </div>
                    <small>
                      {row.healthy_board_count}/{row.board_count} healthy
                    </small>
                  </td>
                  <td>
                    <div className="mini-tags">
                      {tags(row.discovery_sources).map((x) => (
                        <span key={x}>{x}</span>
                      ))}
                    </div>
                  </td>
                  <td>
                    {date(row.last_hiring_signal_at)}
                    <small>Checked {date(row.last_board_check)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <button disabled={!page} onClick={() => setPage((x) => x - 1)}>
          ← Previous
        </button>
        <span>
          Page {page + 1} of{" "}
          {Math.max(1, Math.ceil((state.data?.total ?? 0) / limit))}
        </span>
        <button
          disabled={(page + 1) * limit >= (state.data?.total ?? 0)}
          onClick={() => setPage((x) => x + 1)}
        >
          Next →
        </button>
      </div>
    </>
  );
}

export function EmployerDetail() {
  const { id } = useParams(),
    state = useData<any>(`/api/v1/employers/${id}`);
  if (state.loading)
    return <div className="dense-empty">Loading employer evidence…</div>;
  if (state.error || !state.data)
    return <div className="error">{state.error || "Employer not found"}</div>;
  const e = state.data;
  return (
    <>
      <header className="page-head dense-head">
        <div>
          <p>Employer evidence</p>
          <h1>{e.canonical_name}</h1>
        </div>
        <Link className="button" to="/employers">
          ← Employers
        </Link>
      </header>
      <div className="intel-summary">
        <article>
          <span>Headquarters</span>
          <strong>{e.headquarters}</strong>
        </article>
        <article>
          <span>Last hiring signal</span>
          <strong>{date(e.last_hiring_signal_at)}</strong>
        </article>
        <article>
          <span>First discovered</span>
          <strong>{date(e.first_discovered_at)}</strong>
        </article>
        <article>
          <span>Benchmark</span>
          <strong>{e.benchmark ? "Included" : "Not included"}</strong>
        </article>
      </div>
      <section className="evidence-section">
        <div className="section-heading">
          <div>
            <p>Collection endpoints</p>
            <h2>Boards and health</h2>
          </div>
        </div>
        <div className="data-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Board</th>
                <th>Status</th>
                <th>Source</th>
                <th>Last checked</th>
                <th>Failure</th>
              </tr>
            </thead>
            <tbody>
              {e.boards.map((b: any) => (
                <tr key={b.id}>
                  <td>{b.provider || "unsupported"}</td>
                  <td>
                    <a href={b.board_url} target="_blank" rel="noreferrer">
                      {b.board_url}
                    </a>
                  </td>
                  <td>
                    <span className={`health ${b.status}`}>{b.status}</span>
                  </td>
                  <td>{b.discovery_source}</td>
                  <td>{date(b.last_checked_at)}</td>
                  <td>{b.failure_reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="evidence-section">
        <div className="section-heading">
          <div>
            <p>Vacancy evidence</p>
            <h2>Observed Netherlands vacancies</h2>
          </div>
        </div>
        <div className="data-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Location</th>
                <th>Source</th>
                <th>Profile match</th>
                <th>Observed</th>
              </tr>
            </thead>
            <tbody>
              {e.observations.map((v: any) => (
                <tr key={v.id}>
                  <td>
                    <a href={v.url} target="_blank" rel="noreferrer">
                      {v.title}
                    </a>
                  </td>
                  <td>{v.location}</td>
                  <td>{v.source_id}</td>
                  <td>{v.matched_profile ? "Yes" : "No"}</td>
                  <td>{date(v.observed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="evidence-section">
        <div className="section-heading">
          <div>
            <p>Relevant opportunities</p>
            <h2>Stored matching jobs</h2>
          </div>
        </div>
        {e.jobs.length ? (
          <div className="data-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Location</th>
                  <th>Score</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {e.jobs.map((j: any) => (
                  <tr key={j.id}>
                    <td>
                      <Link to={`/jobs/${j.id}`}>{j.title}</Link>
                    </td>
                    <td>{j.location}</td>
                    <td>{j.overall_score}</td>
                    <td>{date(j.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dense-empty">
            No stored profile matches for this employer.
          </div>
        )}
      </section>
    </>
  );
}
