import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";
import {randomUUID} from "node:crypto";
import * as money from "../js/money.js";
import * as orderFormat from "../js/order-format.js";
import {sanitizeStore} from "../netlify/lib/validate.js";
import {buildOrder} from "../netlify/lib/order.js";
import {makeRecord,monthKey} from "../netlify/functions/feedback.js";

const catalog={settings:{storeName:"Example",whatsapps:["123456789"],rates:{USD_TRY:33,USD_SYP:14000},baseCurrency:"TRY"},categories:[],banners:[],products:[
  {id:1,name:"A",prices:{USD:1.25,TRY:1,SYP:1},oldPrices:{USD:2},images:["/api/image/abcdef.jpg"],variants:[{name:"Large",prices:{USD:1.75},showCurrencies:{USD:false}}]},
  {id:2,name:"B",prices:{SYP:28000},images:[],showCurrencies:{USD:false,TRY:false}}
]};
test("exact rounding and formatting in three currencies",()=>{
  assert.equal(money.roundPrice(1.005,"USD"),1.01);
  assert.equal(money.roundPrice(2.675,"USD"),2.68);
  assert.deepEqual([10.24,10.25,10.74,10.75].map(x=>money.roundPrice(x,"TRY")),[10,10.5,10.5,11]);
  assert.deepEqual([14.99,15,24.99,25,34.9,35].map(x=>money.roundPrice(x,"SYP")),[10,20,20,30,30,40]);
  assert.equal(money.convertUSD(1.25,33,"TRY"),41.5);
  assert.equal(money.convertUSD(.35,70,"SYP"),20);
  assert.equal(money.convertUSD(.25,100,"SYP"),30);
  assert.equal(money.formatMoney(1,"USD"),"1.00 $");
  assert.equal(money.formatMoney(2,"TRY"),"2.0 ₺");
  assert.equal(money.formatMoney(30,"SYP"),"30 ل.س");
});
test("Arabic decimals, grouping and rejected malformed numbers",()=>{
  for(const [s,n] of [["١٤٬٠٠٠",14000],["١٫٢٥",1.25],["1,234.50",1234.5],["12,5",12.5],["-12",0],["12abc",0]])assert.equal(money.decimal(s),n);
});
test("USD canonical pricing includes offers, variants, and legacy prices",()=>{
  const d=sanitizeStore(catalog);
  assert.equal(d.settings.baseCurrency,"USD");
  assert.deepEqual(d.products[0].prices,{USD:1.25,TRY:41.5,SYP:17500});
  assert.equal(d.products[0].oldPrices.TRY,66);
  assert.equal(d.products[0].variants[0].prices.TRY,58);
  assert.equal(d.products[1].prices.USD,2);
  const prior=d.settings.rates;d.settings.rates={USD_TRY:40,USD_SYP:15000};
  money.normalizeCatalogPricing(d,prior);
  assert.deepEqual(d.products[0].prices,{USD:1.25,TRY:50,SYP:18750});
  assert.equal(d.products[1].prices.SYP,30000);
  const snapshot=JSON.stringify(d);
  money.normalizeCatalogPricing(d);assert.equal(JSON.stringify(d),snapshot);
});
test("order totals are exact, use rounded unit prices and respect currency visibility",()=>{
  const o=buildOrder(catalog,{items:[{id:1,variant:0,qty:3},{id:2,qty:2}]});
  assert.equal(o.items[0].total,174);assert.equal(o.items[1].total,56000);
  assert.match(o.text,/174\.0\u00a0₺/);
  assert.equal(money.lineAmount({USD:.1},{},3).total,.3);
  assert.equal(money.lineAmount({TRY:10.5},{},3).total,31.5);
  assert.equal(money.lineAmount({SYP:20},{},3).total,60);
  assert.throws(()=>money.convertUSD(1e12,2,"TRY"),RangeError);
});
test("feedback stores server timestamp and trusted item snapshot without identity or notes",()=>{
  const now=new Date("2026-11-25T18:10:11.000Z");
  const body={id:now.getTime()+"-"+randomUUID(),text:"اقتراح",items:[{id:1,qty:2,unit:0}],name:"private",ip:"1.2.3.4",notes:"secret"};
  const {key,record}=makeRecord(catalog,body,now);
  assert.ok(key.startsWith("feedback/2026-11/"));
  assert.equal(record.timestamp,now.toISOString());
  assert.equal(record.items[0].total,2.5);
  assert.equal(record.status,"order-attempt");
  assert.deepEqual(Object.keys(record).sort(),["items","status","text","timestamp"]);
  assert.equal(monthKey(new Date("2026-11-30T22:00:00Z")),"2026-12");
  assert.throws(()=>makeRecord(catalog,{...body,text:" "},now));
  assert.throws(()=>makeRecord(catalog,{...body,text:"x".repeat(1501)},now));
  assert.throws(()=>makeRecord(catalog,{...body,items:[{id:999,qty:1}]},now));
  assert.throws(()=>makeRecord({...catalog,settings:{...catalog.settings,maintenanceMode:true}},body,now));
});
async function storefront(){
  const source=await readFile(new URL("../js/store.js",import.meta.url),"utf8");
  const nodes={};
  const node=id=>nodes[id]??(nodes[id]={style:{},value:"",textContent:"",innerHTML:"",disabled:false,open:false,classList:{add(){},remove(){},toggle(){}},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;},focus(){},removeAttribute(){}});
  const document={getElementById:node,querySelectorAll:()=>[],documentElement:node("html"),addEventListener(){},hidden:false};
  const location={href:"https://example.test/",origin:"https://example.test",hash:"",assign(url){this.assigned=url;}};
  const calls=[];let fail=false,closed=false,intercept=null;const timers=new Map();let timerId=0;
  const fetch=async(url,opts)=>{
    calls.push({url,opts});
    const custom=intercept?.(url,opts);if(custom)return custom;
    return {ok:url!=="/api/feedback"||!fail,json:async()=>url.includes("status=1")?{maintenanceMode:closed}:url==="/api/feedback"&&fail?{error:"failed"}:{ok:true}};
  };
  const ctx={...money,...orderFormat,document,window:{addEventListener(){}},location,history:{},fetch,URL,AbortSignal,AbortController,crypto:{randomUUID},console,setInterval:()=>1,clearInterval(){},setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}};
  const script=source.replace(/^import .*;\n/gm,"").split("(async function init()")[0]+
    "\n({setup(d){SETTINGS=d.settings;PRODUCTS=d.products;cart={'1':2,'2':3};storeReady=true;},buyNowWA,showGeneralFeedback,finishFeedback,cancelFeedback,requestJSON,checkout,cartTotals,renderMaintenance,getCart:()=>cart,updateShopDock,updateCartCount,cardStep,cardHTML,openCategories});";
  const api=runInNewContext(script,ctx);api.setup(sanitizeStore(catalog));
  return {api,node,calls,location,setFail(v){fail=v;},setClosed(v){closed=v;},intercept(fn){intercept=fn;},expire(ms){for(const [id,t] of timers){if(t.ms===ms){timers.delete(id);t.fn();}}}};
}
test("purchase opens optional feedback, skip sends no feedback and preserves all selected items",async()=>{
  const t=await storefront();
  assert.equal(t.api.buyNowWA(1),true);assert.equal(t.node("feedbackDialog").open,true);assert.equal(t.calls.length,0);
  await t.api.finishFeedback(false);
  assert.equal(t.calls.filter(x=>x.url==="/api/feedback").length,0);
  const order=JSON.parse(t.calls.find(x=>x.url==="/api/notify").opts.body);
  assert.deepEqual(order.items.map(i=>[i.id,i.qty]),[[1,2],[2,3]]);
  assert.match(decodeURIComponent(t.location.assigned),/\*\u2068A\u2069\*\n\u200fالكمية: \u20662\u2069/);
  assert.ok(!decodeURIComponent(t.location.assigned).includes("/api/image/"));
});
test("feedback is saved before redirect, failed save can be skipped, duplicate submit blocked",async()=>{
  const t=await storefront();t.api.buyNowWA(1);
  await t.api.finishFeedback(true);assert.equal(t.calls.length,0);
  t.node("feedbackText").value="Useful suggestion";t.setFail(true);
  await t.api.finishFeedback(true);assert.equal(t.location.assigned,undefined);assert.equal(t.node("feedbackDialog").open,true);
  t.setFail(false);
  await Promise.all([t.api.finishFeedback(true),t.api.finishFeedback(true)]);
  const feedback=t.calls.filter(x=>x.url==="/api/feedback");
  assert.equal(feedback.length,2);assert.equal(JSON.parse(feedback[0].opts.body).id,JSON.parse(feedback[1].opts.body).id);
  assert.equal(t.calls.filter(x=>x.url==="/api/notify").length,1);
  assert.ok(t.location.assigned.startsWith("https://wa.me/"));
  assert.ok(!decodeURIComponent(t.location.assigned).includes("Useful suggestion"));
});
test("maintenance while feedback open blocks the order",async()=>{
  const t=await storefront();t.api.buyNowWA(1);t.setClosed(true);
  await t.api.finishFeedback(false);
  assert.equal(t.location.assigned,undefined);
  assert.equal(t.calls.filter(x=>x.url==="/api/notify").length,0);
});

