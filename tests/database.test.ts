import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/database.js";
import type { JobPosting } from "../src/types.js";

test("SQLite preserves jobs, observations, filters and lifecycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-test-"));
  const store = new Store(join(dir, "test.sqlite"));
  try {
    store.startRun("scan-1");
    const job: JobPosting = { id: "aaaaaaaaaaaaaaaaaaaaaaaa", provider: "greenhouse", sourceId: "acme", externalId: "1", company: "Acme", title: "Data Scientist", location: "Amsterdam, Netherlands", url: "https://example.com/jobs/1", canonicalUrl: "https://example.com/jobs/1", workArrangement: "hybrid", roleFamily: "data-science", matchEvidence: { roleFamily: "data-science", roleTerm: "data scientist", locationTerm: "netherlands" }, firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", status: "active", raw: {} };
    store.upsertJob(job, "fingerprint", "scan-1");
    const outside: JobPosting = { ...job, id: "bbbbbbbbbbbbbbbbbbbbbbbb", sourceId: "beta", externalId: "2", company: "Beta", location: "Rotterdam, Netherlands", url: "https://example.com/jobs/2", canonicalUrl: "https://example.com/jobs/2" };
    store.upsertJob(outside, "fingerprint-outside", "scan-1");
    assert.equal(store.jobs({ company: "acm", roleFamily: "data-science" }).length, 1);
    assert.equal(store.jobs({ locationGroup: "amsterdam" }).length, 1);
    assert.equal(store.jobs({ locationGroup: "outside-amsterdam" }).length, 1);
    store.ageUnseen("acme", "2026-01-02T00:00:00.000Z", 1);
    assert.equal((store.job(job.id) as any).status, "expired");
    assert.equal((store.stats() as any).expired, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("canonical URL owner wins when stored job identities converge", () => {
  const store = new Store(":memory:");
  const firstSeen = "2026-01-01T00:00:00.000Z";
  const base: JobPosting = { id: "aaaaaaaaaaaaaaaaaaaaaaaa", provider: "browser", sourceId: "directory", externalId: "shared-id", company: "Acme", title: "Analytics Engineer", location: "Amsterdam, Netherlands", url: "https://careers.acme.test/jobs/shared-id", canonicalUrl: "https://careers.acme.test/jobs/shared-id", workArrangement: "hybrid", roleFamily: "data-engineering", matchEvidence: { roleFamily: "data-engineering", roleTerm: "analytics engineer", locationTerm: "netherlands" }, firstSeenAt: firstSeen, lastSeenAt: firstSeen, status: "active", raw: {} };
  try {
    store.startRun("scan-1");
    store.upsertJob(base, "fingerprint-a", "scan-1");
    const urlOwner = { ...base, id: "bbbbbbbbbbbbbbbbbbbbbbbb", sourceId: "ats", url: "https://jobs.ats.test/acme/shared-id", canonicalUrl: "https://jobs.ats.test/acme/shared-id" };
    store.upsertJob(urlOwner, "fingerprint-b", "scan-1");
    store.upsertApplication(urlOwner.id, { stage: "saved", notes: "Keep this history" });

    const incoming = { ...base, canonicalUrl: urlOwner.canonicalUrl, url: urlOwner.url, lastSeenAt: "2026-01-02T00:00:00.000Z" };
    assert.doesNotThrow(() => store.upsertJob(incoming, "fingerprint-a", "scan-1"));
    assert.equal(store.jobIdFor(incoming.id, incoming.canonicalUrl, "fingerprint-a"), urlOwner.id);
    const refreshed = store.job(urlOwner.id) as any;
    assert.equal(refreshed.first_seen_at, firstSeen);
    assert.equal(refreshed.application.notes, "Keep this history");
  } finally { store.close(); }
});
