import {api,demo} from "./support-client.js";
const $=id=>document.getElementById(id);
const key="ck_admin_feedback_seen_v1";
let lastMonth="",latest="",unread=0,inFlight=false,epoch=0;
function currentMonth(){
  const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Damascus",year:"numeric",month:"2-digit"}).formatToParts(new Date());
  return p.find(x=>x.type==="year").value+"-"+p.find(x=>x.type==="month").value;
}
function readSeen(month){
  try{return JSON.parse(localStorage.getItem(key)||"{}")[month]||"";}catch{return "";}
}
function writeSeen(month,value){
  try{const old=JSON.parse(localStorage.getItem(key)||"{}");old[month]=value;localStorage.setItem(key,JSON.stringify(old));}catch{}
}
const auth=()=>window.ckSupportAdminAuth?.()||{};
function signedIn(){return demo||/^Bearer .+/.test(auth().Authorization||"");}
function draw(n){
  unread=n;const badge=$("adminFeedbackBadge"),bell=$("adminFeedbackBell");
  badge.textContent=n>99?"99+":String(n);badge.hidden=!n;
  bell.hidden=!n;bell.textContent="🔔 "+(n>99?"99+":n);
  bell.setAttribute("aria-label",n+" آراء جديدة");
  $("feedbackNewAlert").hidden=!n;
  $("feedbackNewText").textContent=n?"لديك "+n+" آراء لم تفتح سجلها بعد.":"";
}
async function poll(){
  if(inFlight||document.hidden||!signedIn())return;
  const g=epoch,month=currentMonth(),seen=readSeen(month);
  inFlight=true;
  try{
    let j;
    if(demo){
      const r=await api({action:"adminList",month});
      const ids=r.records.map(t=>"feedback/"+month+"/"+t.id+".json").sort().reverse();
      j={month,latest:ids[0]||"",unread:ids.filter(x=>x>seen).length};
    }else{
      const res=await fetch("/api/feedback?"+new URLSearchParams({status:"1",month,since:seen}),{headers:auth(),cache:"no-store",signal:AbortSignal.timeout(10000)});
      if(!res.ok)return;j=await res.json();
    }
    if(g!==epoch||!signedIn())return;
    // A successful manual list load may have marked the records seen while polling.
    if(readSeen(month)!==seen)return;
    lastMonth=j.month;latest=j.latest||"";
    draw(Math.max(0,Number(j.unread)||0));
  }catch{}finally{if(g===epoch)inFlight=false;}
}
function seen(month,value){
  if(!signedIn()||month!==currentMonth()||typeof value!=="string")return;
  const old=readSeen(month);if(value>=old)writeSeen(month,value);
  if(lastMonth===month&&latest>value){poll();return;}
  draw(0);poll();
}
function open(){
  $("feedbackMonth").value=currentMonth();
  $("supportMonth").value=currentMonth();
  window.ckOpenFeedback?.();
  if(demo&&lastMonth)seen(lastMonth,latest);
}
$("adminFeedbackBell").addEventListener("click",open);
$("feedbackNewOpen").addEventListener("click",open);
window.ckFeedbackAlerts={seen,poll,clear(){epoch++;inFlight=false;lastMonth="";latest="";draw(0);}};
window.addEventListener("focus",poll);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)poll();});
window.addEventListener("storage",e=>{if(e.key===key||demo&&e.key==="ck_support_demo_threads_v1")poll();});
setInterval(poll,30000);
poll();
