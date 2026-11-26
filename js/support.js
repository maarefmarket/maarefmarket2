import {api,demo,types,states,stamp,randomSecret,validKey,element,button} from "./support-client.js";
const $=id=>document.getElementById(id);
const storageKey="ck_support_keys_v1",dialog=$("supportDialog"),badge=$("supportUnread"),panel=$("supportContent"),status=$("supportStatus");
let enabled=false,rows=[],selected="",generation=0,busy=false,worker=null,publicKey=null,loading=false;
let keys=[];
try{keys=JSON.parse(localStorage.getItem(storageKey)||"[]").filter(validKey).slice(0,50);}catch{}
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
  enabled=value===true;renderBadge();
  if(!enabled&&dialog.open)dialog.close();
}
async function refreshConfig(){
  try{const c=await api();setEnabled(c.enabled);return enabled;}catch{return enabled;}
}
async function refreshInbox({render=false}={}){
  if(!enabled||loading)return;
  loading=true;const g=generation;
  try{
    const j=await api({action:"inbox",keys:keys.map(({id,secret})=>({id,secret}))});
    if(!enabled)return;
    rows=j.records||[];renderBadge();
    if(render&&dialog.open&&g===generation&&!busy){draw();}
  }catch(e){if(e.code==="DISABLED")setEnabled(false);else if(dialog.open)notice("تعذر تحديث الردود؛ أعد المحاولة.");}
  finally{loading=false;}
}
function openHub(id=""){
  if(!enabled||$("feedbackDialog").open)return false;
  selected=id;generation++;busy=false;notice(demo?"معاينة محلية: بيانات افتراضية، لا إشعارات حقيقية.":"");
  if(!dialog.open)dialog.showModal();
  draw();refreshInbox({render:true});preparePush();return true;
}
function draw(){
  panel.replaceChildren();
  if(selected){
    const t=rows.find(x=>x.id===selected);if(t){drawThread(t);return;}
    selected="";
  }
  const top=element("div",null,"support-actions");
  top.append(button("✉ إرسال اقتراح أو شكوى",()=>{dialog.close();window.ckFeedbackOpen?.();},"btn btn-primary"),button("تحديث الردود",()=>refreshInbox({render:true})));
  panel.append(top);
  if(!rows.length)panel.append(element("p","لا توجد محادثات بعد. أرسل رأياً جديداً أو استرجع محادثة سابقة.","support-hint"));
  for(const t of rows.slice().sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))){
    const b=button("",()=>{selected=t.id;generation++;draw();},"support-thread-button");
    b.append(element("strong",types[t.type]+" — "+states[t.state]+(unread(t)?" • رد جديد":"")),element("span",t.record.text.slice(0,110)),element("small",stamp(t.updatedAt)));
    panel.append(b);
  }
  const recovery=element("details",null,"support-recovery");recovery.append(element("summary","استرجاع محادثة من جهاز آخر"));
  const input=element("input");input.className="support-input";input.placeholder="الصق رمز الاسترجاع السري";input.autocomplete="off";input.spellcheck=false;
  recovery.append(input,button("استرجاع",async()=>{
    if(busy)return;const [id,secret,...rest]=input.value.trim().split(".");
    if(rest.length||!validKey({id,secret})){notice("رمز الاسترجاع غير صالح.");return;}
    busy=true;
    try{
      const j=await api({action:"inbox",keys:[{id,secret}]});const t=j.records?.[0];if(!t)throw Error("المحادثة غير متاحة");
      if(!getKey(id)){if(keys.length>=50)throw Error("احذف محادثة من جهازك بعد حفظ رمزها أولاً.");saveKeys([...keys,{id,secret,read:0}]);}
      rows=[...rows.filter(r=>r.id!==id),t];selected=id;notice("");draw();
    }catch(e){notice(e.message);}finally{busy=false;}
  }));
  panel.append(recovery);
}
function messageBubble(role,text,time){
  const el=element("div",null,"support-message "+(role==="admin"?"support-admin-message":"support-visitor-message"));
  el.append(element("small",(role==="admin"?"إدارة المتجر":"أنت — مجهول")+" · "+stamp(time)),element("p",text));return el;
}
function markRead(t){
  const k=getKey(t.id);if(!k)return;
  const read=t.messages.filter(m=>m.role==="admin").length;
  if(k.read!==read){try{saveKeys(keys.map(x=>x.id===t.id?{...x,read}:x));}catch{}}
  renderBadge();
}
function drawThread(t){
  markRead(t);
  panel.append(button("‹ العودة إلى رسائلي",()=>{selected="";generation++;draw();}));
  panel.append(element("h3",types[t.type]+" · "+states[t.state]));
  const messages=element("div",null,"support-messages");messages.append(messageBubble("visitor",t.record.text,t.record.timestamp));
  for(const m of t.messages)messages.append(messageBubble(m.role,m.text,m.timestamp));
  panel.append(messages);
  const k=getKey(t.id);
  if(!k)return;
  if(t.state!=="resolved"){
    const field=element("textarea");field.className="support-input";field.rows=3;field.maxLength=1500;field.placeholder="اكتب متابعة...";
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
  if(!demo&&(!("PushManager" in window)||!("Notification" in window)))panel.append(element("p","قد تحتاج إلى إضافة الموقع إلى الشاشة الرئيسية على آيفون. يمكنك متابعة الردود هنا دون إشعارات.","support-hint"));
  const details=element("details",null,"support-recovery");details.append(element("summary","رمز الاسترجاع — احتفظ به سراً"));
  const code=element("textarea");code.className="support-input";code.readOnly=true;code.rows=3;code.dir="ltr";code.value=t.id+"."+k.secret;
  details.append(element("p","من يملك هذا الرمز يمكنه قراءة المحادثة والرد عليها. لا تشاركه مع الآخرين.","support-hint"),code,button("نسخ الرمز",async()=>{try{await navigator.clipboard.writeText(code.value);notice("تم نسخ الرمز.");}catch{code.select();notice("انسخ الرمز يدوياً.");}}),button("إزالة المحادثة من هذا الجهاز",()=>{
    if(confirm("هل حفظت رمز الاسترجاع؟ لن تتمكن من فتح المحادثة مجدداً بدونه.")){try{saveKeys(keys.filter(x=>x.id!==t.id));rows=rows.filter(x=>x.id!==t.id);selected="";draw();}catch{notice("تعذر تحديث التخزين المحلي.");}}
  }));
  panel.append(details);
}
async function preparePush(){
  if(demo||!enabled||!("serviceWorker" in navigator)||!("PushManager" in window)||!("Notification" in window))return;
  try{
    await navigator.serviceWorker.register("/support-sw.js",{scope:"/"});
    worker=await navigator.serviceWorker.ready;
    publicKey=(await api({action:"publicKey"})).publicKey;
  }catch{}
}
function bytes(b64){const s=atob(b64.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(b64.length/4)*4,"="));return Uint8Array.from(s,c=>c.charCodeAt(0));}
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
    let k=pending.supportKey;
    if(!k){
      k={id:body.id,secret:randomSecret(),read:0};
      try{if(keys.length>=50)throw Error("حد المحادثات");saveKeys([...keys,k]);pending.supportKey=k;}
      catch{pending.supportUnavailable=true;return legacy();}
    }
    try{
      const j=await api({...body,action:"create",type:$("supportType").value,secret:k.secret},{},pending.controller.signal);
      if(pending.controller.signal.aborted)throw Error("أُلغيت العملية");
      pending.supportThread=j.thread;rows=[...rows.filter(r=>r.id!==j.thread.id),j.thread];renderBadge();
      return {res:{ok:true},data:{ok:true,preview:demo}};
    }catch(e){
      if(e.code==="DISABLED"){setEnabled(false);try{saveKeys(keys.filter(x=>x.id!==k.id));}catch{}return legacy();}
      throw e;
    }
  },
  afterGeneral(pending){if(pending.supportThread&&enabled)openHub(pending.supportThread.id);},
  cancel(){if(dialog.open)dialog.close();}
};
$("supportClose").addEventListener("click",()=>dialog.close());
dialog.addEventListener("close",()=>{generation++;selected="";busy=false;});
async function tick(){
  if(document.hidden)return;
  if(await refreshConfig()&&keys.length)await refreshInbox({render:dialog.open&&!selected});
}
window.addEventListener("focus",tick);
navigator.serviceWorker?.addEventListener("message",async e=>{if(e.data?.type==="support-reply"&&await refreshConfig())openHub();});
setInterval(tick,60000);
refreshConfig().then(async ok=>{if(!ok)return;if(keys.length)await refreshInbox();if(new URLSearchParams(location.search).has("support"))openHub();});
