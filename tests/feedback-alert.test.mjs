import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {notifyFeedbackAdmin} from "../netlify/lib/feedback-alert.js";

test("admin Telegram alerts use configured destinations once and contain no private message data",async()=>{
  const calls=[];
  const result=await notifyFeedbackAdmin("new",{env:{TELEGRAM_BOT_TOKEN:"test-token",TELEGRAM_CHAT_IDS:"123,123,-456,bad"},send:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true};}});
  assert.equal(result,true);
  assert.deepEqual(calls.map(x=>x.body.chat_id),["123","-456"]);
  assert.ok(calls.every(x=>x.url.endsWith("/sendMessage")&&x.body.text.includes("رأي جديد")&&x.body.text.includes("https://maarefmarket.netlify.app/admin")));
  assert.ok(calls.every(x=>Object.keys(x.body).sort().join(",")==="chat_id,disable_web_page_preview,text"));
});
test("missing Telegram configuration or failed network cannot break feedback saving",async()=>{
  assert.equal(await notifyFeedbackAdmin("new",{env:{},send:()=>{throw Error("unexpected call");}}),false);
  assert.equal(await notifyFeedbackAdmin("followup",{env:{TELEGRAM_BOT_TOKEN:"test",TELEGRAM_CHAT_IDS:"123"},send:async()=>{throw Error("offline");}}),false);
});
test("admin has one direct reply dialog, reply links and a separately polled badge",async()=>{
  const read=path=>readFile(new URL(path,import.meta.url),"utf8");
  const [html,admin,support,alerts]=await Promise.all(["../admin.html","../js/admin.js","../js/support-admin.js","../js/admin-feedback-alerts.js"].map(read));
  for(const id of ["supportReplyDialog","supportAdminDetail","adminFeedbackBadge","adminFeedbackBell","feedbackNewOpen"])assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1);
  assert.match(admin,/data-feedback-reply/);
  assert.match(admin,/ckSupportAdmin\?\.openReply/);
  assert.match(support,/request\(\{action:"adminGet",id\}\)/);
  assert.match(support,/replyDialog\.showModal\(\)/);
  assert.match(support,/action:"adminReply"/);
  assert.match(alerts,/setInterval\(poll,30000\)/);
  assert.match(alerts,/!signedIn\(\)/);
});
