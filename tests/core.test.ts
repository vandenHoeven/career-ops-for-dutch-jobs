import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl, deduplicate, matchJob, stableJobId } from "../src/core.js";
import type { ProfileConfig, RawJob } from "../src/types.js";

const profile: ProfileConfig = {
  country: "Netherlands", countryAliases: ["netherlands", "nederland", "nl"], remoteAliases: ["remote netherlands"],
  roleFamilies: { "data-science": ["data scientist"], "machine-learning": ["machine learning engineer", "ml engineer"] },
  excludeTitleTerms: ["intern", "stage"], excludedSeniority:["senior"], expiryAfterMissedScans: 3,
};
const job = (overrides: Partial<RawJob> = {}): RawJob => ({ company: "Acme", title: "Data Scientist", location: "Amsterdam, Netherlands", url: "https://jobs.example.com/1", raw: {}, ...overrides });

test("canonical URLs remove tracking while keeping functional parameters", () => {
  assert.equal(canonicalizeUrl("https://EXAMPLE.com/jobs/1/?utm_source=x&lang=nl#top"), "https://example.com/jobs/1?lang=nl");
});
test("profile filter explains role and Netherlands match", () => {
  assert.deepEqual(matchJob(job(), profile), { roleFamily: "data-science", roleTerm: "data scientist", locationTerm: "netherlands", matchedFrom:"title",confidence:"high",technicalTerms:[],fieldsInspected:["title"] });
  assert.equal(matchJob(job({ title: "Senior Data Scientist" }), profile), null);
  assert.equal(matchJob(job({ title: "Data Science Intern" }), profile), null);
  assert.equal(matchJob(job({ location: "Berlin, Germany" }), profile), null);
});
test("description role evidence expands recall but a skill alone does not",()=>{const expanded={...profile,descriptionRoleTerms:{"data-science":["predictive modelling"]},technicalEvidenceTerms:{"data-science":["statistics","python"]},minimumDescriptionTechnicalEvidence:1};const match=matchJob(job({title:"Insights Specialist",summary:"Predictive modelling using statistics"}),expanded);assert.equal(match?.matchedFrom,"description");assert.equal(match?.confidence,"low");assert.equal(matchJob(job({title:"Insights Specialist",summary:"Python reporting"}),expanded),null);});
test("deduplication follows URL, external ID and cross-listing fingerprint", () => {
  const result = deduplicate([job(), job({ url: "https://jobs.example.com/1?utm_source=board" }), job({ url: "https://other.example.com/x", externalId: "REQ-1" }), job({ url: "https://third.example.com/y", externalId: "REQ-1", title: "Different" })]);
  assert.equal(result.jobs.length, 2); assert.equal(result.duplicateCount, 2);
});
test("stable IDs do not change with tracking links", () => {
  assert.equal(stableJobId("greenhouse", job()), stableJobId("greenhouse", job({ url: "https://jobs.example.com/1?utm_campaign=x" })));
});
