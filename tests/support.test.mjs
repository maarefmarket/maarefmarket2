import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {createSupportHandler} from "../netlify/functions/support.js";
import {createThread,owns,publicThread,addMessage,cleanSubscription,mutateThread} from "../netlify/lib/support.js";

const id=()=>Date.now()+"-"+randomUUID(),secret="a".repeat(64),wrong="b".repeat(64);
const origin="https://maarefmarket.netlify.app";
const fakeSub={endpoint:"https://fcm.googleapis.com/fcm/send/test",keys:{p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,1)]).toString("base64url"),auth:Buffer.alloc(16,2).toString("base64url")}};
function fixture(){
  const buckets=new Map();let etag=0,pushCalls=[],pushFailure=false,alerts=[];
  function getStore({name}){
    if(!buckets.has(name))buckets.set(name,new Map());
    const db=buckets.get(name);
    return {
      async get(k){return structuredClone(db.get(k)?.data??null);},
      async getWithMetadata(k){return structuredClone(db.get(k)??null);},
      async setJSON(k,data,opts={}){
        const prev=db.get(k);
        if(opts.onlyIfNew&&prev||opts.onlyIfMatch&&prev?.etag!==opts.onlyIfMatch)return {modified:false};
        db.set(k,{data:structuredClone(data),etag:String(++etag)});return {modified:true};
      },
      async list({prefix}){return {blobs:[...db.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))};}
    };
  }
  const handler=createSupportHandler({getStore,notifyAdmin:async kind=>{alerts.push(kind);},requireAuth:req=>req.headers.get("authorization")==="Bearer test-admin"?null:new Response("denied",{status:401}),rateLimit:async()=>({allowed:true}),webpush:{generateVAPIDKeys:()=>({publicKey:"public",privateKey:"private"}),sendNotification:async(sub,payload,options)=>{pushCalls.push({sub,payload,options});if(pushFailure)throw Error("offline");}}});
  const call=async(body,admin=false,url=origin+"/api/support")=>{
    const res=await handler(new Request(url,body===undefined?{}:{method:"POST",headers:{Origin:new URL(url).origin,"Content-Type":"application/json",...(admin?{Authorization:"Bearer test-admin"}:{})},body:JSON.stringify(body)}),{ip:"test"});
    return {status:res.status,body:await res.json().catch(()=>null)};
  };
  return {getStore,call,buckets,pushCalls,alerts,failPush(){pushFailure=true;}};
}
async function setup(f){
  await f.getStore({name:"campuskart-data"}).setJSON("store.json",{settings:{storeName:"Test",rates:{USD_TRY:33,USD_SYP:14000}},categories:[],banners:[],products:[{id:1,name:"Product",prices:{USD:1.25}}]});
  await f.call({action:"setEnabled",enabled:true},true);
}
const create=(threadId=id(),kind="general")=>({action:"create",id:threadId,secret,type:"complaint",text:"مشكلة تجريبية",kind,items:kind==="order"?[{id:1,qty:2}]:[]});
test("support defaults off, preview cannot read or write production and toggle requires admin",async()=>{
  const f=fixture();
  assert.deepEqual((await f.call()).body,{enabled:false});
  assert.equal((await f.call({action:"setEnabled",enabled:true})).status,401);
  assert.equal((await f.call(create())).status,409);
  const before=f.buckets.size;
  assert.equal((await f.call({action:"setEnabled",enabled:true},true,"https://deploy-preview-14--maarefmarket.netlify.app/api/support")).status,403);
  assert.equal(f.buckets.size,before);
});
test("anonymous creation and retry preserve legacy log and require unguessable secret",async()=>{
  const f=fixture();await setup(f);const body=create();
  const first=await f.call(body);assert.equal(first.status,200);
  assert.equal(first.body.thread.record.text,body.text);
  assert.equal(first.body.thread.hash,undefined);
  assert.equal(first.body.thread.subscription,undefined);
  assert.equal((await f.call(body)).status,200);
  assert.equal(f.buckets.get("campuskart-feedback").size,1);
  assert.equal((await f.call({...body,secret:wrong})).status,404);
  assert.deepEqual((await f.call({action:"inbox",keys:[{id:body.id,secret:wrong}]})).body.records,[]);
  assert.equal((await f.call({action:"adminList"})).status,401);
  const own=(await f.call({action:"inbox",keys:[{id:body.id,secret}]})).body.records;
  assert.equal(own.length,1);assert.equal(own[0].record.items.length,0);
});
test("checkout feedback retains trusted product snapshot and no personal fields",async()=>{
  const f=fixture();await setup(f);const body=create(id(),"order");
  const r=await f.call({...body,name:"private",phone:"123"});
  assert.equal(r.status,200);assert.equal(r.body.thread.record.items[0].total,2.5);
  assert.equal(r.body.thread.record.name,undefined);assert.equal(r.body.thread.record.phone,undefined);
});
test("reply persists independently of push delivery; duplicate retries do not re-send",async()=>{
  const f=fixture();await setup(f);const body=create();await f.call(body);
  assert.equal((await f.call({action:"subscribe",id:body.id,secret,subscription:fakeSub})).status,200);
  const op=randomUUID(),reply={action:"adminReply",id:body.id,op,text:"رد الإدارة"};
  assert.equal((await f.call(reply)).status,401);
  f.failPush();const sent=await f.call(reply,true);
  assert.equal(sent.status,200);assert.equal(sent.body.push,"failed");
  assert.equal(f.pushCalls.length,1);
  assert.equal(f.pushCalls[0].payload,'{"type":"support-reply"}');
  assert.equal((await f.call(reply,true)).body.push,"not-sent");
  assert.equal(f.pushCalls.length,1);
  const t=(await f.call({action:"inbox",keys:[{id:body.id,secret}]})).body.records[0];
  assert.equal(t.state,"answered");assert.equal(t.messages.length,1);assert.equal(t.messages[0].text,"رد الإدارة");
  assert.equal(t.subscription,undefined);
  assert.equal((await f.call({action:"message",id:body.id,secret:wrong,op:randomUUID(),text:"bad"})).status,404);
  assert.equal((await f.call({action:"message",id:body.id,secret,op:randomUUID(),text:"متابعة"})).body.thread.state,"new");
});
test("disable restores legacy mode without deleting old or new messages",async()=>{
  const f=fixture();await setup(f);const body=create();await f.call(body);
  await f.call({action:"adminState",id:body.id,state:"resolved"},true);
  assert.equal((await f.call({action:"message",id:body.id,secret,op:randomUUID(),text:"follow"})).status,503);
  const before=JSON.stringify([...f.buckets.get("campuskart-feedback")]);
  await f.call({action:"setEnabled",enabled:false},true);
  assert.equal((await f.call({action:"inbox",keys:[{id:body.id,secret}]})).status,409);
  assert.equal((await f.call({action:"adminList"},true)).body.records.length,1);
  await f.call({action:"setEnabled",enabled:true},true);
  assert.equal((await f.call({action:"inbox",keys:[{id:body.id,secret}]})).body.records[0].state,"resolved");
  assert.equal(JSON.stringify([...f.buckets.get("campuskart-feedback")]),before);
});
test("subscription endpoints are allowlisted and private capability is not exposed",()=>{
  for(const endpoint of ["http://fcm.googleapis.com/test","https://127.0.0.1/test","https://fcm.googleapis.com.evil.example/test","https://user@fcm.googleapis.com/test","https://fcm.googleapis.com:8080/test"])assert.throws(()=>cleanSubscription({...fakeSub,endpoint}));
  assert.deepEqual(cleanSubscription(fakeSub),fakeSub);
  const t=createThread({timestamp:new Date().toISOString(),text:"test",items:[]},id(),secret,"question");
  assert.equal(owns(t,secret),true);assert.equal(owns(t,wrong),false);assert.equal(publicThread(t).hash,undefined);
});
test("conditional thread updates retry contention without losing messages",async()=>{
  const f=fixture();const s=f.getStore({name:"test"});const t=createThread({timestamp:new Date().toISOString(),text:"test",items:[]},id(),secret,"question");await s.setJSON("thread",t);
  await Promise.all([mutateThread(s,"thread",x=>addMessage(x,"admin","one",randomUUID())),mutateThread(s,"thread",x=>addMessage(x,"visitor","two",randomUUID()))]);
  assert.equal((await s.get("thread")).messages.length,2);
});
test("worker does not cache or intercept storefront traffic",async()=>{
  const source=await readFile(new URL("../support-sw.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/addEventListener\(["']fetch|caches\./);
  assert.match(source,/addEventListener\("push"/);
});

test("new opinion and followup alert once, direct reply lookup is admin-only",async()=>{
  const f=fixture();await setup(f);const body=create();
  await f.call(body);await f.call(body);
  assert.deepEqual(f.alerts,["new"]);
  const lookup={action:"adminGet",id:body.id};
  assert.equal((await f.call(lookup)).status,401);
  const direct=await f.call(lookup,true);
  assert.equal(direct.body.thread.id,body.id);
  assert.equal(direct.body.thread.hash,undefined);
  assert.equal(direct.body.enabled,true);
  const follow={action:"message",id:body.id,secret,op:randomUUID(),text:"متابعة"};
  await f.call(follow);await f.call(follow);
  assert.deepEqual(f.alerts,["new","followup"]);
  assert.equal((await f.call({...lookup,id:id()},true)).body.code,"NO_THREAD");
  await f.call({action:"setEnabled",enabled:false},true);
  assert.equal((await f.call(lookup,true)).body.enabled,false);
});
