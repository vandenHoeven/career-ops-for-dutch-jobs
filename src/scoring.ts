import { createHash } from "node:crypto";
import type {
  ProfileConfig,
  RawJob,
  ScoreComponent,
  ScoreLedger,
  WorkArrangement,
} from "./types.js";
import { scoreLocation } from "./locations.js";
import { phrase, jobSpecificText } from './text.js';

export const SCORING_VERSION = "4";
const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function profileFingerprint(profile: ProfileConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(profile))
    .digest("hex")
    .slice(0, 24);
}

const seniorityTerms: Record<string, string[]> = {
  junior: ["junior", "entry level", "graduate", "starter"],
  mid: ["mid", "medior"],
  senior: [
    "senior",
    "lead",
    "principal",
    "staff",
    "head of",
    "manager",
    "director",
  ],
};

export function detectedSeniority(title: string): string {
  const value = normalizeText(title);
  return (
    Object.entries(seniorityTerms).find(([, terms]) =>
      terms.some((term) => phrase(value, term)),
    )?.[0] ?? "unspecified"
  );
}

export function hardExclusion(
  job: RawJob,
  profile: ProfileConfig,
): string | null {
  const title = normalizeText(job.title);
  const all = normalizeText(
    `${job.title} ${job.summary ?? ""} ${job.description ?? ""}`,
  );
  const excludedTitle = profile.excludeTitleTerms.find((term) =>
    phrase(title, term),
  );
  if (excludedTitle) return `Excluded title term: ${excludedTitle}`;
  const dealBreaker = profile.dealBreakers?.find((term) =>
    all.includes(normalizeText(term)),
  );
  if (dealBreaker) return `Deal-breaker: ${dealBreaker}`;
  const seniority = detectedSeniority(job.title);
  if (profile.excludedSeniority?.includes(seniority))
    return `Excluded seniority: ${seniority}`;
  return null;
}

export function hasTechnicalEvidence(
  job: RawJob,
  family: string,
  profile: ProfileConfig,
): boolean {
  const required = profile.technicalEvidenceTerms?.[family] ?? [];
  if (!required.length) return true;
  const value = normalizeText(
    `${job.title} ${job.summary ?? ""} ${jobSpecificText(job.description ?? "")}`,
  );
  return required.some((term) => normalizeText(term).length<=3 ? phrase(value,term) : value.includes(normalizeText(term)));
}

function languageEvidence(
  text: string,
  preferred: string[],
): { awarded: number; evidence: string[]; explanation: string } {
  const explicit = text.match(
    /(?:language|taal)\s*[:\-]?\s*(english|dutch|nederlands|engels)/i,
  )?.[1];
  if (explicit) {
    const normalized = normalizeText(explicit);
    const matched = preferred.some(
      (value) =>
        normalized.includes(normalizeText(value)) ||
        normalizeText(value).includes(normalized),
    );
    return {
      awarded: matched ? 5 : 0,
      evidence: [explicit],
      explanation: matched
        ? "Explicit preferred language found"
        : "Explicit language is outside preferences",
    };
  }
  const dutchSignals = (
    text.match(
      /\b(ervaring|werkzaamheden|functie|opleiding|vaardigheden|nederlands)\b/gi,
    ) ?? []
  ).length;
  const englishSignals = (
    text.match(
      /\b(experience|responsibilities|qualifications|skills|english)\b/gi,
    ) ?? []
  ).length;
  if (dutchSignals >= 2 || englishSignals >= 2) {
    const detected =
      dutchSignals > englishSignals
        ? "Dutch (heuristic)"
        : "English (heuristic)";
    return {
      awarded: 5,
      evidence: [detected],
      explanation:
        "Language estimated from posting text; provider supplied no language field",
    };
  }
  return {
    awarded: 3,
    evidence: [],
    explanation: "Language unknown; neutral points awarded",
  };
}

function freshness(postedAt?: string): {
  awarded: number;
  evidence: string[];
  explanation: string;
} {
  if (!postedAt || !Number.isFinite(Date.parse(postedAt)))
    return {
      awarded: 4,
      evidence: [],
      explanation: "Publication date not supplied; neutral points awarded",
    };
  const days = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(postedAt)) / 86400000),
  );
  const awarded = days <= 7 ? 10 : days <= 30 ? 8 : days <= 60 ? 5 : 2;
  return {
    awarded,
    evidence: [postedAt, `${days} days old`],
    explanation: `Provider-supplied publication date falls in the ${days <= 7 ? "0–7" : days <= 30 ? "8–30" : days <= 60 ? "31–60" : "61+"} day band`,
  };
}

