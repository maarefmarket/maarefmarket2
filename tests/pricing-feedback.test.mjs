import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";
import {randomUUID} from "node:crypto";
import * as money from "../js/money.js";
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
  assert.match(o.text,/174.0 ₺/);
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
  const calls=[];let fail=false,closed=false;
  const fetch=async(url,opts)=>{
    calls.push({url,opts});
    return {ok:url!=="/api/feedback"||!fail,json:async()=>url.includes("status=1")?{maintenanceMode:closed}:url==="/api/feedback"&&fail?{error:"failed"}:{ok:true}};
  };
  const ctx={...money,document,window:{addEventListener(){}},location,history:{},fetch,URL,AbortSignal,crypto:{randomUUID},console,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}};
  const script=source.replace(/^import .*;\n/,"").split("(async function init()")[0]+
    "\n({setup(d){SETTINGS=d.settings;PRODUCTS=d.products;cart={'1':2,'2':3};storeReady=true;},buyNowWA,finishFeedback,checkout,cartTotals,renderMaintenance,getCart:()=>cart,updateShopDock,updateCartCount,cardStep,cardHTML,openCategories});";
  const api=runInNewContext(script,ctx);api.setup(sanitizeStore(catalog));
  return {api,node,calls,location,setFail(v){fail=v;},setClosed(v){closed=v;}};
}
test("purchase opens optional feedback, skip sends no feedback and preserves all selected items",async()=>{
  const t=await storefront();
  assert.equal(t.api.buyNowWA(1),true);assert.equal(t.node("feedbackDialog").open,true);assert.equal(t.calls.length,0);
  await t.api.finishFeedback(false);
  assert.equal(t.calls.filter(x=>x.url==="/api/feedback").length,0);
  const order=JSON.parse(t.calls.find(x=>x.url==="/api/notify").opts.body);
  assert.deepEqual(order.items.map(i=>[i.id,i.qty]),[[1,2],[2,3]]);
  assert.match(decodeURIComponent(t.location.assigned),/A\* × 2/);
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
