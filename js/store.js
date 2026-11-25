/* ============================================================
   CampusKart — منطق واجهة المتجر
   - كل النصوص القادمة من البيانات تُهرَّب (esc) قبل الإدراج في HTML
   - الأحداث تُربط عبر data-attributes بدل onclick المضمّن
   ============================================================ */
"use strict";

/* ---------- أدوات عامة ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeSrc = (u) => esc(viewerURL(u));
const $ = (id) => document.getElementById(id);

/* ---------- البيانات ---------- */
let SETTINGS = {}, BANNERS = [], CATEGORIES = [], PRODUCTS = [];
const HOUR = 3600000;
const CUR = [["USD", "$"], ["TRY", "₺"], ["SYP", "ل.س"]];
const CUR_LABEL = { SYP: "الليرة السورية", USD: "الدولار الأمريكي", TRY: "الليرة التركية" };
const PRIMARY = "USD";
const state = { q: "", sort: "newest" };
let storeReady=false, maintenance=false, statusBusy=false;
const DEFAULT_MAINTENANCE="نعمل على تحسين المتجر، سنعود قريباً بإذن الله.";

async function loadData() {
  for (const url of ["/api/data"]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() => clearTimeout(timer));
      const data = await res.json();
      if(data.settings?.maintenanceMode===true){
        SETTINGS=data.settings;applyTheme(SETTINGS.theme);
        renderMaintenance(SETTINGS.maintenanceMessage);return false;
      }
      if (!res.ok) continue;
      SETTINGS = data.settings || {};
      SETTINGS.bannerIntervalSec = Math.max(2, parseInt(SETTINGS.bannerIntervalSec, 10) || 7);
      BANNERS = Array.isArray(data.banners) ? data.banners : [];
      CATEGORIES = Array.isArray(data.categories) ? data.categories : [];
      // المنتجات غير المتوفرة تُخفى من الموقع كلياً (تبقى في لوحة التحكم فقط)
      PRODUCTS = (Array.isArray(data.products) ? data.products : [])
        .filter((p) => p && p.availability !== "out")
        .map((p) => ({ ...p, prices: p.prices || {}, images: Array.isArray(p.images) ? p.images : [] }));
      applyTheme(SETTINGS.theme);
      maintenance=false;storeReady=true;
      document.documentElement.classList.remove("maintenance-mode");
      return true;
    } catch (e) { console.warn("loadData fallback", url, e); }
  }
  storeReady=false;
  $("app").innerHTML = `<div class="empty"><h2 class="section-title center">تعذّر تحميل المتجر</h2><p style="margin-top:8px">حدّث الصفحة بعد قليل.</p></div>`;
  return false;
}

function renderMaintenance(message){
  maintenance=true;storeReady=false;resetShare();stopBanner();
  if(imageViewer.open){viewerResume=false;imageViewer.close();}
  document.documentElement.classList.add("maintenance-mode");
  $("app").innerHTML='<section class="maintenance-card" role="status"><img src="assets/logo.svg" alt=""><span class="maintenance-icon" aria-hidden="true">🛠️</span><h1>الموقع قيد الصيانة</h1><p id="maintenanceMessage"></p><button type="button" class="btn btn-primary" id="retryStoreBtn">إعادة المحاولة</button></section>';
  $("maintenanceMessage").textContent=message||DEFAULT_MAINTENANCE;
}
async function checkStoreStatus(){
  const res=await fetch("/api/data?status=1",{cache:"no-store",signal:AbortSignal.timeout(5000)});
  if(!res.ok)throw Error("Status unavailable");
  const status=await res.json();
  if(typeof status.maintenanceMode!=="boolean")throw Error("Invalid status");
  if(status.maintenanceMode){renderMaintenance(status.maintenanceMessage);return false;}
  return true;
}
async function refreshStoreStatus(){
  if(statusBusy||document.hidden)return;
  statusBusy=true;
  try {
    if(await checkStoreStatus()&&!storeReady&&await loadData()){
      loadCart();pruneCart();renderFooter();updateCartCount();route();
    }
  }catch{}finally{statusBusy=false;}
}
async function canOrder(){
  if(!storeReady||maintenance)return false;
  try {return await checkStoreStatus();}
  catch {toast("تعذر التحقق من حالة المتجر؛ حاول مرة أخرى","err");return false;}
}

/* ---------- الألوان المخصّصة من لوحة التحكم ---------- */
const THEME_VARS = { bg: "--bg", surface: "--surface", elevated: "--elevated", line: "--line", fg: "--fg", muted: "--muted", brand: "--brand", brand2: "--brand-2", brandSoft: "--brand-soft", accent: "--accent", accentSoft: "--accent-soft", accentDeep: "--accent-deep", onBrand: "--on-brand", wa: "--wa", danger: "--danger", success: "--success" };
function themeCSS(theme) {
  if (!theme || typeof theme !== "object") return "";
  const ok = (c) => /^#[0-9a-fA-F]{6}$/.test(String(c || ""));
  const block = (sel, m) => {
    if (!m) return "";
    const rules = Object.entries(THEME_VARS).filter(([k]) => ok(m[k])).map(([k, v]) => `${v}:${m[k]}`).join(";");
    return rules ? `${sel}{${rules}}` : "";
  };
  return block(":root", theme.light) + block('html[data-theme="dark"]', theme.dark);
}
function applyTheme(theme) {
  let st = $("customTheme");
  if (!st) { st = document.createElement("style"); st.id = "customTheme"; document.head.appendChild(st); }
  st.textContent = themeCSS(theme);
  const brand = theme?.light?.brand;
  if (brand) { const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute("content", brand); }
}

