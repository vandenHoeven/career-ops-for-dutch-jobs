import test from "node:test";
import assert from "node:assert/strict";
import { stringify } from "devalue";
import {
  benchmarkCandidate,
  parseAcademicTransferDetail,
  parseAcademicTransferLinks,
} from "../src/discovery-sources.js";
import { createEnrichmentLimiter } from "../src/enrichment-limiter.js";
import { BENCHMARK_EMPLOYERS } from "../src/benchmark.js";
test("benchmark discovery follows official careers links and normalizes posting URLs to boards", async () => {
  const employer = BENCHMARK_EMPLOYERS[0];
  const result = await benchmarkCandidate(
    {
      fetchJson: async () => ({}),
      fetchText: async (url) =>
        url.endsWith("/careers")
          ? '<a href="https://example.jobs.personio.com/job/42">Data role</a>'
          : '<a href="/careers">Careers</a>',
    },
    employer,
  );
  assert.equal(result.provider, "personio");
  assert.equal(result.boardUrl, "https://example.jobs.personio.com");
  assert.equal(result.discoveryEvidence?.method, "official-site");
});
test("enrichment limiter allows two destinations but only one request per host", async () => {
  const run = createEnrichmentLimiter(),
    controller = new AbortController();
  let active = 0,
    max = 0;
  const hosts = new Set<string>();
  await Promise.all(
    ["a", "a", "b", "b", "c"].map((host) =>
      run(`https://${host}.example/job`, controller.signal, async () => {
        assert.equal(hosts.has(host), false);
        hosts.add(host);
        active++;
        max = Math.max(max, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        hosts.delete(host);
      }),
    ),
  );
  assert.equal(max, 2);
});
test("AcademicTransfer Nuxt data retains explicit dates and ignores absent countries", () => {
  const vacancy = {
    title: "Research Engineer",
    organisation_name: "Example University",
    city: "Utrecht",
    country_code: "NL",
    absolute_url: "https://www.academictransfer.com/en/jobs/123/example/",
    description: "Technical work",
    start_date: "2026-10-20",
    end_date: "2026-11-20",
  };
  const html = `<script id="__NUXT_DATA__" type="application/json">${stringify({ data: { vacancy } })}</script>`;
  const result = parseAcademicTransferDetail(html, vacancy.absolute_url);
  assert.equal(result[0].jobs?.[0].postedAt, "2026-10-20");
  assert.equal(result[0].jobs?.[0].validThrough, "2026-11-20");
});

test("AcademicTransfer listing and JobPosting detail are parsed", () => {
  const links = parseAcademicTransferLinks(
    `<a href="/en/jobs/123/data-scientist/">Role</a>`,
  );
  assert.equal(
    links[0],
    "https://www.academictransfer.com/en/jobs/123/data-scientist/",
  );
  const detail = parseAcademicTransferDetail(
    `<script type="application/ld+json">{"@type":"JobPosting","title":"Data Scientist","hiringOrganization":{"name":"TU Example"},"jobLocation":{"address":{"addressLocality":"Eindhoven","addressCountry":"Netherlands"}},"description":"Machine learning and statistics","datePosted":"2026-10-20","validThrough":"2026-11-20","url":"https://www.academictransfer.com/en/jobs/123/data-scientist/"}</script>`,
    links[0],
  );
  assert.equal(detail[0].jobs?.[0].company, "TU Example");
  assert.equal(detail[0].jobs?.[0].validThrough, "2026-11-20");
});
