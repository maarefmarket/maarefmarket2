import {api,demo,types,states,stamp,element,button} from "./support-client.js";
const $=id=>document.getElementById(id),root=$("supportAdmin"),list=$("supportAdminList"),detail=$("supportAdminDetail"),status=$("supportAdminStatus");
let rows=[],cursor=null,selected="",enabled=false,busy=false,seq=0;
const headers=()=>window.ckSupportAdminAuth?.()||{};
const request=b=>api(b,headers());
const note=s=>{status.textContent=s||"";};
function month(){const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Damascus",year:"numeric",month:"2-digit"}).formatToParts(new Date());return parts.find(p=>p.type==="year").value+"-"+parts.find(p=>p.type==="month").value;}
function showConfig(){ $("supportEnabled").checked=enabled;$("supportMode").textContent=enabled?"النظام مفعّل":"النظام متوقف — الواجهة القديمة تعمل كما كانت"; }
async function refresh(append=false){
  if(busy)return;busy=true;const g=++seq;
  $("supportReload").disabled=true;
  try{
    const cfg=await request({action:"adminConfig"});if(g!==seq)return;
    enabled=cfg.enabled;showConfig();
    const j=await request({action:"adminList",month:$("supportMonth").value,cursor:append?cursor:null});if(g!==seq)return;
    rows=append?[...rows,...j.records.filter(t=>!rows.some(x=>x.id===t.id))]:j.records;cursor=j.nextCursor;
    $("supportAdminCount").textContent="عدد محادثات الشهر: "+j.total+" · المعروض: "+rows.length;
    $("supportMore").hidden=!cursor;drawList();drawDetail();note(demo?"معاينة محلية — لا تُرسل إشعارات حقيقية.":"");
  }catch(e){if(g===seq)note(e.status===401?"انتهت الجلسة، أعد تسجيل الدخول.":e.message);}
  finally{if(g===seq){busy=false;$("supportReload").disabled=false;}}
}
function drawList(){
  const counts=$("supportCounts");counts.replaceChildren();
  for(const state of Object.keys(states)){const el=element("div",null,"support-count");el.append(element("small",states[state]),element("strong",String(rows.filter(t=>t.state===state).length)));counts.append(el);}
  const query=$("supportSearch").value.trim().toLowerCase(),state=$("supportFilter").value,type=$("supportFilterType").value;
  const filtered=rows.filter(t=>(!state||t.state===state)&&(!type||t.type===type)&&(!query||[t.id,t.record.text,...t.messages.map(m=>m.text)].join(" ").toLowerCase().includes(query)));
  list.replaceChildren();
  if(!filtered.length)list.append(element("p","لا توجد محادثات مطابقة ضمن الرسائل المحمّلة.","hint"));
  for(const t of filtered){
    const b=button("",()=>{if(busy)return;selected=t.id;drawList();drawDetail();},"support-admin-thread"+(selected===t.id?" selected":""));
    b.append(element("strong",types[t.type]+" · "+states[t.state]),element("span",t.record.text.slice(0,140)),element("small",stamp(t.updatedAt)));
    list.append(b);
  }
}
function drawDetail(){
  detail.replaceChildren();
  const t=rows.find(x=>x.id===selected);
  if(!t){detail.append(element("p","اختر محادثة لقراءة الرسائل والرد.","hint"));return;}
  detail.append(element("h3",types[t.type]+" — "+states[t.state]),element("p",t.subscribed?"🔔 إشعارات مفعّلة لهذه المحادثة":"الإشعارات غير مفعّلة؛ الرد متاح داخل الموقع.","hint"));
  const first=element("div",null,"support-admin-message");first.append(element("small","رسالة مجهولة · "+stamp(t.record.timestamp)),element("p",t.record.text));detail.append(first);
  if(t.record.items?.length){const d=element("details");d.append(element("summary","المنتجات المحددة عند محاولة الطلب"));for(const i of t.record.items)d.append(element("p",i.name+" × "+i.qty));detail.append(d);}
  for(const m of t.messages){const b=element("div",null,"support-admin-message"+(m.role==="admin"?" staff":""));b.append(element("small",(m.role==="admin"?"الإدارة":"الزبون — مجهول")+" · "+stamp(m.timestamp)),element("p",m.text));detail.append(b);}
  if(!enabled){detail.append(element("p","أعد تشغيل النظام للرد أو تغيير الحالة. المحادثات محفوظة.","hint"));return;}
  if(t.state!=="resolved"){
    const field=element("textarea");field.className="field";field.rows=3;field.maxLength=1500;field.placeholder="اكتب ردك...";
    const send=button("إرسال الرد والإشعار",async()=>{
      if(busy||!field.value.trim())return;busy=true;send.disabled=true;field.dataset.op=field.dataset.op||crypto.randomUUID();
      const g=seq;
      try{const j=await request({action:"adminReply",id:t.id,text:field.value.trim(),op:field.dataset.op});if(g!==seq)return;
        replace(j.thread);const labels={accepted:"تم حفظ الرد وقَبِل مزوّد الإشعارات الطلب (لا يضمن وصوله).",failed:"تم حفظ الرد، تعذّر إرسال الإشعار.",expired:"تم حفظ الرد، انتهى اشتراك الإشعارات.",disabled:"تم حفظ الرد، الإشعارات متوقفة.",demo:"تم حفظ الرد التجريبي؛ الإشعار محاكى.", "not-subscribed":"تم حفظ الرد داخل الموقع، لا اشتراك بالإشعارات.","not-sent":"الرد محفوظ مسبقاً."};note(labels[j.push]||"تم حفظ الرد.");
      }catch(e){if(g===seq)note(e.message);}finally{if(g===seq)busy=false;send.disabled=false;}
    },"btn btn-primary");
    detail.append(field,send);
  }
  detail.append(button(t.state==="resolved"?"إعادة فتح المحادثة":"✓ تم الحل — إغلاق المحادثة",async()=>{
    if(busy||!confirm(t.state==="resolved"?"إعادة فتح المحادثة؟":"إغلاق المحادثة بعد حل المشكلة؟"))return;busy=true;const g=seq;
    try{const j=await request({action:"adminState",id:t.id,state:t.state==="resolved"?"new":"resolved"});if(g===seq){replace(j.thread);note("تم تحديث الحالة.");}}
    catch(e){if(g===seq)note(e.message);}finally{if(g===seq)busy=false;}
  }));
}
function replace(t){rows=rows.map(r=>r.id===t.id?t:r);drawList();drawDetail();}
$("supportMonth").value=month();
$("supportReload").addEventListener("click",()=>refresh());
$("supportMore").addEventListener("click",()=>refresh(true));
$("supportMonth").addEventListener("change",()=>{selected="";refresh();});
for(const id of ["supportSearch","supportFilter","supportFilterType"])$(id).addEventListener("input",drawList);
$("supportEnabled").addEventListener("change",async e=>{
  const next=e.target.checked;
  if(busy||!confirm(next?"تشغيل المراسلات المجهولة للزبائن؟":"إيقاف المراسلات وإرجاع واجهة الاقتراحات القديمة؟ لن تُحذف المحادثات.")){showConfig();return;}
  busy=true;e.target.disabled=true;const g=seq;
  try{const j=await request({action:"setEnabled",enabled:next});if(g===seq){enabled=j.enabled;showConfig();drawDetail();note("تم حفظ الإعداد بشكل مستقل عن المنتجات.");}}
  catch(err){if(g===seq){showConfig();note(err.message);}}finally{if(g===seq)busy=false;e.target.disabled=false;}
});
window.ckSupportAdmin={refresh,clear(){seq++;rows=[];cursor=null;selected="";enabled=false;busy=false;list.replaceChildren();detail.replaceChildren();$("supportCounts").replaceChildren();note("");showConfig();$("supportReload").disabled=false;$("supportEnabled").disabled=false;}};
if(demo)root.hidden=false;
