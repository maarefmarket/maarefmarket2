import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";
import { json, noContent, corsHeaders, isSameOrigin, clientIp, rateLimit, isProductionRequest } from "../lib/auth.js";
import { buildOrder } from "../lib/order.js";

async function telegram(token, method, payload) {
  try {
    const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "POST", ...(payload instanceof FormData ? {body:payload} : {headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}), signal: AbortSignal.timeout(5000)
    });
    return res.ok && (await res.json()).ok === true;
  } catch { console.error("Telegram delivery failed"); return false; }
}
function photoURL(value, origin) {
  try {
    if (!/^\/api\/image\/[a-z0-9]{6,40}\.(jpg|png|webp|gif)$/.test(value) && !/^https:\/\//i.test(value)) return "";
    const u = new URL(value, origin);
    if (u.protocol !== "https:" || u.username || u.password) return "";
    return u.href;
  } catch { return ""; }
}
const IMAGE_NAME = /^\/api\/image\/([a-z0-9]{6,40}\.(jpg|png|webp|gif))$/;
const IMAGE_MIME = {jpg:"image/jpeg",png:"image/png",webp:"image/webp",gif:"image/gif"};
function internalImage(value,origin) {
  try {
    const u=new URL(value,origin);
    return u.origin===origin&&!u.search&&!u.hash?IMAGE_NAME.exec(u.pathname):null;
  }catch{return null;}
}
async function loadPhotos(order,origin){
  const images=order.items.map(i=>({url:photoURL(i.image,origin),caption:Array.from(i.name+" × "+i.qty).slice(0,450).join(""),image:i.image})).filter(i=>i.url);
  const store=getStore({name:"campuskart-images",consistency:"strong"});
  // Read stored photos directly. Never fetch arbitrary external URLs on the server.
  // Bound the total file payload; remaining images can still be sent by URL.
  let bytes=0;
  for(const image of images.slice(0,10)){
    const match=internalImage(image.image,origin);
    if(!match)continue;
    try{
      const blob=await store.get(match[1],{type:"arrayBuffer"});
      if(blob?.byteLength&&blob.byteLength<=5*1024*1024&&bytes+blob.byteLength<=20*1024*1024){
        image.file=new Blob([blob],{type:IMAGE_MIME[match[2]]});image.filename=match[1];bytes+=blob.byteLength;
      }
    }catch{console.error("Stored order image unavailable");}
  }
  return images;
}
async function sendBatch(token,chatId,batch){
  if(batch.length===1){
    const i=batch[0];
    if(!i.file)return telegram(token,"sendPhoto",{chat_id:chatId,photo:i.url,caption:i.caption});
    const form=new FormData();form.set("chat_id",chatId);form.set("caption",i.caption);form.set("photo",i.file,i.filename);
    if(await telegram(token,"sendPhoto",form))return true;
    const document=new FormData();document.set("chat_id",chatId);document.set("caption",i.caption);document.set("document",i.file,i.filename);
    return telegram(token,"sendDocument",document);
  }
  if(!batch.some(i=>i.file))return telegram(token,"sendMediaGroup",{chat_id:chatId,media:batch.map(i=>({type:"photo",media:i.url,caption:i.caption}))});
  const form=new FormData();form.set("chat_id",chatId);
  const media=batch.map((i,n)=>{
    if(i.file)form.set("file"+n,i.file,i.filename);
    return {type:"photo",media:i.file?"attach://file"+n:i.url,caption:i.caption};
  });
  form.set("media",JSON.stringify(media));return telegram(token,"sendMediaGroup",form);
}
async function deliver(token,chatId,order,images){
  const chars=Array.from(order.text);
  for(let i=0;i<chars.length;i+=1800){
    if(!await telegram(token,"sendMessage",{chat_id:chatId,text:chars.slice(i,i+1800).join(""),disable_web_page_preview:true}))return {sent:false,photos:0};
  }
  let photos=0;const failed=[];const deadline=Date.now()+16000;
  for(let i=0;i<images.length;i+=5){
    const batch=images.slice(i,i+5);
    if(Date.now()>deadline){failed.push(...batch);continue;}
    if(await sendBatch(token,chatId,batch)){photos+=batch.length;continue;}
    // A rejected album must not prevent the other product photos from arriving.
    for(const photo of batch){
      if(Date.now()>deadline){failed.push(photo);continue;}
      if(await sendBatch(token,chatId,[photo]))photos++;else failed.push(photo);
    }
  }
  if(failed.length){
    let message="صور لم يتم إرفاقها — روابط الصور:";
    for(const photo of failed){
      const line=photo.caption+"\n"+photo.url;
      if(message.length+line.length>3500){await telegram(token,"sendMessage",{chat_id:chatId,text:message,disable_web_page_preview:true});message="صور الطلب:";}
      message+="\n"+line;
    }
    await telegram(token,"sendMessage",{chat_id:chatId,text:message,disable_web_page_preview:true});
  }
  return {sent:true,photos,failed:failed.length};
}
export default async (req, context) => {
  const cors = corsHeaders(req,"POST, OPTIONS");
  if(req.method==="OPTIONS") return noContent(cors);
  if(req.method!=="POST") return json({error:"Method not allowed"},405,cors);
  if(!isSameOrigin(req,true)) return json({error:"غير مسموح"},403,cors);
  const origin = new URL(req.url).origin;
  const production = new URL(process.env.URL || "https://maarefmarket.netlify.app").origin;
  const preview=!isProductionRequest(req);
  if(!preview){const rl=await rateLimit("notify",clientIp(req,context),{limit:10,windowMs:600000});if(!rl.allowed)return json({ok:false},429,{...cors,"Retry-After":String(rl.retryAfterSec)});}
  let body;
  try {
    if(Number(req.headers.get("content-length")||0)>16000) return json({ok:false},413,cors);
    const raw=await req.text();
    if(Buffer.byteLength(raw,"utf8")>16000) return json({ok:false},413,cors);
    body=JSON.parse(raw);
  } catch { return json({error:"JSON غير صالح"},400,cors); }
  let catalog;
  try { catalog=await getStore({name:"campuskart-data",consistency:"strong"}).get("store.json",{type:"json"}); }
  catch { return json({ok:false},503,cors); }
  if(!catalog) return json({ok:false},503,cors);
  if(catalog.settings?.maintenanceMode===true)return json({ok:false,error:"المتجر قيد الصيانة"},503,{...cors,"Retry-After":"60"});
  let order;
  try { order=buildOrder(catalog,body); } catch { return json({error:"بيانات الطلب غير صالحة"},400,cors); }
  if(preview)return json({ok:true,preview:true,expectedPhotos:order.items.filter(i=>photoURL(i.image,production)).length,sent:0,photos:0},200,cors);
  if(process.env.WA_LOG==="1" && order.kind==="order") {
    try {
      const key="order-"+Date.now()+"-"+randomUUID()+".json";
      await getStore({name:"campuskart-orders"}).setJSON(key,{timestamp:new Date().toISOString(),store:order.store,text:order.text,items:order.items});
    } catch { console.error("Order logging failed"); }
  }
  const token=process.env.TELEGRAM_BOT_TOKEN || "";
  const chats=[...new Set((process.env.TELEGRAM_CHAT_IDS||"").split(",").map(s=>s.trim()).filter(s=>/^-?\d+$/.test(s)))].slice(0,10);
  if(!token||!chats.length) return json({ok:true,telegramConfigured:false,sent:0,photos:0},200,cors);
  const images=await loadPhotos(order,production);
  const results=await Promise.all(chats.map(id=>deliver(token,id,order,images)));
  return json({ok:results.some(r=>r.sent),sent:results.filter(r=>r.sent).length,photos:results.reduce((n,r)=>n+r.photos,0),expectedPhotos:images.length*chats.length},200,cors);
};
export const config={path:"/api/notify",rateLimit:{windowLimit:20,windowSize:60,aggregateBy:["ip","domain"]}};
