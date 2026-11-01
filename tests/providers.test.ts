import test from "node:test";
import assert from "node:assert/strict";
import { parsePersonioXml, parseRecruiteeXml, resolveProvider } from "../src/providers.js";

const cases = [
  ["https://job-boards.greenhouse.io/acme", "greenhouse"], ["https://jobs.eu.lever.co/acme", "lever"],
  ["https://jobs.ashbyhq.com/acme", "ashby"], ["https://apply.workable.com/acme", "workable"],
  ["https://acme.recruitee.com", "recruitee"], ["https://careers.smartrecruiters.com/Acme", "smartrecruiters"],
  ["https://acme.jobs.personio.de", "personio"], ["https://acme.jobs.personio.com", "personio"],
  ["https://acme.wd3.myworkdayjobs.com/External", "workday"], ["https://acme.icims.com/jobs", "icims"],
  ["https://careers.example.nl", "browser"],
] as const;
for (const [careersUrl, expected] of cases) test(`detects ${expected}`, () => assert.equal(resolveProvider({ id: expected, company: "Acme", careersUrl }).id, expected));

test("Greenhouse adapter normalizes a fixture", async () => {
  const provider = resolveProvider({ id: "acme", company: "Acme", careersUrl: "https://job-boards.greenhouse.io/acme" });
  const {jobs} = await provider.fetch({ id: "acme", company: "Acme", careersUrl: "https://job-boards.greenhouse.io/acme" }, {
    fetchText: async () => "", fetchJson: async () => ({ jobs: [{ id: 7, title: "Data Scientist", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/7", location: { name: "Amsterdam, Netherlands" }, content: "<p>Build models</p>", updated_at: "2026-01-02" }] }),
  });
  assert.equal(jobs.length, 1); assert.equal(jobs[0].externalId, "7"); assert.equal(jobs[0].description, "Build models");
});

test("Personio XML includes descriptions and structured evidence",()=>{const jobs=parsePersonioXml(`<workzag-jobs><position><id>42</id><office>Utrecht, Netherlands</office><department>Data</department><name>Decision Scientist</name><jobDescriptions><jobDescription><value><![CDATA[Build <b>optimization</b> models]]></value></jobDescription></jobDescriptions><createdAt>2026-10-01</createdAt><keywords>python, optimization</keywords></position></workzag-jobs>`,"Acme","https://acme.jobs.personio.de");assert.equal(jobs.length,1);assert.match(jobs[0].description??"",/optimization models/);assert.equal(jobs[0].externalId,"42");});
test("Recruitee XML fallback is normalized",()=>{const rows=parseRecruiteeXml(`<offers><offer><id>7</id><title>Data Analyst</title><location>Eindhoven, Netherlands</location><description><![CDATA[SQL analytics]]></description><careers_url>/o/data-analyst</careers_url></offer></offers>`,"Acme","https://acme.recruitee.com");assert.equal(rows.length,1);assert.equal(rows[0].title,"Data Analyst");});
