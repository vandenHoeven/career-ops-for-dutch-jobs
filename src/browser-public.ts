import type { FetchContext } from './types.js';

/** Rendering is a fallback. Every browser HTTP request goes through the public-source client. */
export async function renderPublicPage(url:string,context:FetchContext):Promise<string|undefined>{
  let browser:import('playwright').Browser|undefined;
  try{
    const {chromium}=await import('playwright');browser=await chromium.launch({headless:true});
    const session=await browser.newContext({serviceWorkers:'block'});
    await session.routeWebSocket('**/*',socket=>socket.close());
    await session.route('**/*',async route=>{
      const request=route.request(),type=request.resourceType();
      if(['image','media','font','other'].includes(type)){await route.abort();return;}
      try{
        const headers=request.headers(),body=await context.fetchText(request.url(),{method:request.method(),body:request.postData()??undefined,headers:{accept:headers.accept??'*/*',...(headers['content-type']?{'content-type':headers['content-type']}:{})}});
        const contentType=type==='script'?'application/javascript':type==='stylesheet'?'text/css':type==='document'?'text/html':body.trim().startsWith('{')||body.trim().startsWith('[')?'application/json':'text/plain';
        await route.fulfill({status:200,contentType,body});
      }catch{await route.abort().catch(()=>{});}
    });
    const page=await session.newPage();await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
    await page.waitForLoadState('networkidle',{timeout:3000}).catch(()=>{});
    return await page.content();
  }catch{return undefined;}finally{await browser?.close();}
}
