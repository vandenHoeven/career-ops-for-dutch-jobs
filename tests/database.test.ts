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
    assert.equal(store.jobs({ company: "acm", roleFamily: "data-science" }).length, 1);
    store.ageUnseen("acme", "2026-01-02T00:00:00.000Z", 1);
    assert.equal((store.job(job.id) as any).status, "expired");
    assert.equal((store.stats() as any).expired, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
