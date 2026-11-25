import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";
import { json, noContent, corsHeaders, isSameOrigin, clientIp, rateLimit, isProductionRequest } from "../lib/auth.js";
import { buildOrder } from "../lib/order.js";

async function telegram(token, method, payload) {
  try {
    const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload), signal: AbortSignal.timeout(5000)
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
async function deliver(token, chatId, order, origin) {
  // Split on code points so no malformed Unicode is sent.
  const chars = Array.from(order.text);
  for (let i = 0; i < chars.length; i += 1800) {
    if (!await telegram(token,"sendMessage",{chat_id:chatId,text:chars.slice(i,i+1800).join(""),disable_web_page_preview:true})) return {sent:false,photos:0};
  }
  const images = order.items.map(i => ({type:"photo",media:photoURL(i.image,origin),caption:Array.from(i.name+" × "+i.qty).slice(0,450).join("")})).filter(i => i.media);
  let photos = 0;
  // Send albums in chunks of up to ten, with a bounded number of requests.
  for(let i=0;i<images.length;i+=10) {
    const batch=images.slice(i,i+10);
    const ok=batch.length===1
      ? await telegram(token,"sendPhoto",{chat_id:chatId,photo:batch[0].media,caption:batch[0].caption})
      : await telegram(token,"sendMediaGroup",{chat_id:chatId,media:batch});
    if(ok)photos+=batch.length;
    else {
      const links=batch.map(x=>x.caption+"\n"+x.media);
      let text="صور لم يتم إرفاقها — روابط الصور:";
      for(const link of links){
        if(text.length+link.length>3500){await telegram(token,"sendMessage",{chat_id:chatId,text,disable_web_page_preview:true});text="صور الطلب:";}
        text+="\n"+link;
      }
      if(text.length>20)await telegram(token,"sendMessage",{chat_id:chatId,text,disable_web_page_preview:true});
    }
  }
  return {sent:true,photos};
}
export default async (req, context) => {
  const cors = corsHeaders(req,"POST, OPTIONS");
  if(req.method==="OPTIONS") return noContent(cors);
  if(req.method!=="POST") return json({error:"Method not allowed"},405,cors);
  if(!isSameOrigin(req,true)) return json({error:"غير مسموح"},403,cors);
  const origin = new URL(req.url).origin;
  const production = new URL(process.env.URL || "https://maarefmarket.netlify.app").origin;
  if(!isProductionRequest(req)) return json({ok:true,preview:true},200,cors);
  const rl = await rateLimit("notify",clientIp(req,context),{limit:10,windowMs:600000});
  if(!rl.allowed) return json({ok:false},429,{...cors,"Retry-After":String(rl.retryAfterSec)});
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
  let order;
  try { order=buildOrder(catalog,body); } catch { return json({error:"بيانات الطلب غير صالحة"},400,cors); }
  if(process.env.WA_LOG==="1" && order.kind==="order") {
    try {
      const key="order-"+Date.now()+"-"+randomUUID()+".json";
      await getStore({name:"campuskart-orders"}).setJSON(key,{timestamp:new Date().toISOString(),store:order.store,text:order.text,items:order.items});
    } catch { console.error("Order logging failed"); }
  }
  const token=process.env.TELEGRAM_BOT_TOKEN || "";
  const chats=[...new Set((process.env.TELEGRAM_CHAT_IDS||"").split(",").map(s=>s.trim()).filter(s=>/^-?\d+$/.test(s)))].slice(0,10);
  if(!token||!chats.length) return json({ok:true,sent:0,photos:0},200,cors);
  const results=await Promise.all(chats.map(id=>deliver(token,id,order,production)));
  return json({ok:results.some(r=>r.sent),sent:results.filter(r=>r.sent).length,photos:results.reduce((n,r)=>n+r.photos,0)},200,cors);
};
export const config={path:"/api/notify",rateLimit:{windowLimit:20,windowSize:60,aggregateBy:["ip","domain"]}};
