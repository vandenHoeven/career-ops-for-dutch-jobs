import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createLinkedInGuestSource, linkedInKeywordsFromProfile, parseLinkedInGuestDetail, parseLinkedInGuestSearch, parseLinkedInPocReport, linkedInGuestSourceFromPocReport } from '../src/linkedin-guest.js';
import { loadProfile } from '../src/config.js';
import { getDiscoverySources } from '../src/discovery-sources.js';
import { discover } from '../src/discovery.js';
import { Store } from '../src/database.js';

const report=JSON.parse(readFileSync(resolve('data/linkedin-guest-poc-results.json'),'utf8'));
const offline={fetchJson:async()=>{throw new Error('unexpected network request');},fetchText:async()=>{throw new Error('unexpected network request');}};

test('saved LinkedIn POC results normalize and deduplicate without live collection',()=>{
 const jobs=parseLinkedInPocReport(report);
 assert.equal(jobs.length,50);assert.equal(new Set(jobs.map(job=>job.externalId)).size,50);
 assert.ok(jobs.every(job=>job.company&&job.title&&job.location&&job.url.startsWith('https://')));
 assert.ok(jobs.every(job=>(job.raw as any).capturedPoc===true));
 assert.equal(jobs.filter(job=>(job.raw as any).capturedDescriptionLength>0).length,10);
 assert.equal(jobs.filter(job=>Object.keys((job.raw as any).criteria).length>0).length,10);
});

test('guest HTML selectors normalize search cards and detail metadata',()=>{
 const search=`<li><div data-entity-urn="urn:li:jobPosting:123"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/data-analyst-123?tracking=x"><span class="sr-only">Data &amp; Analytics Analyst</span></a><h3 class="base-search-card__title">Data &amp; Analytics Analyst</h3><h4 class="base-search-card__subtitle">Example BV</h4><span class="job-search-card__location">Utrecht, Netherlands</span><time datetime="2026-10-30">today</time></div></li>`;
 const [job]=parseLinkedInGuestSearch(search);assert.equal(job.externalId,'123');assert.equal(job.title,'Data & Analytics Analyst');assert.equal(job.postedAt,'2026-10-30');
 const detail=parseLinkedInGuestDetail(`<div class="show-more-less-html__markup">Build models &amp; dashboards.</div></div><ul><li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader">Employment type</h3><span class="description__job-criteria-text">Full-time</span></li></ul>`);
 assert.equal(detail.description,'Build models & dashboards.');assert.equal(detail.criteria['Employment type'],'Full-time');
});

test('default LinkedIn keywords follow CareerOps role families',async()=>{
 const profile=await loadProfile(),keywords=linkedInKeywordsFromProfile(profile);
 assert.match(keywords,/"data scientist"/);assert.match(keywords,/"machine learning engineer"/);assert.match(keywords,/"operations research"/);assert.match(keywords,/"data analyst"/);assert.match(keywords,/"research scientist"/);
});

test('saved LinkedIn jobs pass through the existing discovery and SQLite pipeline offline',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'diego-linkedin-')),store=new Store(join(dir,'test.sqlite'));
 try{
  const result=await discover({store,sources:[linkedInGuestSourceFromPocReport(report)],limit:2,context:offline,enrichmentLimit:0});
  assert.equal(result.fetchedJobs,2);assert.equal((store.db.prepare('SELECT count(*) n FROM jobs').get() as any).n,2);
  assert.equal((store.db.prepare("SELECT count(*) n FROM source_observations WHERE source_id='linkedin-guest'").get() as any).n,2);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('LinkedIn Guest remains unavailable unless both live opt-ins are present',()=>{
 const enabled=process.env.DIEGO_ENABLE_LINKEDIN_GUEST,permission=process.env.DIEGO_LINKEDIN_GUEST_PERMISSION_CONFIRMED;
 try{delete process.env.DIEGO_ENABLE_LINKEDIN_GUEST;delete process.env.DIEGO_LINKEDIN_GUEST_PERMISSION_CONFIRMED;assert.throws(()=>getDiscoverySources('linkedin-guest'),/disabled/);assert.ok(!getDiscoverySources().some(source=>source.id==='linkedin-guest'));process.env.DIEGO_ENABLE_LINKEDIN_GUEST='true';assert.throws(()=>getDiscoverySources('linkedin-guest'),/disabled/);process.env.DIEGO_LINKEDIN_GUEST_PERMISSION_CONFIRMED='true';assert.equal(getDiscoverySources('linkedin-guest')[0].experimental,true);}
 finally{if(enabled===undefined)delete process.env.DIEGO_ENABLE_LINKEDIN_GUEST;else process.env.DIEGO_ENABLE_LINKEDIN_GUEST=enabled;if(permission===undefined)delete process.env.DIEGO_LINKEDIN_GUEST_PERMISSION_CONFIRMED;else process.env.DIEGO_LINKEDIN_GUEST_PERMISSION_CONFIRMED=permission;}
});

test('LinkedIn samples newest jobs before continuing the saved offset',async()=>{
 const starts:number[]=[],context={fetchJson:async()=>({}),fetchText:async(url:string)=>{if(url.includes('/jobPosting/'))return '<div class="show-more-less-html__markup">Build models.</div></div>';const start=Number(new URL(url).searchParams.get('start')??0);starts.push(start);return Array.from({length:10},(_,i)=>{const id=start+i+1;return `<li><div data-entity-urn="urn:li:jobPosting:${id}"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/job-${id}"></a><h3 class="base-search-card__title">Data Scientist ${id}</h3><h4 class="base-search-card__subtitle">Company ${id}</h4><span class="job-search-card__location">Netherlands</span></div></li>`}).join('');}};
 const source=createLinkedInGuestSource({allowLiveCollection:true,keywords:'data scientist',location:'Netherlands'}),first=await source.discover(context,20,25),second=await source.discover(context,first.nextCursor,5);
 assert.equal(first.candidates.length,25);assert.deepEqual(starts.slice(0,3),[0,20,30]);assert.equal(first.nextCursor,35);assert.equal(second.nextCursor,40);assert.equal(starts.at(-1),35);
});
