import {api,demo,types,states,stamp,randomSecret,validKey,element,button} from "./support-client.js";
const $=id=>document.getElementById(id);
const storageKey="ck_support_keys_v1",dialog=$("supportDialog"),badge=$("supportUnread"),panel=$("supportContent"),status=$("supportStatus");
let enabled=false,rows=[],selected="",generation=0,busy=false,worker=null,publicKey=null,loading=null,lastSynced=0,syncFailed=false,configLoading=null;
const inboxBtn=$("supportInboxBtn");
let keys=[];
function readKeys(){try{keys=JSON.parse(localStorage.getItem(storageKey)||"[]").filter(validKey).slice(0,50);}catch{}}
readKeys();
function saveKeys(next){
  localStorage.setItem(storageKey,JSON.stringify(next));
  keys=next;
}
function getKey(id){return keys.find(k=>k.id===id);}
function unread(t){return t.messages.filter(m=>m.role==="admin").length>(getKey(t.id)?.read||0);}
function renderBadge(){
  const n=rows.filter(unread).length;badge.hidden=!enabled||!n;badge.textContent=n;
}
function notice(text){status.textContent=text||"";}
function setEnabled(value){
  enabled=value===true;inboxBtn.hidden=!enabled;renderBadge();
  if(!enabled&&dialog.open)dialog.close();
}
async function refreshConfig(){
  if(!configLoading)configLoading=(async()=>{try{const c=await api();setEnabled(c.enabled);return enabled;}catch{return enabled;}finally{configLoading=null;}})();
  return configLoading;
}
function drawSync(){
  const el=$("supportSyncStatus");if(!el)return;
  el.replaceChildren(element("span",loading?"جاري جلب الردود…":syncFailed?"تعذر الاتصال.":lastSynced?"تُحدّث الردود تلقائياً":"بانتظار تحميل الرسائل…"));
  if(syncFailed&&!loading)el.append(button("إعادة المحاولة",()=>refreshInbox({render:true}),"support-sync-retry"));
}
function directThread(){
  const unreadRows=rows.filter(unread);
  return unreadRows.length===1?unreadRows[0].id:rows.length===1?rows[0].id:"";
}
async function refreshInbox({render=false}={}){
  if(!enabled)return false;
  if(!loading){
    // Fetch only this browser's conversations, not all visitor records.
    loading=(async()=>{
      try{
        readKeys();
        const j=keys.length?await api({action:"inbox",keys:keys.map(({id,secret})=>({id,secret}))}):{records:[]};
        if(!enabled)return false;
        rows=j.records||[];lastSynced=Date.now();syncFailed=false;renderBadge();return true;
      }catch(e){
        if(e.code==="DISABLED")setEnabled(false);
        syncFailed=true;return false;
      }
    })();
  }
  const request=loading,g=generation;
  drawSync();
  const ok=await request;
  if(loading===request)loading=null;
  if(render&&dialog.open&&g===generation&&!busy&&ok){
    const draft=$("supportFollowup"),messageList=$("supportMessages");
    if(selected&&draft&&(draft.value.trim()||document.activeElement===draft)&&messageList){
      // Keep the actual input node, cursor and draft while new messages arrive.
      const t=rows.find(x=>x.id===selected);
      if(t){fillMessages(messageList,t);markRead(t);}
    }else draw();
  }
  drawSync();return ok;
}
function openHub(id="",autoDirect=false){
  readKeys();
  if(!enabled||$("feedbackDialog").open||document.documentElement.classList.contains("maintenance-mode"))return false;
  if(dialog.open&&busy)return false;
  selected=id||((autoDirect&&rows.length)?directThread():"");
  const g=++generation;notice(demo?"معاينة محلية: بيانات افتراضية، لا إشعارات حقيقية.":"");
  if(!dialog.open)dialog.showModal();
  draw();
  refreshInbox().then(ok=>{
    if(!ok||!dialog.open||g!==generation||busy)return;
    if(autoDirect&&!selected)selected=directThread();
    if(!$("supportFollowup")?.value.trim())draw();
  });
  preparePush();return true;
}
function draw(){
  panel.replaceChildren();
  const sync=element("div",null,"support-sync-status");sync.id="supportSyncStatus";sync.setAttribute("role","status");panel.append(sync);drawSync();
  if(selected){
    const t=rows.find(x=>x.id===selected);if(t){drawThread(t);return;}
    selected="";
  }
  const top=element("div",null,"support-actions");
  top.append(button("✉ إرسال اقتراح أو شكوى",()=>{dialog.close();window.ckFeedbackOpen?.();},"btn btn-primary"));
  panel.append(top);
  if(!rows.length)panel.append(element("p",loading?"جاري تحميل رسائلك…":syncFailed?"تعذر تحميل الرسائل حالياً.":"لا توجد محادثات بعد. يمكنك إرسال اقتراح أو شكوى دون طلب أي منتج.","support-hint"));
  for(const t of rows.slice().sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))){
    const b=button("",()=>{selected=t.id;generation++;draw();},"support-thread-button");
    b.append(element("strong",types[t.type]+" — "+states[t.state]+(unread(t)?" • رد جديد":"")),element("span",t.record.text.slice(0,110)),element("small",stamp(t.updatedAt)));
    panel.append(b);
  }
}
function messageBubble(role,text,time){
  const el=element("div",null,"support-message "+(role==="admin"?"support-admin-message":"support-visitor-message"));
  el.append(element("small",(role==="admin"?"إدارة المتجر":"أنت — مجهول")+" · "+stamp(time)),element("p",text));return el;
}
function fillMessages(messages,t){
  const atBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<24;
  messages.replaceChildren(messageBubble("visitor",t.record.text,t.record.timestamp));
  for(const m of t.messages)messages.append(messageBubble(m.role,m.text,m.timestamp));
  if(atBottom)messages.scrollTop=messages.scrollHeight;
}
function markRead(t){
  const k=getKey(t.id);if(!k)return;
  const read=t.messages.filter(m=>m.role==="admin").length;
  if(k.read!==read){try{saveKeys(keys.map(x=>x.id===t.id?{...x,read}:x));}catch{}}
  renderBadge();
}
function drawThread(t){
  markRead(t);
  const nav=element("div",null,"support-actions");nav.append(button("‹ جميع رسائلي",()=>{selected="";generation++;draw();}));panel.append(nav);
  panel.append(element("h3",types[t.type]+" · "+states[t.state]));
  const messages=element("div",null,"support-messages");messages.id="supportMessages";fillMessages(messages,t);panel.append(messages);
  const k=getKey(t.id);
  if(!k)return;
  if(t.state!=="resolved"){
    const field=element("textarea");field.id="supportFollowup";field.className="support-input";field.rows=3;field.maxLength=1500;field.placeholder="اكتب متابعة...";
    const send=button("إرسال المتابعة",async()=>{
      if(busy||!field.value.trim())return;
      const g=generation;busy=true;send.disabled=true;
      // Keep the same operation ID if a response is lost and the user retries.
      field.dataset.op=field.dataset.op||crypto.randomUUID();
      try{const j=await api({action:"message",id:t.id,secret:k.secret,text:field.value.trim(),op:field.dataset.op});
        rows=rows.map(r=>r.id===t.id?j.thread:r);if(dialog.open&&g===generation){notice("تم إرسال المتابعة.");draw();}
      }catch(e){if(g===generation)notice(e.message);}finally{busy=false;send.disabled=false;}
    },"btn btn-primary");
    panel.append(field,send);
  }else panel.append(element("p","تم إغلاق المحادثة بعد المعالجة. يمكنك إرسال رأي جديد.","support-hint"));
  const push=button(t.subscribed?"إيقاف إشعارات هذه المحادثة":"🔔 تفعيل إشعارات هذه المحادثة",()=>togglePush(t,k,push));
  panel.append(push);
  if(demo)panel.append(button("🔔 اختبار إشعار حقيقي على هذا الجهاز",testPreviewPush));
  if(!demo&&(!("PushManager" in window)||!("Notification" in window)))panel.append(element("p","قد تحتاج إلى إضافة الموقع إلى الشاشة الرئيسية على آيفون. يمكنك متابعة الردود هنا دون إشعارات.","support-hint"));
}
async function preparePush(){
  if(!enabled||!("serviceWorker" in navigator)||!("PushManager" in window)||!("Notification" in window))return;
  try{
    await navigator.serviceWorker.register("/support-sw.js",{scope:"/"});
    worker=await navigator.serviceWorker.ready;
    publicKey=(demo?await previewPushRequest():await api({action:"publicKey"})).publicKey;
  }catch{}
}
function bytes(b64){const s=atob(b64.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(b64.length/4)*4,"="));return Uint8Array.from(s,c=>c.charCodeAt(0));}
async function previewPushRequest(subscription){
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),8000);
  try{
    const res=await fetch("/api/support-preview",subscription?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({subscription}),signal:ctrl.signal,cache:"no-store"}:{signal:ctrl.signal,cache:"no-store"});
    const j=await res.json();if(!res.ok)throw Error(j.error||"تعذر اختبار الإشعار");return j;
  }finally{clearTimeout(timer);}
}
async function testPreviewPush(){
  if(!demo||busy)return;busy=true;
  try{
    if(!("Notification" in window)||!worker||!publicKey)throw Error("الإشعارات غير جاهزة؛ جرّب مجدداً أو استخدم متصفحاً مدعوماً.");
    if(await Notification.requestPermission()!=="granted")throw Error("لم تسمح بالإشعارات.");
    let sub=await worker.pushManager.getSubscription();
    if(sub){
      const old=new Uint8Array(sub.options.applicationServerKey||[]),expected=bytes(publicKey);
      if(old.length!==expected.length||old.some((x,i)=>x!==expected[i])){await sub.unsubscribe();sub=null;}
    }
    if(!sub)sub=await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes(publicKey)});
    await previewPushRequest(sub.toJSON());notice("قَبِل مزوّد الإشعارات الاختبار. تحقق من إشعار الهاتف؛ الوصول غير مضمون.");
  }catch(e){notice(e.message);}finally{busy=false;}
}
async function togglePush(t,k,b){
  if(busy)return;busy=true;b.disabled=true;
  try{
    let j;
    if(t.subscribed)j=await api({action:"unsubscribe",id:t.id,secret:k.secret});
    else if(demo)j=await api({action:"subscribe",id:t.id,secret:k.secret});
    else{
      if(!("Notification" in window)||!worker||!publicKey)throw Error("الإشعارات غير جاهزة في هذا المتصفح. على آيفون أضف الموقع للشاشة الرئيسية، أو حاول مجدداً.");
      const permission=await Notification.requestPermission();
      if(permission!=="granted")throw Error("لم يتم السماح بالإشعارات؛ يمكنك قراءة الردود هنا.");
      let sub=await worker.pushManager.getSubscription();
      if(!sub)sub=await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes(publicKey)});
      j=await api({action:"subscribe",id:t.id,secret:k.secret,subscription:sub.toJSON()});
    }
    rows=rows.map(r=>r.id===t.id?j.thread:r);notice(j.thread.subscribed?(demo?"تم تفعيل الإشعار المحاكى.":"تم تفعيل إشعارات هذه المحادثة."):"تم إيقاف إشعارات هذه المحادثة.");if(dialog.open&&selected===t.id)draw();
  }catch(e){notice(e.message);}finally{busy=false;b.disabled=false;}
}
window.ckSupport={
  get enabled(){return enabled;},open:openHub,
  decorate(pending){$("supportTypeRow").hidden=!enabled;$("supportType").value="suggestion";pending.supportEnabled=enabled;},
  async send(pending,body,legacy){
    if(!pending.supportEnabled||!enabled)return legacy();
    readKeys();
    let k=pending.supportKey;
    if(!k){
      k={id:body.id,secret:randomSecret(),read:0};
      try{if(keys.length>=50)throw Error("حد المحادثات");saveKeys([...keys,k]);pending.supportKey=k;}
      catch{pending.supportUnavailable=true;return legacy();}
    }
    try{
      const j=await api({...body,action:"create",type:$("supportType").value,secret:k.secret},{},pending.controller.signal,7000);
      if(pending.controller.signal.aborted)throw Error("أُلغيت العملية");
      pending.supportThread=j.thread;rows=[...rows.filter(r=>r.id!==j.thread.id),j.thread];renderBadge();
      return {res:{ok:true},data:{ok:true,preview:demo}};
    }catch(e){
      if(pending.controller.signal.aborted)throw e;
      if(e.code==="DISABLED"){setEnabled(false);try{saveKeys(keys.filter(x=>x.id!==k.id));}catch{}return legacy();}
      // The legacy endpoint uses the identical feedback ID, so a timeout cannot duplicate the original opinion.
      if(!e.status||e.status>=500){pending.supportUnavailable=true;return legacy();}
      throw e;
    }
  },
  afterGeneral(pending){if(pending.supportThread&&enabled)openHub(pending.supportThread.id);},
  cancel(){if(dialog.open)dialog.close();}
};
inboxBtn.addEventListener("click",()=>openHub("",true));
$("supportClose").addEventListener("click",()=>dialog.close());
dialog.addEventListener("close",()=>{if(dialog.open)return;generation++;selected="";});
async function tick(){
  if(document.hidden)return;
  readKeys();if(await refreshConfig()&&(keys.length||dialog.open))await refreshInbox({render:dialog.open});
}
window.addEventListener("focus",tick);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)tick();});
window.addEventListener("storage",e=>{if(e.key===storageKey||demo&&e.key?.startsWith("ck_support_demo_"))tick();});
navigator.serviceWorker?.addEventListener("message",async e=>{if(e.data?.type==="support-reply"&&await refreshConfig()){await refreshInbox();openHub("",true);}});
setInterval(()=>{if(dialog.open&&!document.hidden&&enabled&&!busy)refreshInbox({render:true});},15000);
setInterval(tick,60000);
refreshConfig().then(async ok=>{if(!ok)return;if(keys.length)await refreshInbox();if(new URLSearchParams(location.search).has("support"))openHub("",true);});