test("responsive cart dock uses all selected currencies and updates quantities",async()=>{
  const t=await storefront();
  t.api.updateShopDock();
  assert.equal(t.node("shopDock").hidden,false);
  assert.equal(t.node("cartSummary").hidden,false);
  assert.equal(t.node("summaryCount").textContent,"5 قطعة محددة");
  assert.match(t.node("summaryTotal").textContent,/2\.50 \$/);
  assert.match(t.node("summaryTotal").textContent,/84,000 ل\.س/);
  t.api.cardStep(1,1);
  assert.equal(t.node("summaryCount").textContent,"6 قطعة محددة");
  t.location.hash="#cart";t.api.updateShopDock();
  assert.equal(t.node("cartSummary").hidden,true);
  assert.equal(t.node("shopDock").hidden,false);
  t.api.renderMaintenance("صيانة");assert.equal(t.node("shopDock").hidden,true);
});
test("responsive product cards retain purchase action, quantities, price and accessible name",async()=>{
  const t=await storefront();
  const html=t.api.cardHTML(sanitizeStore(catalog).products[0]);
  assert.match(html,/class="card selected"/);
  assert.match(html,/data-buy="1"/);
  assert.match(html,/data-step="1\|1"/);
  assert.match(html,/class="card-line-total"/);
  assert.match(html,/2\.50 \$/);
  assert.doesNotMatch(html,/data-add="1"/);
});
test("preview admin demo has no production authentication bypass",async()=>{
  const source=await readFile(new URL("../js/admin.js",import.meta.url),"utf8");
  const line=source.split("\n").find(l=>l.startsWith("const DEMO="));
  const detect=(hostname,search)=>runInNewContext(line+"\nDEMO",{location:{hostname,search},URLSearchParams});
  assert.equal(detect("deploy-preview-5--maarefmarket.netlify.app","?demo=1"),true);
  assert.equal(detect("maarefmarket.netlify.app","?demo=1"),false);
  assert.equal(detect("deploy-preview-5--maarefmarket.netlify.app",""),false);
  assert.match(source,/async function saveAll\(force = false\) \{[\s\S]*?if\(DEMO\)/);
  assert.match(source,/async function uploadImageBlob\(blob\) \{\s*if\(DEMO\)throw/);
});

test("mixed-language order message isolates names and numeric prices and separates products",()=>{
  const d=structuredClone(catalog);
  d.products[0].name="عصير Orange 250 ml";
  d.products[1].name="Biscuit بسكويت 2×50g";
  d.settings.msgTemplate="قالب المتجر {store}\n{items}\n{totals}\n{notes}\nنهاية";
  const before=JSON.stringify(d);
  const o=buildOrder(d,{items:[{id:1,qty:2},{id:2,qty:3}],notes:"ملاحظة {store}"});
  assert.equal(JSON.stringify(d),before);
  assert.ok(o.text.includes("\u2068عصير Orange 250 ml\u2069"));
  assert.ok(o.text.includes("\u2068Biscuit بسكويت 2×50g\u2069"));
  assert.ok(o.text.includes("\u20662\u2069"));
  assert.ok(o.text.includes("\u206684,000\u00a0ل.س\u2069"));
  assert.match(o.text,/\n\n\u200f• \u2068Biscuit/);
  assert.ok(o.text.includes("ملاحظة {store}"));
  assert.ok(o.text.includes("قالب المتجر Example"));
  assert.ok(o.text.endsWith("نهاية"));
  assert.equal(o.items[0].total,2.5);
  assert.equal(o.items[1].total,84000);
});
test("WhatsApp and Telegram share the same layout and preserve the selected products",async()=>{
  const t=await storefront();
  t.api.buyNowWA(1);await t.api.finishFeedback(false);
  const message=new URL(t.location.assigned).searchParams.get("text");
  assert.ok(message.includes("\n\n\u200f• *\u2068B\u2069*"));
  assert.ok(message.includes("\u20662.50\u00a0$\u2069"));
  assert.ok(message.includes("\u206684,000\u00a0ل.س\u2069"));
  const payload=JSON.parse(t.calls.find(x=>x.url==="/api/notify").opts.body);
  assert.deepEqual(payload.items.map(i=>[i.id,i.qty]),[[1,2],[2,3]]);
});
test("Telegram splits at complete product blocks and preserves bidi isolates",()=>{
  const item=orderFormat.formatOrderItem({name:"عصير Orange 250 ml",qty:2,unit:1.25,total:2.5,cur:"USD"});
  const blocks=Array(50).fill(item);
  const chunks=orderFormat.splitOrderText(blocks.join("\n\n"));
  assert.ok(chunks.length>1);
  assert.ok(chunks.every(c=>c.length<=1800));
  assert.equal(chunks.join("\n\n"),blocks.join("\n\n"));
  assert.ok(chunks.every(c=>(c.match(/[\u2066\u2068]/g)||[]).length===(c.match(/\u2069/g)||[]).length));
});

test("final totals represent the entire basket in each currency, even hidden currencies",async()=>{
  const t=await storefront();
  t.api.buyNowWA(1);await t.api.finishFeedback(false);
  const wa=new URL(t.location.assigned).searchParams.get("text");
  const tg=buildOrder(catalog,{items:[{id:1,qty:2},{id:2,qty:3}]}).text;
  for(const msg of [wa,tg]){
    const final=msg.split("السعر النهائي الإجمالي:")[1];
    assert.ok(final.includes("119,000\u00a0ل.س"));
    assert.ok(final.includes("281.0\u00a0₺"));
    assert.ok(final.includes("8.50\u00a0$"));
    assert.equal((final.match(/بالسوري|بالتركي|بالدولار/g)||[]).length,3);
    assert.doesNotMatch(final,/84,000|2\.50/);
  }
  const variant=buildOrder(catalog,{items:[{id:1,variant:0,qty:3},{id:2,qty:2}]}).text.split("السعر النهائي الإجمالي:")[1];
  assert.ok(variant.includes("129,500\u00a0ل.س"));
  assert.ok(variant.includes("306.0\u00a0₺"));
  assert.ok(variant.includes("9.25\u00a0$"));
});
test("unavailable currency is not misrepresented as a partial or zero total",()=>{
  const rows=[{prices:{USD:2,TRY:66,SYP:0},qty:2},{prices:{USD:1,TRY:33,SYP:14000},qty:1}];
  const before=JSON.stringify(rows);
  const totals=orderFormat.formatGrandTotals(rows,{USD_TRY:33});
  assert.ok(totals.includes("بالسوري: غير متاح"));
  assert.ok(totals.includes("165.0\u00a0₺"));
  assert.ok(totals.includes("5.00\u00a0$"));
  assert.equal(JSON.stringify(rows),before);
});


const drain=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
test("close returns without submitting and preserves cart, notes and unsent text",async()=>{
  const t=await storefront();
  t.node("cNotes").value="delivery note";
  t.api.checkout();
  t.node("feedbackText").value="draft";
  t.api.cancelFeedback();
  assert.equal(t.node("feedbackDialog").open,false);
  assert.equal(t.calls.length,0);
  assert.equal(t.node("cNotes").value,"delivery note");
  assert.equal(t.api.getCart()["1"],2);
  assert.equal(t.api.checkout(),true);
  assert.equal(t.node("feedbackText").value,"draft");
  assert.equal(t.node("feedbackSend").disabled,false);
});
test("cancel during a stalled status check prevents late WhatsApp and Telegram dispatch",async()=>{
  const t=await storefront();let resolveOld;
  t.intercept(url=>url.includes("status=1")?new Promise(resolve=>{resolveOld=resolve;}):null);
  t.api.buyNowWA(1);
  const old=t.api.finishFeedback(false);
  await drain();
  assert.equal(t.node("feedbackSkip").disabled,true);
  assert.equal(t.node("feedbackClose").disabled,false);
  t.api.cancelFeedback();
  await old;
  assert.equal(t.calls[0].opts.signal.aborted,true);
  assert.equal(t.location.assigned,undefined);
  t.intercept(null);
  assert.equal(t.api.buyNowWA(1),true);
  resolveOld({ok:true,json:async()=>({maintenanceMode:false})});
  await drain();
  assert.equal(t.node("feedbackDialog").open,true);
  assert.equal(t.calls.filter(x=>x.url==="/api/notify").length,0);
  await t.api.finishFeedback(false);
  assert.equal(t.calls.filter(x=>x.url==="/api/notify").length,1);
});
test("close during a stalled feedback save cannot open WhatsApp after reopening",async()=>{
  const t=await storefront();let resolveOld;
  t.intercept(url=>url==="/api/feedback"?new Promise(resolve=>{resolveOld=resolve;}):null);
  t.api.buyNowWA(1);
  t.node("feedbackText").value="draft";
  const old=t.api.finishFeedback(true);
  await drain();
  assert.equal(typeof resolveOld,"function");
  t.api.cancelFeedback();
  assert.equal(t.node("feedbackDialog").open,false);
  await old;
  t.intercept(null);
  t.api.buyNowWA(1);
  resolveOld({ok:true,json:async()=>({ok:true})});
  await drain();
  assert.equal(t.location.assigned,undefined);
  assert.equal(t.node("feedbackDialog").open,true);
  assert.equal(t.node("feedbackText").value,"draft");
  assert.equal(t.node("feedbackSkip").disabled,false);
  assert.equal(t.calls.filter(x=>x.url==="/api/notify").length,0);
});
test("status and feedback JSON body timeouts release controls, allow retry or skip",async()=>{
  const t=await storefront();
  t.intercept(url=>url.includes("status=1")?Promise.resolve({ok:true,json:()=>new Promise(()=>{})}):null);
  t.api.buyNowWA(1);
  const first=t.api.finishFeedback(false);
  await drain();t.expire(5000);await first;
  assert.equal(t.node("feedbackSkip").disabled,false);
  assert.equal(t.location.assigned,undefined);
  t.intercept(url=>url==="/api/feedback"?Promise.resolve({ok:true,json:()=>new Promise(()=>{})}):null);
  t.node("feedbackText").value="test";
  const second=t.api.finishFeedback(true);
  await drain();t.expire(7000);await second;
  assert.equal(t.node("feedbackSend").disabled,false);
  assert.equal(t.node("feedbackText").disabled,false);
  assert.equal(t.location.assigned,undefined);
  t.intercept(null);
  await t.api.finishFeedback(false);
  assert.equal(t.calls.filter(x=>x.url==="/api/notify").length,1);
});
test("full catalog JSON timeout is bounded",async()=>{
  const t=await storefront();
  t.intercept(()=>Promise.resolve({ok:true,json:()=>new Promise(()=>{})}));
  const request=t.api.requestJSON("/api/data",{},8000).then(()=>false,()=>true);
  await drain();t.expire(8000);
  assert.equal(await request,true);
  assert.equal(t.calls[0].opts.signal.aborted,true);
});

test("general feedback works with an empty cart and never starts an order",async()=>{
  const t=await storefront();
  for(const key of Object.keys(t.api.getCart()))delete t.api.getCart()[key];
  assert.equal(t.api.showGeneralFeedback(),true);
  assert.equal(t.node("feedbackSend").textContent,"إرسال الرأي");
  assert.equal(t.node("feedbackSkip").textContent,"إلغاء");
  await t.api.finishFeedback(true);assert.equal(t.calls.length,0);
  t.node("feedbackText").value="اقتراح عام";
  await t.api.finishFeedback(true);
  assert.equal(t.node("feedbackDialog").open,false);
  assert.equal(t.calls.length,1);
  assert.equal(t.calls[0].url,"/api/feedback");
  const body=JSON.parse(t.calls[0].opts.body);
  assert.equal(body.kind,"general");assert.deepEqual(body.items,[]);
  assert.equal(t.location.assigned,undefined);
});
test("general feedback preserves cart, can be cancelled, and does not mix drafts with checkout",async()=>{
  const t=await storefront();t.api.showGeneralFeedback();
  t.node("feedbackText").value="general draft";
  await t.api.finishFeedback(false);
  assert.equal(t.calls.length,0);
  assert.equal(t.node("feedbackDialog").open,false);
  t.api.buyNowWA(1);
  assert.equal(t.node("feedbackText").value,"");
  assert.equal(t.node("feedbackSkip").textContent,"تخطي والطلب عبر واتساب");
  t.node("feedbackText").value="order draft";t.api.cancelFeedback();
  t.api.showGeneralFeedback();assert.equal(t.node("feedbackText").value,"general draft");
  t.setFail(true);await t.api.finishFeedback(true);
  assert.equal(t.node("feedbackDialog").open,true);
  assert.equal(t.node("feedbackSend").disabled,false);
  t.api.cancelFeedback();
  t.api.buyNowWA(1);assert.equal(t.node("feedbackText").value,"order draft");
  assert.equal(t.api.getCart()["1"],2);
  await t.api.finishFeedback(false);
  assert.equal(t.calls.filter(x=>x.url==="/api/notify").length,1);
});
test("server records general feedback without identity or product data and rejects fake orders",()=>{
  const now=new Date("2026-11-25T18:10:11.000Z");
  const body={id:now.getTime()+"-"+randomUUID(),kind:"general",text:"اقتراح عام",items:[],name:"private",phone:"123",ip:"1.2.3.4"};
  const before=JSON.stringify(catalog);
  const {record}=makeRecord(catalog,body,now);
  assert.deepEqual(record,{timestamp:now.toISOString(),text:"اقتراح عام",items:[],status:"general-feedback"});
  assert.equal(JSON.stringify(catalog),before);
  assert.throws(()=>makeRecord(catalog,{...body,items:[{id:1,qty:2}]},now));
  assert.throws(()=>makeRecord(catalog,{...body,kind:"order"},now));
  assert.throws(()=>makeRecord(catalog,{...body,text:" "},now));
  assert.throws(()=>makeRecord(catalog,{...body,kind:"unknown"},now));
  assert.throws(()=>makeRecord({...catalog,settings:{...catalog.settings,maintenanceMode:true}},body,now));
});
test("cancel standalone feedback during stalled save prevents late response from affecting new checkout",async()=>{
  const t=await storefront();let resolveOld;
  t.intercept(url=>url==="/api/feedback"?new Promise(resolve=>{resolveOld=resolve;}):null);
  t.api.showGeneralFeedback();t.node("feedbackText").value="draft";
  const old=t.api.finishFeedback(true);await drain();
  t.api.cancelFeedback();await old;
  t.intercept(null);t.api.buyNowWA(1);
  resolveOld({ok:true,json:async()=>({ok:true})});await drain();
  assert.equal(t.node("feedbackDialog").open,true);
  assert.equal(t.location.assigned,undefined);
  assert.equal(t.calls.filter(x=>x.url==="/api/notify").length,0);
});
