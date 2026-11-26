export const preview=/^deploy-preview-\d+--maarefmarket\.netlify\.app$/.test(location.hostname);
export const demo=preview&&new URLSearchParams(location.search).has(document.getElementById("appScreen")?"demo":"supportDemo");
export const types={suggestion:"اقتراح",complaint:"شكوى",question:"استفسار"};
export const states={new:"بانتظار الرد",answered:"تم الرد",resolved:"تم الحل"};
export const stamp=value=>new Date(value).toLocaleString("ar-SY",{timeZone:"Asia/Damascus",dateStyle:"short",timeStyle:"medium"});
export const randomSecret=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");
export const validKey=k=>/^\d{13}-[a-f0-9-]{36}$/i.test(k?.id||"")&&/^[a-f0-9]{64}$/.test(k?.secret||"");
export function element(tag,text,cls){
  const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;
}
export function button(text,fn,cls="btn btn-outline"){
  const b=element("button",text,cls);b.type="button";b.addEventListener("click",fn);return b;
}
export async function api(body,headers={},signal,timeout=15000){
  if(demo)return demoAPI(body);
  const ctrl=new AbortController(),abort=()=>ctrl.abort();
  if(signal?.aborted)throw Error("أُلغيت العملية");
  signal?.addEventListener("abort",abort,{once:true});
  let rejectAbort;
  const cancelled=new Promise((_,reject)=>{rejectAbort=()=>reject(Error("انتهت مهلة الاتصال أو أُلغيت العملية"));ctrl.signal.addEventListener("abort",rejectAbort,{once:true});});
  const timer=setTimeout(abort,timeout);
  try{
    return await Promise.race([(async()=>{const res=await fetch("/api/support",body?{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body),signal:ctrl.signal,cache:"no-store"}:{cache:"no-store",signal:ctrl.signal});
    const j=await res.json();if(!res.ok){const e=Error(j.error||"تعذر الاتصال");e.code=j.code;e.status=res.status;throw e;}return j;})(),cancelled]);
  }catch(e){if(ctrl.signal.aborted)throw Error("انتهت مهلة الاتصال أو أُلغيت العملية");throw e;}
  finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);ctrl.signal.removeEventListener("abort",rejectAbort);}
}
// Fictional preview only, isolated to this browser and preview origin.
// Production never invokes this function; no push or network writes.
const demoKey="ck_support_demo_threads_v1",demoFlag="ck_support_demo_flag_v1";
function demoAPI(b){
  let rows=JSON.parse(localStorage.getItem(demoKey)||"[]");
  const enabled=localStorage.getItem(demoFlag)!=="off";
  const out=t=>{const {secret,...safe}=t;return safe;};
  if(!b||b.action==="adminConfig")return {enabled};
  if(b.action==="setEnabled"){localStorage.setItem(demoFlag,b.enabled?"on":"off");return {enabled:b.enabled};}
  if(b.action==="adminList")return {enabled,records:rows.slice().reverse().map(out),total:rows.length,nextCursor:null};
  if(!enabled){const e=Error("نظام المراسلات متوقف");e.code="DISABLED";throw e;}
  if(b.action==="create"){
    let t=rows.find(r=>r.id===b.id);
    if(!t){const timestamp=new Date().toISOString();t={id:b.id,secret:b.secret,type:b.type,state:"new",record:{timestamp,text:b.text,items:[],status:b.kind==="order"?"order-attempt":"general-feedback"},messages:[],updatedAt:timestamp,subscribed:false};rows.push(t);}
    if(t.secret!==b.secret)throw Error("المحادثة غير متاحة");
    localStorage.setItem(demoKey,JSON.stringify(rows));return {ok:true,thread:out(t)};
  }
  if(b.action==="inbox")return {records:rows.filter(t=>b.keys.some(k=>k.id===t.id&&k.secret===t.secret)).map(out)};
  const t=rows.find(r=>r.id===b.id&&(b.action.startsWith("admin")||r.secret===b.secret));
  if(!t)throw Error("المحادثة غير متاحة");
  if(b.action==="message"||b.action==="adminReply"){
    if(t.state==="resolved")throw Error("المحادثة مغلقة");
    const role=b.action==="adminReply"?"admin":"visitor";
    if(!t.messages.some(m=>m.id===b.op&&m.role===role)){t.messages.push({id:b.op,role,text:b.text,timestamp:new Date().toISOString()});t.state=role==="admin"?"answered":"new";}
  }else if(b.action==="adminState")t.state=b.state;
  else if(b.action==="subscribe"||b.action==="unsubscribe")t.subscribed=b.action==="subscribe";
  else throw Error("عملية غير صالحة");
  t.updatedAt=new Date().toISOString();localStorage.setItem(demoKey,JSON.stringify(rows));return {ok:true,thread:out(t),push:t.subscribed?"demo":"not-subscribed"};
}
