import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import App from './AppV2';
import { MissingJobCheck } from './CoverageTools';

let root:Root|undefined,container:HTMLDivElement|undefined;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());container?.remove();root=undefined;vi.unstubAllGlobals();});
async function render(node:React.ReactNode){vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);container=document.createElement('div');document.body.append(container);root=createRoot(container);await act(async()=>root!.render(node));}
const response=(data:unknown)=>Promise.resolve({ok:true,json:async()=>data});

describe('recall interface',()=>{
 it('shows strong and possible jobs together and resets page when filtering',async()=>{
  const calls:string[]=[];
  vi.stubGlobal('fetch',vi.fn((path:string)=>{calls.push(path);return response({items:[{id:'a'.repeat(24),title:'Data Scientist',company:'Example',location:'Vught',match_state:'strong',overall_score:75},{id:'b'.repeat(24),title:'AI Software Engineer',company:'Example',location:'Unknown',match_state:'possible',overall_score:40}],total:110});}));
  await render(<MemoryRouter initialEntries={['/jobs']}><App/></MemoryRouter>);
  expect(container!.textContent).toContain('Strong match');expect(container!.textContent).toContain('Possible match');expect(container!.textContent).toContain('110');
  const next=[...container!.querySelectorAll('button')].find(b=>/next/i.test(b.textContent??''));expect(next).toBeDefined();
  await act(async()=>next!.click());expect(calls.at(-1)).toContain('offset=50');
  const filter=container!.querySelector('.filter-grid select') as HTMLSelectElement;
  await act(async()=>{filter.value='possible';filter.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(calls.at(-1)).toContain('matchState=possible');expect(calls.at(-1)).toContain('offset=0');
 });

 it('submits a vacancy URL and displays the persisted diagnostic outcome',async()=>{
  vi.stubGlobal('fetch',vi.fn((path:string)=>response(path==='/api/v1/diagnostics/job'?{id:'diagnostic'}:{status:'completed',result:{stage:'retained',jobId:'a'.repeat(24)}})));
  await render(<MemoryRouter><MissingJobCheck/></MemoryRouter>);
  const input=container!.querySelector('input')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'https://example.com/jobs/scientist');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>container!.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(container!.textContent).toContain('This job is in your list');expect(container!.querySelector('a')!.getAttribute('href')).toContain('/jobs/');
 });
});
