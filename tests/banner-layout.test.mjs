import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../js/store.js",import.meta.url),"utf8");
const css=await readFile(new URL("../css/style.css",import.meta.url),"utf8");
const admin=await readFile(new URL("../css/admin.css",import.meta.url),"utf8");
const block=source.slice(source.indexOf("function renderBanner("),source.indexOf("function startBanner("));
function fixture(){
  const box={innerHTML:"",querySelector:()=>null};
  const run=new Function("$","BANNERS","bannerIdx","safeSrc","esc","document","animateSlide",block+"\nreturn renderBanner;");
  const render=banner=>run(()=>box,[banner],0,x=>x||"",x=>String(x||"").replace(/</g,"&lt;").replace(/"/g,"&quot;"),{querySelectorAll:()=>[]},()=>{})();
  return {box,render};
}
test("original banner overlays caption and retains image zoom",()=>{
  const {box,render}=fixture();
  render({image:"/api/image/ad.png",eyebrow:"Store",title:"<Offer>"});
  assert.match(box.innerHTML,/<img src="\/api\/image\/ad.png" alt=""><div class="ov"><\/div><div class="txt">/);
  assert.match(box.innerHTML,/&lt;Offer>/);
  assert.match(box.innerHTML,/data-image-banner="0"/);
  assert.doesNotMatch(block,/data-banner-fit|bannerDemo|banner-image-frame/);
});
test("original text-only banners retain link without image controls",()=>{
  const {box,render}=fixture();
  render({title:"Text only",link:"https://example.org/"});
  assert.match(box.innerHTML,/class="ov"/);
  assert.match(box.innerHTML,/href="https:\/\/example.org\/"/);
  assert.doesNotMatch(box.innerHTML,/<img|data-image-banner/);
});
test("original fixed responsive banner and admin preview styles restored",()=>{
  assert.match(css,/\.banner img\{[^}]*object-fit:cover/);
  assert.match(css,/\.banner,\.banner \.txt\{min-height:clamp\(160px,23vw,280px\)/);
  assert.match(admin,/\.banner-preview\{[^}]*max-height:160px;object-fit:cover/);
  assert.doesNotMatch(css,/data-banner-fit|data-banner-trial/);
});
