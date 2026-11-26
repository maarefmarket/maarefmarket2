// Push only. No fetch handler, offline cache, or interception of storefront requests.
self.addEventListener("push",event=>{
  let test=false;try{test=event.data?.json()?.type==="support-test";}catch{}
  event.waitUntil(self.registration.showNotification("Maaref Market",{
    body:test?"إشعار تجريبي — نجح وصوله إلى هذا الجهاز.":"وصلك رد جديد من إدارة المتجر. افتح الموقع للاطلاع عليه.",
    icon:"/assets/logo.svg",tag:test?"maaref-support-test":"maaref-support-reply",data:{type:"support-reply"}
  }));
});
self.addEventListener("notificationclick",event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:"window",includeUncontrolled:true});
    const client=windows.find(c=>{const u=new URL(c.url);return u.origin===self.location.origin&&(u.pathname==="/"||u.pathname==="/index.html");});
    if(client){await client.focus();client.postMessage({type:"support-reply"});}
    else await self.clients.openWindow(/^deploy-preview-\d+--maarefmarket\.netlify\.app$/.test(self.location.hostname)?"/?supportDemo=1&support=1":"/?support=1");
  })());
});
