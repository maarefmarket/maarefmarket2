import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../js/store.js",import.meta.url),"utf8");
const css=await readFile(new URL("../css/style.css",import.meta.url),"utf8");
const admin=await readFile(new URL("../css/admin.css",import.meta.url),"utf8");
const block=source.slice(source.indexOf("function renderBanner("),source.indexOf("function startBanner("));
function fixture(){
  const attrs=new Map(),box={innerHTML:"",setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),querySelector:()=>null};
  const run=new Function("$","BANNERS","bannerIdx","safeSrc","esc","document","animateSlide",block+"\nreturn renderBanner;");
  const render=(banner)=>run(()=>box,[banner],0,x=>x||"",x=>String(x||"").replace(/</g,"&lt;").replace(/"/g,"&quot;"),{querySelectorAll:()=>[]},()=>{})();
  return {attrs,box,render};
}
test("adaptive banner is the default without trial flags, caption covers no image",()=>{
  const {attrs,box,render}=fixture();
  render({image:"/api/image/ad.png",eyebrow:"Store",title:"<Offer>"});
  assert.equal(attrs.get("data-banner-fit"),"adaptive");
  assert.match(box.innerHTML,/class="banner-image-frame"><img/);
  assert.match(box.innerHTML,/<\/div><div class="txt">/);
  assert.match(box.innerHTML,/&lt;Offer>/);
  assert.doesNotMatch(box.innerHTML,/class="ov"/);
  assert.match(box.innerHTML,/data-image-banner="0"/);
  assert.doesNotMatch(block,/bannerDemo|deploy-preview/);
});
test("text-only banners restore original text treatment and link, no empty image frame",()=>{
  const {attrs,box,render}=fixture();
  render({image:"/api/image/ad.png"});
  render({title:"Text only",link:"https://example.org/"});
  assert.equal(attrs.has("data-banner-fit"),false);
  assert.match(box.innerHTML,/class="ov"/);
  assert.match(box.innerHTML,/href="https:\/\/example.org\/"/);
  assert.doesNotMatch(box.innerHTML,/banner-image-frame|data-image-banner/);
});
test("image-only banners omit empty caption; storefront and admin contain instead of crop",()=>{
  const {box,render}=fixture();render({image:"/api/image/ad.png"});
  assert.doesNotMatch(box.innerHTML,/class="txt"/);
  assert.match(css,/#bannerBox\[data-banner-fit="adaptive"\] img\{[^}]*height:auto;max-height:clamp\(280px,50vw,440px\);object-fit:contain/);
  assert.match(admin,/\.banner-preview\{[^}]*object-fit:contain/);
  assert.doesNotMatch(css,/data-banner-trial/);
});