/* ---------- تنسيق الأسعار ---------- */
const fmtN = (v) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v || 0);
function money(v, c) {
  const n = typeof v === "number" ? (isFinite(v) ? v : 0) : num(v);
  if (c === "SYP") return new Intl.NumberFormat("en-US").format(Math.round(n)) + " ل.س";
  return fmtN(Math.round(n * 100) / 100) + " " + (c === "USD" ? "$" : c === "TRY" ? "₺" : c);
}
const catName = (s) => (CATEGORIES.find((c) => c.slug === s) || {}).name || "";
const availText = (a) => (a === "in" ? "متوفر" : a === "limited" ? "كمية محدودة" : "غير متوفر");
const isNew = (p) => Date.now() - (p.created || 0) < 48 * HOUR;
const byId = (id) => PRODUCTS.find((p) => p.id === id);
// تحويل أي سعر (رقم أو نص مثل "14,000" أو "١٫٥") إلى رقم صحيح
function num(v) {
  if (typeof v === "number") return isFinite(v) && v > 0 ? v : 0;
  let s = String(v ?? "").trim();
  if (!s) return 0;
  s = s.replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x30)).replace(/[٫٬]/g, ",").replace(/[^\d.,]/g, "");
  const lastDot = s.lastIndexOf("."), lastCom = s.lastIndexOf(",");
  if (lastDot !== -1 && lastCom !== -1) s = lastDot > lastCom ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  else if (lastCom !== -1) { const after = s.length - lastCom - 1; s = (after === 3 || s.split(",").length > 2) ? s.replace(/,/g, "") : s.replace(",", "."); }
  else if (lastDot !== -1) { const after = s.length - lastDot - 1; if (s.split(".").length > 2 || (after === 3 && lastDot > 0 && s.length >= 5)) s = s.replace(/\./g, ""); }
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? n : 0;
}
const price = (prices, c) => num(prices?.[c]);
/** العملات التي تُعرض للزبون (لها سعر وغير مخفية) */
function visibleCurs(p) {
  const sc = p.showCurrencies || {};
  return CUR.filter(([c]) => sc[c] !== false && price(p.prices, c) > 0).map(([c]) => c);
}
/** كل العملات التي لها سعر (بغضّ النظر عن الإخفاء) */
const pricedCurs = (prices) => CUR.map(([c]) => c).filter((c) => price(prices, c) > 0);
function hasOffer(p) {
  return !!(p.oldPrices && price(p.oldPrices, PRIMARY) > price(p.prices, PRIMARY));
}
/* ---------- المجموعات: منتجات تشارك نفس اسم المجموعة تُعامل كأنواع لبعضها ---------- */
const groupKey = (p) => String(p.group || "").trim().toLowerCase();
function groupSiblings(p) {
  const g = groupKey(p);
  if (!g) return [];
  return PRODUCTS.filter((x) => x.id !== p.id && groupKey(x) === g).sort((a, b) => (a.created || 0) - (b.created || 0));
}
function mainPriceText(p) {
  const vis = visibleCurs(p);
  const c = vis.includes(PRIMARY) ? PRIMARY : vis[0];
  return c ? money(p.prices[c], c) : "";
}

/* ---------- السلة (تبقى أثناء الجلسة، وتُنظَّف من المنتجات المحذوفة) ---------- */
let cart = {};
function loadCart() {
  try { cart = JSON.parse(sessionStorage.getItem("ck_cart") || "{}") || {}; } catch { cart = {}; }
  if (typeof cart !== "object" || cart === null || Array.isArray(cart)) cart = {};
  try { localStorage.removeItem("ck_cart"); } catch {}
}
function saveCart() { try { sessionStorage.setItem("ck_cart", JSON.stringify(cart)); } catch {} updateCartCount(); }
function pruneCart() {
  let changed = false;
  for (const k of Object.keys(cart)) {
    const q = parseInt(cart[k], 10);
    if (!resolveItem(k) || resolveItem(k).availability === "out" || !(q > 0)) { delete cart[k]; changed = true; }
    else { const n = Math.min(999, q); if (cart[k] !== n) changed = true; cart[k] = n; }
  }
  if (changed) saveCart();
}
const cartQty = () => Object.values(cart).reduce((a, b) => a + b, 0);
const vKey = (id, vi) => (vi == null || vi < 0 ? String(id) : id + "__v" + vi);
function resolveItem(key) {
  const m = String(key).match(/^(\d+)(?:__v(\d+))?$/);
  if (!m) return null;
  const p = byId(+m[1]); if (!p) return null;
  const vi = m[2] != null ? +m[2] : -1;
  const v = vi >= 0 && p.variants && p.variants[vi] ? p.variants[vi] : null;
  if (vi >= 0 && !v) return null;
  // النوع يرث أسعار المنتج إن لم يكن له أي سعر خاص (> 0)
  const vPrices = v && v.prices && pricedCurs(v.prices).length ? v.prices : p.prices;
  return {
    p, vi, v,
    prices: vPrices,
    availability: v?.availability || p.availability,
    name: v ? `${p.name} — ${v.name || "نوع " + (vi + 1)}` : p.name,
    image: v?.image || p.images[0] || "",
    showCurrencies: v?.showCurrencies || p.showCurrencies,
  };
}
function addToCart(id, qty, vi) {
  qty = qty || 1;
  const key = vKey(id, vi == null ? -1 : vi);
  const it = resolveItem(key);
  if (!it || it.availability === "out") { toast("غير متوفر", "err"); return; }
  cart[key] = Math.min(999, (cart[key] || 0) + qty);
  saveCart(); toast("أُضيف إلى السلة");
}
function setQty(key, qty) { if (qty <= 0) delete cart[key]; else cart[key] = Math.min(999, qty); saveCart(); }
function cardStep(id, d) {
  const p = byId(id); if (!p) return;
  if (p.availability === "out") { toast("المنتج غير متوفر", "err"); return; }
  const nx = Math.max(0, Math.min(999, (cart[id] || 0) + d));
  setQty(String(id), nx);
  document.querySelectorAll(`[data-qty-for="${id}"]`).forEach((box) => {
    box.querySelector(".qval").textContent = nx;
    box.querySelector(".qminus").disabled = nx <= 0;
  });
}
/* ---------- حساب الإجمالي (بدقة، بدون أخطاء الفاصلة العشرية) ---------- */
// كل منتج يُحاسب بعملة واحدة:
//  1) الدولار إن كان مرئياً وله سعر   2) أول عملة مرئية لها سعر (تركي ثم سوري)
//  3) إن كانت كل العملات مخفية بالخطأ → أي عملة لها سعر (لا يسقط منتج من الإجمالي أبداً)
function billingCur(it) {
  const vis = visibleCurs({ prices: it.prices, showCurrencies: it.showCurrencies });
  if (vis.includes(PRIMARY)) return PRIMARY;
  if (vis.length) return vis[0];
  const any = pricedCurs(it.prices);
  return any.includes(PRIMARY) ? PRIMARY : any[0] || null;
}
// العمليات بالقروش (×100) لتجنّب مثل 0.1+0.2=0.30000000000000004
const toCents = (v) => Math.round(num(v) * 100);
const fromCents = (c) => c / 100;
function lineTotal(it, q) {
  const c = billingCur(it);
  if (!c) return null;
  const unitCents = toCents(it.prices[c]);
  return { cur: c, unit: fromCents(unitCents), total: fromCents(unitCents * q) };
}
/** يُرجع { USD:{sum,count}, TRY:{...}, SYP:{...} } — كل عملة تجمع منتجاتها فقط */
function cartTotals(src) {
  src = src || cart;
  const cents = { USD: 0, TRY: 0, SYP: 0 }, count = { USD: 0, TRY: 0, SYP: 0 };
  for (const key in src) {
    const it = resolveItem(key); if (!it) continue;
    const q = parseInt(src[key], 10) || 0; if (q <= 0) continue;
    const lt = lineTotal(it, q); if (!lt) continue;
    cents[lt.cur] += Math.round(lt.total * 100); count[lt.cur] += 1;
  }
  const out = {};
  for (const c of Object.keys(cents)) out[c] = { sum: fromCents(cents[c]), count: count[c] };
  return out;
}
function updateCartCount() {
  const n = cartQty(); const el = $("cartCount");
  el.textContent = n; el.style.display = n ? "grid" : "none";
}

