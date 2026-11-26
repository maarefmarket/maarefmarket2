import { getDeployStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import webpush from "web-push";
import {json,noContent,corsHeaders,isSameOrigin,isProductionRequest,clientIp} from "../lib/auth.js";
import {cleanSubscription} from "../lib/support.js";

// Actual notification transport test, strictly deploy-scoped. No production
// catalog, feedback, auth, subscription, keys or rate-limit store is accessed.
export default async(req,context)=>{
  const cors=corsHeaders(req),reply=(body,status=200)=>json(body,status,cors);
  if(req.method==="OPTIONS")return noContent(cors);
  const u=new URL(req.url);
  if(isProductionRequest(req)||!/^deploy-preview-\d+--maarefmarket\.netlify\.app$/.test(u.hostname))return reply({error:"اختبار الإشعار متاح في المعاينة فقط"},403);
  try{
    if(req.method!=="GET"&&(req.method!=="POST"||!isSameOrigin(req,true)))return reply({error:"غير مسموح"},403);
    const store=getDeployStore({name:"campuskart-support-push-test",consistency:"strong"});
    let keys=await store.get("vapid",{type:"json"});
    if(!keys){
      await store.setJSON("vapid",webpush.generateVAPIDKeys(),{onlyIfNew:true});
      keys=await store.get("vapid",{type:"json"});
    }
    if(!keys?.publicKey||!keys?.privateKey)throw Error("Missing VAPID");
    if(req.method==="GET")return reply({publicKey:keys.publicKey});
    if(Number(req.headers.get("content-length")||0)>8192)return reply({error:"بيانات كبيرة"},413);
    const raw=await req.text();if(Buffer.byteLength(raw)>8192)return reply({error:"بيانات كبيرة"},413);
    let sub;try{sub=cleanSubscription(JSON.parse(raw).subscription);}catch{return reply({error:"اشتراك غير صالح"},400);}
    const bucket="rate/"+createHash("sha256").update(String(clientIp(req,context))+"|"+Math.floor(Date.now()/600000)).digest("hex");
    let allowed=false;
    for(let i=0;i<4;i++){
      const prev=await store.getWithMetadata(bucket,{type:"json"}),n=Number(prev?.data?.count)||0;
      if(n>=3)break;
      if(prev&&!prev.etag)break;
      const write=await store.setJSON(bucket,{count:n+1},prev?{onlyIfMatch:prev.etag}:{onlyIfNew:true});
      if(write.modified){allowed=true;break;}
    }
    if(!allowed)return reply({error:"تم بلوغ حد الإشعارات التجريبية. حاول لاحقاً."},429);
    await webpush.sendNotification(sub,JSON.stringify({type:"support-reply"}),{TTL:120,timeout:3500,urgency:"normal",vapidDetails:{subject:u.origin,publicKey:keys.publicKey,privateKey:keys.privateKey}});
    return reply({ok:true,accepted:true});
  }catch{console.error("Preview notification unavailable");return reply({error:"لم يقبل مزوّد الإشعارات الاختبار. جرّب متصفحاً مدعوماً أو أعد الاشتراك."},503);}
};
export const config={path:"/api/support-preview",rateLimit:{windowLimit:15,windowSize:60,aggregateBy:["ip","domain"]}};
