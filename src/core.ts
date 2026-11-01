import { createHash } from "node:crypto";
import type {
  MatchEvidence,
  ProfileConfig,
  RawJob,
  WorkArrangement,
} from "./types.js";
import { hardExclusion, hasTechnicalEvidence } from "./scoring.js";
import { assessLocation } from './locations.js';
import { phrase, jobSpecificText } from './text.js';

const trackingParams = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "source",
  "ref",
]);

export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (trackingParams.has(key.toLowerCase())) url.searchParams.delete(key);
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.searchParams.sort();
  return url.toString();
}

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function includesNormalizedTerm(value: string, term: string): boolean {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  return normalizedTerm.length <= 3
    ? value.split(" ").includes(normalizedTerm)
    : value.includes(normalizedTerm);
}

export function detectWorkArrangement(
  job: Pick<RawJob, "title" | "location" | "description">,
): WorkArrangement {
  const value = normalizeText(
    `${job.title} ${job.location} ${job.description ?? ""}`,
  );
  if (/\bhybrid\b|\bhybride\b/.test(value)) return "hybrid";
  if (/\bremote\b|\bthuiswerk/.test(value)) return "remote";
  if (/\bon site\b|\bonsite\b|\bop locatie\b/.test(value)) return "onsite";
  return "unknown";
}

export function matchJob(
  job: RawJob,
  profile: ProfileConfig,
): MatchEvidence | null {
  if (hardExclusion(job, profile)) return null;
  const title = normalizeText(job.title);
  if (
    profile.excludeTitleTerms.some((term) =>
      phrase(title, term),
    )
  )
    return null;
  let roleFamily = "",
    roleTerm = "";
  let matchedFrom: MatchEvidence["matchedFrom"] = "title";
  for (const [family, terms] of Object.entries(profile.roleFamilies)) {
    const hit = terms.find((term) => phrase(title, term));
    if (hit) {
      roleFamily = family;
      roleTerm = hit;
      break;
    }
  }
  if (!roleFamily && plausibleTitle(job, profile)) {
    const description = normalizeText(
      `${job.summary ?? ""} ${jobSpecificText(job.description ?? "")}`,
    );
    for (const [family, terms] of Object.entries(
      profile.descriptionRoleTerms ?? {},
    )) {
      const hit = terms.find((term) =>
        includesNormalizedTerm(description, term),
      );
      if (hit) {
        roleFamily = family;
        roleTerm = hit;
        matchedFrom = "description";
        break;
      }
    }
  }
  if (!roleFamily && plausibleTitle(job,profile) && job.structuredRoleTerms?.length) {
    const structured = normalizeText(job.structuredRoleTerms.join(" "));
    for (const [family, terms] of Object.entries(
      profile.structuredRoleTerms ?? {},
    )) {
      const hit = terms.find((term) =>
        includesNormalizedTerm(structured, term),
      );
      if (hit) {
        roleFamily = family;
        roleTerm = hit;
        matchedFrom = "structured";
        break;
      }
    }
  }
  if (!roleFamily) return null;
  if (
    (matchedFrom !== "title" || roleFamily === "research") &&
    !hasTechnicalEvidence(job, roleFamily, profile)
  )
    return null;
  const all = normalizeText(
    `${job.title} ${job.summary ?? ""} ${jobSpecificText(job.description ?? "")}`,
  );
  const technicalTerms = (
    profile.technicalEvidenceTerms?.[roleFamily] ?? []
  ).filter((term) => includesNormalizedTerm(all, term));
  if (
    matchedFrom !== "title" &&
    technicalTerms.length < (profile.minimumDescriptionTechnicalEvidence ?? 1)
  )
    return null;
  const location = assessLocation(job, profile);
  if(location.state !== 'netherlands') return null;
  const locationTerm = location.evidence[0] ?? 'Netherlands';
  return {
    roleFamily,
    roleTerm,
    locationTerm,
    matchedFrom,
    confidence:
      matchedFrom === "title"
        ? "high"
        : matchedFrom === "structured"
          ? "medium"
          : "low",
    technicalTerms,
    fieldsInspected: [
      "title",
      ...(job.summary ? ["summary"] : []),
      ...(job.description ? ["description"] : []),
      ...(job.structuredRoleTerms?.length ? ["structured metadata"] : []),
    ],
  };
}