/* ---------- واتساب ---------- */
function whatsappNumbers() {
  const list = Array.isArray(SETTINGS.whatsapps) ? SETTINGS.whatsapps : [];
  const nums = list.map((x) => String(x || "").replace(/\D/g, "")).filter((x) => x.length >= 7);
  if (nums.length) return nums;
  const one = String(SETTINGS.whatsapp || "").replace(/\D/g, "");
  return one.length >= 7 ? [one] : [];
}
const DEFAULT_MSG_TEMPLATE = `السلام عليكم
أريد شراء هذه الأشياء:

{items}

السعر النهائي الإجمالي:
{totals}

{notes}

شكراً لكم 🌿`;

const CUR_AR = { USD: "بالدولار", TRY: "بالتركي", SYP: "بالسوري" };
function totalsLines(t) {
  const lines = [];
  for (const c of ["USD", "TRY", "SYP"]) {
    if (t[c] && t[c].count > 0) lines.push(`• ${CUR_AR[c]} (${t[c].count} منتج): *${money(t[c].sum, c)}*`);
  }
  return lines;
}
function buildOrderMessage(notes, fromCart) {
  const src = fromCart || cart;
  const keys = Object.keys(src).filter((k) => resolveItem(k) && resolveItem(k).availability !== "out" && (parseInt(src[k], 10) || 0) > 0);
  if (!keys.length) return "";
  const itemLines = keys.map((key) => {
    const it = resolveItem(key); const q = parseInt(src[key], 10) || 0;
    const lt = lineTotal(it, q);
    if (!lt) return `• *${it.name}* × ${q}`;
    return `• *${it.name}* × ${q} — ${money(lt.unit, lt.cur)} للقطعة = ${money(lt.total, lt.cur)}`;
  });
  const totals = totalsLines(cartTotals(src));
  const totalsText = totals.length ? totals.join("\n") : "—";
  const notesLine = notes && notes.trim() ? `📝 ملاحظة: ${notes.trim().slice(0, 500)}` : "";
  let template = SETTINGS.msgTemplate || DEFAULT_MSG_TEMPLATE;
  // ضمان: إن كان القالب المخصّص بلا {items} أو {totals} نضيفهما حتى لا يضيع الطلب أو الإجمالي
  if (!template.includes("{items}")) template = template.replace(/\s*$/, "") + "\n\n{items}";
  if (!template.includes("{totals}")) template += "\n\nالسعر النهائي الإجمالي:\n{totals}";
  if (!template.includes("{notes}") && notesLine) template += "\n\n{notes}";
  return template
    .replace(/{items}/g, itemLines.join("\n"))
    .replace(/{totals}/g, totalsText)
    .replace(/{notes}/g, notesLine)
    .replace(/{store}/g, SETTINGS.storeName || "")
    .replace(/\n{3,}/g, "\n\n").trim();
}
function orderItems(src) {
  return Object.entries(src).map(([key,qty]) => {
    const it=resolveItem(key);
    return it && it.availability!=="out" ? {id:it.p.id,variant:it.vi,qty:Number(qty)} : null;
  }).filter(Boolean);
}
async function notifyBackground(items, notes, inquiryId) {
  try {
    const res=await fetch("/api/notify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(inquiryId ? {kind:"inquiry",id:inquiryId} : {items,notes}),keepalive:true});
    if(!res.ok) console.warn("Order notification unavailable");
  } catch { console.warn("Order notification unavailable"); }
}
async function openWhatsapp(text, items, notes, inquiryId) {
  const nums=whatsappNumbers();
  if(!nums.length){toast("لم يتم ضبط رقم واتساب","err");return false;}
  if(!await canOrder())return false;
  if(items?.length||inquiryId)notifyBackground(items,notes||"",inquiryId);
  location.assign("https://wa.me/"+nums[0]+"?text="+encodeURIComponent(text));
  return true;
}
function buyNowWA(id,button) {
  const p=byId(id); if(!p)return;
  let vi=-1;
  if(p.variants?.length){vi=p.variants.findIndex(v=>v.availability!=="out");if(vi<0)vi=0;}
  const key=vKey(id,vi),it=resolveItem(key);
  if(!it||it.availability==="out"){toast("غير متوفر","err");return;}
  const src={[key]:1},msg=buildOrderMessage("",src);
  if(msg){
    if(navigator.share&&navigator.canShare&&button)return prepareOrShare(src,button);
    openWhatsapp(withPhotoLinks(msg,src),orderItems(src),"");
  }
}
function inquireWA(id) {
  const p=byId(id);if(!p)return;
  openWhatsapp("مرحباً "+(SETTINGS.storeName||"")+"، مهتم بمنتج: "+p.name,null,"",p.id);
}
function checkout() {
  const notes=($("cNotes")?.value||"").trim(),err=$("cErr");
  if(!whatsappNumbers().length){err.textContent="لم يتم ضبط رقم واتساب المتجر";return;}
  const items=orderItems(cart),msg=buildOrderMessage(notes);
  if(!msg||!items.length){err.textContent="السلة فارغة";return;}
  if(items.length>50){err.textContent="يرجى تقسيم الطلب إلى 50 صنفاً كحد أقصى";return;}
  if(Object.keys(cart).some(k=>{const it=resolveItem(k);return !it||it.availability==="out"||!billingCur(it);})){err.textContent="يوجد منتج غير متوفر أو سعره غير محدد؛ راجع السلة.";return;}
  openWhatsapp(withPhotoLinks(msg,cart),items,notes);
}

/* مشاركة الصور الأصلية: يختار العميل واتساب والمحادثة بنفسه. */
function withPhotoLinks(text,src){
  const links=Object.keys(src).map(key=>resolveItem(key)).filter(Boolean).map(it=>{
    const url=viewerURL(it.image);return url?it.name+": "+url:"";
  }).filter(Boolean);
  return links.length?text+"\n\nصور المنتجات:\n"+links.join("\n"):text;
}
let preparedShare=null;
function resetShare(){preparedShare=null;}
async function getSharePhoto(value){
  const url=viewerURL(value);if(!url)throw Error("Invalid image");
  if(new URL(url).origin===location.origin){
    const res=await fetch(url,{credentials:"omit",signal:AbortSignal.timeout(5000)});
    if(!res.ok)throw Error("Image unavailable");return res.blob();
  }
  // External images may be shared only if their provider permits CORS.
  // No arbitrary server-side proxy is used.
  return new Promise((resolve,reject)=>{
    const img=new Image();img.crossOrigin="anonymous";
    const timer=setTimeout(()=>{img.onload=img.onerror=null;img.src="";reject(Error("Image timeout"));},5000);
    img.onerror=()=>{clearTimeout(timer);reject(Error("External image unavailable"));};
    img.onload=()=>{
      clearTimeout(timer);
      try{
        const scale=Math.min(1,1600/Math.max(img.naturalWidth,img.naturalHeight));
        const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
        canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
        canvas.toBlob(blob=>blob?resolve(blob):reject(Error("Image conversion failed")),"image/jpeg",.9);
      }catch(e){reject(e);}
    };img.src=url;
  });
}
async function prepareOrShare(quickSrc=null,quickButton=null){
  const button=quickButton||$("checkoutBtn"),err=quickSrc?null:$("cErr");
  if(!button||maintenance)return;
  const src=quickSrc||cart;
  const originalLabel=quickSrc?"📲 اطلب":"📲 إتمام الطلب مع الصور";
  const feedback=(message)=>{if(err)err.textContent=message;else toast(message);};
  const fallback=(message)=>{feedback(message);if(quickSrc&&confirm("تعذر إرفاق الصور مباشرة. هل تريد إرسال الطلب النصي وروابط الصور عبر واتساب؟"))openWhatsapp(withPhotoLinks(text,src),items,notes);};
  const notes=quickSrc?"":($("cNotes")?.value||"").trim(),items=orderItems(src),text=buildOrderMessage(notes,src),nums=whatsappNumbers();
  if(!nums.length||!items.length||items.length>50){feedback("تحقق من الطلب ورقم واتساب");return;}
  if(Object.keys(src).some(k=>{const it=resolveItem(k);return !it||it.availability==="out"||!billingCur(it);})){feedback("يوجد منتج غير متوفر أو سعره غير محدد؛ راجع الطلب.");return;}
  const signature=JSON.stringify({items,notes});
  if(preparedShare?.signature===signature&&preparedShare.button===button&&Date.now()-preparedShare.at<30000){
    try{
      await navigator.share(preparedShare.payload);
      notifyBackground(items,notes);resetShare();
      if(button.isConnected)button.textContent=originalLabel;
      feedback("تم فتح المشاركة؛ تأكد من إرسال الطلب في المحادثة.");
    }catch(e){if(e.name!=="AbortError")fallback("تعذرت المشاركة؛ استخدم الطلب النصي وروابط الصور.");}
    return;
  }
  if(!navigator.share||!navigator.canShare){fallback("متصفحك لا يدعم إرفاق الملفات مباشرة. استخدم الطلب النصي وروابط الصور.");return;}
  button.disabled=true;feedback("جاري تجهيز صور المنتجات…");
  try{
    if(!await canOrder())return;
    const urls=[...new Set(Object.keys(src).map(key=>resolveItem(key)?.image).filter(Boolean))];
    const files=[];let bytes=0;
    // Limit memory and prepare batches in parallel, with links for any missing photos.
    for(let i=0;i<Math.min(urls.length,10);i+=3){
      const result=await Promise.allSettled(urls.slice(i,Math.min(i+3,10)).map(getSharePhoto));
      for(const r of result){
        if(r.status!=="fulfilled")continue;
        const blob=r.value,ext=({"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif"})[blob.type];
        if(!ext||!blob.size||blob.size>5*1024*1024||bytes+blob.size>20*1024*1024)continue;
        bytes+=blob.size;files.push(new File([blob],"product-"+(files.length+1)+"."+ext,{type:blob.type}));
      }
    }
    if(!files.length){fallback("لم نتمكن من تجهيز الصور كملفات. استخدم إرسال الطلب النصي مع روابط الصور.");return;}
    const payload={files,text:withPhotoLinks(text,src)+"\nرقم المتجر: +"+nums[0]};
    if(!navigator.canShare(payload)){fallback("المشاركة غير مدعومة لهذه الصور؛ استخدم الطلب النصي.");return;}
    if(!button.isConnected||signature!==JSON.stringify({items:orderItems(src),notes:quickSrc?"":($("cNotes")?.value||"").trim()}))return;
    if(!await canOrder())return;
    if(!button.isConnected||maintenance)return;
    preparedShare={signature,payload,button,at:Date.now()};button.textContent=quickSrc?"📲 أرسل الصورة":"📲 إرسال الصور الآن — اختر WhatsApp";
    feedback("تم تجهيز "+files.length+" من "+urls.length+" صورة. اضغط مجدداً، ثم اختر واتساب ومحادثة المتجر: +"+nums[0]+". روابط جميع الصور مرفقة في النص.");
  }catch{fallback("تعذر تجهيز الصور؛ استخدم إرسال الطلب النصي وروابط الصور.");}
  finally{button.disabled=false;}
}

/* ---------- التنقّل ---------- */
// الانتقال لأعلى الصفحة فوراً (بدون أنيميشن سحب) عند كل تنقّل داخل المتجر
function jumpTop() {
  document.documentElement.style.scrollBehavior = "auto";
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  document.documentElement.scrollTop = 0; document.body.scrollTop = 0;
}
function go(path) {
  const h = path ? "#" + path : "#";
  if (location.hash !== h) history.pushState(null, "", h);
  route(); jumpTop();
}
function navTo(path) {
  state.q = ""; $("searchInput").value = "";
  go(path);
}
// زر الرجوع/التقدم في المتصفح أو تغيير الرابط يدوياً
window.addEventListener("hashchange", () => { route(); jumpTop(); });
window.addEventListener("popstate", () => { route(); jumpTop(); });
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.addEventListener("pageshow", async (e) => { if (e.persisted && await loadData()) { loadCart(); pruneCart(); updateCartCount(); route(); } });

/* ---------- المكوّنات ---------- */
function renderChips(active) {
  let h = `<button class="chip ${active === "" ? "active" : ""}" data-nav="">🏠 الرئيسية</button>`;
  h += `<button class="chip ${active === "new" ? "active" : ""}" data-nav="new">🆕 جديد</button>`;
  CATEGORIES.forEach((c) => { h += `<button class="chip ${active === c.slug ? "active" : ""}" data-nav="category/${esc(c.slug)}">${esc(c.name)}</button>`; });
  $("chipBar").innerHTML = h;
}
function sidebarHTML(active) {
  const counts = {}; PRODUCTS.forEach((p) => (counts[p.category] = (counts[p.category] || 0) + 1));
  let h = `<nav class="sidebar" aria-label="الأقسام"><div class="side-title">الأقسام</div>`;
  h += `<button class="side-link new-link ${active === "new" ? "active" : ""}" data-nav="new"><span>🆕 جديد</span><span class="n">${PRODUCTS.filter(isNew).length}</span></button>`;
  h += `<button class="side-link ${active === "" ? "active" : ""}" data-nav=""><span>كل المنتجات</span><span class="n">${PRODUCTS.length}</span></button>`;
  CATEGORIES.forEach((c) => { h += `<button class="side-link ${active === c.slug ? "active" : ""}" data-nav="category/${esc(c.slug)}"><span>${esc(c.name)}</span><span class="n">${counts[c.slug] || 0}</span></button>`; });
  return h + `</nav>`;
}

let bannerIdx = 0, bannerTimer = null;
function stopBanner() { if (bannerTimer) { clearInterval(bannerTimer); bannerTimer = null; } }
function bannerHTML() {
  if (SETTINGS.bannersEnabled === false) return "";
  if (!BANNERS.length) {
    return `<div class="banner-area"><div class="banner empty"><div class="txt"><div class="ey">${esc(SETTINGS.storeName)}</div><h2>${esc(SETTINGS.description || "أهلاً بك")}</h2></div></div></div>`;
  }
  const dots = BANNERS.length > 1 ? `<div class="banner-dots">${BANNERS.map((_, i) => `<button type="button" data-banner-set="${i}" class="${i === 0 ? "active" : ""}" aria-label="الإعلان ${i+1}"></button>`).join("")}</div>` : "";
  return `<section class="banner-area" aria-label="إعلانات"><div class="banner" id="bannerBox"></div>${dots}</section>`;
}
function renderBanner() {
  const box = $("bannerBox"); const b = BANNERS[bannerIdx];
  if (!box || !b) return;
  const src = safeSrc(b.image);
  const link = safeSrc(b.link);
  const inner = `${src ? `<img src="${src}" alt="">` : ""}<div class="ov"></div><div class="txt">${b.eyebrow ? `<div class="ey">${esc(b.eyebrow)}</div>` : ""}${b.title ? `<h2>${esc(b.title)}</h2>` : ""}</div>`;
  box.innerHTML = inner + (src ? `<button type="button" class="image-hit" data-image-banner="${bannerIdx}" aria-label="تكبير الإعلان"></button>` : link ? `<a href="${link}" target="_blank" rel="noopener" class="image-hit" aria-label="فتح رابط الإعلان"></a>` : "");
  document.querySelectorAll(".banner-dots button").forEach((d, i) => d.classList.toggle("active", i === bannerIdx));
}
function startBanner() {
  stopBanner();
  if (SETTINGS.bannersEnabled === false || BANNERS.length < 2) return;
  bannerTimer = setInterval(() => { bannerIdx = (bannerIdx + 1) % BANNERS.length; renderBanner(); }, SETTINGS.bannerIntervalSec * 1000);
}

function getList(mode, slug) {
  let list = PRODUCTS.slice();
  if (mode === "category") list = list.filter((p) => p.category === slug);
  if (mode === "new") list = list.filter(isNew);
  if (state.q) {
    const q = state.q.trim().toLowerCase();
    list = list.filter((p) => (p.name || "").toLowerCase().includes(q) || (p.description || "").toLowerCase().includes(q) || (p.group || "").toLowerCase().includes(q) || (p.variants || []).some((v) => (v.name || "").toLowerCase().includes(q)));
  }
  const pr = (p) => price(p.prices, PRIMARY);
  if (state.sort === "price_asc") list.sort((a, b) => pr(a) - pr(b));
  else if (state.sort === "price_desc") list.sort((a, b) => pr(b) - pr(a));
  else if (state.sort === "views") list.sort((a, b) => (b.views || 0) - (a.views || 0));
  else list.sort((a, b) => (b.created || 0) - (a.created || 0));
  return list;
}

function cardHTML(p) {
  const img = safeSrc(p.images[0]);
  const vis = visibleCurs(p);
  const primary = vis.includes(PRIMARY) ? PRIMARY : vis[0] || PRIMARY;
  const subPrices = vis.filter((c) => c !== primary).map((c) => money(p.prices[c], c)).join(" · ");
  const offer = hasOffer(p);
  const badges = [];
  if (offer) badges.push('<span class="badge offer">عرض</span>');
  if (isNew(p)) badges.push('<span class="badge new">جديد</span>');
  if (p.availability === "limited") badges.push('<span class="badge limited">محدود</span>');
  const out = p.availability === "out";
  const q = cart[p.id] || 0;
  return `<article class="card" data-pid="${p.id}">
    <div class="thumb" ${img ? "" : `data-open="${p.id}"`}>
      ${img ? `<img loading="lazy" src="${img}" alt="${esc(p.name)}">` : `<div class="ph">🛍️</div>`}
      <div class="badges">${badges.join("")}</div>
      ${out ? '<div class="soldout"><span>غير متوفر</span></div>' : ""}
      ${img ? `<button type="button" class="image-hit" data-image-product="${p.id}" aria-label="تكبير صورة ${esc(p.name)}"></button>` : ""}
    </div>
    <div class="body">
      <button class="cat" data-nav="category/${esc(p.category)}">${esc(catName(p.category))}</button>
      <div class="name" data-open="${p.id}">${esc(p.name)}</div>
      ${groupSiblings(p).length ? `<div class="group-hint" data-open="${p.id}">🧩 ${esc(p.group)} · ${groupSiblings(p).length + 1} أنواع</div>` : ""}
      <div class="desc">${esc(p.description)}</div>
      <div class="price"><b>${money(p.prices[primary], primary)}</b>${offer && vis.includes(PRIMARY) ? `<s>${money(p.oldPrices[PRIMARY], PRIMARY)}</s>` : ""}${subPrices ? `<span class="sub">${subPrices}</span>` : ""}</div>
      <div class="add">${out ? '<button class="btn btn-ghost" disabled>غير متوفر</button>' : `
        <div class="qty-inline" data-qty-for="${p.id}">
          <button class="qbtn qminus" data-step="${p.id}|-1" aria-label="إنقاص" ${q <= 0 ? "disabled" : ""}>−</button>
          <span class="qval">${q}</span>
          <button class="qbtn qplus" data-step="${p.id}|1" aria-label="زيادة">+</button>
        </div>
        <div class="card-actions">
          <button class="btn btn-outline" data-add="${p.id}" title="أضف للسلة" aria-label="أضف للسلة">🛒</button>
          <button class="btn btn-wa" data-buy="${p.id}" title="اطلب عبر واتساب">📲 اطلب</button>
        </div>`}</div>
    </div></article>`;
}

function renderListing(mode, slug) {
  const list = getList(mode, slug);
  const active = mode === "category" ? slug : mode === "new" ? "new" : "";
  const title = state.q ? `نتائج: ${state.q}` : mode === "new" ? "وصل حديثاً" : mode === "category" ? catName(slug) : "جميع المنتجات";
  const banner = mode === "" && !state.q ? bannerHTML() : "";
  const showSide = mode !== "";
  $("app").innerHTML = `${banner}
    <div class="layout ${showSide ? "with-side" : ""}">
      ${showSide ? sidebarHTML(active) : ""}
      <section aria-label="${esc(title)}">
        <div class="toolbar">
          <h2 class="section-title">${esc(title)}</h2>
          <select id="sortSel" aria-label="ترتيب">
            <option value="newest">الأحدث</option><option value="price_asc">السعر: من الأقل</option>
            <option value="price_desc">السعر: من الأعلى</option><option value="views">الأكثر مشاهدة</option>
          </select>
        </div>
        <div class="count">${list.length} نتيجة</div>
        ${list.length ? `<div class="grid" style="margin-top:10px">${list.map(cardHTML).join("")}</div>` : `<div class="empty">لا توجد منتجات هنا حالياً.</div>`}
      </section>
    </div>`;
  const sel = $("sortSel"); sel.value = state.sort; sel.onchange = (e) => { state.sort = e.target.value; route(); };
  const si = $("searchInput"); if (document.activeElement !== si) si.value = state.q;
  if (banner) { bannerIdx = 0; renderBanner(); startBanner(); }
}

/* ---------- صفحة المنتج ---------- */
let gImg = 0, curVariant = -1, pQ = 1;
const curProductId = () => { const m = location.hash.match(/product\/(\d+)/); return m ? +m[1] : null; };
function priceRows(prices, sc, oldPrices) {
  const vis = visibleCurs({ prices, showCurrencies: sc });
  return CUR.filter(([c]) => vis.includes(c)).map(([c]) => `<div class="pr"><span class="cur">${CUR_LABEL[c]}</span><span class="val">${money(prices[c], c)}${oldPrices && price(oldPrices, c) > price(prices, c) ? `<s>${money(oldPrices[c], c)}</s>` : ""}</span></div>`).join("");
}
function similarHTML(p) {
  const g = groupKey(p);
  const sims = PRODUCTS.filter((x) => x.id !== p.id && x.category === p.category && (!g || groupKey(x) !== g)).slice(0, 4);
  return sims.length ? `<div style="margin:26px 0 10px"><h2 class="section-title">منتجات مشابهة</h2></div><div class="grid">${sims.map(cardHTML).join("")}</div>` : "";
}
/** أنواع أخرى من نفس المجموعة — تظهر تحت صورة المنتج */
function groupBoxHTML(p) {
  const sibs = groupSiblings(p);
  if (!sibs.length) return "";
  const tile = (x, current) => {
    const img = safeSrc(x.images[0]);
    const out = x.availability === "out";
    return `<button type="button" class="group-tile${current ? " current" : ""}${out ? " out" : ""}" ${current ? "disabled" : `data-open="${x.id}"`} title="${esc(x.name)}">
      ${img ? `<img src="${img}" alt="" loading="lazy">` : `<div class="ph">🛍️</div>`}
      <span class="gt-name">${esc(x.name)}</span>
      <span class="gt-price">${out ? "غير متوفر" : esc(mainPriceText(x))}</span>
      ${current ? '<span class="gt-badge">الحالي</span>' : ""}
    </button>`;
  };
  const all = [p, ...sibs].sort((a, b) => (a.created || 0) - (b.created || 0));
  return `<section class="group-box" aria-label="أنواع المجموعة">
    <h3>🧩 أنواع ${esc(p.group)} <span class="n">(${all.length})</span></h3>
    <div class="group-list">${all.map((x) => tile(x, x.id === p.id)).join("")}</div>
  </section>`;
}
function renderProduct(id) {
  const p = byId(id);
  if (!p) { $("app").innerHTML = '<div class="empty">المنتج غير موجود.</div>'; return; }
  gImg = 0; pQ = 1;
  curVariant = p.variants?.length ? 0 : -1;
  const imgs = [...new Set([...p.images,...(p.variants||[]).map(v=>v.image)].map(safeSrc).filter(Boolean))];
  const varBlock = p.variants?.length ? `<div class="block"><h3>اختر النوع</h3><div class="variants-bar" id="varBox">${p.variants.map((v, i) => `<button type="button" class="var-chip${i === 0 ? " active" : ""}" data-var="${i}">${esc(v.name || "نوع " + (i + 1))}</button>`).join("")}</div></div>` : "";
  $("app").innerHTML = `
    <nav class="crumb" aria-label="مسار"><button data-nav="">الرئيسية</button><span>/</span><button data-nav="category/${esc(p.category)}">${esc(catName(p.category))}</button><span>/</span><span style="color:var(--fg)">${esc(p.name)}</span></nav>
    <div class="pview">
      <div class="gallery">
        <div class="main">
          ${imgs[0] ? `<img id="gMain" src="${imgs[0]}" alt="${esc(p.name)}"><button type="button" class="image-hit" data-image-current="${p.id}" aria-label="تكبير صورة ${esc(p.name)}"></button>` : `<div class="ph" style="display:grid;place-items:center;height:100%;font-size:60px">🛍️</div>`}
          ${imgs.length > 1 ? `<button class="gnav prev" data-gstep="-1" aria-label="السابق">›</button><button class="gnav next" data-gstep="1" aria-label="التالي">‹</button>` : ""}
        </div>
        ${imgs.length > 1 ? `<div class="thumbs">${imgs.map((im, i) => `<img src="${im}" alt="" class="${i === 0 ? "active" : ""}" data-gset="${i}">`).join("")}</div>` : ""}
        ${groupBoxHTML(p)}
      </div>
      <div class="pinfo">
        <div class="cat">${esc(catName(p.category))}</div>
        <h1>${esc(p.name)}</h1>
        <div><span class="tag ${esc(p.availability)}" id="pAvailTag">${availText(p.availability)}</span></div>
        <div class="prices" id="pPricesBox">${priceRows(p.prices, p.showCurrencies, p.oldPrices)}</div>
        ${varBlock}
        ${p.description ? `<div class="block"><h3>الوصف</h3><div class="body-txt">${esc(p.description)}</div></div>` : ""}
        ${p.notes ? `<div class="block"><h3>ملاحظات</h3><div class="notes">${esc(p.notes)}</div></div>` : ""}
        ${p.availability !== "out" ? `
        <div class="row" style="align-items:flex-end">
          <div style="flex:0 0 auto"><label class="label">الكمية</label>
            <div class="qty"><button data-pstep="-1" aria-label="إنقاص">−</button><span id="pQty">1</span><button data-pstep="1" aria-label="زيادة">+</button></div>
          </div>
          <button class="btn btn-primary" style="flex:1" id="pAddBtn" data-addpage="${p.id}">أضف إلى السلة 🛒</button>
        </div>` : '<button class="btn btn-ghost" disabled>غير متوفر حالياً</button>'}
        ${whatsappNumbers().length ? `<button class="btn btn-wa" data-inquire="${p.id}" style="width:100%">استفسار عبر واتساب</button>` : ""}
      </div>
    </div>
    ${similarHTML(p)}`;
  if(curVariant >= 0) pickVariant(curVariant);
}
function gSet(i) {
  const p = byId(curProductId()); if (!p) return;
  const imgs = [...new Set([...p.images,...(p.variants||[]).map(v=>v.image)].map(viewerURL).filter(Boolean))];
  gImg = i; const m = $("gMain"); if (m && imgs[i]) m.src = imgs[i];
  document.querySelectorAll(".thumbs img").forEach((t, idx) => t.classList.toggle("active", idx === i));
}
function pickVariant(vi) {
  const p = byId(curProductId()); if (!p?.variants?.[vi]) return;
  curVariant = vi; const v = p.variants[vi];
  $("pPricesBox").innerHTML = priceRows(v.prices && pricedCurs(v.prices).length ? v.prices : p.prices, v.showCurrencies || p.showCurrencies);
  const avail = v.availability || p.availability;
  const tag = $("pAvailTag"); tag.className = "tag " + esc(avail); tag.textContent = availText(avail);
  const gm = $("gMain"); const vimg = viewerURL(v.image); if (gm) { const urls=[...new Set([...p.images,...(p.variants||[]).map(x=>x.image)].map(viewerURL).filter(Boolean))]; gSet(Math.max(0,urls.indexOf(vimg))); }
  document.querySelectorAll("#varBox .var-chip").forEach((c, i) => c.classList.toggle("active", i === vi));
  const addBtn = $("pAddBtn"); if (addBtn) addBtn.disabled = avail === "out";
}

/* ---------- السلة ---------- */
function renderCart() {
  resetShare(); pruneCart();
  const keys = Object.keys(cart);
  if (!keys.length) {
    $("app").innerHTML = `<div class="empty"><h2 class="section-title center">سلة المشتريات فارغة</h2><p style="margin-top:10px">أضف بعض المنتجات لتبدأ.</p><button class="btn btn-primary" style="margin-top:14px" data-nav="">تصفّح المنتجات</button></div>`;
    return;
  }
  const t = cartTotals();
  const rows = keys.map((key) => {
    const q = cart[key]; const it = resolveItem(key);
    const img = safeSrc(it.image);
    const lt = lineTotal(it, q);
    return `<div class="cart-item">
      ${img ? `<img src="${img}" alt="${esc(it.p.name)}" data-image-product="${it.p.id}" role="button" tabindex="0" style="cursor:zoom-in">` : '<div class="ph">🛍️</div>'}
      <div class="ci-body">
        <div class="ci-name">${esc(it.name)}</div>
        <div class="ci-price">${lt ? money(lt.unit, lt.cur) + " · للقطعة" : ""}</div>
        <div class="qty" style="margin-top:5px"><button data-cstep="${esc(key)}|-1" aria-label="إنقاص">−</button><span>${q}</span><button data-cstep="${esc(key)}|1" aria-label="زيادة">+</button></div>
      </div>
      <div style="text-align:end">
        <div class="ci-total">${lt ? money(lt.total, lt.cur) : ""}</div>
        <button class="link-remove" data-cremove="${esc(key)}">حذف</button>
      </div></div>`;
  }).join("");
  const totalsRows = ["USD", "TRY", "SYP"].filter((c) => t[c].count > 0);
  $("app").innerHTML = `
    <nav class="crumb"><button data-nav="">الرئيسية</button><span>/</span><span style="color:var(--fg)">السلة</span></nav>
    <h2 class="section-title" style="margin-bottom:10px">🛒 سلة المشتريات</h2>
    <div>${rows}</div>
    <div class="cart-totals">
      <div class="t-row" style="color:var(--muted);font-size:12.5px">السعر النهائي الإجمالي${totalsRows.length > 1 ? " (مقسّم حسب عملة كل منتج)" : ""}</div>
      ${totalsRows.map((c) => `<div class="t-row big"><span>${CUR_AR[c]} <small style="color:var(--muted);font-weight:400">(${t[c].count} منتج)</small></span><span>${money(t[c].sum, c)}</span></div>`).join("")}
    </div>
    <div class="cart-totals">
      <label class="label" for="cNotes">ملاحظات (اختياري)</label>
      <textarea class="field" id="cNotes" rows="2" maxlength="500" placeholder="مكان التوصيل، وقت مفضّل..."></textarea>
      <div id="cErr" class="err-msg"></div>
      <button class="btn btn-wa" style="width:100%;margin-top:10px" id="checkoutBtn">📲 إتمام الطلب مع الصور</button>
      <button type="button" class="btn btn-outline" style="width:100%;margin-top:8px" id="shareOrderBtn">إرسال الطلب النصي ورابط الصور عبر واتساب</button>
      ${SETTINGS.deliveryNote ? `<p class="delivery-note">${esc(SETTINGS.deliveryNote)}</p>` : ""}
    </div>`;
}

/* ---------- Toast / Footer / Theme ---------- */
let toastTimer = null;
function toast(msg, type) {
  let el = $("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.className = "show" + (type === "err" ? " err" : ""); el.textContent = msg;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = ""), 1600);
}
function renderFooter() {
  const items = [];
  const email = String(SETTINGS.email || "").replace(/[^\w.@+-]/g, "");
  if (email) items.push(`<a class="fitem" href="mailto:${esc(email)}">✉️ ${esc(email)}</a>`);
  const w = whatsappNumbers();
  if (w.length) items.push(`<a class="fitem" target="_blank" rel="noopener" href="https://wa.me/${w[0]}"><span dir="ltr">✆ +${w[0]}</span></a>`);
  const ig = String(SETTINGS.instagram || "").replace(/^@/, "").replace(/[^\w.]/g, "");
  if (ig) items.push(`<a class="fitem" target="_blank" rel="noopener" href="https://instagram.com/${esc(ig)}">◎ @${esc(ig)}</a>`);
  $("foot").innerHTML = `<div class="fitems">${items.join("")}</div>${SETTINGS.deliveryNote ? `<div class="delivery">${esc(SETTINGS.deliveryNote)}</div>` : ""}`;
  const name = SETTINGS.storeName || "CampusKart";
  $("copy").textContent = `© ${new Date().getFullYear()} ${name} — جميع الحقوق محفوظة`;
  $("logoText").innerHTML = esc(name) + "<b>.</b>";
  document.title = `${name} — متجر الجامعة`;
}
/* ---------- معرض تكبير الصور ---------- */
function viewerURL(value) {
  const raw=String(value||"").trim();
  if(/[\u0000-\u0020\u007f\\]/.test(raw)||(!/^\/(?![\/\\])/.test(raw)&&!/^https?:\/\//i.test(raw)))return "";
  try {const u=new URL(raw,location.href);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:"";}catch{return "";}
}
let viewerItems=[],viewerIndex=0,viewerProduct=null,viewerFocus=null,viewerResume=false,swipeStart=null;
function showViewerImage(){
  const item=viewerItems[viewerIndex];if(!item)return;
  $("viewerImage").src=item.src;$("viewerImage").alt=item.title;
  $("viewerTitle").textContent=item.title;$("viewerCount").textContent=(viewerIndex+1)+" / "+viewerItems.length;
  $("viewerPrev").hidden=$("viewerNext").hidden=viewerItems.length<2;
  const link=$("viewerLink");link.hidden=!item.link;
  if(item.link)link.href=item.link;else link.removeAttribute("href");
  $("viewerProduct").hidden=viewerProduct===null;
}
function openViewer(items,index,product=null){
  if(!items.length)return;
  const dialog=$("imageViewer");if(dialog.open)return;
  viewerItems=items;viewerIndex=Math.max(0,Math.min(index,items.length-1));viewerProduct=product;
  viewerFocus=document.activeElement;viewerResume=!!$("bannerBox");stopBanner();
  showViewerImage();dialog.showModal();document.documentElement.classList.add("viewer-open");$("viewerClose").focus();
}
function openBannerViewer(index){
  const entries=BANNERS.map((b,i)=>({src:viewerURL(b.image),title:String(b.title||"إعلان "+(i+1)),link:viewerURL(b.link),index:i})).filter(b=>b.src);
  openViewer(entries,entries.findIndex(b=>b.index===index));
}
function openProductViewer(id,current,selected){
  const p=byId(id);if(!p)return;
  const active=viewerURL(selected || (current?$("gMain")?.getAttribute("src"):""));
  const urls=[...new Set([...p.images,...(p.variants||[]).map(v=>v.image)].map(viewerURL).filter(Boolean))];
  openViewer(urls.map(src=>({src,title:p.name,link:""})),Math.max(0,urls.indexOf(active)),current?null:id);
}
function moveViewer(step){
  if(viewerItems.length<2)return;
  viewerIndex=(viewerIndex+step+viewerItems.length)%viewerItems.length;showViewerImage();
}
const imageViewer=$("imageViewer");
$("viewerClose").addEventListener("click",()=>imageViewer.close());
$("viewerPrev").addEventListener("click",()=>moveViewer(-1));
$("viewerNext").addEventListener("click",()=>moveViewer(1));
$("viewerProduct").addEventListener("click",()=>{const id=viewerProduct;viewerResume=false;imageViewer.close();if(id!==null)go("product/"+id);});
imageViewer.addEventListener("click",e=>{if(e.target===imageViewer)imageViewer.close();});
imageViewer.addEventListener("keydown",e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight"){e.preventDefault();moveViewer(e.key==="ArrowLeft"?1:-1);}});
$("viewerImage").addEventListener("touchstart",e=>{swipeStart=e.changedTouches[0].clientX;},{passive:true});
$("viewerImage").addEventListener("touchcancel",()=>{swipeStart=null;});
$("viewerImage").addEventListener("touchend",e=>{if(swipeStart===null)return;const d=e.changedTouches[0].clientX-swipeStart;swipeStart=null;if(Math.abs(d)>50)moveViewer(d>0?1:-1);},{passive:true});
imageViewer.addEventListener("close",()=>{
  document.documentElement.classList.remove("viewer-open");$("viewerImage").removeAttribute("src");swipeStart=null;
  if(viewerResume&&$("bannerBox"))startBanner();
  if(viewerFocus?.isConnected)viewerFocus.focus({preventScroll:true});
  viewerItems=[];viewerProduct=null;viewerFocus=null;viewerResume=false;
});
document.addEventListener("keydown",e=>{if((e.key==="Enter"||e.key===" ")&&e.target.matches?.('img[data-image-product]')){e.preventDefault();openProductViewer(Number(e.target.dataset.imageProduct),false,e.target.getAttribute("src"));}});

function route() {
  if(!storeReady||maintenance)return;
  if(imageViewer.open){viewerResume=false;imageViewer.close();}
  stopBanner();
  const h = location.hash.replace(/^#/, "");
  let active = "";
  if (h.startsWith("category/")) active = h.split("/")[1];
  else if (h === "new") active = "new";
  renderChips(active);
  if (h.startsWith("product/")) return renderProduct(+h.split("/")[1]);
  if (h.startsWith("category/")) return renderListing("category", (h.split("/")[1] || "").replace(/[^a-z0-9_-]/gi,""));
  if (h === "new") return renderListing("new");
  if (h === "cart") return renderCart();
  return renderListing("");
}
function initTheme() {
  let saved = "light";
  try { saved = localStorage.getItem("ck_theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); } catch {}
  document.documentElement.setAttribute("data-theme", saved);
  $("themeBtn").textContent = saved === "dark" ? "☀️" : "🌙";
}

/* ---------- ربط الأحداث (تفويض واحد) ---------- */
document.addEventListener("click", (e) => {
  if(e.target.closest("#retryStoreBtn"))return refreshStoreStatus();
  if(!storeReady||maintenance)return;
  if(e.target.closest("#shareOrderBtn"))return checkout();
  const imageTrigger=e.target.closest("[data-image-banner],[data-image-product],[data-image-current],[data-banner-set]");
  if(imageTrigger){
    const d=imageTrigger.dataset;
    if(d.bannerSet!==undefined){bannerIdx=Number(d.bannerSet);renderBanner();startBanner();return;}
    if(d.imageBanner!==undefined)return openBannerViewer(Number(d.imageBanner));
    return openProductViewer(Number(d.imageProduct??d.imageCurrent),d.imageCurrent!==undefined,imageTrigger.tagName==="IMG"?imageTrigger.getAttribute("src"):null);
  }
  const t = e.target.closest("[data-nav],[data-open],[data-step],[data-add],[data-buy],[data-var],[data-gstep],[data-gset],[data-pstep],[data-addpage],[data-inquire],[data-cstep],[data-cremove],#checkoutBtn");
  if (!t) return;
  const d = t.dataset;
  if (d.nav !== undefined) { e.stopPropagation(); return navTo(d.nav); }
  if (d.open !== undefined) return go("product/" + d.open);
  if (d.step) { const [id, dir] = d.step.split("|"); return cardStep(+id, +dir); }
  if (d.add) return addToCart(+d.add, 1);
  if (d.buy) return buyNowWA(+d.buy,t);
  if (d.var !== undefined) return pickVariant(+d.var);
  if (d.gstep) { const p = byId(curProductId()); if (!p) return; const n = [...new Set([...p.images,...(p.variants||[]).map(v=>v.image)].map(viewerURL).filter(Boolean))].length; if(n)return gSet((gImg + +d.gstep + n) % n);return; }
  if (d.gset !== undefined) return gSet(+d.gset);
  if (d.pstep) { pQ = Math.max(1, Math.min(999, pQ + +d.pstep)); $("pQty").textContent = pQ; return; }
  if (d.addpage) { addToCart(+d.addpage, pQ, curVariant); pQ = 1; $("pQty").textContent = 1; return; }
  if (d.inquire) return inquireWA(+d.inquire);
  if (d.cstep) { const [key, dir] = d.cstep.split("|"); setQty(key, (cart[key] || 0) + +dir); return renderCart(); }
  if (d.cremove) { delete cart[d.cremove]; saveCart(); return renderCart(); }
  if (t.id === "checkoutBtn") return prepareOrShare();
});
$("themeBtn").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("ck_theme", next); } catch {}
  $("themeBtn").textContent = next === "dark" ? "☀️" : "🌙";
});
$("cartBtn").addEventListener("click", () => go("cart"));
$("logoBtn").addEventListener("click", () => navTo(""));
let searchTimer;
$("searchInput").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.slice(0, 80); (!location.hash || location.hash === "#") ? route() : go(""); }, 250);
});

/* ---------- تشغيل ---------- */
(async function init() {
  initTheme();
  setInterval(refreshStoreStatus,30000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)refreshStoreStatus();});
  if (!(await loadData())) return;
  loadCart(); pruneCart();
  renderFooter(); updateCartCount(); route();
})();
