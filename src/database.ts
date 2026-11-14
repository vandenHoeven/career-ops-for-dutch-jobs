import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./config.js";
import { BENCHMARK_EMPLOYERS, BENCHMARK_VERSION } from "./benchmark.js";
import { buildTransparentForecast, buildTransparentForecastSeries, type ForecastMode, type ForecastPlanRow, type ForecastSeriesInput, type TransparentForecast } from "./forecast.js";
import { classifyLocationAccess } from "./locations.js";
import { discoveryArmId, rankAdaptiveArms, recencyReward, type AdaptiveEvidence } from "./adaptive-discovery.js";
import type { ApplicationRecord, ApplicationStage, DiscoveryAttempt, DiscoveryCandidate, DiscoverySourceArm, Employer, JobPosting, JobStatus, LocationAccessAssessment, LocationAccessTier, ProviderId, ReviewState, ScoreLedger, SourceConfig } from "./types.js";

export interface JobQuery {
  matchState?: 'strong' | 'possible' | 'excluded' | 'all';
  company?: string; roleFamily?: string; location?: string; provider?: string;
  locationAccess?: LocationAccessTier;
  status?: JobStatus; q?: string; from?: string; to?: string; remote?: string;
  limit?: number; offset?: number;
  minScore?: number; reviewState?: ReviewState; reviewStates?: ReviewState[]; applicationStage?: ApplicationStage; applicationStages?: ApplicationStage[]; seniority?: string; sort?: string;
  eligibility?: "eligible" | "excluded" | "all"; sourceId?: string; postedFrom?: string; postedTo?: string; firstSeenFrom?: string; firstSeenTo?: string; postedAvailable?: boolean;
}
export interface EmployerQuery { name?: string; headquarters?: string; hiring?: boolean; matches?: boolean; benchmark?: boolean; sizeBand?: string; provider?: string; source?: string; boardStatus?: string; since?: string; sort?: string; limit?: number; offset?: number }
const round1=(value:number)=>Math.round(value*10)/10;

