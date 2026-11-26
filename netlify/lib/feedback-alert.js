// Use the same administration Telegram destinations as order alerts.
// Only a generic notice leaves the site; opinions, capability keys and endpoints stay private.
export async function notifyFeedbackAdmin(kind,{env=process.env,send=fetch}={}){
  try{
    const token=env.TELEGRAM_BOT_TOKEN||"";
    const chats=[...new Set((env.TELEGRAM_CHAT_IDS||"").split(",").map(x=>x.trim()).filter(x=>/^-?\d+$/.test(x)))].slice(0,10);
    if(!token||!chats.length)return false;
    const text=(kind==="followup"?"💬 متابعة جديدة من زبون":"💬 رأي جديد من زبون")+"\nMaaref Market\nافتح لوحة التحكم — آراء الزبائن للقراءة والرد:\nhttps://maarefmarket.netlify.app/admin";
    const results=await Promise.allSettled(chats.map(async chat_id=>{
      const res=await send("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id,text,disable_web_page_preview:true}),signal:AbortSignal.timeout(2500)});
      return res.ok;
    }));
    return results.some(r=>r.status==="fulfilled"&&r.value);
  }catch{return false;}
}
