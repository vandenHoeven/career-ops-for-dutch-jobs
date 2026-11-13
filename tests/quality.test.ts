import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enrichJob } from "../src/enrichment.js";
import { profileFingerprint, scoreJob } from "../src/scoring.js";
import { evaluateJob } from "../src/core.js";
import { validateAiAssessment } from "../src/ai-scoring.js";
import { Store } from "../src/database.js";
import type { JobPosting, ProfileConfig } from "../src/types.js";

const profile: ProfileConfig = { country: "Netherlands", countryAliases: ["netherlands", "amsterdam"], remoteAliases: [], roleFamilies: { research: ["researcher"] }, excludeTitleTerms: ["intern"], expiryAfterMissedScans: 3, technicalEvidenceTerms: { research: ["python", "statistics"] }, preferredRoleFamilies: ["research"], skills: [{ term: "python", weight: 5 }], desiredSeniority: ["mid"], preferredLocations: ["amsterdam"], locationPenalties: { amsterdam: 10 }, preferredWorkArrangements: ["hybrid"], dealBreakers: ["unpaid"] };
const base: any = { company: "Acme", title: "Researcher", location: "Amsterdam", description: "Use Python and statistics to build models", url: "https://example.com/job", roleFamily: "research", workArrangement: "hybrid", raw: {} };

test("rules scoring is deterministic, explainable and enforces hard exclusions", () => {
  const first = scoreJob(base, profile), second = scoreJob(base, profile);
  assert.equal(first.score, second.score); assert.ok(first.score > 60); assert.deepEqual(first.breakdown.matchedSkills, ["python"]);
  const penalties=first.ledger.components.find(component=>component.key==="penalties");assert.equal(penalties?.awarded,-10);assert.match(penalties?.explanation??"",/Location penalty: −10 for amsterdam/);assert.equal(evaluateJob(base,profile).matchState,"strong","location ranking penalties do not redefine strong-match eligibility");
  assert.equal(scoreJob({ ...base, title: "Research Intern" }, profile).rejected, "Excluded title term: intern");
  assert.equal(scoreJob({ ...base, title: "AI Engineering Manager" }, { ...profile, excludedSeniority: ["senior"] }).rejected, "Excluded seniority: senior");
  assert.equal(profileFingerprint(profile), profileFingerprint({ ...profile }));
});

test("scoring v5 preserves unknown date evidence and exposes exact arithmetic", () => {
  const result = scoreJob({ ...base, postedAt: undefined }, profile);
  assert.equal(result.ledger.version, "5");
  assert.equal(result.ledger.components.reduce((sum, component) => sum + Math.max(0, component.maximum), 0), 100);
  const freshness = result.ledger.components.find(component => component.key === "freshness");
  assert.equal(freshness?.awarded, 4);
  assert.match(freshness?.explanation ?? "", /not supplied/i);
  const senior = scoreJob({ ...base, title: "Senior Researcher" }, profile);
  assert.equal(senior.ledger.hardExcluded, false);
  assert.ok(senior.score > 0, "senior exclusion follows profile settings");
});

test("enrichment prefers public JobPosting data and fails softly", async () => {
  const result = await enrichJob({ ...base, description: undefined }, { fetchJson: async () => ({}), fetchText: async () => `<script type="application/ld+json">{"@type":"JobPosting","description":"${"Build statistical Python systems. ".repeat(8)}"}</script>` });
  assert.equal(result.status, "complete"); assert.match(result.job.description!, /statistical Python/);
  const failed = await enrichJob({ ...base, description: undefined }, { fetchJson: async () => ({}), fetchText: async () => { throw new Error("blocked"); } });
  assert.equal(failed.status, "failed"); assert.equal(failed.error, "blocked");
});

test("AI assessments require validated structured output", () => {
  assert.equal(validateAiAssessment({ score: 81.2, rationale: "Strong fit", strengths: ["Python"], concerns: [], missingInformation: [] }).score, 81);
  assert.throws(() => validateAiAssessment({ score: 120, rationale: "bad", strengths: [], concerns: [], missingInformation: [] }));
});

test("application stages persist with append-only history", () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-quality-")), store = new Store(join(dir, "test.sqlite"));
  try {
    store.startRun("run"); const job: JobPosting = { ...base, id: "aaaaaaaaaaaaaaaaaaaaaaaa", provider: "greenhouse", sourceId: "fixture", canonicalUrl: base.url, roleFamily: "research", matchEvidence: { roleFamily: "research", roleTerm: "researcher", locationTerm: "amsterdam" }, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), status: "active" };
    store.upsertJob(job, "bbbbbbbbbbbbbbbbbbbbbbbb", "run"); store.upsertApplication(job.id, { stage: "saved", notes: "Interesting" }); store.upsertApplication(job.id, { stage: "applied", notes: "Sent" });
    assert.equal((store.applications()[0] as any).stage, "applied"); assert.equal(store.applicationHistory(job.id).length, 2); assert.equal((store.job(job.id) as any).review_state, "reviewed");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
