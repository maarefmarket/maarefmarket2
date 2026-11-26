import { getStore } from "@netlify/blobs";
import { createHmac } from "node:crypto";
import { json,noContent,corsHeaders,isSameOrigin,isProductionRequest,requireAuth,clientIp,rateLimit } from "../lib/auth.js";
import { buildOrder } from "../lib/order.js";
import { notifyFeedbackAdmin } from "../lib/feedback-alert.js";

const STORE="campuskart-feedback", MAX_TEXT=1500, PAGE=25;
const ID_RE=/^(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function monthKey(date){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Damascus",year:"numeric",month:"2-digit"}).formatToParts(date);
  return parts.find(p=>p.type==="year").value+"-"+parts.find(p=>p.type==="month").value;
}
export function makeRecord(catalog,body,now=new Date()){
  if(typeof body?.text!=="string")throw Error("Invalid feedback");
  const text=body.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,"").trim();
  if(!text||text.length>MAX_TEXT)throw Error("Invalid feedback length");
  const m=ID_RE.exec(String(body.id||""));
  if(!m||Math.abs(now.getTime()-Number(m[1]))>15*60*1000)throw Error("Invalid feedback id");
  if(catalog?.settings?.maintenanceMode===true)throw Error("Store under maintenance");
  const general=body.kind==="general";
  if(body.kind!==undefined&&body.kind!=="order"&&!general)throw Error("Invalid feedback kind");
  if(general&&(!Array.isArray(body.items)||body.items.length))throw Error("General feedback cannot contain order items");
  const order=general?{items:[]}:buildOrder(catalog,{items:body.items,notes:""});
  const key="feedback/"+monthKey(new Date(Number(m[1])))+"/"+m[0].toLowerCase()+".json";
  // Only the opinion and intended product selections are persisted. No IP,
  // name, contact details, user-agent, order notes or account identifier.
  return {key,record:{timestamp:now.toISOString(),text,items:order.items.map(({id,variant,name,qty,cur,unit,total})=>({id,variant,name,qty,cur,unit,total})),status:general?"general-feedback":"order-attempt"}};
}
export default async(req,context)=>{
  const cors=corsHeaders(req,"GET, POST, OPTIONS");
  if(req.method==="OPTIONS")return noContent(cors);
  if(req.method==="GET"){
    const denied=requireAuth(req);if(denied)return denied;
    try{
      const u=new URL(req.url),month=u.searchParams.get("month")||monthKey(new Date());
      if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return json({error:"شهر غير صالح"},400,cors);
      const prefix="feedback/"+month+"/",cursor=u.searchParams.get("cursor")||"";
      if(cursor&&(!cursor.startsWith(prefix)||!ID_RE.test(cursor.slice(prefix.length,-5))||!cursor.endsWith(".json")))return json({error:"صفحة غير صالحة"},400,cors);
      const store=getStore({name:STORE,consistency:"strong"});
      const {blobs}=await store.list({prefix});
      const keys=blobs.map(b=>b.key).filter(k=>k.startsWith(prefix)&&k.endsWith(".json")&&ID_RE.test(k.slice(prefix.length,-5))).sort().reverse();
      if(u.searchParams.get("status")==="1"){
        const since=u.searchParams.get("since")||"";
        const unread=since&&since.startsWith(prefix)?keys.filter(k=>k>since).length:keys.length;
        return json({month,total:keys.length,unread,latest:keys[0]||""},200,cors);
      }
      const eligible=cursor?keys.filter(k=>k<cursor):keys;
      const page=eligible.slice(0,PAGE);
      const support=getStore({name:"campuskart-support-v1",consistency:"strong"});
      const records=(await Promise.all(page.map(async k=>{
        const record=await store.get(k,{type:"json"});if(!record)return null;
        const id=k.slice(prefix.length,-5);
        // Old records use the identical ID as their support mirror, if one exists.
        let replyable=null;try{replyable=!!(await support.get("threads/"+id+".json",{type:"json"}));}catch{}
        return {...record,id,replyable};
      }))).filter(Boolean);
      return json({records,month,total:keys.length,nextCursor:eligible.length>PAGE?page.at(-1):null},200,cors);
    }catch{console.error("Feedback list unavailable");return json({error:"تعذر تحميل سجل الآراء"},503,cors);}
  }
  if(req.method!=="POST")return json({error:"Method not allowed"},405,cors);
  if(!isSameOrigin(req,true))return json({error:"غير مسموح"},403,cors);
  if(!isProductionRequest(req))return json({ok:true,preview:true},200,cors);
  // Limit spam with a separate keyed digest, not an address in the feedback log.
  const secret=process.env.SESSION_SECRET||process.env.ADMIN_PASSWORD||"campuskart-feedback";
  const bucket=createHmac("sha256",secret).update(new Date().toISOString().slice(0,10)+"|"+clientIp(req,context)).digest("hex");
  const rl=await rateLimit("feedback",bucket,{limit:15,windowMs:600000});
  if(!rl.allowed)return json({error:"محاولات كثيرة، حاول لاحقاً"},429,{...cors,"Retry-After":String(rl.retryAfterSec)});
  let body;
  try{
    if(Number(req.headers.get("content-length")||0)>16000)return json({error:"الطلب كبير"},413,cors);
    const raw=await req.text();if(Buffer.byteLength(raw,"utf8")>16000)return json({error:"الطلب كبير"},413,cors);
    body=JSON.parse(raw);
  }catch{return json({error:"بيانات غير صالحة"},400,cors);}
  try{
    const catalog=await getStore({name:"campuskart-data",consistency:"strong"}).get("store.json",{type:"json"});
    if(!catalog||catalog.settings?.maintenanceMode===true)return json({error:"المتجر غير متاح حالياً"},503,cors);
    let entry;try{entry=makeRecord(catalog,body);}catch{return json({error:"تعذر حفظ الرأي: تحقق من النص والبيانات"},400,cors);}
    const store=getStore({name:STORE,consistency:"strong"});
    const written=await store.setJSON(entry.key,entry.record,{onlyIfNew:true});
    if(written.modified)await notifyFeedbackAdmin("new");
    return json({ok:true},200,cors);
  }catch{console.error("Feedback save unavailable");return json({error:"تعذر حفظ الرأي؛ أعد المحاولة"},503,cors);}
};
export const config={path:"/api/feedback",rateLimit:{windowLimit:30,windowSize:60,aggregateBy:["ip","domain"]}};