export class Store {
  readonly db: DatabaseSync;
  constructor(path = databasePath) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL is ideal on local disks but SQLite does not support its shared-memory
    // coordination reliably on UNC/network filesystems. Fall back to the
    // rollback journal there so a fully self-contained network-folder install
    // remains usable.
    try {
      this.db.exec("PRAGMA journal_mode=WAL;");
    } catch {
      this.db.exec("PRAGMA journal_mode=DELETE;");
    }
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get();
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if(existing && version < 1 && path !== ':memory:') {
      const folder = join(dirname(path),'backups'); mkdirSync(folder,{recursive:true});
      this.db.prepare('VACUUM INTO ?').run(join(folder,`before-coverage-v1-${Date.now()}.sqlite`));
    }
    this.migrate();
  }
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY, experimental INTEGER NOT NULL DEFAULT 0, last_success_at TEXT, last_error_at TEXT, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS discovery_targets (
        id TEXT PRIMARY KEY, company TEXT NOT NULL, careers_url TEXT NOT NULL, detected_provider TEXT,
        status TEXT NOT NULL DEFAULT 'pending', last_attempt_at TEXT, failure_reason TEXT, enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS scan_runs (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
        requested_provider TEXT, checkpoint_json TEXT NOT NULL DEFAULT '[]', found_count INTEGER NOT NULL DEFAULT 0,
        accepted_count INTEGER NOT NULL DEFAULT 0, duplicate_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT, company TEXT NOT NULL,
        title TEXT NOT NULL, location TEXT NOT NULL, description TEXT, canonical_url TEXT NOT NULL, apply_url TEXT,
        posted_at TEXT, work_arrangement TEXT NOT NULL, role_family TEXT NOT NULL, match_evidence_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', missed_scans INTEGER NOT NULL DEFAULT 0,
        fingerprint TEXT NOT NULL, raw_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_canonical_url ON jobs(canonical_url);
      CREATE INDEX IF NOT EXISTS jobs_search ON jobs(company, title, location, role_family, status);
      CREATE TABLE IF NOT EXISTS source_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), scan_id TEXT NOT NULL REFERENCES scan_runs(id),
        source_id TEXT NOT NULL, provider TEXT NOT NULL, observed_url TEXT NOT NULL, observed_at TEXT NOT NULL,
        UNIQUE(job_id, scan_id, source_id, observed_url)
      );
      CREATE TABLE IF NOT EXISTS failure_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scan_id TEXT REFERENCES scan_runs(id), source_id TEXT, provider TEXT,
        occurred_at TEXT NOT NULL, error_type TEXT NOT NULL, message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS employers (
        id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, normalized_name TEXT NOT NULL, domain TEXT,
        headquarters TEXT NOT NULL DEFAULT 'unknown', size_band TEXT, size_confidence TEXT NOT NULL DEFAULT 'unknown', size_evidence TEXT,
        first_discovered_at TEXT NOT NULL, last_discovered_at TEXT NOT NULL, last_hiring_signal_at TEXT, active_nl_vacancies INTEGER NOT NULL DEFAULT 0,
        review_state TEXT NOT NULL DEFAULT 'resolved'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS employers_domain ON employers(domain) WHERE domain IS NOT NULL;
      CREATE INDEX IF NOT EXISTS employers_name ON employers(normalized_name);
      CREATE TABLE IF NOT EXISTS employer_aliases (employer_id TEXT NOT NULL REFERENCES employers(id), alias TEXT NOT NULL, normalized_alias TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(employer_id,normalized_alias));
      CREATE TABLE IF NOT EXISTS employer_boards (
        id TEXT PRIMARY KEY, employer_id TEXT NOT NULL REFERENCES employers(id), provider TEXT, board_url TEXT NOT NULL UNIQUE, api_url TEXT,
        status TEXT NOT NULL DEFAULT 'pending', confidence REAL NOT NULL DEFAULT 1, last_checked_at TEXT, failure_reason TEXT, discovery_source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discovery_sources (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, license TEXT NOT NULL, kind TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
        total_items INTEGER, last_run_at TEXT, last_success_at TEXT, last_error TEXT, processed_total INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS discovery_runs (
        id TEXT PRIMARY KEY, source_id TEXT, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
        limit_count INTEGER NOT NULL, processed_count INTEGER NOT NULL DEFAULT 0, employer_count INTEGER NOT NULL DEFAULT 0,
        matching_jobs INTEGER NOT NULL DEFAULT 0, nonmatching_jobs INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0,
        checkpoint_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS discovery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES discovery_runs(id), source_id TEXT NOT NULL,
        company TEXT NOT NULL, board_url TEXT, provider TEXT, started_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
        result TEXT NOT NULL, http_status INTEGER, retryable INTEGER NOT NULL DEFAULT 0, error_message TEXT,
        jobs_fetched INTEGER NOT NULL DEFAULT 0, netherlands_jobs INTEGER NOT NULL DEFAULT 0, profile_matches INTEGER NOT NULL DEFAULT 0,
        candidate_json TEXT NOT NULL, UNIQUE(run_id,source_id,company,board_url)
      );
      CREATE INDEX IF NOT EXISTS discovery_attempts_result ON discovery_attempts(result,retryable,source_id);
      CREATE TABLE IF NOT EXISTS discovery_queue (
        run_id TEXT NOT NULL REFERENCES discovery_runs(id), ordinal INTEGER NOT NULL, candidate_id TEXT NOT NULL,
        source_id TEXT NOT NULL, candidate_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY(run_id,candidate_id), UNIQUE(run_id,ordinal)
      );
      CREATE INDEX IF NOT EXISTS discovery_queue_status ON discovery_queue(run_id,status,ordinal);
      CREATE TABLE IF NOT EXISTS discovery_run_sources (
        run_id TEXT NOT NULL REFERENCES discovery_runs(id), source_id TEXT NOT NULL, label TEXT NOT NULL, category TEXT NOT NULL,
        planned_count INTEGER NOT NULL DEFAULT 0, reassigned_count INTEGER NOT NULL DEFAULT 0, queued_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0, exhausted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run_id,source_id)
      );
      CREATE TABLE IF NOT EXISTS discovery_run_tasks (
        run_id TEXT NOT NULL REFERENCES discovery_runs(id), candidate_id TEXT NOT NULL, worker_id TEXT NOT NULL,
        source_id TEXT NOT NULL, provider TEXT, company TEXT NOT NULL, board_url TEXT, job_title TEXT, job_url TEXT,
        stage TEXT NOT NULL, detail TEXT, started_at TEXT NOT NULL, stage_started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id,candidate_id)
      );
      CREATE TABLE IF NOT EXISTS discovery_run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES discovery_runs(id), occurred_at TEXT NOT NULL,
        level TEXT NOT NULL, phase TEXT NOT NULL, event_type TEXT NOT NULL, source_id TEXT, candidate_id TEXT, worker_id TEXT,
        message TEXT NOT NULL, url TEXT, cursor TEXT, attempt INTEGER, http_status INTEGER, duration_ms INTEGER, metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS discovery_run_events_run ON discovery_run_events(run_id,sequence);
      CREATE TABLE IF NOT EXISTS discovery_candidate_health (
        candidate_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, company TEXT NOT NULL, board_url TEXT,
        provider TEXT, candidate_json TEXT NOT NULL, latest_result TEXT NOT NULL, latest_at TEXT NOT NULL,
        retryable INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT,
        http_status INTEGER, error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS vacancy_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL, employer_id TEXT NOT NULL REFERENCES employers(id), source_id TEXT NOT NULL,
        external_id TEXT, title TEXT NOT NULL, location TEXT NOT NULL, url TEXT NOT NULL, observed_at TEXT NOT NULL, matched_profile INTEGER NOT NULL,
        UNIQUE(fingerprint,source_id)
      );
      CREATE TABLE IF NOT EXISTS applications (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id), stage TEXT NOT NULL, notes TEXT,
        applied_at TEXT, next_follow_up_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS application_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
        from_stage TEXT, to_stage TEXT NOT NULL, occurred_at TEXT NOT NULL, note TEXT
      );
      CREATE INDEX IF NOT EXISTS application_transitions_job ON application_transitions(job_id,occurred_at DESC);
      CREATE TABLE IF NOT EXISTS application_documents (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), category TEXT NOT NULL,
        label TEXT, original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, checksum TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE,
        submission_date TEXT, replaces_id TEXT REFERENCES application_documents(id), created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS application_documents_job ON application_documents(job_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS ai_score_cache (
        cache_key TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), model TEXT NOT NULL,
        assessment_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_enrichment_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
        occurred_at TEXT NOT NULL, status TEXT NOT NULL, source_url TEXT NOT NULL, error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS job_score_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
        calculated_at TEXT NOT NULL, scoring_version TEXT NOT NULL, profile_fingerprint TEXT NOT NULL,
        rule_score INTEGER NOT NULL, ai_score INTEGER, overall_score INTEGER NOT NULL, ledger_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS benchmark_panels (
        version TEXT PRIMARY KEY, created_at TEXT NOT NULL, employer_count INTEGER NOT NULL, description TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS benchmark_employers (
        panel_version TEXT NOT NULL REFERENCES benchmark_panels(version), benchmark_id TEXT NOT NULL,
        canonical_name TEXT NOT NULL, normalized_name TEXT NOT NULL, domain TEXT, aliases_json TEXT NOT NULL,
        region TEXT NOT NULL, sector TEXT NOT NULL, size_band TEXT NOT NULL, ownership TEXT NOT NULL,
        evidence_source TEXT NOT NULL, PRIMARY KEY(panel_version,benchmark_id)
      );
      CREATE TABLE IF NOT EXISTS benchmark_matches (
        panel_version TEXT NOT NULL, benchmark_id TEXT NOT NULL, employer_id TEXT REFERENCES employers(id),
        match_method TEXT, review_state TEXT NOT NULL DEFAULT 'unmatched', reviewed_at TEXT,
        PRIMARY KEY(panel_version,benchmark_id),
        FOREIGN KEY(panel_version,benchmark_id) REFERENCES benchmark_employers(panel_version,benchmark_id)
      );
      CREATE TABLE IF NOT EXISTS enrichment_queue (
        id TEXT PRIMARY KEY, job_json TEXT NOT NULL, candidate_json TEXT NOT NULL, employer_id TEXT REFERENCES employers(id),
        discovery_run_id TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS enrichment_queue_status ON enrichment_queue(status,created_at);
      CREATE TABLE IF NOT EXISTS benchmark_board_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, benchmark_id TEXT NOT NULL, attempted_at TEXT NOT NULL,
        method TEXT NOT NULL, query_or_url TEXT NOT NULL, resolved_url TEXT, provider TEXT,
        confidence REAL NOT NULL DEFAULT 0, result TEXT NOT NULL, error_message TEXT
      );
    `);
    this.ensureColumn("discovery_runs", "heartbeat_at", "TEXT");
    this.ensureColumn("discovery_runs", "process_id", "INTEGER");
    this.ensureColumn("discovery_runs", "no_nl_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "empty_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "retryable_error_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "permanent_error_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "duration_ms", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "fetched_jobs", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "new_jobs", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "refreshed_jobs", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "missing_board_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "unsupported_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "partial_collection_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "description_candidate_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "enriched_job_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "deferred_enrichment_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "description_match_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "enrichment_failure_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "plan_json", "TEXT");
    this.ensureColumn("discovery_runs", "mode", "TEXT NOT NULL DEFAULT 'balanced'");
    this.ensureColumn("discovery_runs", "worker_count", "INTEGER NOT NULL DEFAULT 4");
    this.ensureColumn("discovery_runs", "phase", "TEXT NOT NULL DEFAULT 'planning'");
    this.ensureColumn("discovery_runs", "phase_message", "TEXT");
    this.ensureColumn("discovery_runs", "queued_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "fresh_candidate_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "recheck_candidate_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "continuation_candidate_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "forced_refresh_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "skipped_recent_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "dropped_event_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "selection_policy", "TEXT NOT NULL DEFAULT 'legacy-auto-fallback'");
    this.ensureColumn("discovery_runs", "candidates_returned_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "duplicate_candidate_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "unfilled_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "shortfall_json", "TEXT");
    this.ensureColumn("discovery_runs", "time_budget_ms", "INTEGER");
    this.ensureColumn("discovery_runs", "deadline_at", "TEXT");
    this.ensureColumn("discovery_runs", "drain_deadline_at", "TEXT");
    this.ensureColumn("discovery_runs", "current_concurrency", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "weighted_reward", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "useful_match_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "recent_7_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "recent_30_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "recent_60_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "unknown_date_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "new_strong_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_runs", "metrics_version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("discovery_run_sources", "fresh_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_run_sources", "recheck_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_run_sources", "continuation_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_run_sources", "forced_refresh_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_run_sources", "skipped_recent_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_run_sources", "current_cursor", "TEXT");
    this.ensureColumn("discovery_run_sources", "requested_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_run_sources", "returned_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "summary", "TEXT");
    this.ensureColumn("jobs", "provider_first_observed_at", "TEXT");
    this.ensureColumn("jobs", "review_state", "TEXT NOT NULL DEFAULT 'new'");
    this.db.exec("UPDATE jobs SET review_state='declined' WHERE review_state='ignored';");
    this.db.exec(`UPDATE applications SET applied_at=(SELECT MIN(occurred_at) FROM application_transitions t WHERE t.job_id=applications.job_id AND t.to_stage IN ('applied','screening','interview','assessment','offer','hired')) WHERE applied_at IS NULL AND EXISTS(SELECT 1 FROM application_transitions t WHERE t.job_id=applications.job_id AND t.to_stage IN ('applied','screening','interview','assessment','offer','hired'));`);
    this.ensureColumn("jobs", "enrichment_status", "TEXT NOT NULL DEFAULT 'unavailable'");
    this.ensureColumn("jobs", "enrichment_error", "TEXT");
    this.ensureColumn("jobs", "enriched_at", "TEXT");
    this.ensureColumn("jobs", "rule_score", "INTEGER");
    this.ensureColumn("jobs", "ai_score", "INTEGER");
    this.ensureColumn("jobs", "overall_score", "INTEGER");
    this.ensureColumn("jobs", "score_breakdown_json", "TEXT");
    this.ensureColumn("jobs", "scoring_version", "TEXT");
    this.ensureColumn("jobs", "profile_fingerprint", "TEXT");
    this.ensureColumn("jobs", "seniority", "TEXT NOT NULL DEFAULT 'unspecified'");
    this.ensureColumn("jobs", "hard_excluded", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "exclusion_reason", "TEXT");
    this.ensureColumn("jobs", "score_calculated_at", "TEXT");
    this.ensureColumn("jobs", "location_access_tier", "TEXT");
    this.ensureColumn("jobs", "location_access_json", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_location_access_tier ON jobs(location_access_tier)");
    this.ensureColumn("jobs", "posted_at_source", "TEXT");
    this.ensureColumn("jobs", "posted_date_precision", "TEXT NOT NULL DEFAULT 'unknown'");
    this.ensureColumn("jobs", "valid_through", "TEXT");
    this.ensureColumn("source_observations", "discovery_run_id", "TEXT");
    this.ensureColumn("source_observations", "candidate_id", "TEXT");
    this.ensureColumn("source_observations", "board_url", "TEXT");
    this.ensureColumn("source_observations", "external_id", "TEXT");
    this.db.exec(`UPDATE jobs SET posted_at_source='provider payload (historical)',
      posted_date_precision=CASE WHEN posted_at LIKE '%T%' THEN 'time' ELSE 'day' END
      WHERE posted_at IS NOT NULL AND posted_at_source IS NULL`);
    this.db.exec(`UPDATE jobs SET valid_through=COALESCE(json_extract(raw_json,'$.validThrough'),json_extract(raw_json,'$.valid_through'))
      WHERE valid_through IS NULL`);
    this.ensureColumn("discovery_attempts", "historical_note", "TEXT");
    this.ensureColumn("discovery_attempts", "collection_partial", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_attempts", "continuation", "TEXT");
    this.ensureColumn("discovery_attempts", "collection_duration_ms", "INTEGER");
    this.ensureColumn("job_enrichment_events", "duration_ms", "INTEGER");
    this.migrateCoverage();
    this.ensureColumn("discovery_outcomes","is_new","INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("discovery_outcomes","match_state","TEXT NOT NULL DEFAULT 'possible'");
    this.seedBenchmark();
    this.db.exec(`UPDATE jobs SET provider_first_observed_at=posted_at,posted_at=NULL,
      summary=COALESCE(summary,json_extract(raw_json,'$.gist'))
      WHERE source_id='gigsignal' AND provider_first_observed_at IS NULL
        AND posted_at=json_extract(raw_json,'$.first_seen_at')`);
    this.db.exec(`UPDATE discovery_attempts SET historical_note='Parser repaired 2026-10-29; original attempt retained'
      WHERE source_id='werken-voor-nederland' AND result='parse-error'
        AND error_message='Werken voor Nederland detail page had an unexpected response shape'
        AND historical_note IS NULL`);
    this.db.exec(`UPDATE discovery_candidate_health SET retryable=1,retry_count=0,next_retry_at=datetime('now'),
      error_message=error_message || ' (parser repaired; retry queued)'
      WHERE source_id='werken-voor-nederland' AND latest_result='parse-error'
        AND error_message='Werken voor Nederland detail page had an unexpected response shape'`);
  }
  private migrateCoverage(): void {
    this.ensureColumn('jobs','match_state',"TEXT NOT NULL DEFAULT 'strong'");
    this.ensureColumn('jobs','record_kind',"TEXT NOT NULL DEFAULT 'posting'");
    this.ensureColumn('jobs','uncertainty_reasons_json',"TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('enrichment_queue','next_retry_at','TEXT');
    this.ensureColumn('enrichment_queue','retry_after_ms','INTEGER');
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_decisions(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT,canonical_url TEXT NOT NULL,source_id TEXT NOT NULL,run_id TEXT,observed_at TEXT NOT NULL,rule_version TEXT NOT NULL,profile_fingerprint TEXT NOT NULL,match_state TEXT NOT NULL,retained INTEGER NOT NULL,reasons_json TEXT NOT NULL,evidence_json TEXT NOT NULL,job_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS decision_job ON job_decisions(job_id,id);
      CREATE INDEX IF NOT EXISTS decision_url ON job_decisions(canonical_url,id);
      CREATE TABLE IF NOT EXISTS collection_checkpoints(board_url TEXT PRIMARY KEY,source_id TEXT NOT NULL,provider TEXT NOT NULL,cursor TEXT,snapshot_started_at TEXT NOT NULL,state TEXT NOT NULL,last_checked_at TEXT NOT NULL,total INTEGER,jobs_collected INTEGER NOT NULL DEFAULT 0,error TEXT,benchmark_id TEXT,candidate_json TEXT);
      CREATE TABLE IF NOT EXISTS job_diagnostics(id TEXT PRIMARY KEY,url TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,result_json TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS discovery_forecasts(run_id TEXT PRIMARY KEY REFERENCES discovery_runs(id),created_at TEXT NOT NULL,model_version TEXT NOT NULL,target TEXT NOT NULL,input_json TEXT NOT NULL,prediction_json TEXT NOT NULL,actual_new_strong INTEGER,reconciled_at TEXT);
      INSERT OR IGNORE INTO schema_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      UPDATE jobs SET match_state='excluded' WHERE hard_excluded=1;
      PRAGMA user_version=1;`);
    this.db.exec(`UPDATE enrichment_queue SET status='terminal',next_retry_at=NULL
      WHERE status='failed' AND (
        attempts>=4 OR last_error='Public posting did not contain a usable job-specific description' OR
        (last_error GLOB 'HTTP 4[0-9][0-9] *' AND last_error NOT LIKE 'HTTP 408 %' AND last_error NOT LIKE 'HTTP 425 %' AND last_error NOT LIKE 'HTTP 429 %') OR
        last_error='Cross-domain redirect requires an explicitly configured public board URL'
      )`);
    this.ensureColumn('collection_checkpoints','last_signature','TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS discovery_source_pulls(
      id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES discovery_runs(id),arm_id TEXT NOT NULL,source_id TEXT NOT NULL,label TEXT NOT NULL,
      started_at TEXT NOT NULL,duration_ms INTEGER NOT NULL,cursor TEXT,requested INTEGER NOT NULL,returned INTEGER NOT NULL,eligible INTEGER NOT NULL,
      duplicates INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,metadata_json TEXT);
      CREATE INDEX IF NOT EXISTS discovery_source_pulls_arm ON discovery_source_pulls(arm_id,started_at);
      CREATE TABLE IF NOT EXISTS discovery_outcomes(
      run_id TEXT NOT NULL REFERENCES discovery_runs(id),job_id TEXT NOT NULL,arm_id TEXT NOT NULL,source_id TEXT NOT NULL,occurred_at TEXT NOT NULL,
      new_strong INTEGER NOT NULL,posted_at TEXT,date_band TEXT NOT NULL,reward REAL NOT NULL,PRIMARY KEY(run_id,job_id));
      CREATE INDEX IF NOT EXISTS discovery_outcomes_arm ON discovery_outcomes(arm_id,occurred_at);`);
  }
  recordDecision(value: {jobId?:string;url:string;sourceId:string;runId?:string;profileFingerprint:string;decision:any;job:any}):void {
    this.db.prepare('INSERT INTO job_decisions(job_id,canonical_url,source_id,run_id,observed_at,rule_version,profile_fingerprint,match_state,retained,reasons_json,evidence_json,job_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(value.jobId??null,value.url,value.sourceId,value.runId??null,new Date().toISOString(),'4',value.profileFingerprint,value.decision.matchState,value.decision.retain?1:0,JSON.stringify(value.decision.reasons),JSON.stringify({location:value.decision.location,match:value.decision.evidence,fieldsInspected:value.decision.fieldsInspected}),JSON.stringify(value.job));
  }
  decisions(id:string):unknown[] { return (this.db.prepare('SELECT * FROM job_decisions WHERE job_id=? ORDER BY id DESC').all(id) as any[]).map(row=>({...row,reasons:JSON.parse(row.reasons_json),evidence:JSON.parse(row.evidence_json)})); }
  updateMatch(id:string,state:string,reasons:string[]):void {this.db.prepare('UPDATE jobs SET match_state=?,uncertainty_reasons_json=?,hard_excluded=? WHERE id=?').run(state,JSON.stringify(reasons),state==='excluded'?1:0,id);}
  collection(board:string):any {return this.db.prepare('SELECT * FROM collection_checkpoints WHERE board_url=?').get(board);}
  saveCollection(board:string,sourceId:string,provider:string,value:{cursor?:string;complete:boolean;total?:number;count:number;error?:string;benchmarkId?:string;candidate?:unknown}):void {
    const prior=this.collection(board), now=new Date().toISOString(), start=prior && prior.state!=='complete'?prior.snapshot_started_at:now;
    this.db.prepare(`INSERT INTO collection_checkpoints(board_url,source_id,provider,cursor,snapshot_started_at,state,last_checked_at,total,jobs_collected,error,benchmark_id,candidate_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(board_url) DO UPDATE SET source_id=excluded.source_id,provider=excluded.provider,cursor=excluded.cursor,snapshot_started_at=excluded.snapshot_started_at,state=excluded.state,last_checked_at=excluded.last_checked_at,total=COALESCE(excluded.total,collection_checkpoints.total),jobs_collected=excluded.jobs_collected,error=excluded.error,benchmark_id=COALESCE(excluded.benchmark_id,collection_checkpoints.benchmark_id),candidate_json=COALESCE(excluded.candidate_json,collection_checkpoints.candidate_json)`).run(board,sourceId,provider,value.cursor??null,start,value.error?'failed':value.complete?'complete':'partial',now,value.total??null,(prior && prior.state!=='complete'?prior.jobs_collected:0)+value.count,value.error??null,value.benchmarkId??null,value.candidate?JSON.stringify(value.candidate):null);
  }
  coverageTrace():any {
    const scalar=(sql:string)=>(this.db.prepare(sql).get() as any).n;
    return {unknownCollectionBoards:scalar("SELECT count(*) n FROM employer_boards b WHERE NOT EXISTS(SELECT 1 FROM collection_checkpoints c WHERE c.board_url=b.board_url)"),collectionStates:this.db.prepare('SELECT state,count(*) count FROM collection_checkpoints GROUP BY state').all(),pendingContinuations:scalar("SELECT count(*) n FROM collection_checkpoints WHERE cursor IS NOT NULL AND state!='complete'"),unresolvedEmployers:scalar("SELECT count(*) n FROM benchmark_matches bm WHERE NOT EXISTS(SELECT 1 FROM employer_boards b JOIN collection_checkpoints c ON c.board_url=b.board_url WHERE b.employer_id=bm.employer_id AND (c.jobs_collected>0 OR c.state='complete'))"),enrichment:this.enrichmentQueueCounts(),rejectionReasons:this.db.prepare("SELECT j.value reason,count(*) count FROM job_decisions d,json_each(d.reasons_json) j WHERE d.id=(SELECT max(x.id) FROM job_decisions x WHERE x.canonical_url=d.canonical_url) GROUP BY j.value").all(),matchStates:this.db.prepare('SELECT match_state,count(*) count FROM jobs GROUP BY match_state').all(),boardsResolved:scalar("SELECT count(*) n FROM employer_boards WHERE provider IS NOT NULL"),boardsCompletelyCollected:scalar("SELECT count(*) n FROM collection_checkpoints WHERE state='complete'"),netherlandsVacanciesObserved:scalar('SELECT count(*) n FROM vacancy_observations')};
  }
  private seedBenchmark(): void {
    this.db.prepare("INSERT OR IGNORE INTO benchmark_panels(version,created_at,employer_count,description) VALUES(?,?,?,?)").run(BENCHMARK_VERSION,new Date().toISOString(),BENCHMARK_EMPLOYERS.length,"Representative Dutch employer coverage panel; not a census");
    const employer = this.db.prepare("INSERT OR IGNORE INTO benchmark_employers(panel_version,benchmark_id,canonical_name,normalized_name,domain,aliases_json,region,sector,size_band,ownership,evidence_source) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const match = this.db.prepare("INSERT OR IGNORE INTO benchmark_matches(panel_version,benchmark_id,review_state) VALUES(?,?,'unmatched')");
    const normalize = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g," ").trim();
    for (const row of BENCHMARK_EMPLOYERS) { employer.run(BENCHMARK_VERSION,row.id,row.name,normalize(row.name),row.domain??null,JSON.stringify(row.aliases),row.region,row.sector,row.sizeBand,row.ownership,row.evidenceSource); match.run(BENCHMARK_VERSION,row.id); }
    for (const row of BENCHMARK_EMPLOYERS) {
      const candidates = row.domain ? this.db.prepare("SELECT id FROM employers WHERE LOWER(domain)=LOWER(?)").all(row.domain) as any[] : [];
      const exact = candidates.length ? candidates : this.db.prepare("SELECT id FROM employers WHERE normalized_name=(SELECT normalized_name FROM benchmark_employers WHERE panel_version=? AND benchmark_id=?)").all(BENCHMARK_VERSION,row.id) as any[];
      if (exact.length === 1) this.db.prepare("UPDATE benchmark_matches SET employer_id=?,match_method=?,review_state='matched',reviewed_at=? WHERE panel_version=? AND benchmark_id=? AND review_state!='reviewed'").run(exact[0].id,candidates.length?"domain":"exact-name",new Date().toISOString(),BENCHMARK_VERSION,row.id);
      else if (exact.length > 1) this.db.prepare("UPDATE benchmark_matches SET review_state='needs-review' WHERE panel_version=? AND benchmark_id=? AND review_state='unmatched'").run(BENCHMARK_VERSION,row.id);
    }
  }
  private ensureColumn(table: string, column: string, definition: string): void { const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]; if (!columns.some(item => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
  registerDiscoverySource(source: { id: string; label: string; license: string; kind: string }): void {
    this.db.prepare(`INSERT INTO discovery_sources(id,label,license,kind) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,license=excluded.license,kind=excluded.kind`).run(source.id, source.label, source.license, source.kind);
  }
  discoveryCursor(id: string): number { return Number((this.db.prepare("SELECT cursor FROM discovery_sources WHERE id=?").get(id) as any)?.cursor ?? 0); }
  updateDiscoverySource(id: string, cursor: number, total: number | undefined, processed: number, error?: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE discovery_sources SET cursor=?,total_items=COALESCE(?,total_items),last_run_at=?,last_success_at=CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,last_error=?,processed_total=processed_total+? WHERE id=?`).run(cursor, total ?? null, now, error ?? null, now, error ?? null, processed, id);
  }
  claimDiscoveryRun(id: string, sourceId: string | undefined, limit: number, plan?:any, mode="balanced", workerCount=6, resume=false): {claimed:true}|{claimed:false;activeRun:any} {
    const now=new Date().toISOString();this.db.exec("BEGIN IMMEDIATE");
    try {
      const target=resume?this.db.prepare("SELECT id,started_at,status,mode,limit_count,processed_count,queued_count FROM discovery_runs WHERE id=?").get(id) as any:undefined;
      if(target?.status==='running'){this.db.exec("ROLLBACK");return {claimed:false,activeRun:target};}
      const active=this.db.prepare("SELECT id,started_at,status,mode,limit_count,processed_count,queued_count FROM discovery_runs WHERE status='running' AND id<>? ORDER BY started_at LIMIT 1").get(id) as any;
      if(active){this.db.exec("ROLLBACK");return {claimed:false,activeRun:active};}
      if(resume)this.db.prepare("UPDATE discovery_runs SET status='running',finished_at=NULL,heartbeat_at=?,process_id=?,phase='processing',phase_message='Resuming persisted candidate queue' WHERE id=?").run(now,process.pid,id);
      else this.db.prepare("INSERT INTO discovery_runs(id,source_id,started_at,status,limit_count,heartbeat_at,process_id,plan_json,mode,worker_count,phase,phase_message,selection_policy) VALUES(?,?,?,?,?,?,?,?,?,?,'planning','Preparing discovery sources',?)").run(id,sourceId??null,now,"running",limit,now,process.pid,plan?JSON.stringify(plan):null,mode,workerCount,plan?.rules?.selectionPolicy??(plan?'strict':'explicit-source'));
      this.db.exec("COMMIT");return {claimed:true};
    } catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  claimTimedDiscoveryRun(id:string,durationMs:number):{claimed:true}|{claimed:false;activeRun:any}{
    const result=this.claimDiscoveryRun(id,undefined,0,undefined,"adaptive",4,false);if(!result.claimed)return result;
    const now=Date.now(),deadline=new Date(now+durationMs).toISOString(),drain=new Date(now+durationMs+30_000).toISOString();
    this.db.prepare("UPDATE discovery_runs SET time_budget_ms=?,deadline_at=?,drain_deadline_at=?,current_concurrency=4,selection_policy='adaptive-time',metrics_version=2 WHERE id=?").run(durationMs,deadline,drain,id);return result;
  }
  startDiscoveryRun(id: string, sourceId: string | undefined, limit: number, plan?:any, mode="balanced", workerCount=6): void { const now=new Date().toISOString();this.db.prepare("INSERT INTO discovery_runs(id,source_id,started_at,status,limit_count,heartbeat_at,process_id,plan_json,mode,worker_count,phase,phase_message,selection_policy) VALUES(?,?,?,?,?,?,?,?,?,?,'planning','Preparing discovery sources',?)").run(id,sourceId??null,now,"running",limit,now,process.pid,plan?JSON.stringify(plan):null,mode,workerCount,plan?.rules?.selectionPolicy??(plan?'strict':'explicit-source')); }
  saveDiscoveryPlan(id:string,plan:any):void { this.db.prepare('UPDATE discovery_runs SET plan_json=?,selection_policy=? WHERE id=?').run(JSON.stringify(plan),plan?.rules?.selectionPolicy??'strict',id);const insert=this.db.prepare(`INSERT INTO discovery_run_sources(run_id,source_id,label,category,planned_count) VALUES(?,?,?,?,?) ON CONFLICT(run_id,source_id) DO UPDATE SET label=excluded.label,category=excluded.category,planned_count=excluded.planned_count`);for(const row of plan.sources)insert.run(id,row.id,row.label,row.category,row.planned); }
  updateDiscoveryPlanSource(runId:string,sourceId:string,value:{queued:number;duplicates:number;reassigned:number;exhausted:boolean;fresh?:number;recheck?:number;continuation?:number;forcedRefresh?:number;skippedRecent?:number;cursor?:string|number;requested?:number;returned?:number}):void {this.db.prepare(`UPDATE discovery_run_sources SET queued_count=?,duplicate_count=?,reassigned_count=?,exhausted=?,fresh_count=COALESCE(?,fresh_count),recheck_count=COALESCE(?,recheck_count),continuation_count=COALESCE(?,continuation_count),forced_refresh_count=COALESCE(?,forced_refresh_count),skipped_recent_count=COALESCE(?,skipped_recent_count),current_cursor=COALESCE(?,current_cursor),requested_count=COALESCE(?,requested_count),returned_count=COALESCE(?,returned_count) WHERE run_id=? AND source_id=?`).run(value.queued,value.duplicates,value.reassigned,value.exhausted?1:0,value.fresh??null,value.recheck??null,value.continuation??null,value.forcedRefresh??null,value.skippedRecent??null,value.cursor===undefined?null:String(value.cursor),value.requested??null,value.returned??null,runId,sourceId);}
  discoveryRunSources(runId:string):unknown[]{return this.db.prepare(`SELECT p.source_id,p.label,p.category,p.planned_count,p.reassigned_count,p.queued_count,p.duplicate_count,p.exhausted,
    p.fresh_count,p.recheck_count,p.continuation_count,p.forced_refresh_count,p.skipped_recent_count,p.current_cursor,p.requested_count,p.returned_count,
    COUNT(a.id) processed_count,COALESCE(SUM(a.jobs_fetched),0) jobs_fetched,COALESCE(SUM(a.netherlands_jobs),0) netherlands_jobs,COALESCE(SUM(a.profile_matches),0) profile_matches,
    COALESCE(AVG(COALESCE(a.collection_duration_ms,a.duration_ms)),0) avg_duration_ms,(SELECT COUNT(*) FROM discovery_run_tasks t WHERE t.run_id=p.run_id AND t.source_id=p.source_id) active_workers,
    (SELECT GROUP_CONCAT(DISTINCT t.stage) FROM discovery_run_tasks t WHERE t.run_id=p.run_id AND t.source_id=p.source_id) active_stages,
    COALESCE(SUM(CASE WHEN a.result IN ('timeout','rate-limited','network-error','parse-error','invalid-record') THEN 1 ELSE 0 END),0) errors
    FROM discovery_run_sources p LEFT JOIN discovery_attempts a ON a.run_id=p.run_id AND a.source_id=p.source_id WHERE p.run_id=? GROUP BY p.source_id ORDER BY p.planned_count DESC,p.source_id`).all(runId);}
  updateDiscoveryPhase(id:string,phase:string,message?:string):void {this.db.prepare("UPDATE discovery_runs SET phase=?,phase_message=?,heartbeat_at=? WHERE id=?").run(phase,message??null,new Date().toISOString(),id);}
  updateDiscoveryComposition(id:string,value:{queued:number;fresh:number;recheck:number;continuation:number;forcedRefresh:number;skippedRecent:number}):void {this.db.prepare("UPDATE discovery_runs SET queued_count=?,fresh_candidate_count=?,recheck_candidate_count=?,continuation_candidate_count=?,forced_refresh_count=?,skipped_recent_count=? WHERE id=?").run(value.queued,value.fresh,value.recheck,value.continuation,value.forcedRefresh,value.skippedRecent,id);}
  updateDiscoverySelectionSummary(id:string,value:{returned:number;duplicates:number;unfilled:number;shortfall:unknown[]}):void {this.db.prepare("UPDATE discovery_runs SET candidates_returned_count=?,duplicate_candidate_count=?,unfilled_count=?,shortfall_json=? WHERE id=?").run(value.returned,value.duplicates,value.unfilled,JSON.stringify(value.shortfall),id);}
  recordDiscoveryEvent(runId:string,event:{level?:string;phase:string;type:string;message:string;sourceId?:string;candidateId?:string;workerId?:string;url?:string;cursor?:string|number;attempt?:number;httpStatus?:number;durationMs?:number;metadata?:unknown}):void {
    const count=Number((this.db.prepare("SELECT COUNT(*) count FROM discovery_run_events WHERE run_id=?").get(runId) as any)?.count??0);
    if(count>=2000){this.db.prepare("UPDATE discovery_runs SET dropped_event_count=dropped_event_count+1 WHERE id=?").run(runId);return;}
    this.db.prepare("INSERT INTO discovery_run_events(run_id,occurred_at,level,phase,event_type,source_id,candidate_id,worker_id,message,url,cursor,attempt,http_status,duration_ms,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(runId,new Date().toISOString(),event.level??"info",event.phase,event.type,event.sourceId??null,event.candidateId??null,event.workerId??null,event.message,event.url??null,event.cursor===undefined?null:String(event.cursor),event.attempt??null,event.httpStatus??null,event.durationMs??null,event.metadata===undefined?null:JSON.stringify(event.metadata));
  }
  recordDiscoveryPull(value:{runId:string;armId:string;sourceId:string;label:string;startedAt:string;durationMs:number;cursor:number;requested:number;returned:number;eligible:number;duplicates?:number;failures?:number;metadata?:unknown}):void{
    this.db.prepare("INSERT INTO discovery_source_pulls(run_id,arm_id,source_id,label,started_at,duration_ms,cursor,requested,returned,eligible,duplicates,failures,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(value.runId,value.armId,value.sourceId,value.label,value.startedAt,value.durationMs,String(value.cursor),value.requested,value.returned,value.eligible,value.duplicates??0,value.failures??0,value.metadata===undefined?null:JSON.stringify(value.metadata));
  }
  recordDiscoveryOutcome(runId:string,jobId:string,candidate:DiscoveryCandidate,postedAt:string|undefined,value:{isNew?:boolean;matchState:string}):void{
    if(!this.db.prepare("SELECT id FROM discovery_runs WHERE id=?").get(runId))return;
    const armId=discoveryArmId(candidate),fresh=recencyReward(postedAt),now=new Date().toISOString();
    const existing=this.db.prepare("SELECT new_strong,is_new FROM discovery_outcomes WHERE run_id=? AND job_id=?").get(runId,jobId) as any,isNew=value.isNew??Boolean(existing?.is_new),newStrong=isNew&&value.matchState==='strong',upgrade=newStrong&&!existing?.new_strong;
    if(existing)this.db.prepare("UPDATE discovery_outcomes SET arm_id=?,source_id=?,is_new=?,match_state=?,new_strong=?,posted_at=?,date_band=?,reward=?,occurred_at=? WHERE run_id=? AND job_id=?").run(armId,candidate.sourceId,isNew?1:0,value.matchState,newStrong?1:0,postedAt??null,fresh.band,newStrong?fresh.reward:0,now,runId,jobId);
    else this.db.prepare("INSERT INTO discovery_outcomes(run_id,job_id,arm_id,source_id,occurred_at,new_strong,posted_at,date_band,reward,is_new,match_state) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(runId,jobId,armId,candidate.sourceId,now,newStrong?1:0,postedAt??null,fresh.band,newStrong?fresh.reward:0,isNew?1:0,value.matchState);
    if(upgrade)this.db.prepare(`UPDATE discovery_runs SET new_strong_count=new_strong_count+1,weighted_reward=weighted_reward+?,useful_match_count=useful_match_count+CASE WHEN ?>0 THEN 1 ELSE 0 END,
      recent_7_count=recent_7_count+CASE WHEN ?='0-7' THEN 1 ELSE 0 END,recent_30_count=recent_30_count+CASE WHEN ?='8-30' THEN 1 ELSE 0 END,
      recent_60_count=recent_60_count+CASE WHEN ?='31-60' THEN 1 ELSE 0 END,unknown_date_count=unknown_date_count+CASE WHEN ?='unknown' THEN 1 ELSE 0 END WHERE id=?`).run(fresh.reward,fresh.reward,fresh.band,fresh.band,fresh.band,fresh.band,runId);
  }
  adaptiveArmRanking(sourceRows:Array<{id:string;label:string}>):any[]{
    const pullHistory=new Map((this.db.prepare(`SELECT p.source_id,SUM(MAX(p.returned,1)) pulls,SUM(p.duration_ms) worker_ms,SUM(p.failures) failures,SUM(p.duplicates) duplicates,MAX(p.started_at) last_at
      FROM discovery_source_pulls p JOIN discovery_runs r ON r.id=p.run_id WHERE r.metrics_version>=2 AND p.started_at>=datetime('now','-30 days') GROUP BY p.source_id`).all() as any[]).map(row=>[String(row.source_id),row])),rewards=new Map((this.db.prepare(`SELECT o.source_id,SUM(o.reward) reward FROM discovery_outcomes o JOIN discovery_runs r ON r.id=o.run_id WHERE r.metrics_version>=2 AND o.occurred_at>=datetime('now','-30 days') GROUP BY o.source_id`).all() as any[]).map(row=>[String(row.source_id),Number(row.reward??0)]));
    const evidence:AdaptiveEvidence[]=sourceRows.map(row=>{const pull=pullHistory.get(row.id);return {armId:`source:${row.id}`,sourceId:row.id,label:row.label,pulls:Number(pull?.pulls??0),workerMs:Number(pull?.worker_ms??0),reward:rewards.get(row.id)??0,failures:Number(pull?.failures??0),duplicates:Number(pull?.duplicates??0),lastAt:pull?.last_at};});
    return rankAdaptiveArms(evidence);
  }
  adaptiveSearchArmRanking(sourceId:string,arms:DiscoverySourceArm[]):any[]{
    const rows=this.db.prepare(`SELECT p.arm_id,SUM(MAX(p.returned,1)) pulls,SUM(p.duration_ms) worker_ms,SUM(p.failures) failures,SUM(p.duplicates) duplicates,MAX(p.started_at) last_at,
      COALESCE((SELECT SUM(o.reward) FROM discovery_outcomes o JOIN discovery_runs ro ON ro.id=o.run_id WHERE ro.metrics_version>=2 AND o.arm_id=p.arm_id AND o.occurred_at>=datetime('now','-30 days')),0) reward
      FROM discovery_source_pulls p JOIN discovery_runs r ON r.id=p.run_id WHERE r.metrics_version>=2 AND p.source_id=? AND p.started_at>=datetime('now','-30 days') GROUP BY p.arm_id`).all(sourceId) as any[],byId=new Map(rows.map(row=>[String(row.arm_id),row]));
    return rankAdaptiveArms(arms.map(arm=>{const row=byId.get(arm.id);return {armId:arm.id,sourceId,label:arm.label,pulls:Number(row?.pulls??0),workerMs:Number(row?.worker_ms??0),reward:Number(row?.reward??0),failures:Number(row?.failures??0),duplicates:Number(row?.duplicates??0),lastAt:row?.last_at};}));
  }
  lastDiscoveryArmPull(armId:string):string|undefined{return (this.db.prepare("SELECT MAX(started_at) last_at FROM discovery_source_pulls WHERE arm_id=?").get(armId) as any)?.last_at;}
  adaptiveCandidateScore(candidate:DiscoveryCandidate):number{
    if(!candidate.boardUrl)return Number(this.adaptiveArmRanking([{id:candidate.sourceId,label:candidate.sourceId}])[0]?.score??0);
    const armId=discoveryArmId(candidate),attempt=this.db.prepare(`SELECT COUNT(*) pulls,SUM(COALESCE(collection_duration_ms,duration_ms)) worker_ms,
      SUM(CASE WHEN result IN ('timeout','rate-limited','network-error','parse-error','invalid-record') THEN 1 ELSE 0 END) failures,MAX(started_at) last_at
      FROM discovery_attempts WHERE board_url=? AND started_at>=datetime('now','-30 days')`).get(candidate.boardUrl) as any,
      outcome=this.db.prepare("SELECT SUM(reward) reward FROM discovery_outcomes WHERE arm_id=? AND occurred_at>=datetime('now','-30 days')").get(armId) as any;
    return Number(rankAdaptiveArms([{armId,sourceId:candidate.sourceId,label:candidate.company,pulls:Number(attempt?.pulls??0),workerMs:Number(attempt?.worker_ms??0),reward:Number(outcome?.reward??0),failures:Number(attempt?.failures??0),duplicates:0,lastAt:attempt?.last_at}])[0]?.score??0);
  }
  adaptiveForecast(durationMinutes:number,sourceRows:Array<{id:string;label:string}>):any{
    const arms=this.adaptiveArmRanking(sourceRows),minutes=durationMinutes,point=arms.slice(0,Math.min(8,arms.length)).reduce((sum,row)=>sum+row.expectedRewardPerMinute,0)*minutes*.55,trainingPulls=arms.reduce((sum,row)=>sum+row.pulls,0),confidence=trainingPulls>=500?'limited':'experimental',radius=Math.max(2,Math.sqrt(point+1)*1.96);
    return {durationMinutes,target:'new-date-verified-strong-nl',targetDefinition:'Distinct newly discovered strong Netherlands jobs, weighted by verified posting age.',expectedUsefulMatches:{point:Number(point.toFixed(1)),lower:Number(Math.max(0,point-radius).toFixed(1)),upper:Number((point+radius).toFixed(1))},expectedWeightedReward:Number(point.toFixed(1)),confidence,trainingPulls,arms:arms.slice(0,12),warnings:[trainingPulls?'Forecast uses measured metrics-v2 pulls only.':'Metrics v2 starts without legacy timing assumptions; confidence will improve after new timed runs.'],recencyWeights:{'0-7':1,'8-30':.4,'31-60':.1,older:0,unknown:0}};
  }
  discoveryTrace(runId:string,after=0,limit=200):unknown {const row=this.db.prepare("SELECT dropped_event_count FROM discovery_runs WHERE id=?").get(runId) as any;if(!row)return undefined;const items=(this.db.prepare("SELECT sequence,occurred_at,level,phase,event_type,source_id,candidate_id,worker_id,message,url,cursor,attempt,http_status,duration_ms,metadata_json FROM discovery_run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(runId,after,Math.min(Math.max(limit,1),500)) as any[]).map(item=>({...item,metadata:item.metadata_json?JSON.parse(item.metadata_json):null,metadata_json:undefined}));return {items,droppedCount:Number(row.dropped_event_count??0),nextAfter:items.at(-1)?.sequence??after};}
  startDiscoveryTask(runId:string,candidateId:string,workerId:string,candidate:DiscoveryCandidate,stage="resolving-board",detail?:string):void {const now=new Date().toISOString();this.db.prepare(`INSERT INTO discovery_run_tasks(run_id,candidate_id,worker_id,source_id,provider,company,board_url,stage,detail,started_at,stage_started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,candidate_id) DO UPDATE SET worker_id=excluded.worker_id,stage=excluded.stage,detail=excluded.detail,stage_started_at=excluded.stage_started_at,updated_at=excluded.updated_at`).run(runId,candidateId,workerId,candidate.sourceId,candidate.provider??null,candidate.company,candidate.boardUrl??null,stage,detail??null,now,now,now);}
  updateDiscoveryTask(runId:string,candidateId:string,stage:string,value:{detail?:string;jobTitle?:string;jobUrl?:string}={}):void {const now=new Date().toISOString();this.db.prepare("UPDATE discovery_run_tasks SET stage=?,detail=?,job_title=?,job_url=?,stage_started_at=?,updated_at=? WHERE run_id=? AND candidate_id=?").run(stage,value.detail??null,value.jobTitle??null,value.jobUrl??null,now,now,runId,candidateId);}
  finishDiscoveryTask(runId:string,candidateId:string):void {this.db.prepare("DELETE FROM discovery_run_tasks WHERE run_id=? AND candidate_id=?").run(runId,candidateId);}
  clearDiscoveryTasks(runId:string):void {this.db.prepare("DELETE FROM discovery_run_tasks WHERE run_id=?").run(runId);}
  private forecastHistory():any[]{return this.db.prepare(`
    WITH attempt_counts AS (
      SELECT run_id,source_id,COUNT(*) candidates,SUM(CASE WHEN result IN ('timeout','rate-limited','network-error','parse-error','invalid-record') THEN 1 ELSE 0 END) failures
      FROM discovery_attempts GROUP BY run_id,source_id
    ), outcomes AS (
      SELECT r.id run_id,so.source_id,COUNT(DISTINCT j.id) new_strong
      FROM discovery_runs r JOIN source_observations so ON so.discovery_run_id=r.id JOIN jobs j ON j.id=so.job_id
      WHERE j.match_state='strong' AND datetime(j.first_seen_at)>=datetime(r.started_at)
      GROUP BY r.id,so.source_id
    )
    SELECT r.id runId,r.started_at startedAt,COALESCE(r.mode,'balanced') mode,p.source_id sourceId,p.label,p.category,p.planned_count planned,
      COALESCE(a.candidates,0) candidates,COALESCE(a.failures,0) failures,COALESCE(o.new_strong,0) newStrong
    FROM discovery_runs r JOIN discovery_run_sources p ON p.run_id=r.id
    LEFT JOIN attempt_counts a ON a.run_id=r.id AND a.source_id=p.source_id LEFT JOIN outcomes o ON o.run_id=r.id AND o.source_id=p.source_id
    WHERE r.source_id IS NULL AND r.status IN ('completed','partial') AND r.finished_at IS NOT NULL AND r.processed_count>0
    ORDER BY r.started_at,p.source_id
  `).all();}
  discoveryForecast(limit:number,allocations:Record<string,number>,mode:ForecastMode="balanced",plan?:ForecastPlanRow[]):TransparentForecast {
    const rows=(plan?.length?plan:Object.entries(allocations).map(([category,planned])=>({sourceId:`category:${category}`,label:category,category,planned:Number(planned)}))).filter(row=>row.planned>0);
    return buildTransparentForecast(this.forecastHistory(),rows,mode,limit);
  }
  discoveryForecastSeries(inputs:ForecastSeriesInput[],mode:ForecastMode="balanced"):TransparentForecast[] {return buildTransparentForecastSeries(this.forecastHistory(),inputs,mode);}
  discoveryForecastBudgetSupport():{minLimit:number;maxLimit:number;runs:number}{const row=this.db.prepare("SELECT MIN(limit_count) minLimit,MAX(limit_count) maxLimit,COUNT(*) runs FROM discovery_runs WHERE source_id IS NULL AND status IN ('completed','partial') AND finished_at IS NOT NULL AND processed_count>0").get() as any;return {minLimit:Number(row?.minLimit??1),maxLimit:Number(row?.maxLimit??0),runs:Number(row?.runs??0)};}
  saveDiscoveryForecast(runId:string,input:unknown,forecast:TransparentForecast):void {this.db.prepare(`INSERT INTO discovery_forecasts(run_id,created_at,model_version,target,input_json,prediction_json) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET created_at=excluded.created_at,model_version=excluded.model_version,target=excluded.target,input_json=excluded.input_json,prediction_json=excluded.prediction_json`).run(runId,new Date().toISOString(),forecast.modelVersion,forecast.target,JSON.stringify(input),JSON.stringify(forecast));}
  private actualNewStrongMatches(runId:string):number {const row=this.db.prepare(`SELECT COUNT(DISTINCT j.id) count FROM discovery_runs r JOIN source_observations so ON so.discovery_run_id=r.id JOIN jobs j ON j.id=so.job_id WHERE r.id=? AND j.match_state='strong' AND datetime(j.first_seen_at)>=datetime(r.started_at)`).get(runId) as any;return Number(row?.count??0);}
  pendingEnrichmentCount(runId?:string):number {const row=this.db.prepare(`SELECT COUNT(*) count FROM enrichment_queue WHERE status IN ('pending','failed') AND attempts<4 AND (? IS NULL OR discovery_run_id=?)`).get(runId??null,runId??null) as any;return Number(row?.count??0);}
  eligibleEnrichmentCount():number {const row=this.db.prepare("SELECT COUNT(*) count FROM enrichment_queue WHERE status IN ('pending','failed') AND attempts<4 AND (next_retry_at IS NULL OR next_retry_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))").get() as any;return Number(row?.count??0);}
  enrichmentQueueSummary():{eligibleNow:number;coolingDown:number;terminal:number;complete:number;skipped:number;nextRetryAt?:string} {
    const row=this.db.prepare(`SELECT
      SUM(CASE WHEN status IN ('pending','failed') AND attempts<4 AND (next_retry_at IS NULL OR next_retry_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN 1 ELSE 0 END) eligible_now,
      SUM(CASE WHEN status IN ('pending','failed') AND attempts<4 AND next_retry_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END) cooling_down,
      SUM(CASE WHEN status='terminal' OR (status='failed' AND attempts>=4) THEN 1 ELSE 0 END) terminal,
      SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) complete,
      SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) skipped,
      MIN(CASE WHEN status IN ('pending','failed') AND attempts<4 AND next_retry_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN next_retry_at END) next_retry_at
      FROM enrichment_queue`).get() as any;
    return {eligibleNow:Number(row?.eligible_now??0),coolingDown:Number(row?.cooling_down??0),terminal:Number(row?.terminal??0),complete:Number(row?.complete??0),skipped:Number(row?.skipped??0),...(row?.next_retry_at?{nextRetryAt:String(row.next_retry_at)}:{})};
  }
  reconcileDiscoveryForecast(runId:string):void {const pending=this.pendingEnrichmentCount(runId);this.db.prepare("UPDATE discovery_forecasts SET actual_new_strong=?,reconciled_at=? WHERE run_id=?").run(this.actualNewStrongMatches(runId),pending?null:new Date().toISOString(),runId);}
  discoveryForecastSnapshot(runId:string):unknown {const row=this.db.prepare("SELECT * FROM discovery_forecasts WHERE run_id=?").get(runId) as any;return row?{...row,reconciliationStatus:this.pendingEnrichmentCount(runId)?'provisional':'final',pendingEnrichments:this.pendingEnrichmentCount(runId),input:JSON.parse(row.input_json),prediction:JSON.parse(row.prediction_json),input_json:undefined,prediction_json:undefined}:undefined;}
  resumeDiscoveryRun(id: string): void { const row=this.db.prepare("SELECT source_id,limit_count,mode,worker_count FROM discovery_runs WHERE id=?").get(id) as any;if(!row)throw new Error("Discovery run not found");const claimed=this.claimDiscoveryRun(id,row.source_id??undefined,Number(row.limit_count),undefined,row.mode??'balanced',Number(row.worker_count??6),true);if(!claimed.claimed)throw Object.assign(new Error("A discovery run is already active"),{statusCode:409,activeRun:claimed.activeRun}); }
  finishDiscoveryRun(id: string, result: { status: string; processed: number; employers: number; matching: number; nonmatching: number; errors: number; noNl?: number; empty?: number; retryableErrors?: number; permanentErrors?: number; durationMs?: number; checkpoint?: unknown; fetched?: number; newJobs?: number; refreshedJobs?: number; missingBoards?: number; unsupported?: number; partialCollections?: number; descriptionCandidates?:number; enrichedJobs?:number; deferredEnrichments?:number; descriptionMatches?:number; enrichmentFailures?:number }): void {
    this.db.prepare("UPDATE discovery_runs SET finished_at=?,heartbeat_at=?,status=?,phase=?,phase_message=?,processed_count=?,employer_count=?,matching_jobs=?,nonmatching_jobs=?,error_count=?,no_nl_count=?,empty_count=?,retryable_error_count=?,permanent_error_count=?,duration_ms=?,checkpoint_json=?,fetched_jobs=?,new_jobs=?,refreshed_jobs=?,missing_board_count=?,unsupported_count=?,partial_collection_count=?,description_candidate_count=?,enriched_job_count=?,deferred_enrichment_count=?,description_match_count=?,enrichment_failure_count=? WHERE id=?").run(new Date().toISOString(), new Date().toISOString(), result.status,result.status==="interrupted"?"cancelled":"completed",result.status==="interrupted"?"Cancelled safely; queue can be resumed":"Discovery finished", result.processed, result.employers, result.matching, result.nonmatching, result.errors, result.noNl ?? 0, result.empty ?? 0, result.retryableErrors ?? 0, result.permanentErrors ?? 0, result.durationMs ?? 0, JSON.stringify(result.checkpoint ?? {}), result.fetched ?? 0, result.newJobs ?? 0, result.refreshedJobs ?? 0, result.missingBoards ?? 0, result.unsupported ?? 0, result.partialCollections ?? 0,result.descriptionCandidates??0,result.enrichedJobs??0,result.deferredEnrichments??0,result.descriptionMatches??0,result.enrichmentFailures??0,id);
    this.reconcileDiscoveryForecast(id);
    this.clearDiscoveryTasks(id);
  }
  updateDiscoveryCheckpoint(id: string, checkpoint: unknown, counts: { processed: number; employers: number; matching: number; nonmatching: number; errors: number; noNl: number; empty: number; retryableErrors: number; permanentErrors: number }): void { this.db.prepare("UPDATE discovery_runs SET heartbeat_at=?,checkpoint_json=?,processed_count=?,employer_count=?,matching_jobs=?,nonmatching_jobs=?,error_count=?,no_nl_count=?,empty_count=?,retryable_error_count=?,permanent_error_count=? WHERE id=?").run(new Date().toISOString(), JSON.stringify(checkpoint), counts.processed, counts.employers, counts.matching, counts.nonmatching, counts.errors, counts.noNl, counts.empty, counts.retryableErrors, counts.permanentErrors, id); }
  recoverStaleDiscoveryRuns(staleMs = 120_000): number { const cutoff = new Date(Date.now() - staleMs).toISOString(),ids=(this.db.prepare("SELECT id FROM discovery_runs WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at<?)").all(cutoff) as any[]).map(row=>row.id);if(!ids.length)return 0;const now=new Date().toISOString();for(const id of ids){this.db.prepare("UPDATE discovery_runs SET status='interrupted',phase='cancelled',phase_message='Process heartbeat stopped; queue can be resumed',finished_at=?,heartbeat_at=? WHERE id=?").run(now,now,id);this.clearDiscoveryTasks(id);}return ids.length; }
  failDiscoveryRun(id:string,message:string):void {const now=new Date().toISOString();this.db.prepare("UPDATE discovery_runs SET status='failed',phase='failed',phase_message=?,finished_at=?,heartbeat_at=? WHERE id=? AND status='running'").run(message.slice(0,500),now,now,id);this.clearDiscoveryTasks(id);}
  interruptDiscoveryRun(id: string): void { this.db.prepare("UPDATE discovery_runs SET status='interrupted',phase='cancelled',phase_message='Interrupted; queue can be resumed',finished_at=?,heartbeat_at=? WHERE id=? AND status='running'").run(new Date().toISOString(), new Date().toISOString(), id);this.clearDiscoveryTasks(id); }
  incompleteDiscoveryRun(sourceId?: string): { id: string; checkpoint: any; row: any } | null { const row = this.db.prepare("SELECT * FROM discovery_runs WHERE (status IN ('running','interrupted') OR (status IN ('partial','failed') AND EXISTS(SELECT 1 FROM discovery_queue q WHERE q.run_id=discovery_runs.id AND q.status='pending'))) AND COALESCE(source_id,'')=COALESCE(?,'') ORDER BY started_at DESC LIMIT 1").get(sourceId ?? null) as any; return row ? { id: row.id, checkpoint: JSON.parse(row.checkpoint_json), row } : null; }
  enqueueDiscoveryCandidates(runId: string, rows: Array<{ id: string; candidate: DiscoveryCandidate }>): {queued:number;duplicates:number} {
    const statement = this.db.prepare("INSERT OR IGNORE INTO discovery_queue(run_id,ordinal,candidate_id,source_id,candidate_json,status,updated_at) VALUES(?,?,?,?,?,'pending',?)");
    const now = new Date().toISOString();let queued=0,duplicates=0;this.db.exec("BEGIN IMMEDIATE");
    try { const existing=new Set((this.db.prepare("SELECT candidate_id FROM discovery_queue WHERE run_id=?").all(runId) as any[]).map(row=>String(row.candidate_id)));let ordinal=Number((this.db.prepare("SELECT COALESCE(MAX(ordinal),-1) ordinal FROM discovery_queue WHERE run_id=?").get(runId) as any)?.ordinal??-1)+1;for(const row of rows){if(existing.has(row.id)){duplicates++;continue;}const result=statement.run(runId,ordinal,row.id,row.candidate.sourceId,JSON.stringify(row.candidate),now);if(Number(result.changes)){queued++;ordinal++;existing.add(row.id);}else duplicates++;}this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return {queued,duplicates};
  }
  discoveryQueue(runId: string, statuses = ["pending"]): Array<{ ordinal: number; candidateId: string; candidate: DiscoveryCandidate }> {
    const placeholders = statuses.map(() => "?").join(",");
    return (this.db.prepare(`SELECT ordinal,candidate_id,candidate_json FROM discovery_queue WHERE run_id=? AND status IN (${placeholders}) ORDER BY ordinal`).all(runId, ...statuses) as any[]).map(row => ({ ordinal: row.ordinal, candidateId: row.candidate_id, candidate: JSON.parse(row.candidate_json) }));
  }
  markDiscoveryQueue(runId: string, candidateId: string, status: string, result?: string): void { this.db.prepare("UPDATE discovery_queue SET status=?,result=?,updated_at=? WHERE run_id=? AND candidate_id=?").run(status, result ?? null, new Date().toISOString(), runId, candidateId); }
  pendingDiscoveryCount(runId: string): number { return Number((this.db.prepare("SELECT COUNT(*) count FROM discovery_queue WHERE run_id=? AND status='pending'").get(runId) as any).count); }
  recordDiscoveryAttempt(attempt: DiscoveryAttempt): void { this.db.prepare(`INSERT INTO discovery_attempts(run_id,source_id,company,board_url,provider,started_at,duration_ms,result,http_status,retryable,error_message,jobs_fetched,netherlands_jobs,profile_matches,candidate_json,collection_partial,continuation,collection_duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,source_id,company,board_url) DO UPDATE SET started_at=excluded.started_at,duration_ms=excluded.duration_ms,result=excluded.result,http_status=excluded.http_status,retryable=excluded.retryable,error_message=excluded.error_message,jobs_fetched=excluded.jobs_fetched,netherlands_jobs=excluded.netherlands_jobs,profile_matches=excluded.profile_matches,candidate_json=excluded.candidate_json,collection_partial=excluded.collection_partial,continuation=excluded.continuation,collection_duration_ms=excluded.collection_duration_ms`).run(attempt.runId, attempt.sourceId, attempt.company, attempt.boardUrl ?? null, attempt.provider ?? null, attempt.startedAt, attempt.durationMs, attempt.result, attempt.httpStatus ?? null, attempt.retryable ? 1 : 0, attempt.errorMessage?.slice(0, 1000) ?? null, attempt.jobsFetched, attempt.netherlandsJobs, attempt.profileMatches, JSON.stringify(attempt.candidate), attempt.collectionPartial ? 1 : 0, attempt.continuation ?? null,attempt.collectionDurationMs??null); }
  discoveryFailures(query: { retryable?: boolean; source?: string; limit?: number; history?: boolean; includeMissing?: boolean } = {}): unknown[] {
    const params: any[] = [];
    if (query.history) {
      const clauses = ["a.result IN ('timeout','rate-limited','network-error','parse-error','invalid-record','board-not-found')"];
      if (query.retryable !== undefined) { clauses.push("a.retryable=?"); params.push(query.retryable ? 1 : 0); }
      if (query.source) { clauses.push("a.source_id=?"); params.push(query.source); }
      return this.db.prepare(`SELECT a.*,h.retry_count,h.next_retry_at FROM discovery_attempts a LEFT JOIN discovery_candidate_health h ON h.source_id=a.source_id AND h.company=a.company AND COALESCE(h.board_url,'')=COALESCE(a.board_url,'') WHERE ${clauses.join(" AND ")} ORDER BY a.started_at DESC LIMIT ?`).all(...params, Math.min(query.limit ?? 100, 500));
    }
    const currentResults = query.includeMissing ? "'timeout','rate-limited','network-error','parse-error','invalid-record','board-not-found'" : "'timeout','rate-limited','network-error','parse-error','invalid-record'";
    const clauses = [`latest_result IN (${currentResults})`];
    if (query.retryable !== undefined) { clauses.push("retryable=?"); params.push(query.retryable ? 1 : 0); }
    if (query.source) { clauses.push("source_id=?"); params.push(query.source); }
    return this.db.prepare(`SELECT candidate_id,source_id,company,board_url,provider,latest_result result,latest_at,retryable,retry_count,next_retry_at,http_status,error_message FROM discovery_candidate_health WHERE ${clauses.join(" AND ")} ORDER BY latest_at DESC LIMIT ?`).all(...params, Math.min(query.limit ?? 100, 500));
  }
  updateCandidateHealth(candidateId: string, attempt: DiscoveryAttempt): void {
    const prior = this.db.prepare("SELECT retry_count FROM discovery_candidate_health WHERE candidate_id=?").get(candidateId) as any;
    const retryCount = attempt.retryable ? Number(prior?.retry_count ?? 0) + 1 : 0;
    const delays = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
    const delay = attempt.result === "board-not-found" ? 7 * 24 * 60 * 60_000 : attempt.retryable ? delays[Math.min(retryCount - 1, delays.length - 1)] : 0;
    const nextRetry = delay ? new Date(Date.now() + delay).toISOString() : null;
    this.db.prepare(`INSERT INTO discovery_candidate_health(candidate_id,source_id,company,board_url,provider,candidate_json,latest_result,latest_at,retryable,retry_count,next_retry_at,http_status,error_message)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET source_id=excluded.source_id,company=excluded.company,board_url=excluded.board_url,provider=excluded.provider,candidate_json=excluded.candidate_json,latest_result=excluded.latest_result,latest_at=excluded.latest_at,retryable=excluded.retryable,retry_count=excluded.retry_count,next_retry_at=excluded.next_retry_at,http_status=excluded.http_status,error_message=excluded.error_message`)
      .run(candidateId, attempt.sourceId, attempt.company, attempt.boardUrl ?? null, attempt.provider ?? null, JSON.stringify(attempt.candidate), attempt.result, new Date().toISOString(), attempt.retryable ? 1 : 0, retryCount, nextRetry, attempt.httpStatus ?? null, attempt.errorMessage ?? null);
  }
  retryableCandidates(source?: string, limit = 100): DiscoveryCandidate[] { const clauses = ["retryable=1", "(next_retry_at IS NULL OR next_retry_at<=?)"], params: any[] = [new Date().toISOString()]; if (source) { clauses.push("source_id=?"); params.push(source); } return (this.db.prepare(`SELECT candidate_json FROM discovery_candidate_health WHERE ${clauses.join(" AND ")} ORDER BY latest_at ASC LIMIT ?`).all(...params, limit) as any[]).map(row => JSON.parse(row.candidate_json)); }
  transaction<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const value = fn(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  upsertEmployer(candidate: DiscoveryCandidate, id: string, normalizedName: string, hiringCount: number): string {
    const domain = candidate.domain?.toLowerCase() ?? null;
    const board = candidate.boardUrl ? this.db.prepare("SELECT employer_id FROM employer_boards WHERE board_url=?").get(candidate.boardUrl) as any : null;
    const existing = (domain ? this.db.prepare("SELECT id FROM employers WHERE domain=?").get(domain) : null) as any
      ?? board
      ?? this.db.prepare("SELECT id FROM employers WHERE normalized_name=? LIMIT 1").get(normalizedName) as any;
    const employerId = existing?.id ?? existing?.employer_id ?? id;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO employers(id,canonical_name,normalized_name,domain,headquarters,size_band,size_confidence,size_evidence,first_discovered_at,last_discovered_at,last_hiring_signal_at,active_nl_vacancies)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET canonical_name=CASE WHEN LENGTH(excluded.canonical_name)>LENGTH(employers.canonical_name) THEN excluded.canonical_name ELSE employers.canonical_name END,domain=COALESCE(employers.domain,excluded.domain),headquarters=CASE WHEN employers.headquarters='unknown' THEN excluded.headquarters ELSE employers.headquarters END,size_band=COALESCE(excluded.size_band,employers.size_band),size_confidence=CASE WHEN excluded.size_confidence='reported' THEN 'reported' WHEN employers.size_confidence='unknown' THEN excluded.size_confidence ELSE employers.size_confidence END,size_evidence=COALESCE(excluded.size_evidence,employers.size_evidence),last_discovered_at=excluded.last_discovered_at,last_hiring_signal_at=COALESCE(excluded.last_hiring_signal_at,employers.last_hiring_signal_at),active_nl_vacancies=MAX(employers.active_nl_vacancies,excluded.active_nl_vacancies)`)
      .run(employerId, candidate.company, normalizedName, domain, candidate.headquarters ?? "unknown", candidate.sizeBand ?? null, candidate.sizeConfidence ?? "unknown", candidate.sizeEvidence ?? null, now, now, hiringCount ? now : null, hiringCount);
    this.db.prepare("INSERT OR IGNORE INTO employer_aliases(employer_id,alias,normalized_alias,source_id) VALUES(?,?,?,?)").run(employerId, candidate.company, normalizedName, candidate.sourceId);
    this.db.prepare(`UPDATE benchmark_matches SET employer_id=?,match_method=?,review_state='matched',reviewed_at=?
      WHERE panel_version=? AND review_state IN ('unmatched','needs-review') AND benchmark_id IN
      (SELECT benchmark_id FROM benchmark_employers WHERE panel_version=? AND ((domain IS NOT NULL AND LOWER(domain)=LOWER(?)) OR normalized_name=?))`)
      .run(employerId,domain?"domain":"exact-name",now,BENCHMARK_VERSION,BENCHMARK_VERSION,domain,normalizedName);
    return employerId;
  }
  upsertEmployerBoard(employerId: string, candidate: DiscoveryCandidate, id: string, status: string, failure?: string): void {
    if (!candidate.boardUrl) return;
    this.db.prepare(`INSERT INTO employer_boards(id,employer_id,provider,board_url,api_url,status,confidence,last_checked_at,failure_reason,discovery_source) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(board_url) DO UPDATE SET employer_id=excluded.employer_id,provider=COALESCE(excluded.provider,employer_boards.provider),api_url=COALESCE(excluded.api_url,employer_boards.api_url),status=excluded.status,last_checked_at=excluded.last_checked_at,failure_reason=excluded.failure_reason`).run(id, employerId, candidate.provider ?? null, candidate.boardUrl, candidate.apiUrl ?? null, status, candidate.provider ? 1 : .5, new Date().toISOString(), failure ?? null, candidate.sourceId);
  }
  recordBenchmarkBoardAttempt(candidate:DiscoveryCandidate):void { if(!candidate.benchmarkId||!candidate.discoveryEvidence)return;const e=candidate.discoveryEvidence;this.db.prepare("INSERT INTO benchmark_board_attempts(benchmark_id,attempted_at,method,query_or_url,resolved_url,provider,confidence,result,error_message) VALUES(?,?,?,?,?,?,?,?,?)").run(candidate.benchmarkId,new Date().toISOString(),e.method,e.queryOrUrl,e.resolvedUrl??null,candidate.provider??null,e.confidence,e.result,e.error?.slice(0,500)??null); }
  benchmarkBoardNeedsCheck(id:string):boolean {
    const row=this.db.prepare('SELECT attempted_at,result FROM benchmark_board_attempts WHERE benchmark_id=? ORDER BY attempted_at DESC LIMIT 1').get(id) as any;
    return !row || Date.now()-Date.parse(row.attempted_at)>=(row.result==='board-found'?86400000:7*86400000);
  }
  candidateLastChecked(candidate:DiscoveryCandidate):string {return String((this.db.prepare("SELECT max(latest_at) checked FROM discovery_candidate_health WHERE board_url=? OR (source_id=? AND company=?)").get(candidate.boardUrl??null,candidate.sourceId,candidate.company) as any)?.checked??'');}
  candidateDisposition(candidate:DiscoveryCandidate,mode="balanced"):"fresh"|"recheck"|"continuation"|"forced-refresh"|"skipped-recent" {
    if(candidate.boardUrl){const collection=this.collection(candidate.boardUrl);if(collection?.cursor&&collection.state!=="complete"&&!collection.error)return "continuation";}
    const row=this.db.prepare("SELECT * FROM discovery_candidate_health WHERE (board_url IS NOT NULL AND board_url=?) OR (source_id=? AND company=? AND board_url IS NULL) ORDER BY latest_at DESC LIMIT 1").get(candidate.boardUrl??null,candidate.sourceId,candidate.company) as any;
    if(!row)return "fresh";
    if(mode==="refresh-known")return "forced-refresh";
    if(mode==="fresh")return "skipped-recent";
    if(row.next_retry_at)return Date.parse(row.next_retry_at)<=Date.now()?"recheck":"skipped-recent";
    return Date.now()-Date.parse(row.latest_at)>=(row.latest_result==="matched"?86400000:7*86400000)?"recheck":"skipped-recent";
  }
  candidateDue(candidate:DiscoveryCandidate):boolean {
    return this.candidateDisposition(candidate,"balanced")!=="skipped-recent";
  }
  observeVacancy(employerId: string, sourceId: string, job: { externalId?: string; title: string; location: string; url: string }, print: string, matched: boolean): void {
    this.db.prepare(`INSERT INTO vacancy_observations(fingerprint,employer_id,source_id,external_id,title,location,url,observed_at,matched_profile) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(fingerprint,source_id) DO UPDATE SET observed_at=excluded.observed_at,matched_profile=excluded.matched_profile`).run(print, employerId, sourceId, job.externalId ?? null, job.title, job.location, job.url, new Date().toISOString(), matched ? 1 : 0);
  }
  discoveredSources(): SourceConfig[] {
    return (this.db.prepare(`SELECT eb.id, e.canonical_name company, eb.board_url careersUrl, eb.api_url apiUrl, eb.provider FROM employer_boards eb JOIN employers e ON e.id=eb.employer_id WHERE eb.status='healthy' AND eb.provider IS NOT NULL AND (EXISTS(SELECT 1 FROM vacancy_observations v WHERE v.employer_id=e.id) OR EXISTS(SELECT 1 FROM benchmark_matches bm WHERE bm.employer_id=e.id) OR EXISTS(SELECT 1 FROM collection_checkpoints c WHERE c.board_url=eb.board_url AND c.state!='complete')) ORDER BY COALESCE(eb.last_checked_at,'') ASC`).all() as any[]).map(row => ({ id: row.id, company: row.company, careersUrl: row.careersUrl, apiUrl: row.apiUrl ?? undefined, provider: row.provider as ProviderId, enabled: true }));
  }
  employers(query: EmployerQuery = {}): unknown[] {
    const clauses: string[] = [], params: any[] = [];
    if (query.name) { clauses.push("LOWER(e.canonical_name) LIKE ?"); params.push(`%${query.name.toLowerCase()}%`); }
    if (query.headquarters) { clauses.push("e.headquarters=?"); params.push(query.headquarters); }
    if (query.hiring !== undefined) clauses.push(query.hiring ? "EXISTS(SELECT 1 FROM vacancy_observations v WHERE v.employer_id=e.id AND v.observed_at>=datetime('now','-30 days'))" : "NOT EXISTS(SELECT 1 FROM vacancy_observations v WHERE v.employer_id=e.id AND v.observed_at>=datetime('now','-30 days'))");
    if (query.sizeBand) { clauses.push("e.size_band=?"); params.push(query.sizeBand); }
    if (query.provider) { clauses.push("EXISTS(SELECT 1 FROM employer_boards b WHERE b.employer_id=e.id AND b.provider=?)"); params.push(query.provider); }
    if (query.source) { clauses.push("EXISTS(SELECT 1 FROM employer_aliases a WHERE a.employer_id=e.id AND a.source_id=?)"); params.push(query.source); }
    if (query.boardStatus) { clauses.push("EXISTS(SELECT 1 FROM employer_boards b WHERE b.employer_id=e.id AND b.status=?)"); params.push(query.boardStatus); }
    if (query.since) { clauses.push("e.last_discovered_at>=?"); params.push(query.since); }
    if (query.matches !== undefined) clauses.push(`${query.matches ? "" : "NOT "}EXISTS(SELECT 1 FROM vacancy_observations v WHERE v.employer_id=e.id AND v.matched_profile=1 AND v.observed_at>=datetime('now','-30 days'))`);
    if (query.benchmark !== undefined) clauses.push(`${query.benchmark ? "" : "NOT "}EXISTS(SELECT 1 FROM benchmark_matches bm WHERE bm.employer_id=e.id AND bm.review_state='matched')`);
    const order = query.sort === "company" ? "e.canonical_name" : query.sort === "matches" ? "profile_matches_30d DESC,e.canonical_name" : query.sort === "vacancies" ? "vacancies_30d DESC,e.canonical_name" : query.sort === "firstDiscovered" ? "e.first_discovered_at DESC" : "e.last_hiring_signal_at DESC,e.canonical_name";
    return this.db.prepare(`SELECT e.*,
      (SELECT COUNT(DISTINCT v.fingerprint) FROM vacancy_observations v WHERE v.employer_id=e.id AND v.observed_at>=datetime('now','-30 days')) vacancies_30d,
      (SELECT COUNT(DISTINCT v.fingerprint) FROM vacancy_observations v WHERE v.employer_id=e.id AND v.matched_profile=1 AND v.observed_at>=datetime('now','-30 days')) profile_matches_30d,
      (SELECT GROUP_CONCAT(DISTINCT COALESCE(b.provider,'unsupported')) FROM employer_boards b WHERE b.employer_id=e.id) providers,
      (SELECT GROUP_CONCAT(DISTINCT a.source_id) FROM employer_aliases a WHERE a.employer_id=e.id) discovery_sources,
      (SELECT COUNT(*) FROM employer_boards b WHERE b.employer_id=e.id) board_count,
      (SELECT COUNT(*) FROM employer_boards b WHERE b.employer_id=e.id AND b.status='healthy') healthy_board_count,
      (SELECT MAX(b.last_checked_at) FROM employer_boards b WHERE b.employer_id=e.id) last_board_check,
      EXISTS(SELECT 1 FROM benchmark_matches bm WHERE bm.employer_id=e.id AND bm.review_state='matched') benchmark_member
      FROM employers e ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, Math.min(query.limit ?? 50, 200), query.offset ?? 0);
  }
  employerCount(query: EmployerQuery = {}): number { const copy={...query,limit:1,offset:0}; const clauses: string[] = [], params: any[]=[]; if(copy.name){clauses.push("LOWER(e.canonical_name) LIKE ?");params.push(`%${copy.name.toLowerCase()}%`)} if(copy.headquarters){clauses.push("e.headquarters=?");params.push(copy.headquarters)} if(copy.hiring!==undefined)clauses.push(copy.hiring?"EXISTS(SELECT 1 FROM vacancy_observations v WHERE v.employer_id=e.id AND v.observed_at>=datetime('now','-30 days'))":"NOT EXISTS(SELECT 1 FROM vacancy_observations v WHERE v.employer_id=e.id AND v.observed_at>=datetime('now','-30 days'))"); if(copy.provider){clauses.push("EXISTS(SELECT 1 FROM employer_boards b WHERE b.employer_id=e.id AND b.provider=?)");params.push(copy.provider)} if(copy.source){clauses.push("EXISTS(SELECT 1 FROM employer_aliases a WHERE a.employer_id=e.id AND a.source_id=?)");params.push(copy.source)} if(copy.boardStatus){clauses.push("EXISTS(SELECT 1 FROM employer_boards b WHERE b.employer_id=e.id AND b.status=?)");params.push(copy.boardStatus)} if(copy.matches!==undefined)clauses.push(`${copy.matches?"":"NOT "}EXISTS(SELECT 1 FROM vacancy_observations v WHERE v.employer_id=e.id AND v.matched_profile=1 AND v.observed_at>=datetime('now','-30 days'))`); if(copy.benchmark!==undefined)clauses.push(`${copy.benchmark?"":"NOT "}EXISTS(SELECT 1 FROM benchmark_matches bm WHERE bm.employer_id=e.id AND bm.review_state='matched')`); return Number((this.db.prepare(`SELECT COUNT(*) count FROM employers e ${clauses.length?`WHERE ${clauses.join(" AND ")}`:""}`).get(...params) as any).count); }
  employer(id: string): unknown { const employer = this.db.prepare("SELECT * FROM employers WHERE id=?").get(id) as any; if (!employer) return undefined; return { ...employer, aliases: this.db.prepare("SELECT alias,source_id sourceId FROM employer_aliases WHERE employer_id=?").all(id), boards: this.db.prepare("SELECT * FROM employer_boards WHERE employer_id=? ORDER BY last_checked_at DESC").all(id), observations: this.db.prepare("SELECT * FROM vacancy_observations WHERE employer_id=? ORDER BY observed_at DESC LIMIT 200").all(id), jobs: this.db.prepare("SELECT j.id,j.title,j.location,j.overall_score,j.status,j.canonical_url,j.first_seen_at,j.last_seen_at FROM jobs j WHERE EXISTS(SELECT 1 FROM vacancy_observations v WHERE v.employer_id=? AND v.fingerprint=j.fingerprint) ORDER BY j.overall_score DESC").all(id), attempts: this.db.prepare("SELECT source_id,provider,board_url,result,started_at,duration_ms,jobs_fetched,netherlands_jobs,profile_matches,error_message FROM discovery_attempts WHERE LOWER(company)=LOWER(?) ORDER BY started_at DESC LIMIT 100").all(employer.canonical_name), benchmark: this.db.prepare("SELECT be.*,bm.match_method,bm.review_state FROM benchmark_matches bm JOIN benchmark_employers be ON be.panel_version=bm.panel_version AND be.benchmark_id=bm.benchmark_id WHERE bm.employer_id=?").get(id) }; }
  discoverySourceRows(): unknown[] { return this.db.prepare("SELECT * FROM discovery_sources ORDER BY id").all(); }
  sourceYieldEvidence(sourceId:string):{attempts:number;averageDurationMs:number;matchYield:number;failureRate:number;matches:number}|undefined {
    const row=this.db.prepare("SELECT COUNT(*) attempts,COALESCE(AVG(COALESCE(collection_duration_ms,duration_ms)),0) averageDurationMs,COALESCE(SUM(profile_matches),0) matches,COALESCE(SUM(CASE WHEN result IN ('timeout','rate-limited','network-error','parse-error','invalid-record') THEN 1 ELSE 0 END),0) failures FROM discovery_attempts WHERE source_id=? AND started_at>=datetime('now','-30 days')").get(sourceId) as any;
    const attempts=Number(row?.attempts??0),matches=Number(row?.matches??0);return attempts?{attempts,matches,averageDurationMs:Number(row.averageDurationMs),matchYield:matches/attempts,failureRate:Number(row.failures)/attempts}:undefined;
  }
  private discoveryEta(row:any,pending:number):unknown {
    if(row.status!=="running")return null;
    const elapsed=Math.max(1,Date.now()-Date.parse(row.started_at)),processed=Number(row.processed_count??0);
    if(row.phase==="planning"||row.phase==="querying-sources"){
      const samples=(this.db.prepare("SELECT duration_ms FROM discovery_runs WHERE status IN ('completed','partial') AND mode=? AND duration_ms>0 AND limit_count BETWEEN ? AND ? ORDER BY started_at DESC LIMIT 5").all(row.mode??"balanced",Math.max(1,Math.floor(row.limit_count*.75)),Math.ceil(row.limit_count*1.25)) as any[]).map(value=>Number(value.duration_ms)).sort((a,b)=>a-b);
      if(!samples.length)return {seconds:null,lowerSeconds:null,upperSeconds:null,confidence:"low",basis:"Waiting for a comparable run"};
      const middle=samples[Math.floor(samples.length/2)],remaining=Math.max(0,middle-elapsed);return {seconds:Math.round(remaining/1000),lowerSeconds:Math.round(Math.max(0,samples[0]-elapsed)/1000),upperSeconds:Math.round(Math.max(0,samples.at(-1)!-elapsed)/1000),confidence:samples.length>=3?"medium":"low",basis:`${samples.length} comparable run${samples.length===1?"":"s"}`};
    }
    if(!pending)return {seconds:0,lowerSeconds:0,upperSeconds:0,confidence:"high",basis:"Queue completed"};
    const historical=(this.db.prepare("SELECT source_id,provider,duration_ms FROM discovery_attempts WHERE duration_ms>0 AND started_at>=datetime('now','-30 days') ORDER BY started_at DESC LIMIT 3000").all() as any[]),byKey=new Map<string,number[]>();
    for(const item of historical){const key=`${item.source_id}|${item.provider??""}`,values=byKey.get(key)??[];values.push(Number(item.duration_ms));byKey.set(key,values);}
    const all=historical.map(item=>Number(item.duration_ms)).sort((a,b)=>a-b),quantile=(values:number[],fraction:number)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*fraction))]:0;};
    const queued=this.db.prepare("SELECT candidate_id,source_id,candidate_json FROM discovery_queue WHERE run_id=? AND status='pending' ORDER BY ordinal").all(row.id) as any[],activeRows=this.db.prepare("SELECT candidate_id,worker_id,started_at FROM discovery_run_tasks WHERE run_id=?").all(row.id) as any[],active=new Map(activeRows.map(task=>[task.candidate_id,{elapsed:Math.max(0,Date.now()-Date.parse(task.started_at)),worker:Number(String(task.worker_id).replace(/^worker-/,'')||1)-1}])),workItems:any[]=[];let modelled=0;
    for(const item of queued){const candidate=JSON.parse(item.candidate_json),values=byKey.get(`${item.source_id}|${candidate.provider??""}`)??all;if(values.length&&byKey.has(`${item.source_id}|${candidate.provider??""}`))modelled++;const running=active.get(item.candidate_id),elapsedActive=running?.elapsed??0;let host=String(candidate.sourceId??item.source_id);try{host=candidate.provider==="greenhouse"?"boards-api.greenhouse.io":candidate.provider==="lever"?(String(candidate.boardUrl).includes("jobs.eu.lever.co")?"api.eu.lever.co":"api.lever.co"):candidate.provider==="ashby"?"api.ashbyhq.com":candidate.boardUrl?new URL(candidate.apiUrl??candidate.boardUrl).hostname:host;}catch{/* Keep the source as its scheduling destination. */}workItems.push({host,hostLimit:candidate.provider==="workday"||candidate.provider==="ashby"?1:2,active:running,low:Math.max(250,(quantile(values,.25)||2000)-elapsedActive),median:Math.max(500,(quantile(values,.5)||5000)-elapsedActive),high:Math.max(1000,(quantile(values,.75)||15000)-elapsedActive)});}
    if(!historical.length&&processed>=4){const workerCount=Math.max(1,Number(row.worker_count??4)),rate=elapsed/processed,seconds=Math.round(rate*pending/workerCount/1000);return {seconds,lowerSeconds:Math.round(seconds*.7),upperSeconds:Math.round(seconds*1.5),confidence:"low",basis:"Current run completion rate"};}
    if(!historical.length)return {seconds:null,lowerSeconds:null,upperSeconds:null,confidence:"low",basis:"Collecting timing evidence"};
    const workers=Math.min(Math.max(1,Number(row.worker_count??4)),Math.max(1,pending)),scheduled=(key:"median"|"low"|"high")=>{const workerReady=Array(workers).fill(0),hostReady=new Map<string,number[]>();for(const item of workItems){const slots=hostReady.get(item.host)??Array(item.hostLimit).fill(0);hostReady.set(item.host,slots);if(item.active){const worker=Math.min(workers-1,Math.max(0,item.active.worker)),hostSlot=slots.indexOf(Math.min(...slots)),duration=item[key];workerReady[worker]=Math.max(workerReady[worker],duration);slots[hostSlot]=Math.max(slots[hostSlot],duration);}}const queuedWork=workItems.filter(item=>!item.active).sort((a,b)=>b[key]-a[key]);for(const item of queuedWork){const workerSlot=workerReady.indexOf(Math.min(...workerReady)),slots=hostReady.get(item.host)!,hostSlot=slots.indexOf(Math.min(...slots)),start=Math.max(workerReady[workerSlot],slots[hostSlot]),finish=start+item[key];workerReady[workerSlot]=finish;slots[hostSlot]=finish;}return Math.max(...workerReady);},seconds=Math.round(scheduled("median")/1000);return {seconds,lowerSeconds:Math.round(scheduled("low")/1000),upperSeconds:Math.max(seconds,Math.round(scheduled("high")/1000)),confidence:modelled>=Math.min(20,pending)?"high":modelled>=Math.min(5,pending)?"medium":"low",basis:`${modelled} queued candidates matched to ${workers} workers, source timings and per-host limits`};
  }
  private explainRun(row: any): any { const reasons: string[] = []; if (row.error_count) reasons.push(`${row.error_count} operational error${row.error_count === 1 ? "" : "s"}`); if (row.missing_board_count) reasons.push(`${row.missing_board_count} missing board${row.missing_board_count === 1 ? "" : "s"}`); if (row.partial_collection_count) reasons.push(`${row.partial_collection_count} partial board collection${row.partial_collection_count === 1 ? "" : "s"}`); const pending = Number((this.db.prepare("SELECT COUNT(*) count FROM discovery_queue WHERE run_id=? AND status='pending'").get(row.id) as any)?.count ?? 0),shortfall=row.shortfall_json?JSON.parse(row.shortfall_json):[]; if (pending) reasons.push(`${pending} pending candidate${pending === 1 ? "" : "s"}`); if(Number(row.unfilled_count??0)>0)reasons.push(`${row.unfilled_count} requested slot${row.unfilled_count===1?"":"s"} unfilled by selected sources`);if(row.time_budget_ms&&Number(row.metrics_version??1)<2)reasons.push("Legacy adaptive metrics: duplicate counts may include queue-position collisions"); const displayStatus = row.status === "completed" ? "Completed" : row.status === "partial" ? "Completed with issues" : row.status === "interrupted" ? "Interrupted — resumable" : row.status === "failed" ? "Failed" : "Running",policy=row.selection_policy??"legacy-auto-fallback",sourceExplanation=shortfall.map((item:any)=>`${item.label} returned ${item.returned}, skipped ${item.skippedRecent} recent, merged ${item.duplicates} duplicate${item.duplicates===1?"":"s"}, and queued ${item.queued}`).join("; "),completionSummary=row.status==="running"?null:row.time_budget_ms?`${row.time_budget_ms/60000} minutes · ${row.new_strong_count??0} new strong · ${row.useful_match_count??0} reward-eligible · ${Number(row.weighted_reward??0).toFixed(1)} weighted reward`:`Completed ${row.processed_count} of ${row.limit_count} requested${sourceExplanation?`: ${sourceExplanation}`:""}${Number(row.unfilled_count??0)>0&&policy!=="turbo-tiered"?"; no other sources were used":""}.`; return { ...row, plan:row.plan_json?JSON.parse(row.plan_json):null, plan_json:undefined, shortfall_json:undefined,shortfall,selection_policy:policy,selection_policy_label:policy==="adaptive-time"?"Adaptive time window":policy==="turbo-tiered"?"Turbo tiered selection":policy==="strict"?"Strict source selection":policy==="legacy-auto-fallback"?"Legacy automatic fallback":"Explicit single source",completion_summary:completionSummary,pending_count: pending, display_status: displayStatus, status_reasons: reasons }; }
  private runSourcesWithPlan(runId:string,plan:any):any[]{const metadata=new Map<string,any>((plan?.sources??[]).map((item:any)=>[item.id,item]));return (this.discoveryRunSources(runId) as any[]).map(row=>({...row,...(metadata.get(row.source_id)??{}),source_id:row.source_id}));}
  discoveryRuns(): unknown[] { return (this.db.prepare("SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT 100").all() as any[]).map(row => {const explained:any=this.explainRun(row);return {...explained,mode:row.mode??"balanced",phase:row.phase??(row.status==="running"?"processing":"completed"),eta:this.discoveryEta(row,explained.pending_count),sources:row.plan_json?this.runSourcesWithPlan(row.id,explained.plan):[]};}); }
  coverage(): unknown {
    const scalar = (sql: string) => Number((this.db.prepare(sql).get() as any).value);
    return { employers: scalar("SELECT COUNT(*) value FROM employers"), hiringEmployers: scalar("SELECT COUNT(*) value FROM employers WHERE active_nl_vacancies>0"), matchingVacancies: scalar("SELECT COUNT(*) value FROM vacancy_observations WHERE matched_profile=1"), nonmatchingVacancies: scalar("SELECT COUNT(*) value FROM vacancy_observations WHERE matched_profile=0"), byHeadquarters: this.db.prepare("SELECT headquarters,COUNT(*) count FROM employers GROUP BY headquarters").all(), bySizeConfidence: this.db.prepare("SELECT size_confidence confidence,COUNT(*) count FROM employers GROUP BY size_confidence").all(), byBoardStatus: this.db.prepare("SELECT status,COUNT(*) count FROM employer_boards GROUP BY status").all(), byProvider: this.db.prepare("SELECT COALESCE(provider,'unsupported') provider,COUNT(*) count FROM employer_boards GROUP BY provider").all(), attemptsByResult: this.db.prepare("SELECT result,COUNT(*) count FROM discovery_attempts GROUP BY result ORDER BY count DESC").all(), currentCandidateHealth: this.db.prepare("SELECT latest_result result,COUNT(*) count FROM discovery_candidate_health GROUP BY latest_result ORDER BY count DESC").all(), failuresByReason: this.db.prepare("SELECT latest_result result,COUNT(*) count FROM discovery_candidate_health WHERE retryable=1 OR latest_result IN ('parse-error','invalid-record') GROUP BY latest_result ORDER BY count DESC").all(), sourceQualityFindings: this.db.prepare("SELECT latest_result result,COUNT(*) count FROM discovery_candidate_health WHERE latest_result='board-not-found' GROUP BY latest_result").all(), failuresBySource: this.db.prepare("SELECT source_id sourceId,latest_result result,COUNT(*) count FROM discovery_candidate_health WHERE retryable=1 OR latest_result IN ('parse-error','invalid-record') GROUP BY source_id,latest_result ORDER BY count DESC").all(), sources: this.db.prepare("SELECT id,cursor,total_items totalItems,processed_total processedTotal,last_success_at lastSuccessAt,last_error lastError,CASE WHEN total_items>0 THEN ROUND(cursor*100.0/total_items,1) ELSE 0 END cyclePercent FROM discovery_sources ORDER BY id").all() };
  }
  sourcePerformance(type: "discovery"|"provider", window: "30d"|"lifetime" = "30d"): unknown {
    const attemptWhere = window === "30d" ? "AND da.started_at>=datetime('now','-30 days')" : "";
    const jobWhere = window === "30d" ? "AND j.last_seen_at>=datetime('now','-30 days')" : "";
    if (type === "discovery") return { type, window, items: this.db.prepare(`WITH ids AS (SELECT id FROM discovery_sources UNION SELECT DISTINCT source_id id FROM discovery_attempts), metrics AS (
      SELECT ids.id,COUNT(da.id) attempts,SUM(CASE WHEN da.result NOT IN ('timeout','rate-limited','network-error','parse-error','invalid-record') THEN 1 ELSE 0 END) reliable_attempts,
      SUM(CASE WHEN da.result NOT IN ('board-not-found','invalid-record') THEN 1 ELSE 0 END) valid_records,SUM(CASE WHEN da.netherlands_jobs>0 THEN 1 ELSE 0 END) nl_candidates,
      COALESCE(SUM(da.netherlands_jobs),0) nl_vacancies,COALESCE(SUM(da.profile_matches),0) profile_matches,COALESCE(AVG(COALESCE(da.collection_duration_ms,da.duration_ms)),0) avg_duration_ms,
      SUM(CASE WHEN da.result IN ('timeout','rate-limited','network-error','parse-error','invalid-record') THEN 1 ELSE 0 END) operational_failures,
      SUM(CASE WHEN da.result='board-not-found' THEN 1 ELSE 0 END) missing_boards
      FROM ids LEFT JOIN discovery_attempts da ON da.source_id=ids.id ${attemptWhere} GROUP BY ids.id)
      SELECT m.*,ds.label,ds.license,ds.kind,ds.cursor,ds.total_items,ds.processed_total,ds.last_success_at,ds.last_error,
      CASE WHEN ds.total_items>0 THEN ROUND(ds.cursor*100.0/ds.total_items,1) ELSE NULL END cycle_percent,
      CASE WHEN ds.total_items>ds.cursor AND m.attempts>0 THEN ROUND((ds.total_items-ds.cursor)/(m.attempts/30.0),1) ELSE NULL END estimated_cycle_days,
      (SELECT COUNT(DISTINCT a.employer_id) FROM employer_aliases a WHERE a.source_id=m.id) employers_contributed,
      (SELECT COUNT(*) FROM vacancy_observations v WHERE v.source_id=m.id ${window === "30d" ? "AND v.observed_at>=datetime('now','-30 days')" : ""}) vacancy_observations,
      (SELECT COUNT(*) FROM vacancy_observations v WHERE v.source_id=m.id ${window === "30d" ? "AND v.observed_at>=datetime('now','-30 days')" : ""} AND NOT EXISTS(SELECT 1 FROM vacancy_observations v2 WHERE v2.fingerprint=v.fingerprint AND v2.source_id<>v.source_id)) unique_vacancies,
      ROUND(100.0*(SELECT COUNT(*) FROM vacancy_observations v WHERE v.source_id=m.id ${window === "30d" ? "AND v.observed_at>=datetime('now','-30 days')" : ""} AND NOT EXISTS(SELECT 1 FROM vacancy_observations v2 WHERE v2.fingerprint=v.fingerprint AND v2.source_id<>v.source_id))/NULLIF(m.attempts,0),1) unique_per_100,
      CASE WHEN (SELECT COUNT(*) FROM discovery_attempts x WHERE x.source_id=m.id AND x.started_at>=datetime('now','-7 days'))<3 THEN 'insufficient data'
        WHEN (SELECT COALESCE(SUM(profile_matches),0)*1.0/COUNT(*) FROM discovery_attempts x WHERE x.source_id=m.id AND x.started_at>=datetime('now','-7 days')) > 1.1*(SELECT COALESCE(SUM(profile_matches),0)*1.0/NULLIF(COUNT(*),0) FROM discovery_attempts x WHERE x.source_id=m.id AND x.started_at>=datetime('now','-14 days') AND x.started_at<datetime('now','-7 days')) THEN 'rising'
        WHEN (SELECT COALESCE(SUM(profile_matches),0)*1.0/COUNT(*) FROM discovery_attempts x WHERE x.source_id=m.id AND x.started_at>=datetime('now','-7 days')) < 0.9*(SELECT COALESCE(SUM(profile_matches),0)*1.0/NULLIF(COUNT(*),0) FROM discovery_attempts x WHERE x.source_id=m.id AND x.started_at>=datetime('now','-14 days') AND x.started_at<datetime('now','-7 days')) THEN 'falling'
        ELSE 'stable' END marginal_yield_trend
      FROM metrics m LEFT JOIN discovery_sources ds ON ds.id=m.id ORDER BY nl_vacancies DESC,m.id`).all() };
    return { type, window, items: this.db.prepare(`WITH ids AS (SELECT DISTINCT COALESCE(provider,'unsupported') id FROM employer_boards UNION SELECT DISTINCT COALESCE(provider,'unsupported') FROM discovery_attempts), metrics AS (
      SELECT ids.id,COUNT(da.id) attempts,SUM(CASE WHEN da.result NOT IN ('timeout','rate-limited','network-error','parse-error','invalid-record') THEN 1 ELSE 0 END) reliable_attempts,
      COALESCE(SUM(da.jobs_fetched),0) fetched_vacancies,COALESCE(SUM(da.netherlands_jobs),0) nl_vacancies,COALESCE(SUM(da.profile_matches),0) profile_matches,
      COALESCE(AVG(COALESCE(da.collection_duration_ms,da.duration_ms)),0) avg_duration_ms,SUM(CASE WHEN da.result IN ('timeout','rate-limited','network-error','parse-error','invalid-record') THEN 1 ELSE 0 END) operational_failures
      FROM ids LEFT JOIN discovery_attempts da ON COALESCE(da.provider,'unsupported')=ids.id ${attemptWhere} GROUP BY ids.id)
      SELECT m.*,(SELECT COUNT(*) FROM employer_boards b WHERE COALESCE(b.provider,'unsupported')=m.id) boards,
      (SELECT COUNT(*) FROM employer_boards b WHERE COALESCE(b.provider,'unsupported')=m.id AND b.status='healthy') healthy_boards,
      (SELECT COUNT(*) FROM jobs j WHERE j.provider=m.id ${jobWhere}) stored_jobs,
      (SELECT ROUND(100.0*SUM(CASE WHEN LENGTH(COALESCE(j.description,''))>=160 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) FROM jobs j WHERE j.provider=m.id ${jobWhere}) description_percent,
      (SELECT ROUND(100.0*SUM(CASE WHEN j.posted_at IS NOT NULL THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) FROM jobs j WHERE j.provider=m.id ${jobWhere}) posted_date_percent,
      (SELECT ROUND(100.0*SUM(CASE WHEN j.external_id IS NOT NULL THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) FROM jobs j WHERE j.provider=m.id ${jobWhere}) external_id_percent,
      (SELECT ROUND(100.0*SUM(CASE WHEN j.apply_url IS NOT NULL OR j.canonical_url IS NOT NULL THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) FROM jobs j WHERE j.provider=m.id ${jobWhere}) url_percent
      FROM metrics m ORDER BY nl_vacancies DESC,m.id`).all() };
  }
  sourcePerformanceDetail(id: string, window: "30d"|"lifetime" = "30d"): unknown { const discovery=(this.sourcePerformance("discovery",window) as any).items.find((row:any)=>row.id===id), provider=(this.sourcePerformance("provider",window) as any).items.find((row:any)=>row.id===id); const where=window==="30d"?"AND started_at>=datetime('now','-30 days')":""; return { id,window,discovery,provider,activity:this.db.prepare(`SELECT substr(started_at,1,10) day,COUNT(*) attempts,SUM(netherlands_jobs) nlVacancies,SUM(profile_matches) matches,SUM(CASE WHEN result IN ('timeout','rate-limited','network-error','parse-error','invalid-record') THEN 1 ELSE 0 END) failures FROM discovery_attempts WHERE (source_id=? OR provider=?) ${where} GROUP BY day ORDER BY day`).all(id,id),attempts:this.db.prepare(`SELECT source_id,company,provider,board_url,result,started_at,duration_ms,jobs_fetched,netherlands_jobs,profile_matches,error_message FROM discovery_attempts WHERE (source_id=? OR provider=?) ${where} ORDER BY started_at DESC LIMIT 100`).all(id,id),employers:this.db.prepare("SELECT DISTINCT e.id,e.canonical_name,e.last_hiring_signal_at FROM employers e LEFT JOIN employer_aliases a ON a.employer_id=e.id LEFT JOIN employer_boards b ON b.employer_id=e.id WHERE a.source_id=? OR b.provider=? ORDER BY e.last_hiring_signal_at DESC LIMIT 100").all(id,id),jobs:this.db.prepare("SELECT id,company,title,location,overall_score,last_seen_at FROM jobs WHERE source_id=? OR provider=? ORDER BY last_seen_at DESC LIMIT 100").all(id,id) }; }
  coverageOverlap(window: "30d"|"lifetime" = "30d"): unknown {
    const timeFilter=window==="30d"?" AND datetime(observed_at)>=datetime('now','-30 days')":"";
    const sources=this.db.prepare(`SELECT source_id id,COUNT(DISTINCT fingerprint) totalVacancies FROM vacancy_observations WHERE 1=1${timeFilter} GROUP BY source_id ORDER BY source_id`).all() as any[];
    const totals=new Map(sources.map(row=>[String(row.id),Number(row.totalVacancies)]));
    const uniqueRows=this.db.prepare(`SELECT v.source_id id,COUNT(DISTINCT v.fingerprint) uniqueVacancies FROM vacancy_observations v WHERE 1=1${window==="30d"?" AND datetime(v.observed_at)>=datetime('now','-30 days')":""} AND NOT EXISTS(SELECT 1 FROM vacancy_observations other WHERE other.fingerprint=v.fingerprint AND other.source_id<>v.source_id${window==="30d"?" AND datetime(other.observed_at)>=datetime('now','-30 days')":""}) GROUP BY v.source_id`).all() as any[];
    const unique=new Map(uniqueRows.map(row=>[String(row.id),Number(row.uniqueVacancies)]));
    const pairs:any[]=[];
    for(let i=0;i<sources.length;i++)for(let j=i+1;j<sources.length;j++){
      const a=String(sources[i].id),b=String(sources[j].id);
      const row=this.db.prepare(`SELECT COUNT(DISTINCT va.fingerprint) intersection_count FROM vacancy_observations va JOIN vacancy_observations vb ON vb.fingerprint=va.fingerprint WHERE va.source_id=? AND vb.source_id=?${window==="30d"?" AND datetime(va.observed_at)>=datetime('now','-30 days') AND datetime(vb.observed_at)>=datetime('now','-30 days')":""}`).get(a,b) as any;
      const intersection=Number(row.intersection_count),union=(totals.get(a)??0)+(totals.get(b)??0)-intersection;
      pairs.push({sourceA:a,sourceB:b,intersection,sourceACount:totals.get(a)??0,sourceBCount:totals.get(b)??0,jaccard:union?Math.round(intersection*1000/union)/10:0});
    }
    const summaries=sources.map(source=>{
      const id=String(source.id),totalVacancies=totals.get(id)??0,uniqueVacancies=unique.get(id)??0;
      return {id,totalVacancies,uniqueVacancies,sharedVacancies:totalVacancies-uniqueVacancies,overlaps:pairs.filter(pair=>pair.intersection>0&&(pair.sourceA===id||pair.sourceB===id)).map(pair=>({sourceId:pair.sourceA===id?pair.sourceB:pair.sourceA,intersection:pair.intersection,jaccard:pair.jaccard})).sort((a,b)=>b.intersection-a.intersection||a.sourceId.localeCompare(b.sourceId))};
    });
    return {window,sources:sources.map(x=>x.id),summaries,pairs};
  }
  benchmarkCoverage(): unknown { const rows=this.db.prepare(`SELECT be.*,bm.employer_id,bm.match_method,bm.review_state,
      EXISTS(SELECT 1 FROM employer_boards b WHERE b.employer_id=bm.employer_id AND b.status='healthy' AND b.provider IS NOT NULL AND b.provider!='browser') board_discovered,
      EXISTS(SELECT 1 FROM employer_boards b WHERE b.employer_id=bm.employer_id AND b.last_checked_at>=datetime('now','-30 days')) checked_30d,
      EXISTS(SELECT 1 FROM vacancy_observations v WHERE v.employer_id=bm.employer_id AND v.observed_at>=datetime('now','-30 days')) hiring_signal_30d
      FROM benchmark_employers be JOIN benchmark_matches bm ON bm.panel_version=be.panel_version AND bm.benchmark_id=be.benchmark_id WHERE be.panel_version=? ORDER BY be.region,be.canonical_name`).all(BENCHMARK_VERSION) as any[];
    for(const row of rows){
      const collection=this.db.prepare('SELECT * FROM collection_checkpoints WHERE benchmark_id=? OR board_url IN (SELECT board_url FROM employer_boards WHERE employer_id=?) ORDER BY last_checked_at DESC LIMIT 1').get(row.benchmark_id,row.employer_id) as any;
      const attempt=this.db.prepare('SELECT * FROM benchmark_board_attempts WHERE benchmark_id=? ORDER BY attempted_at DESC LIMIT 1').get(row.benchmark_id) as any;
      const latest=this.db.prepare("SELECT started_at,result,error_message FROM discovery_attempts WHERE source_id='benchmark-employers' AND json_extract(candidate_json,'$.benchmarkId')=? ORDER BY started_at DESC LIMIT 1").get(row.benchmark_id) as any;
      row.attempted=Boolean(collection||attempt||latest);
      row.board_discovered=Boolean(row.board_discovered||collection?.jobs_collected>0||collection?.state==='complete');
      row.collectionState=collection?.state??'unknown';
      row.coverageState=collection?.state==='complete'?'completely-collected':collection?.state==='partial'?'partially-collected':collection?.state==='failed'?(collection.error?.includes('No public JobPosting')?'unsupported':'temporarily-failed'):latest&&['timeout','network-error','rate-limited','parse-error','board-not-found'].includes(latest.result)?'temporarily-failed':attempt?.result==='unsupported-or-not-found'||latest?.result==='unsupported'?'unsupported':row.board_discovered?'resolved':'unattempted';
      row.collectionError=collection?.error??latest?.error_message??attempt?.error_message??null;
      row.lastAttempt=collection?.last_checked_at??latest?.started_at??attempt?.attempted_at??null;
    } const summarize=(key:string)=>Object.values(rows.reduce((acc:any,row:any)=>{const value=row[key];acc[value]??={value,total:0,matched:0,checked:0,hiring:0};acc[value].total++;acc[value].matched+=row.board_discovered?1:0;acc[value].checked+=row.checked_30d?1:0;acc[value].hiring+=row.hiring_signal_30d?1:0;return acc},{})); return { attempted:rows.filter(r=>r.attempted).length,states:rows.reduce((acc:Record<string,number>,row:any)=>{acc[row.coverageState]=(acc[row.coverageState]??0)+1;return acc;},{}),version:BENCHMARK_VERSION,label:"Representative panel coverage — not total Dutch-market coverage",total:rows.length,matched:rows.filter(r=>r.board_discovered).length,checked30d:rows.filter(r=>r.checked_30d).length,hiringSignals30d:rows.filter(r=>r.hiring_signal_30d).length,needsReview:rows.filter(r=>r.review_state==="needs-review").length,byRegion:summarize("region"),bySector:summarize("sector"),bySize:summarize("size_band"),byOwnership:summarize("ownership"),items:rows}; }
  close(): void { this.db.close(); }
  syncSources(sources: SourceConfig[], resolver: (source: SourceConfig) => ProviderId): void {
    const statement = this.db.prepare(`INSERT INTO discovery_targets(id,company,careers_url,detected_provider,status,enabled)
      VALUES(?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET company=excluded.company,careers_url=excluded.careers_url,detected_provider=excluded.detected_provider,enabled=1`);
    for (const source of sources) statement.run(source.id, source.company, source.careersUrl, resolver(source), "ready");
  }
  startRun(id: string, provider?: string): void {
    this.db.prepare("INSERT INTO scan_runs(id,started_at,status,requested_provider) VALUES(?,?,?,?)").run(id, new Date().toISOString(), "running", provider ?? null);
  }
  updateRun(id: string, fields: { checkpoint: string[]; found: number; accepted: number; duplicates: number; errors: number }): void {
    this.db.prepare("UPDATE scan_runs SET checkpoint_json=?,found_count=?,accepted_count=?,duplicate_count=?,error_count=? WHERE id=?")
      .run(JSON.stringify(fields.checkpoint), fields.found, fields.accepted, fields.duplicates, fields.errors, id);
  }
  finishRun(id: string, status: "completed" | "partial" | "failed"): void {
    this.db.prepare("UPDATE scan_runs SET finished_at=?,status=? WHERE id=?").run(new Date().toISOString(), status, id);
  }
  incompleteRun(provider?: string): { id: string; checkpoint: string[] } | null {
    const row = this.db.prepare("SELECT id,checkpoint_json FROM scan_runs WHERE status IN ('running','partial') AND COALESCE(requested_provider,'')=COALESCE(?, '') ORDER BY started_at DESC LIMIT 1").get(provider ?? null) as any;
    return row ? { id: row.id, checkpoint: JSON.parse(row.checkpoint_json) } : null;
  }
  markSource(source: SourceConfig, provider: ProviderId, error?: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE discovery_targets SET status=?,last_attempt_at=?,failure_reason=? WHERE id=?").run(error ? "error" : "supported", now, error ?? null, source.id);
    this.db.prepare(`INSERT INTO providers(id,experimental,last_success_at,last_error_at,last_error) VALUES(?,0,?,?,?)
      ON CONFLICT(id) DO UPDATE SET last_success_at=COALESCE(excluded.last_success_at,providers.last_success_at),last_error_at=COALESCE(excluded.last_error_at,providers.last_error_at),last_error=excluded.last_error`)
      .run(provider, error ? null : now, error ? now : null, error ?? null);
  }
  recordFailure(scanId: string, sourceId: string, provider: ProviderId, error: unknown): void {
    const value = error instanceof Error ? error : new Error(String(error));
    this.db.prepare("INSERT INTO failure_events(scan_id,source_id,provider,occurred_at,error_type,message) VALUES(?,?,?,?,?,?)")
      .run(scanId, sourceId, provider, new Date().toISOString(), value.name, value.message.slice(0, 2000));
  }
  upsertJob(job: JobPosting, fingerprint: string, scanId: string, provenance?: { discoveryRunId?: string; candidateId?: string; boardUrl?: string }): "new" | "refreshed" {
    // A provider ID, fingerprint and canonical URL can temporarily point at
    // different historical rows (for example after a source changes from a
    // careers-site URL to its underlying ATS URL). The canonical URL has a
    // UNIQUE index, so its current owner must win. An unordered OR ... LIMIT 1
    // can pick the ID owner instead and then fail while assigning the URL.
    const existing = (this.db.prepare("SELECT id,first_seen_at FROM jobs WHERE canonical_url=? LIMIT 1").get(job.canonicalUrl)
      ?? this.db.prepare("SELECT id,first_seen_at FROM jobs WHERE fingerprint=? LIMIT 1").get(fingerprint)
      ?? this.db.prepare("SELECT id,first_seen_at FROM jobs WHERE id=? LIMIT 1").get(job.id)) as any;
    const id = existing?.id ?? job.id;
    this.db.prepare(`INSERT INTO jobs(id,provider,source_id,external_id,company,title,location,description,summary,canonical_url,apply_url,posted_at,provider_first_observed_at,work_arrangement,role_family,match_evidence_json,first_seen_at,last_seen_at,status,missed_scans,fingerprint,raw_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,source_id=excluded.source_id,external_id=COALESCE(excluded.external_id,jobs.external_id),company=excluded.company,title=excluded.title,location=excluded.location,description=COALESCE(excluded.description,jobs.description),summary=COALESCE(excluded.summary,jobs.summary),canonical_url=excluded.canonical_url,apply_url=COALESCE(excluded.apply_url,jobs.apply_url),posted_at=COALESCE(excluded.posted_at,jobs.posted_at),provider_first_observed_at=COALESCE(excluded.provider_first_observed_at,jobs.provider_first_observed_at),work_arrangement=excluded.work_arrangement,role_family=excluded.role_family,match_evidence_json=excluded.match_evidence_json,last_seen_at=excluded.last_seen_at,status='active',missed_scans=0,raw_json=excluded.raw_json`)
      .run(id, job.provider, job.sourceId, job.externalId ?? null, job.company, job.title, job.location, job.description ?? null, job.summary ?? null, job.canonicalUrl, job.applyUrl ?? null, job.postedAt ?? null, job.firstObservedAt ?? null, job.workArrangement, job.roleFamily, JSON.stringify(job.matchEvidence ?? null), existing?.first_seen_at ?? job.firstSeenAt, job.lastSeenAt, "active", fingerprint, JSON.stringify(job.raw));
    this.db.prepare("INSERT OR IGNORE INTO source_observations(job_id,scan_id,source_id,provider,observed_url,observed_at) VALUES(?,?,?,?,?,?)")
      .run(id, scanId, job.sourceId, job.provider, job.url, job.lastSeenAt);
    this.db.prepare("UPDATE source_observations SET discovery_run_id=COALESCE(discovery_run_id,?),candidate_id=COALESCE(candidate_id,?),board_url=COALESCE(board_url,?),external_id=COALESCE(external_id,?) WHERE job_id=? AND scan_id=? AND source_id=? AND observed_url=?")
      .run(provenance?.discoveryRunId ?? null, provenance?.candidateId ?? null, provenance?.boardUrl ?? null, job.externalId ?? null, id, scanId, job.sourceId, job.url);
    if (job.postedAt) this.db.prepare("UPDATE jobs SET posted_at_source=COALESCE(posted_at_source,'provider'),posted_date_precision=CASE WHEN ? LIKE '%T%' THEN 'time' ELSE 'day' END WHERE id=?").run(job.postedAt, id);
    if (job.validThrough) this.db.prepare('UPDATE jobs SET valid_through=? WHERE id=?').run(job.validThrough,id);
    this.db.prepare("UPDATE jobs SET valid_through=COALESCE(valid_through,json_extract(raw_json,'$.validThrough'),json_extract(raw_json,'$.valid_through')) WHERE id=?").run(id);
    return existing ? "refreshed" : "new";
  }
  ageUnseenBoard(board:string,started:string,threshold:number):void {
    this.db.prepare("UPDATE jobs SET missed_scans=missed_scans+1,status=CASE WHEN missed_scans+1>=? THEN 'expired' ELSE 'uncertain' END WHERE last_seen_at<? AND id IN (SELECT job_id FROM source_observations WHERE board_url=?)").run(threshold,started,board);
  }
  ageUnseen(sourceId: string, scanStartedAt: string, threshold: number): void {
    this.db.prepare(`UPDATE jobs SET missed_scans=missed_scans+1,status=CASE WHEN missed_scans+1>=? THEN 'expired' ELSE 'uncertain' END
      WHERE source_id=? AND last_seen_at<?`).run(threshold, sourceId, scanStartedAt);
  }
  updateJobQuality(id: string, values: { description?: string; enrichmentStatus?: string; enrichmentError?: string; ruleScore: number; overallScore: number; breakdown: ScoreLedger; scoringVersion: string; profileFingerprint: string; seniority: string; workArrangement?: string; locationAccess: LocationAccessAssessment }): void {
    const now = values.breakdown.calculatedAt ?? new Date().toISOString();
    this.db.prepare(`UPDATE jobs SET description=COALESCE(?,description),enrichment_status=?,enrichment_error=?,enriched_at=?,rule_score=?,overall_score=?,score_breakdown_json=?,scoring_version=?,profile_fingerprint=?,seniority=?,work_arrangement=COALESCE(?,work_arrangement),hard_excluded=?,exclusion_reason=?,score_calculated_at=?,location_access_tier=?,location_access_json=? WHERE id=?`)
      .run(values.description ?? null, values.enrichmentStatus ?? "not-needed", values.enrichmentError ?? null, new Date().toISOString(), values.ruleScore, values.overallScore, JSON.stringify(values.breakdown), values.scoringVersion, values.profileFingerprint, values.seniority, values.workArrangement ?? null, values.breakdown.hardExcluded ? 1 : 0, values.breakdown.exclusionReason ?? null, now, values.locationAccess.tier, JSON.stringify(values.locationAccess), id);
    this.db.prepare("INSERT INTO job_score_events(job_id,calculated_at,scoring_version,profile_fingerprint,rule_score,ai_score,overall_score,ledger_json) VALUES(?,?,?,?,?,?,?,?)").run(id, now, values.scoringVersion, values.profileFingerprint, values.ruleScore, values.breakdown.aiScore ?? null, values.overallScore, JSON.stringify(values.breakdown));
  }
  backfillLocationAccess(profile: import('./types.js').ProfileConfig, limit=500): number {
    const rows=this.db.prepare("SELECT id,location,work_arrangement,raw_json FROM jobs WHERE location_access_tier IS NULL LIMIT ?").all(Math.min(Math.max(limit,1),5000)) as any[];
    if(!rows.length)return 0;
    const update=this.db.prepare("UPDATE jobs SET location_access_tier=?,location_access_json=? WHERE id=?");
    return this.transaction(()=>{for(const row of rows){let raw={};try{raw=JSON.parse(row.raw_json??'{}')}catch{}const access=classifyLocationAccess({location:row.location??'',workArrangement:row.work_arrangement??'unknown',raw},profile);update.run(access.tier,JSON.stringify(access),row.id);}return rows.length;});
  }
  recordEnrichment(id: string, status: string, sourceUrl: string, error?: string, durationMs?:number): void { this.db.prepare("INSERT INTO job_enrichment_events(job_id,occurred_at,status,source_url,error_message,duration_ms) VALUES(?,?,?,?,?,?)").run(id, new Date().toISOString(), status, sourceUrl, error?.slice(0,500) ?? null,durationMs??null); }
  queueEnrichment(id: string, job: unknown, candidate: DiscoveryCandidate, employerId: string | undefined, runId: string): void { const now=new Date().toISOString(); this.db.prepare(`INSERT INTO enrichment_queue(id,job_json,candidate_json,employer_id,discovery_run_id,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?) ON CONFLICT(id) DO UPDATE SET job_json=excluded.job_json,candidate_json=excluded.candidate_json,employer_id=COALESCE(excluded.employer_id,enrichment_queue.employer_id),updated_at=excluded.updated_at WHERE enrichment_queue.status!='complete'`).run(id,JSON.stringify(job),JSON.stringify(candidate),employerId??null,runId,now,now); }
  pendingEnrichments(limit=100): any[] { return this.db.prepare("SELECT * FROM enrichment_queue WHERE status IN ('pending','failed') AND attempts<4 AND (next_retry_at IS NULL OR next_retry_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) ORDER BY created_at LIMIT ?").all(Math.min(Math.max(limit,1),500)) as any[]; }
  finishQueuedEnrichment(id:string,status:"complete"|"failed"|"skipped"|"terminal",error?:string,retryAfterMs?:number):void {
    const row=this.db.prepare('SELECT attempts FROM enrichment_queue WHERE id=?').get(id) as any;
    const attempts=Number(row?.attempts??0)+1, delay=retryAfterMs??[900000,3600000,21600000,86400000][Math.min(attempts-1,3)];
    const finalStatus=status==='failed'&&attempts>=4?'terminal':status;
    this.db.prepare('UPDATE enrichment_queue SET status=?,attempts=?,last_error=?,updated_at=?,next_retry_at=?,retry_after_ms=? WHERE id=?').run(finalStatus,attempts,error?.slice(0,500)??null,new Date().toISOString(),finalStatus==='failed'?new Date(Date.now()+delay).toISOString():null,retryAfterMs??null,id);
  }
  retryEnrichment(id:string):void { this.db.prepare("UPDATE enrichment_queue SET status='pending',attempts=0,next_retry_at=NULL WHERE id=? AND status!='complete'").run(id); }
  enrichmentQueueCounts():unknown { return this.db.prepare("SELECT status,COUNT(*) count FROM enrichment_queue GROUP BY status ORDER BY status").all(); }
  updateRecallCheckpoint(id:string,counts:{descriptionCandidates:number;enrichedJobs:number;deferredEnrichments:number;descriptionMatches:number;enrichmentFailures:number;newJobs:number;refreshedJobs:number;fetched:number}):void {
    this.db.prepare('UPDATE discovery_runs SET description_candidate_count=?,enriched_job_count=?,deferred_enrichment_count=?,description_match_count=?,enrichment_failure_count=?,new_jobs=?,refreshed_jobs=?,fetched_jobs=? WHERE id=?').run(counts.descriptionCandidates,counts.enrichedJobs,counts.deferredEnrichments,counts.descriptionMatches,counts.enrichmentFailures,counts.newJobs,counts.refreshedJobs,counts.fetched,id);
  }
  jobIdFor(id: string, canonicalUrl: string, print: string): string {
    const row = this.db.prepare("SELECT id FROM jobs WHERE canonical_url=? LIMIT 1").get(canonicalUrl)
      ?? this.db.prepare("SELECT id FROM jobs WHERE fingerprint=? LIMIT 1").get(print)
      ?? this.db.prepare("SELECT id FROM jobs WHERE id=? LIMIT 1").get(id);
    return String((row as any)?.id ?? id);
  }
  updateAiScore(id: string, score: number, overall: number): void { const row = this.db.prepare("SELECT score_breakdown_json,scoring_version,profile_fingerprint,rule_score FROM jobs WHERE id=?").get(id) as any; const ledger = row?.score_breakdown_json ? JSON.parse(row.score_breakdown_json) : {}; ledger.aiScore = score; ledger.overallScore = overall; ledger.formula = `70% rules (${row?.rule_score ?? 0}) + 30% AI (${score}) = ${overall}`; this.db.prepare("UPDATE jobs SET ai_score=?,overall_score=?,score_breakdown_json=? WHERE id=?").run(score, overall, JSON.stringify(ledger), id); if (row) this.db.prepare("INSERT INTO job_score_events(job_id,calculated_at,scoring_version,profile_fingerprint,rule_score,ai_score,overall_score,ledger_json) VALUES(?,?,?,?,?,?,?,?)").run(id, new Date().toISOString(), row.scoring_version ?? "2", row.profile_fingerprint ?? "unknown", row.rule_score ?? 0, score, overall, JSON.stringify(ledger)); }
  aiCache(key: string): unknown { const row = this.db.prepare("SELECT assessment_json FROM ai_score_cache WHERE cache_key=?").get(key) as any; return row ? JSON.parse(row.assessment_json) : undefined; }
  saveAiCache(key: string, jobId: string, model: string, value: unknown): void { this.db.prepare("INSERT OR REPLACE INTO ai_score_cache(cache_key,job_id,model,assessment_json,created_at) VALUES(?,?,?,?,?)").run(key, jobId, model, JSON.stringify(value), new Date().toISOString()); }
  updateReviewState(id: string, state: ReviewState): void { this.db.prepare("UPDATE jobs SET review_state=? WHERE id=?").run(state, id); }
  upsertApplication(jobId: string, input: { stage?: ApplicationStage; notes?: string | null; appliedAt?: string | null; nextFollowUpAt?: string | null; transitionNote?: string }): ApplicationRecord {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM applications WHERE job_id=?").get(jobId) as any;
      const stage = input.stage ?? existing?.stage;
      if (!stage) throw new Error("Application stage is required");
      const now = new Date().toISOString();
      const submittedStages = new Set<ApplicationStage>(["applied", "screening", "interview", "assessment", "offer", "hired"]);
      const closedAfterSubmission = (["rejected", "withdrawn"] as ApplicationStage[]).includes(stage) && existing && !["saved", "preparing"].includes(existing.stage);
      const appliedAt = input.appliedAt === undefined
        ? (existing?.applied_at ?? (submittedStages.has(stage) || closedAfterSubmission ? now : null))
        : input.appliedAt;
      this.db.prepare(`INSERT INTO applications(job_id,stage,notes,applied_at,next_follow_up_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(job_id) DO UPDATE SET stage=excluded.stage,notes=excluded.notes,applied_at=excluded.applied_at,next_follow_up_at=excluded.next_follow_up_at,updated_at=excluded.updated_at`)
        .run(jobId, stage, input.notes === undefined ? existing?.notes ?? null : input.notes, appliedAt, input.nextFollowUpAt === undefined ? existing?.next_follow_up_at ?? null : input.nextFollowUpAt, existing?.created_at ?? now, now);
      if (!existing || existing.stage !== stage) this.db.prepare("INSERT INTO application_transitions(job_id,from_stage,to_stage,occurred_at,note) VALUES(?,?,?,?,?)").run(jobId, existing?.stage ?? null, stage, now, input.transitionNote ?? null);
      this.db.prepare("UPDATE jobs SET review_state='reviewed' WHERE id=?").run(jobId);
      const row = this.db.prepare("SELECT * FROM applications WHERE job_id=?").get(jobId) as any;
      return { jobId, stage: row.stage, notes: row.notes, appliedAt: row.applied_at, nextFollowUpAt: row.next_follow_up_at, createdAt: row.created_at, updatedAt: row.updated_at };
    });
  }
  applications(): unknown[] { return this.db.prepare(`SELECT a.job_id,a.stage,a.notes,a.applied_at,a.next_follow_up_at,a.created_at,a.updated_at record_updated_at,COALESCE((SELECT MAX(t.occurred_at) FROM application_transitions t WHERE t.job_id=a.job_id),a.updated_at) updated_at,COALESCE((SELECT MAX(t.occurred_at) FROM application_transitions t WHERE t.job_id=a.job_id),a.updated_at) stage_changed_at,j.company,j.title,j.location,j.overall_score,j.canonical_url,j.apply_url,j.status,j.review_state,(SELECT COUNT(*) FROM application_documents d WHERE d.job_id=a.job_id) document_count FROM applications a JOIN jobs j ON j.id=a.job_id ORDER BY CASE a.stage WHEN 'offer' THEN 1 WHEN 'interview' THEN 2 WHEN 'assessment' THEN 3 WHEN 'screening' THEN 4 WHEN 'applied' THEN 5 ELSE 6 END,stage_changed_at DESC`).all(); }
  applicationHistory(jobId: string): unknown[] { return this.db.prepare("SELECT * FROM application_transitions WHERE job_id=? ORDER BY occurred_at DESC").all(jobId); }
  applicationDocuments(jobId: string): unknown[] { return this.db.prepare("SELECT id,job_id,category,label,original_name,mime_type,size_bytes,checksum,submission_date,replaces_id,created_at FROM application_documents WHERE job_id=? ORDER BY created_at DESC").all(jobId); }
  applicationDocument(id: string): any { return this.db.prepare("SELECT * FROM application_documents WHERE id=?").get(id); }
  addApplicationDocument(value: { id:string; jobId:string; category:string; label?:string; originalName:string; storedName:string; mimeType:string; sizeBytes:number; checksum:string; relativePath:string; submissionDate?:string; replacesId?:string }): unknown { const now=new Date().toISOString(); this.db.prepare("INSERT INTO application_documents(id,job_id,category,label,original_name,stored_name,mime_type,size_bytes,checksum,relative_path,submission_date,replaces_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(value.id,value.jobId,value.category,value.label??null,value.originalName,value.storedName,value.mimeType,value.sizeBytes,value.checksum,value.relativePath,value.submissionDate??null,value.replacesId??null,now); return this.applicationDocument(value.id); }
  deleteApplicationDocument(id: string): any { const row=this.applicationDocument(id); if(row)this.db.prepare("DELETE FROM application_documents WHERE id=?").run(id); return row; }
  private jobFilter(query: JobQuery): { clauses: string[]; params: any[] } {
    const clauses: string[] = [], params: any[] = [];
    const like = (column: string, value?: string) => { if (value) { clauses.push(`LOWER(${column}) LIKE ?`); params.push(`%${value.toLowerCase()}%`); } };
    like("company", query.company); like("location", query.location);
    if (query.locationAccess) { clauses.push("location_access_tier=?"); params.push(query.locationAccess); }
    if (query.roleFamily) { clauses.push("role_family=?"); params.push(query.roleFamily); }
    if (query.provider) { clauses.push("provider=?"); params.push(query.provider); }
    if (query.status) { clauses.push("status=?"); params.push(query.status); }
    if (query.remote) { clauses.push("work_arrangement=?"); params.push(query.remote); }
    if (query.from) { clauses.push("last_seen_at>=?"); params.push(query.from); }
    if (query.to) { clauses.push("last_seen_at<=?"); params.push(query.to); }
    if (query.q) { clauses.push("(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(company) LIKE ?)"); params.push(...Array(3).fill(`%${query.q.toLowerCase()}%`)); }
    if (query.minScore !== undefined) { clauses.push("COALESCE(overall_score,0)>=?"); params.push(Math.max(1, query.minScore)); }
    const reviews=query.reviewStates?.length?query.reviewStates:query.reviewState?[query.reviewState]:[];
    if (reviews.length) { clauses.push(`review_state IN (${reviews.map(()=>"?").join(",")})`); params.push(...reviews); }
    const stages=query.applicationStages?.length?query.applicationStages:query.applicationStage?[query.applicationStage]:[];
    if (stages.length) { clauses.push(`EXISTS(SELECT 1 FROM applications a WHERE a.job_id=jobs.id AND a.stage IN (${stages.map(()=>"?").join(",")}))`); params.push(...stages); }
    if (query.seniority) { clauses.push("seniority=?"); params.push(query.seniority); }
    if (query.matchState && query.matchState !== "all") { clauses.push("match_state=?"); params.push(query.matchState); }
    if (query.eligibility === "eligible" || (query.eligibility === undefined && (!query.matchState || ["strong","possible"].includes(query.matchState)))) clauses.push("hard_excluded=0");
    else if (query.eligibility === "excluded") clauses.push("hard_excluded=1");
    if (query.sourceId) { clauses.push("source_id=?"); params.push(query.sourceId); }
    if (query.postedFrom) { clauses.push("posted_at>=?"); params.push(query.postedFrom); }
    if (query.postedTo) { clauses.push("posted_at<=?"); params.push(query.postedTo); }
    if (query.firstSeenFrom) { clauses.push("first_seen_at>=?"); params.push(query.firstSeenFrom); }
    if (query.firstSeenTo) { clauses.push("first_seen_at<=?"); params.push(query.firstSeenTo); }
    if (query.postedAvailable !== undefined) clauses.push(query.postedAvailable ? "posted_at IS NOT NULL" : "posted_at IS NULL");
    return { clauses, params };
  }
  jobs(query: JobQuery = {}): unknown[] {
    const { clauses, params } = this.jobFilter(query);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 5000), offset = Math.max(query.offset ?? 0, 0);
    const order = query.sort === "posted" ? "posted_at IS NULL,posted_at DESC" : query.sort === "firstSeen" ? "first_seen_at DESC" : query.sort === "company" ? "company,title" : query.sort === "scoreAsc" ? "COALESCE(overall_score,0),first_seen_at DESC" : "CASE match_state WHEN 'strong' THEN 0 WHEN 'possible' THEN 1 ELSE 2 END,COALESCE(overall_score,0) DESC,COALESCE(posted_at,first_seen_at) DESC";
    return this.db.prepare(`SELECT jobs.*, (SELECT stage FROM applications a WHERE a.job_id=jobs.id) application_stage FROM jobs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  }
  jobCount(query: JobQuery = {}): number { const { clauses, params } = this.jobFilter(query); return Number((this.db.prepare(`SELECT COUNT(*) count FROM jobs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`).get(...params) as any).count); }
  job(id: string): unknown { const row = this.db.prepare("SELECT jobs.*, (SELECT stage FROM applications a WHERE a.job_id=jobs.id) application_stage FROM jobs WHERE id=?").get(id) as any; return row ? { ...row, matchState:row.match_state, uncertaintyReasons:JSON.parse(row.uncertainty_reasons_json??'[]'),collectionProvenance:this.db.prepare('SELECT source_id,provider,board_url,observed_at FROM source_observations WHERE job_id=? ORDER BY observed_at DESC').all(id), application: this.db.prepare("SELECT a.*,(SELECT MAX(t.occurred_at) FROM application_transitions t WHERE t.job_id=a.job_id) stage_changed_at FROM applications a WHERE job_id=?").get(id), transitions: this.applicationHistory(id), documents:this.applicationDocuments(id) } : undefined; }
  jobTrace(id: string): unknown {
    const job = this.job(id) as any; if (!job) return undefined;
    const dates = [
      { key: "posted", label: "Posted", value: job.posted_at ?? undefined, source: job.posted_at_source ?? "not supplied", precision: job.posted_at ? job.posted_date_precision : "unknown" },
      { key: "providerFirstObserved", label: "Provider first observed", value: job.provider_first_observed_at ?? undefined, source: job.provider_first_observed_at ? job.source_id : "not supplied", precision: job.provider_first_observed_at ? "time" : "unknown" },
      { key: "diegoFirstSeen", label: "Diego first seen", value: job.first_seen_at, source: "Diego Career Ops", precision: "time" },
      { key: "lastChecked", label: "Last checked", value: job.last_seen_at, source: "Diego Career Ops", precision: "time" },
      { key: "validThrough", label: "Valid through", value: job.valid_through ?? undefined, source: job.valid_through ? "provider payload" : "not supplied", precision: job.valid_through ? (String(job.valid_through).includes("T") ? "time" : "day") : "unknown" },
    ];
    const observations = this.db.prepare(`SELECT so.*,dr.status run_status,dr.started_at run_started_at,dr.finished_at run_finished_at,h.candidate_json,b.status board_status,b.failure_reason board_failure
      FROM source_observations so LEFT JOIN discovery_runs dr ON dr.id=so.discovery_run_id
      LEFT JOIN discovery_candidate_health h ON h.candidate_id=so.candidate_id
      LEFT JOIN employer_boards b ON b.board_url=so.board_url WHERE so.job_id=? ORDER BY so.observed_at`).all(id);
    return { job: { id: job.id, provider: job.provider, sourceId: job.source_id, externalId: job.external_id, fingerprint: job.fingerprint, canonicalUrl: job.canonical_url }, dates, score: job.score_breakdown_json ? JSON.parse(job.score_breakdown_json) : null, observations, enrichmentEvents: this.db.prepare("SELECT * FROM job_enrichment_events WHERE job_id=? ORDER BY occurred_at").all(id), scoreHistory: (this.db.prepare("SELECT calculated_at,scoring_version,profile_fingerprint,rule_score,ai_score,overall_score,ledger_json FROM job_score_events WHERE job_id=? ORDER BY calculated_at DESC LIMIT 20").all(id) as any[]).map(row => ({ ...row, ledger: JSON.parse(row.ledger_json), ledger_json: undefined })) };
  }
  sources(): unknown[] { return this.db.prepare("SELECT * FROM discovery_targets ORDER BY company").all(); }
  scans(): unknown[] { return this.db.prepare("SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 100").all(); }
  stats(): unknown {
    const scalar = (sql: string) => (this.db.prepare(sql).get() as any).value;
    return {
      total: scalar("SELECT COUNT(*) value FROM jobs"), active: scalar("SELECT COUNT(*) value FROM jobs WHERE status='active' AND hard_excluded=0"),
      eligibleActive: scalar("SELECT COUNT(*) value FROM jobs WHERE status='active' AND hard_excluded=0"), excluded: scalar("SELECT COUNT(*) value FROM jobs WHERE hard_excluded=1"),
      expired: scalar("SELECT COUNT(*) value FROM jobs WHERE status='expired'"), companies: scalar("SELECT COUNT(DISTINCT company) value FROM jobs"),
      byRole: this.db.prepare("SELECT role_family roleFamily,COUNT(*) count FROM jobs GROUP BY role_family ORDER BY count DESC").all(),
      byProvider: this.db.prepare("SELECT provider,COUNT(*) count FROM jobs GROUP BY provider ORDER BY count DESC").all(),
      sourceHealth: this.db.prepare("SELECT status,COUNT(*) count FROM discovery_targets GROUP BY status").all(),
      failures: scalar("SELECT COUNT(*) value FROM failure_events"),
      duplicates: scalar("SELECT COALESCE(SUM(duplicate_count),0) value FROM scan_runs"),
      newJobs: scalar("SELECT COUNT(*) value FROM jobs WHERE review_state='new' AND status='active' AND hard_excluded=0 AND COALESCE(overall_score,0)>0"),
      followUpsDue: scalar("SELECT COUNT(*) value FROM applications WHERE next_follow_up_at IS NOT NULL AND next_follow_up_at<=datetime('now')"),
      byStage: this.db.prepare("SELECT stage,COUNT(*) count FROM applications GROUP BY stage ORDER BY count DESC").all(),
      scoreDistribution: this.db.prepare("SELECT (COALESCE(overall_score,0)/10)*10 bucket,COUNT(*) count FROM jobs GROUP BY bucket ORDER BY bucket").all(),
    };
  }
  discoveryRun(id: string): unknown {
    const row=this.db.prepare("SELECT * FROM discovery_runs WHERE id=?").get(id) as any;if(!row)return undefined;
    const explained:any=this.explainRun(row),adaptive=Boolean(row.time_budget_ms),now=Date.now(),sources=adaptive?this.db.prepare(`SELECT p.source_id,MAX(p.label) label,COUNT(*) pulls,SUM(p.duration_ms) acquisition_ms,SUM(p.returned) returned_count,SUM(MAX(p.eligible-p.duplicates,0)) queued_count,SUM(p.duplicates) duplicate_count,SUM(p.failures) errors,
      (SELECT COUNT(*) FROM discovery_attempts a WHERE a.run_id=p.run_id AND a.source_id=p.source_id) processed_candidates,
      (SELECT COALESCE(SUM(a.jobs_fetched),0) FROM discovery_attempts a WHERE a.run_id=p.run_id AND a.source_id=p.source_id) jobs_fetched,
      (SELECT COALESCE(SUM(o.new_strong),0) FROM discovery_outcomes o WHERE o.run_id=p.run_id AND o.source_id=p.source_id) new_strong_count,
      (SELECT COUNT(*) FROM discovery_outcomes o WHERE o.run_id=p.run_id AND o.source_id=p.source_id AND o.new_strong=1 AND o.reward>0) useful_match_count,
      (SELECT COALESCE(SUM(o.reward),0) FROM discovery_outcomes o WHERE o.run_id=p.run_id AND o.source_id=p.source_id) weighted_reward
      FROM discovery_source_pulls p WHERE p.run_id=? GROUP BY p.run_id,p.source_id ORDER BY pulls DESC`).all(id):this.runSourcesWithPlan(id,explained.plan),pulls=(this.db.prepare("SELECT arm_id,source_id,label,started_at,duration_ms,returned,eligible,duplicates,failures,metadata_json FROM discovery_source_pulls WHERE run_id=? ORDER BY id DESC LIMIT 20").all(id) as any[]).map(pull=>({...pull,queued_unique:Math.max(0,Number(pull.eligible)-Number(pull.duplicates)),metadata:pull.metadata_json?JSON.parse(pull.metadata_json):null,metadata_json:undefined}));
    return {...explained,mode:row.mode??"balanced",phase:adaptive&&row.status==="running"&&row.deadline_at&&now>=Date.parse(row.deadline_at)?"draining":row.phase??(row.status==="running"?"processing":"completed"),eta:adaptive?{seconds:row.status==="running"?Math.max(0,Math.ceil((Date.parse(row.deadline_at)-now)/1000)):0,lowerSeconds:null,upperSeconds:null,confidence:"fixed",basis:"Selected processing time"}:this.discoveryEta(row,explained.pending_count),forecast:this.discoveryForecastSnapshot(id),sources,active_tasks:this.db.prepare("SELECT *,CAST((julianday('now')-julianday(stage_started_at))*86400000 AS INTEGER) stage_elapsed_ms FROM discovery_run_tasks WHERE run_id=? ORDER BY worker_id").all(id),attempts:this.db.prepare("SELECT source_id,company,provider,board_url,result,http_status,retryable,duration_ms,jobs_fetched,netherlands_jobs,profile_matches,error_message,started_at FROM discovery_attempts WHERE run_id=? ORDER BY id DESC LIMIT 20").all(id),adaptive:adaptive?{durationMinutes:Number(row.time_budget_ms)/60000,deadlineAt:row.deadline_at,drainDeadlineAt:row.drain_deadline_at,remainingSeconds:row.status==="running"?Math.max(0,Math.ceil((Date.parse(row.deadline_at)-now)/1000)):0,currentConcurrency:Number(row.current_concurrency??0),metricsVersion:Number(row.metrics_version??1),pulls}:undefined};
  }
  activeDiscoveryRun():unknown {this.recoverStaleDiscoveryRuns();const row=this.db.prepare("SELECT id FROM discovery_runs WHERE status='running' ORDER BY started_at DESC LIMIT 1").get() as any;return row?this.discoveryRun(row.id):null;}
  overview(): unknown {
    const list=(where:string)=>this.db.prepare(`SELECT jobs.*,(SELECT stage FROM applications a WHERE a.job_id=jobs.id) application_stage FROM jobs WHERE ${where} ORDER BY COALESCE(overall_score,0) DESC,COALESCE(posted_at,first_seen_at) DESC LIMIT 8`).all();
    const applications=this.applications() as any[];
    const needsReview=list("review_state='new' AND status='active' AND hard_excluded=0 AND NOT EXISTS(SELECT 1 FROM applications a WHERE a.job_id=jobs.id)");
    const saved=list("EXISTS(SELECT 1 FROM applications a WHERE a.job_id=jobs.id AND a.stage IN ('saved','preparing'))");
    const followUps=this.db.prepare(`SELECT jobs.*,(SELECT stage FROM applications a WHERE a.job_id=jobs.id) application_stage,(SELECT next_follow_up_at FROM applications a WHERE a.job_id=jobs.id) next_follow_up_at FROM jobs WHERE EXISTS(SELECT 1 FROM applications a WHERE a.job_id=jobs.id AND a.next_follow_up_at IS NOT NULL AND a.next_follow_up_at<=datetime('now') AND a.stage NOT IN ('hired','rejected','withdrawn')) ORDER BY next_follow_up_at LIMIT 8`).all();
    const recentlyApplied=this.db.prepare(`SELECT jobs.*,a.stage application_stage,a.applied_at,a.updated_at application_updated_at FROM applications a JOIN jobs ON jobs.id=a.job_id WHERE a.stage IN ('applied','screening','interview','assessment','offer') ORDER BY COALESCE(a.applied_at,a.updated_at) DESC LIMIT 8`).all();
    return { stats:{...(this.stats() as any),applications:applications.length,needsReview:(this.db.prepare("SELECT COUNT(*) value FROM jobs WHERE review_state='new' AND status='active' AND hard_excluded=0 AND NOT EXISTS(SELECT 1 FROM applications a WHERE a.job_id=jobs.id)").get() as any).value,savedPreparing:applications.filter(a=>['saved','preparing'].includes(a.stage)).length,recentlyApplied:applications.filter(a=>['applied','screening','interview','assessment','offer'].includes(a.stage)).length},sections:{needsReview,saved,followUps,recentlyApplied},recentJobs:needsReview,applications,recentRuns:this.discoveryRuns().slice(0,5) };
  }
}
