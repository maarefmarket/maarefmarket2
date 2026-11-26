import { createHash, timingSafeEqual } from "node:crypto";
export const ID=/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SECRET=/^[a-f0-9]{64}$/;
export const TYPES=["suggestion","complaint","question"];
export const STATES=["new","answered","resolved"];
export const hashSecret=secret=>createHash("sha256").update(secret).digest("hex");
export function owns(thread,secret){
  if(!thread||!SECRET.test(String(secret||""))||!SECRET.test(String(thread.hash||"")))return false;
  return timingSafeEqual(Buffer.from(thread.hash,"hex"),Buffer.from(hashSecret(secret),"hex"));
}
export function threadKey(id){
  if(!ID.test(String(id||"")))throw Error("معرّف محادثة غير صالح");
  return "threads/"+id.toLowerCase()+".json";
}
export function cleanText(value){
  if(typeof value!=="string")throw Error("اكتب الرسالة أولاً");
  const text=value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,"").trim();
  if(!text||text.length>1500)throw Error("الرسالة من 1 إلى 1500 حرف");
  return text;
}
export function createThread(record,id,secret,type){
  threadKey(id);
  if(!SECRET.test(String(secret||""))||!TYPES.includes(type))throw Error("بيانات المتابعة غير صالحة");
  return {id:id.toLowerCase(),hash:hashSecret(secret),type,state:"new",record,updatedAt:record.timestamp,messages:[],subscription:null};
}
export function publicThread(t){
  return {id:t.id,type:t.type,state:t.state,record:t.record,updatedAt:t.updatedAt,messages:t.messages,subscribed:!!t.subscription};
}
export function addMessage(thread,role,text,op,now=new Date()){
  if(!["admin","visitor"].includes(role)||!/^[a-f0-9-]{36}$/i.test(String(op||"")))throw Error("بيانات الرسالة غير صالحة");
  if(thread.messages.some(m=>m.id===op&&m.role===role))return false;
  if(thread.state==="resolved")throw Error("المحادثة مغلقة");
  if(thread.messages.length>=100)throw Error("وصلت المحادثة إلى الحد الأقصى؛ افتح رسالة جديدة");
  thread.messages.push({id:op,role,text:cleanText(text),timestamp:now.toISOString()});
  thread.updatedAt=now.toISOString();thread.state=role==="admin"?"answered":"new";return true;
}
// Restrict the server's outbound network targets to known browser push providers.
export function cleanSubscription(raw){
  if(!raw||typeof raw.endpoint!=="string"||raw.endpoint.length>2048)throw Error("اشتراك غير صالح");
  const u=new URL(raw.endpoint),h=u.hostname.toLowerCase();
  const allowed=h==="fcm.googleapis.com"||h==="updates.push.services.mozilla.com"||h==="web.push.apple.com"||h.endsWith(".push.apple.com")||h.endsWith(".notify.windows.com")||h.endsWith(".push.microsoft.com");
  if(!allowed||u.protocol!=="https:"||u.port||u.username||u.password||u.hash)throw Error("مزود الإشعارات غير مدعوم");
  const p=raw.keys?.p256dh,a=raw.keys?.auth;
  if(typeof p!=="string"||typeof a!=="string"||!/^[A-Za-z0-9_-]{87}$/.test(p)||!/^[A-Za-z0-9_-]{22}$/.test(a)||Buffer.from(p,"base64url")[0]!==4)throw Error("مفاتيح الاشتراك غير صالحة");
  return {endpoint:u.href,keys:{p256dh:p,auth:a}};
}
export async function mutateThread(store,key,change){
  for(let i=0;i<4;i++){
    const current=await store.getWithMetadata(key,{type:"json"});
    if(!current?.data||!current.etag)throw Error("المحادثة غير متاحة");
    const next=structuredClone(current.data),changed=await change(next);
    if(changed===false)return {thread:current.data,changed:false};
    const result=await store.setJSON(key,next,{onlyIfMatch:current.etag});
    if(result.modified)return {thread:next,changed:true};
  }
  throw Error("تغيرت المحادثة، أعد المحاولة");
}