export function scoreJob(
  job: RawJob & {
    roleFamily: string;
    workArrangement: WorkArrangement;
    matchEvidence?: import("./types.js").MatchEvidence;
  },
  profile: ProfileConfig,
): {
  score: number;
  ledger: ScoreLedger;
  breakdown: ScoreLedger;
  seniority: string;
  rejected?: string;
} {
  const rejected = hardExclusion(job, profile);
  const text = normalizeText(
    `${job.title} ${job.summary ?? ""} ${job.description ?? ""}`,
  );
  const seniority = detectedSeniority(job.title);
  const calculatedAt = new Date().toISOString(),
    components: ScoreComponent[] = [],
    matchedSkills: string[] = [],
    missingSkills: string[] = [];
  if (rejected) {
    const ledger: ScoreLedger = {
      version: SCORING_VERSION,
      calculatedAt,
      ruleScore: 0,
      overallScore: 0,
      formula: "Hard exclusion → not ranked",
      hardExcluded: true,
      exclusionReason: rejected,
      exclusionEvidence: job.title,
      components,
      matchedSkills,
      missingSkills,
    };
    return { score: 0, ledger, breakdown: ledger, seniority, rejected };
  }

  const preferred =
    profile.preferredRoleFamilies ?? Object.keys(profile.roleFamilies);
  const acceptable = profile.acceptableRoleFamilies ?? [];
  const baseRolePoints = preferred.includes(job.roleFamily)
    ? 30
    : acceptable.includes(job.roleFamily)
      ? 20
      : 12;
  const rolePoints = Math.max(
    0,
    baseRolePoints -
      (job.matchEvidence?.matchedFrom === "description"
        ? 8
        : job.matchEvidence?.matchedFrom === "structured"
          ? 4
          : 0),
  );
  components.push({
    key: "role",
    label: "Role family",
    awarded: rolePoints,
    maximum: 30,
    rule: "Preferred 30 · acceptable 20 · other matched 12 · structured evidence −4 · description evidence −8",
    evidence: [job.roleFamily, job.matchEvidence?.matchedFrom ?? "title"],
    explanation: `${job.roleFamily} is ${preferred.includes(job.roleFamily) ? "preferred" : acceptable.includes(job.roleFamily) ? "acceptable" : "matched but not prioritized"}; evidence came from ${job.matchEvidence?.matchedFrom ?? "the title"}${baseRolePoints === rolePoints ? "" : `, reducing role points from ${baseRolePoints} to ${rolePoints}`}`,
  });

  const skills = profile.skills ?? [];
  const totalWeight = skills.reduce(
    (sum, item) => sum + Math.max(0, item.weight),
    0,
  );
  let matchedWeight = 0;
  for (const skill of skills) {
    if (text.includes(normalizeText(skill.term))) {
      matchedSkills.push(skill.term);
      matchedWeight += Math.max(0, skill.weight);
    } else missingSkills.push(skill.term);
  }
  const skillPoints = totalWeight
    ? Math.round((25 * matchedWeight) / totalWeight)
    : 15;
  components.push({
    key: "skills",
    label: "Skills",
    awarded: skillPoints,
    maximum: 25,
    rule: "Weighted share of configured skills",
    evidence: matchedSkills,
    explanation: totalWeight
      ? `${matchedWeight} of ${totalWeight} configured skill weight matched`
      : "No skills configured; neutral points awarded",
  });

  const desired = profile.desiredSeniority ?? [];
  const seniorityPoints =
    seniority === "unspecified" || !desired.length
      ? 6
      : desired.includes(seniority)
        ? 12
        : 3;
  components.push({
    key: "seniority",
    label: "Seniority",
    awarded: seniorityPoints,
    maximum: 12,
    rule: "Desired 12 · unspecified 6 · other 3 · excluded 0",
    evidence: [seniority, job.title],
    explanation:
      seniority === "unspecified"
        ? "No seniority marker found in the title"
        : `${seniority} seniority detected from title`,
  });
  const location = scoreLocation(job, profile);
  components.push({
    key: "location",
    label: "Location",
    awarded: location.awarded,
    maximum: 10,
    rule: "Strongly preferred 10 · nearby 9 · ≤60 km or NL-remote 7 · rest of Netherlands 4",
    evidence: location.evidence,
    explanation: location.explanation,
  });
  const arrangementPoints = profile.preferredWorkArrangements?.includes(
    job.workArrangement,
  )
    ? 8
    : job.workArrangement === "unknown"
      ? 4
      : 3;
  components.push({
    key: "workArrangement",
    label: "Work arrangement",
    awarded: arrangementPoints,
    maximum: 8,
    rule: "Preferred 8 · unknown 4 · other 3",
    evidence: [job.workArrangement],
    explanation:
      job.workArrangement === "unknown"
        ? "Work arrangement was not supplied or detected"
        : `${job.workArrangement} arrangement detected`,
  });
  const language = languageEvidence(
    `${job.title} ${job.summary ?? ""} ${job.description ?? ""}`,
    profile.languages ?? [],
  );
  components.push({
    key: "language",
    label: "Language",
    awarded: language.awarded,
    maximum: 5,
    rule: "Preferred explicit/detected 5 · unknown 3 · nonpreferred 0",
    evidence: language.evidence,
    explanation: language.explanation,
  });
  const fresh = freshness(job.postedAt);
  components.push({
    key: "freshness",
    label: "Freshness",
    awarded: fresh.awarded,
    maximum: 10,
    rule: "≤7d 10 · ≤30d 8 · ≤60d 5 · older 2 · unknown 4",
    evidence: fresh.evidence,
    explanation: fresh.explanation,
  });
  const negative = (profile.negativeTerms ?? []).filter((term) =>
    text.includes(normalizeText(term)),
  );
  const penalty = Math.min(20, negative.length * 5);
  components.push({
    key: "penalties",
    label: "Penalties",
    awarded: -penalty,
    maximum: 0,
    rule: "−5 per configured negative term, maximum −20",
    evidence: negative,
    explanation: negative.length
      ? `Matched negative terms: ${negative.join(", ")}`
      : "No configured negative terms matched",
  });
  const score = Math.max(
    0,
    Math.min(
      100,
      components.reduce((sum, component) => sum + component.awarded, 0),
    ),
  );
  const ledger: ScoreLedger = {
    version: SCORING_VERSION,
    calculatedAt,
    ruleScore: score,
    overallScore: score,
    formula: `${components
      .filter((c) => c.key !== "penalties")
      .map((c) => c.awarded)
      .join(" + ")}${penalty ? ` − ${penalty}` : ""} = ${score}`,
    hardExcluded: false,
    components,
    matchedSkills,
    missingSkills,
  };
  return { score, ledger, breakdown: ledger, seniority };
}
