export type ProviderId =
  | "greenhouse" | "lever" | "ashby" | "workable" | "recruitee" | "personio"
  | "smartrecruiters" | "workday" | "icims" | "government" | "academictransfer" | "browser";

export type WorkArrangement = "onsite" | "hybrid" | "remote" | "unknown";
export type JobStatus = "active" | "uncertain" | "expired";
export type ReviewState = "new" | "reviewed" | "declined" | "archived";
export type ApplicationStage = "saved" | "preparing" | "applied" | "screening" | "interview" | "assessment" | "offer" | "hired" | "rejected" | "withdrawn";
export type EnrichmentStatus = "complete" | "unavailable" | "failed" | "not-needed";
export type LocationAccessTier = "easy" | "medium" | "hard" | "remote" | "unknown";
export type LocationTransportMode = "direct-train" | "train-transfer" | "bus" | "car-only";

export interface LocationAccessCityProfile {
  city: string;
  aliases?: string[];
  distanceKm: number;
  publicTransportMinutes?: number;
  mode: LocationTransportMode;
  source?: string;
  updatedAt?: string;
}

export interface LocationAccessibilityPreferences {
  easyMaxMinutes: number;
  mediumMaxMinutes: number;
  closeOverrideKm: number;
  modePenalties: { "direct-train": number; "train-transfer": number; bus: number };
  cityProfiles: LocationAccessCityProfile[];
}

export interface LocationAccessAssessment {
  tier: LocationAccessTier;
  matchedCity?: string;
  distanceKm?: number;
  publicTransportMinutes?: number;
  mode?: LocationTransportMode;
  penaltyMinutes?: number;
  effectiveMinutes?: number;
  confidence: "configured" | "unknown";
  explanation: string;
}

export interface SourceConfig {
  id: string;
  company: string;
  careersUrl: string;
  provider?: ProviderId;
  apiUrl?: string;
  cursor?: string;
  evidenceUrl?: string;
  verifiedAt?: string;
  enabled?: boolean;
  experimental?: boolean;
}

export interface RawJob {
  countryCode?: string;
  externalId?: string;
  company: string;
  title: string;
  location: string;
  description?: string;
  url: string;
  applyUrl?: string;
  postedAt?: string;
  firstObservedAt?: string;
  summary?: string;
  workArrangement?: WorkArrangement;
  structuredRoleTerms?: string[];
  validThrough?: string;
  raw: unknown;
}

export interface MatchEvidence {
  roleFamily: string;
  roleTerm: string;
  locationTerm: string;
  matchedFrom?: "title" | "description" | "structured";
  confidence?: "high" | "medium" | "low";
  technicalTerms?: string[];
  fieldsInspected?: string[];
  enrichmentState?: EnrichmentStatus;
}

export interface ScoreBreakdown {
  role: number; skills: number; seniority: number; location: number;
  workArrangement: number; language: number; freshness: number; penalties: number;
  matchedSkills: string[]; missingSkills: string[]; reasons: string[];
}

export interface ScoreComponent {
  key: "role" | "skills" | "seniority" | "location" | "workArrangement" | "language" | "freshness" | "penalties";
  label: string; awarded: number; maximum: number; rule: string;
  evidence: string[]; explanation: string;
}

export interface ScoreLedger {
  version: string; calculatedAt: string; ruleScore: number; aiScore?: number; overallScore: number;
  formula: string; hardExcluded: boolean; exclusionReason?: string; exclusionEvidence?: string;
  components: ScoreComponent[]; matchedSkills: string[]; missingSkills: string[];
}

export interface DateEvidence { key: "posted" | "providerFirstObserved" | "diegoFirstSeen" | "lastChecked" | "validThrough"; label: string; value?: string; source: string; precision: "time" | "day" | "unknown"; }

export interface JobPosting extends RawJob {
  matchState?: 'strong' | 'possible' | 'excluded';
  id: string;
  provider: ProviderId;
  sourceId: string;
  canonicalUrl: string;
  workArrangement: WorkArrangement;
  roleFamily: string;
  matchEvidence: MatchEvidence | null;
  firstSeenAt: string;
  lastSeenAt: string;
  status: JobStatus;
}

export interface FetchContext {
  fetchJson(url: string, init?: RequestInit): Promise<unknown>;
  fetchText(url: string, init?: RequestInit): Promise<string>;
}

export interface CollectionResult { jobs: RawJob[]; nextCursor?: string; complete: boolean; total?: number; error?: string; httpStatus?:number; retryable?:boolean; retryAfterMs?:number; }
export interface Provider {
  id: ProviderId;
  experimental?: boolean;
  detect(source: SourceConfig): boolean;
  fetch(source: SourceConfig, context: FetchContext): Promise<CollectionResult>;
  collect(source: SourceConfig, context: FetchContext): Promise<CollectionResult>;
}

