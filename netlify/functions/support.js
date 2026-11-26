import { getStore } from "@netlify/blobs";
import { createHmac } from "node:crypto";
import webpush from "web-push";
import { json,noContent,corsHeaders,isSameOrigin,isProductionRequest,requireAuth,clientIp,rateLimit } from "../lib/auth.js";
import { makeRecord,monthKey } from "./feedback.js";
import { ID,SECRET,TYPES,STATES,owns,threadKey,createThread,publicThread,addMessage,cleanSubscription,mutateThread } from "../lib/support.js";
const storeFor=()=>getStore({name:"campuskart-support-v1",consistency:"strong"});
const readConfig=async store=>({enabled:(await store.get("config",{type:"json"}))?.enabled===true});
async function vapid(store){
  let keys=await store.get("vapid",{type:"json"});
  if(!keys){
    await store.setJSON("vapid",webpush.generateVAPIDKeys(),{onlyIfNew:true});
    keys=await store.get("vapid",{type:"json"});
  }
  if(!keys?.publicKey||!keys?.privateKey)throw Error("الإشعارات غير متاحة");
  return keys;
}
async function sendPush(store,t,req){
  if(!t.subscription)return "not-subscribed";
  try{
    if(!(await readConfig(store)).enabled)return "disabled";
    const keys=await vapid(store);
    await webpush.sendNotification(t.subscription,JSON.stringify({type:"support-reply"}),{
      TTL:86400,urgency:"normal",topic:"support-reply",timeout:3500,
      vapidDetails:{subject:new URL(req.url).origin,publicKey:keys.publicKey,privateKey:keys.privateKey}
    });
    return "accepted";
  }catch(e){
    if([404,410].includes(e?.statusCode)){
      try{await mutateThread(store,threadKey(t.id),x=>{
        if(x.subscription?.endpoint!==t.subscription.endpoint)return false;
        x.subscription=null;return true;
      });}catch{}
      return "expired";
    }
    return "failed";
  }
}
async function limited(req,context,bucket,limit,windowMs){
  const key=createHmac("sha256",process.env.SESSION_SECRET||process.env.ADMIN_PASSWORD||"support-rate").update(new Date().toISOString().slice(0,10)+"|"+clientIp(req,context)).digest("hex");
  return rateLimit(bucket,key,{limit,windowMs});
}
export default async(req,context)=>{
  const cors=corsHeaders(req,"GET, POST, OPTIONS"),reply=(body,status=200)=>json(body,status,cors);
  if(req.method==="OPTIONS")return noContent(cors);
  // Preview demo uses local fictional data. Never touch production support Blobs.
  if(!isProductionRequest(req))return reply(req.method==="GET"?{enabled:false,preview:true}:{error:"المعاينة محلية فقط"},req.method==="GET"?200:403);
  try{
    const store=storeFor();
    if(req.method==="GET")return reply(await readConfig(store));
    if(req.method!=="POST"||!isSameOrigin(req,true))return reply({error:"غير مسموح"},403);
    if(Number(req.headers.get("content-length")||0)>32000)return reply({error:"الطلب كبير"},413);
    let b;try{const raw=await req.text();if(Buffer.byteLength(raw)>32000)return reply({error:"الطلب كبير"},413);b=JSON.parse(raw);}catch{return reply({error:"بيانات غير صالحة"},400);}
    const action=b?.action,admin=["adminConfig","setEnabled","adminList","adminReply","adminState"].includes(action);
    if(admin){const denied=requireAuth(req);if(denied)return denied;}
    if(action==="adminConfig")return reply(await readConfig(store));
    if(action==="setEnabled"){
      if(typeof b.enabled!=="boolean")return reply({error:"إعداد غير صالح"},400);
      await store.setJSON("config",{enabled:b.enabled});
      return reply(await readConfig(store));
    }
    const enabled=(await readConfig(store)).enabled;
    if(action==="adminList"){
      const month=String(b.month||monthKey(new Date()));
      if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return reply({error:"شهر غير صالح"},400);
      const cursor=String(b.cursor||"");
      if(cursor&&!ID.test(cursor))return reply({error:"صفحة غير صالحة"},400);
      const {blobs}=await store.list({prefix:"threads/"});
      const ids=blobs.map(x=>x.key.slice(8,-5)).filter(id=>ID.test(id)&&monthKey(new Date(Number(id.slice(0,13))))===month).sort().reverse();
      const eligible=cursor?ids.filter(id=>id<cursor):ids,page=eligible.slice(0,25);
      const records=(await Promise.all(page.map(id=>store.get(threadKey(id),{type:"json"})))).filter(Boolean).map(publicThread);
      return reply({enabled,records,total:ids.length,nextCursor:eligible.length>25?page.at(-1):null});
    }
    if(!enabled)return reply({error:"نظام المراسلات متوقف",code:"DISABLED"},409);
    if(!admin){
      const rl=await limited(req,context,action==="create"?"feedback":"support",action==="create"?15:120,600000);
      if(!rl.allowed)return reply({error:"محاولات كثيرة، حاول لاحقاً"},429);
    }
    if(action==="create"){
      if(!SECRET.test(String(b.secret||""))||!ID.test(String(b.id||""))||!TYPES.includes(b.type))return reply({error:"بيانات المتابعة غير صالحة"},400);
      const key=threadKey(b.id);
      let t=await store.get(key,{type:"json"});
      if(t&&!owns(t,b.secret))return reply({error:"المحادثة غير متاحة"},404);
      if(!t){
        const catalog=await getStore({name:"campuskart-data",consistency:"strong"}).get("store.json",{type:"json"});
        if(!catalog||catalog.settings?.maintenanceMode===true)return reply({error:"المتجر غير متاح"},503);
        let entry;try{entry=makeRecord(catalog,b);}catch{return reply({error:"تحقق من النص والطلب"},400);}
        const candidate=createThread(entry.record,b.id,b.secret,b.type);
        await store.setJSON(key,candidate,{onlyIfNew:true});
        t=await store.get(key,{type:"json"});
        if(!owns(t,b.secret))return reply({error:"المحادثة غير متاحة"},404);
      }
      // Keep the original feedback log intact, including when the feature is turned off.
      const legacy=getStore({name:"campuskart-feedback",consistency:"strong"});
      await legacy.setJSON("feedback/"+monthKey(new Date(Number(t.id.slice(0,13))))+"/"+t.id+".json",t.record,{onlyIfNew:true});
      return reply({ok:true,thread:publicThread(t)});
    }
    if(action==="inbox"){
      if(!Array.isArray(b.keys)||b.keys.length>50)return reply({error:"قائمة غير صالحة"},400);
      const rows=await Promise.all(b.keys.map(async x=>{
        if(!ID.test(String(x?.id||""))||!SECRET.test(String(x?.secret||"")))return null;
        const t=await store.get(threadKey(x.id),{type:"json"});
        return owns(t,x.secret)?publicThread(t):null;
      }));
      return reply({records:rows.filter(Boolean)});
    }
    if(action==="publicKey")return reply({publicKey:(await vapid(store)).publicKey});
    if(!ID.test(String(b.id||"")))return reply({error:"المحادثة غير متاحة"},404);
    const key=threadKey(b.id),initial=await store.get(key,{type:"json"});
    if(!initial||(!admin&&!owns(initial,b.secret)))return reply({error:"المحادثة غير متاحة"},404);
    if(action==="subscribe"||action==="unsubscribe"){
      const sub=action==="subscribe"?cleanSubscription(b.subscription):null;
      const r=await mutateThread(store,key,t=>{if(!owns(t,b.secret))throw Error("المحادثة غير متاحة");t.subscription=sub;return true;});
      return reply({ok:true,thread:publicThread(r.thread)});
    }
    if(action==="message"||action==="adminReply"){
      const role=admin?"admin":"visitor";
      const r=await mutateThread(store,key,t=>{if(!admin&&!owns(t,b.secret))throw Error("المحادثة غير متاحة");return addMessage(t,role,b.text,b.op);});
      const push=admin&&r.changed?await sendPush(store,r.thread,req):"not-sent";
      return reply({ok:true,thread:publicThread(r.thread),push});
    }
    if(action==="adminState"){
      if(!STATES.includes(b.state))return reply({error:"حالة غير صالحة"},400);
      const r=await mutateThread(store,key,t=>{if(t.state===b.state)return false;t.state=b.state;t.updatedAt=new Date().toISOString();return true;});
      return reply({ok:true,thread:publicThread(r.thread)});
    }
    return reply({error:"عملية غير صالحة"},400);
  }catch(e){
    // No secrets, message content or endpoint URLs in logs.
    console.error("Support request failed");
    return reply({error:"تعذر إكمال العملية. حاول مرة أخرى."},503);
  }
};
export const config={path:"/api/support",rateLimit:{windowLimit:150,windowSize:60,aggregateBy:["ip","domain"]}};
