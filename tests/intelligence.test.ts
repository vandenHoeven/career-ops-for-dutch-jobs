import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/database.js";
import type { DiscoveryCandidate } from "../src/types.js";

test("benchmark panel is versioned and source performance keeps dimensions separate", () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-intel-")), store = new Store(join(dir, "test.sqlite"));
  try {
    const coverage: any = store.benchmarkCoverage();
    assert.equal(coverage.total, 120); assert.equal(coverage.version, "nl-employers-v1");
    assert.match(coverage.label, /not total Dutch-market coverage/i); assert.ok(coverage.byRegion.length >= 8);
    const discovery: any = store.sourcePerformance("discovery", "30d");
    assert.equal(discovery.type, "discovery");
    assert.ok(discovery.items.every((row: any) => "unique_per_100" in row && "marginal_yield_trend" in row && "estimated_cycle_days" in row));
    assert.equal((store.sourcePerformance("provider", "lifetime") as any).type, "provider");
    assert.equal(Array.isArray(store.coverageOverlap() as any), false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("cross-source coverage respects its window and reports unique and shared vacancies", () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-overlap-")), store = new Store(join(dir, "test.sqlite"));
  try {
    const candidate: DiscoveryCandidate = { sourceId: "fixture", company: "Acme", domain: "acme.example", boardUrl: "https://boards.example/acme", provider: "greenhouse", headquarters: "netherlands", jobs: [] };
    const employerId = store.upsertEmployer(candidate, "bbbbbbbbbbbbbbbbbbbbbbbb", "acme", 1);
    const job = (fingerprint: string) => ({ title: `Role ${fingerprint}`, location: "Amsterdam", url: `https://example.com/${fingerprint}` });
    store.observeVacancy(employerId, "linkedin-guest", job("shared"), "shared", true);
    store.observeVacancy(employerId, "jobspy-indeed", job("shared"), "shared", true);
    store.observeVacancy(employerId, "linkedin-guest", job("linkedin-only"), "linkedin-only", true);
    store.observeVacancy(employerId, "linkedin-guest", job("linkedin-only"), "linkedin-only", true);
    store.observeVacancy(employerId, "jobspy-indeed", job("indeed-only"), "indeed-only", true);
    store.observeVacancy(employerId, "old-source", job("old"), "old", false);
    store.db.prepare("UPDATE vacancy_observations SET observed_at=datetime('now','-45 days') WHERE source_id='old-source'").run();

    const recent: any = store.coverageOverlap("30d");
    assert.equal(recent.window, "30d");
    assert.deepEqual(recent.sources, ["jobspy-indeed", "linkedin-guest"]);
    assert.deepEqual(recent.summaries.find((row: any) => row.id === "linkedin-guest"), {
      id: "linkedin-guest", totalVacancies: 2, uniqueVacancies: 1, sharedVacancies: 1,
      overlaps: [{ sourceId: "jobspy-indeed", intersection: 1, jaccard: 33.3 }],
    });
    assert.equal(recent.pairs[0].intersection, 1);

    const lifetime: any = store.coverageOverlap("lifetime");
    assert.equal(lifetime.window, "lifetime");
    assert.ok(lifetime.sources.includes("old-source"));
    assert.equal(lifetime.summaries.find((row: any) => row.id === "old-source").uniqueVacancies, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("employer intelligence returns rolling evidence, boards and totals", () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-employer-")), store = new Store(join(dir, "test.sqlite"));
  try {
    const candidate: DiscoveryCandidate = { sourceId: "fixture", company: "Adyen", domain: "adyen.com", boardUrl: "https://boards.example/adyen", provider: "greenhouse", headquarters: "netherlands", jobs: [] };
    const id = store.upsertEmployer(candidate, "aaaaaaaaaaaaaaaaaaaaaaaa", "adyen", 1);
    store.upsertEmployerBoard(id, candidate, "board-1", "healthy");
    store.observeVacancy(id, "fixture", { title: "Data Scientist", location: "Amsterdam, Netherlands", url: "https://example/jobs/1" }, "fp-1", true);
    const rows: any[] = store.employers({ benchmark: true, limit: 10 });
    assert.equal(rows.length, 1); assert.equal(rows[0].vacancies_30d, 1); assert.equal(rows[0].profile_matches_30d, 1); assert.equal(rows[0].benchmark_member, 1);
    assert.equal(store.employerCount({ benchmark: true }), 1);
    const detail: any = store.employer(id); assert.equal(detail.boards.length, 1); assert.equal(detail.observations.length, 1); assert.equal(detail.benchmark.canonical_name, "Adyen");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