export interface ProfileConfig {
  country: string;
  countryAliases: string[];
  remoteAliases: string[];
  roleFamilies: Record<string, string[]>;
  excludeTitleTerms: string[];
  expiryAfterMissedScans: number;
  preferredRoleFamilies?: string[];
  acceptableRoleFamilies?: string[];
  technicalEvidenceTerms?: Record<string, string[]>;
  descriptionRoleTerms?: Record<string, string[]>;
  broadCandidateTitleTerms?: string[];
  structuredRoleTerms?: Record<string, string[]>;
  minimumDescriptionTechnicalEvidence?: number;
  skills?: Array<{ term: string; weight: number }>;
  desiredSeniority?: string[];
  excludedSeniority?: string[];
  languages?: string[];
  preferredLocations?: string[];
  locationPenalties?: Record<string, number>;
  locationPreferences?: {
    anchor: { city: string; aliases?: string[]; latitude: number; longitude: number };
    stronglyPreferredCities: string[];
    nearbyCities: string[];
    distanceBandKm?: number;
    includeRestOfNetherlands?: boolean;
    foreignLocations?: "exclude";
    accessibility?: LocationAccessibilityPreferences;
  };
  preferredWorkArrangements?: WorkArrangement[];
  dealBreakers?: string[];
  negativeTerms?: string[];
}

export interface ApplicationRecord {
  jobId: string; stage: ApplicationStage; notes?: string; appliedAt?: string;
  nextFollowUpAt?: string; createdAt: string; updatedAt: string;
}

export type Headquarters = "netherlands" | "foreign" | "unknown";
export type SizeConfidence = "reported" | "estimated" | "unknown";
export type BoardStatus = "pending" | "healthy" | "failing" | "unsupported";

export interface Employer {
  id: string; canonicalName: string; domain?: string; headquarters: Headquarters;
  sizeBand?: string; sizeConfidence: SizeConfidence; sizeEvidence?: string;
  firstDiscoveredAt: string; lastDiscoveredAt: string; lastHiringSignalAt?: string;
  activeNlVacancies: number;
}

export interface EmployerBoard {
  id: string; employerId: string; provider?: ProviderId; boardUrl: string; apiUrl?: string;
  status: BoardStatus; confidence: number; lastCheckedAt?: string; failureReason?: string;
}

export interface DiscoveryCandidate {
  contributingSources?: string[];
  cursor?: string;
  searchArmId?: string;
  searchArmLabel?: string;
  sourceId: string; company: string; domain?: string; headquarters?: Headquarters;
  sizeBand?: string; sizeConfidence?: SizeConfidence; sizeEvidence?: string;
  boardUrl?: string; apiUrl?: string; provider?: ProviderId; jobs?: RawJob[];
  benchmarkId?: string;
  discoveryEvidence?: { method: string; queryOrUrl: string; resolvedUrl?: string; confidence: number; result: string; error?: string };
}

export interface DiscoverySourceArm { id:string; label:string; metadata?:Record<string,unknown>; }
export interface DiscoveryBatch { candidates:DiscoveryCandidate[]; nextCursor:number; total?:number; arm?:DiscoverySourceArm; exhaustedReason?:"all-arms-queried"|"cooling-down"|"no-results"; }

export interface DiscoverySource {
  id: string; label: string; license: string; kind: "board-directory" | "job-feed";
  experimental?: boolean;
  discover(context: FetchContext, cursor: number, limit: number): Promise<DiscoveryBatch>;
  listArms?():Promise<DiscoverySourceArm[]>;
  discoverArm?(context:FetchContext,arm:DiscoverySourceArm,limit:number):Promise<DiscoveryBatch>;
}

export type DiscoveryAttemptResult = "matched" | "no-netherlands-jobs" | "empty-board" | "unsupported" | "board-not-found" | "timeout" | "rate-limited" | "network-error" | "parse-error" | "invalid-record";

export interface DiscoveryAttempt {
  runId: string; sourceId: string; company: string; boardUrl?: string; provider?: ProviderId;
  startedAt: string; durationMs: number; result: DiscoveryAttemptResult; httpStatus?: number;
  retryable: boolean; errorMessage?: string; jobsFetched: number; netherlandsJobs: number;
  profileMatches: number; collectionPartial?: boolean; continuation?: string; candidate: DiscoveryCandidate;
  collectionDurationMs?: number;
}
