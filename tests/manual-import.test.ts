import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/database.js";
import { importVacancyUrl } from "../src/manual-import.js";

test("manual URL import stores, scores, and saves a structured vacancy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-manual-import-"));
  const store = new Store(join(dir, "test.sqlite"));
  const url = "https://jobs.example.test/vacatures/data-scientist-42";
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: "Data Scientist",
    hiringOrganization: { name: "Example Water Authority" },
    jobLocation: { address: { addressLocality: "Utrecht", addressCountry: "NL" } },
    description: "Build Python machine-learning models and statistical analyses for public water systems. ".repeat(4),
    datePosted: "2026-11-01",
    identifier: { value: "42" },
    url,
  })}</script>`;
  try {
    const result = await importVacancyUrl({
      store,
      url,
      context: { fetchJson: async () => ({}), fetchText: async () => html },
    });
    const job: any = store.job(result.jobId);
    assert.equal(result.importStatus, "new");
    assert.equal(job.title, "Data Scientist");
    assert.equal(job.company, "Example Water Authority");
    assert.equal(job.location, "Utrecht, NL");
    assert.equal(job.source_id, "manual-url");
    assert.ok(Number.isFinite(job.overall_score));
    assert.equal((store.applications() as any[])[0].stage, "saved");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("manual URL import rejects unsafe URLs before fetching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diego-manual-import-"));
  const store = new Store(join(dir, "test.sqlite"));
  let fetched = false;
  try {
    await assert.rejects(
      importVacancyUrl({ store, url: "http://127.0.0.1/internal", context: { fetchJson: async () => ({}), fetchText: async () => { fetched = true; return ""; } } }),
      /Only public HTTPS/,
    );
    assert.equal(fetched, false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
