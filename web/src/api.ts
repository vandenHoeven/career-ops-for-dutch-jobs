export class ApiError extends Error { constructor(message:string,public status:number,public data:any){super(message);this.name="ApiError";} }
export async function api<T=any>(path:string,init?:RequestInit):Promise<T>{const headers=new Headers(init?.headers);if(init?.body&&typeof init.body==="string"&&!headers.has("content-type"))headers.set("content-type","application/json");const response=await fetch(path,{...init,headers});const data=await response.json().catch(()=>({}));if(!response.ok)throw new ApiError(data.error??`Request failed (${response.status})`,response.status,data);return data}
export const date=(value?:string|null)=>value?new Intl.DateTimeFormat("en-NL",{day:"numeric",month:"short",year:"numeric"}).format(new Date(value)):"—";
export const applicationStageMeta=[
  {value:"saved",label:"Saved"},
  {value:"preparing",label:"Preparing"},
  {value:"applied",label:"Applied"},
  {value:"screening",label:"Screening"},
  {value:"interview",label:"First interview"},
  {value:"second_interview",label:"Second interview"},
  {value:"assessment",label:"Assessment"},
  {value:"offer",label:"Offer"},
  {value:"hired",label:"Hired"},
  {value:"rejected",label:"Rejected"},
  {value:"withdrawn",label:"Withdrawn"},
] as const;
export const stages=applicationStageMeta.map(stage=>stage.value);
export const stageLabel=(value?:string|null)=>applicationStageMeta.find(stage=>stage.value===value)?.label??value??"";