export function isPlausibleRecallCandidate(
  job: RawJob,
  profile: ProfileConfig,
): boolean {
  if (hardExclusion(job, profile)) return false;
  return plausibleTitle(job, profile);
}

export function plausibleTitle(job: RawJob, profile: ProfileConfig): boolean {
  const value = normalizeText(`${job.title} ${(job.structuredRoleTerms ?? []).join(' ')}`);
  if (/\b(sales|account executive|marketing|recruiter|customer success|legal counsel)\b/.test(value)) return false;
  const signals = [
    ...(profile.broadCandidateTitleTerms ?? ['analyst','analist','researcher','onderzoeker','scientist','engineer','ontwikkelaar','specialist','consultant']),
    ...Object.values(profile.roleFamilies).flat(),
    ...Object.values(profile.descriptionRoleTerms ?? {}).flat(),
    ...Object.values(profile.structuredRoleTerms ?? {}).flat(),
  ];
  return signals.some((term) => includesNormalizedTerm(value, term));
}

export interface JobDecision {
  matchState: 'strong' | 'possible' | 'excluded'; retain: boolean;
  reasons: string[]; location: ReturnType<typeof assessLocation>;
  evidence: MatchEvidence | null; roleFamily: string; fieldsInspected: string[];
}
export function evaluateJob(job: RawJob, profile: ProfileConfig): JobDecision {
  const location = assessLocation(job, profile), exclusion = hardExclusion(job, profile);
  const evidence = matchJob(job, profile);
  const titleFamily = Object.entries(profile.roleFamilies).find(([,terms])=>terms.some(t=>phrase(job.title,t)))?.[0];
  const roleFamily = evidence?.roleFamily ?? titleFamily ?? 'unclassified';
  const fieldsInspected = ['title','location',...(job.countryCode?['countryCode']:[]),...(job.summary?['summary']:[]),...(job.description?['description']:[]),...(job.structuredRoleTerms?.length?['structured metadata']:[])];
  if(exclusion || location.state==='foreign') return {matchState:'excluded',retain:false,reasons:[exclusion ? exclusion.startsWith('Excluded title')?'excluded_title':exclusion.startsWith('Excluded seniority')?'excluded_seniority':'deal_breaker':'foreign_location'], location,evidence,roleFamily,fieldsInspected};
  const plausible = Boolean(evidence || titleFamily || plausibleTitle(job,profile));
  const reasons = [...(location.state==='unknown'?['unknown_location']:[]),...(!evidence?[roleFamily==='unclassified'?'unmatched_role':'insufficient_evidence']:[])];
  const strong = Boolean(evidence && location.state==='netherlands' && evidence.confidence==='high');
  if(evidence && !strong && location.state==='netherlands')reasons.push('inferred_role');
  return {matchState:strong?'strong':plausible?'possible':'excluded',retain:plausible,reasons:plausible?reasons:['unmatched_role'],location,evidence,roleFamily,fieldsInspected};
}

export function fingerprint(job: RawJob): string {
  const key = [
    normalizeText(job.company),
    normalizeText(job.title),
    normalizeText(job.location),
  ].join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

export function stableJobId(provider: string, job: RawJob): string {
  const precise = job.externalId
    ? `${provider}:${normalizeText(job.company)}:${job.externalId}`
    : canonicalizeUrl(job.url);
  return createHash("sha256").update(precise).digest("hex").slice(0, 24);
}

export function deduplicate(jobs: RawJob[]): {
  jobs: RawJob[];
  duplicateCount: number;
} {
  const seenUrl = new Set<string>(),
    seenExternal = new Set<string>(),
    seenFingerprint = new Set<string>();
  const result: RawJob[] = [];
  for (const job of jobs) {
    let url: string;
    try {
      url = canonicalizeUrl(job.url);
    } catch {
      continue;
    }
    const external = job.externalId?.trim().toLowerCase() ?? "";
    const print = fingerprint(job);
    if (
      seenUrl.has(url) ||
      (external && seenExternal.has(external)) ||
      seenFingerprint.has(print)
    )
      continue;
    seenUrl.add(url);
    if (external) seenExternal.add(external);
    seenFingerprint.add(print);
    result.push(job);
  }
  return { jobs: result, duplicateCount: jobs.length - result.length };
}
