import { decimal, roundPrice, formatAmount, normalizeRates, normalizePrices, normalizeCatalogPricing, convertUSD } from "./money.js";
/* ============================================================
   CampusKart — لوحة التحكم
   - توكن جلسة موقّع (لا كلمة مرور) في sessionStorage
   - كل النصوص تُهرَّب قبل الإدراج
   - حماية من التعارض بين جهازين (X-Base-Version)
   ============================================================ */
"use strict";

const TOKEN_KEY = "ck_admin_session";
// The visual demo uses only fictional local data; it never authenticates or writes to the server.
const DEMO=/^deploy-preview-\d+--maarefmarket\.netlify\.app$/.test(location.hostname)&&new URLSearchParams(location.search).get("demo")==="1";
const CURS = ["USD", "TRY", "SYP"];
const CUR_NAME = { USD: "دولار", TRY: "تركي", SYP: "سوري" };
const CUR_SYM = { USD: "$", TRY: "₺", SYP: "ل.س" };
const DEFAULT_MSG_TEMPLATE = `السلام عليكم
أريد شراء هذه الأشياء:

{items}

السعر النهائي الإجمالي:
{totals}

{notes}

شكراً لكم 🌿`;

let session = DEMO?null:loadSession();
let DATA = null, SAVED_DATA = null, VERSION = 0;
let editingProductId = null, editingCategoryIdx = null, editingBannerIdx = null;
let mpImages = [], mpVariants = [];

/* ---------- أدوات ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeSrc = (u) => {
  const s=String(u||"").trim();
  if(!/^\/(?![\/\\])/.test(s)&&!/^https?:\/\//i.test(s))return "";
  try {const url=new URL(s,location.href);return /^https?:$/.test(url.protocol)&&!url.username&&!url.password?esc(url.href):"";}catch{return "";}
};
const deepClone = (o) => JSON.parse(JSON.stringify(o));
function toast(msg, type) {
  const t = $("toast"); t.textContent = msg; t.className = "show " + (type || "info");
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = ""), 2600);
}
function loadSession() {
  try { const s = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null"); return s && s.token && s.exp > Date.now() ? s : null; } catch { return null; }
}
function storeSession(s) { session = s; try { s ? sessionStorage.setItem(TOKEN_KEY, JSON.stringify(s)) : sessionStorage.removeItem(TOKEN_KEY); } catch {} }
const authHeaders = () => ({ Authorization: "Bearer " + (session?.token || "") });

/** يعالج 401 من أي طلب: يُخرج المستخدم */
function handleUnauthorized() {
  window.ckSupportAdmin?.clear();
  storeSession(null);
  feedbackRequest++;$("feedbackList").textContent="";$("feedbackCount").textContent="";feedbackCursor=null;
  $("appScreen").style.display = "none"; $("loginScreen").style.display = "grid";
  $("loginErr").textContent = "انتهت الجلسة — سجّل الدخول مجدداً";
  window.onbeforeunload = null;
}

/* ---------- الحالة (محفوظ/غير محفوظ) ---------- */
const isDirty = () => JSON.stringify(DATA) !== JSON.stringify(SAVED_DATA);
function updateDirty() {
  const dirty = isDirty();
  $("dirtyBadge").style.display = dirty ? "inline-block" : "none";
  $("savedBadge").style.display = dirty ? "none" : "inline-block";
  $("savebar").classList.toggle("show", dirty);
  window.onbeforeunload = dirty ? () => "لديك تعديلات غير محفوظة." : null;
}
function updateSessionLabel() {
  if (!session) return;
  const mins = Math.max(0, Math.round((session.exp - Date.now()) / 60000));
  $("sessionLabel").textContent = mins >= 60 ? `الجلسة: ${Math.floor(mins / 60)} س ${mins % 60} د` : `الجلسة: ${mins} د`;
  if (mins <= 0) handleUnauthorized();
}
setInterval(updateSessionLabel, 60000);

/* ---------- الدخول ---------- */
async function doLogin() {
  if(DEMO)return;
  const pwd = $("pwdInput").value;
  if (!pwd) { $("loginErr").textContent = "أدخل كلمة المرور"; return; }
  $("loginBtn").disabled = true; $("loginErr").textContent = "";
  try {
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pwd }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok || !j.token) throw new Error(j.error || "فشل الدخول");
    storeSession({ token: j.token, exp: j.exp || Date.now() + 12 * 3600e3 });
    $("pwdInput").value = "";
    await enterApp();
  } catch (e) { $("loginErr").textContent = e.message || "فشل الدخول"; }
  finally { $("loginBtn").disabled = false; }
}
async function autoLogin() {
  if(DEMO)return false;
  if (!session) return false;
  try {
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: session.token }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) { await enterApp(); return true; }
  } catch {}
  storeSession(null);
  return false;
}
function doLogout() {
  window.ckSupportAdmin?.clear();
  if(DEMO){location.assign("/");return;}
  if (isDirty() && !confirm("لديك تعديلات غير محفوظة. الخروج وفقدها؟")) return;
  storeSession(null); DATA = null; SAVED_DATA = null;
  feedbackRequest++;$("feedbackList").textContent="";$("feedbackCount").textContent="";feedbackCursor=null;
  $("appScreen").style.display = "none"; $("loginScreen").style.display = "grid"; $("loginErr").textContent = "";
  window.onbeforeunload = null;
}
async function enterApp() {
  $("loginScreen").style.display = "none"; $("appScreen").style.display = "grid";
  updateSessionLabel();
  await loadData();
}

/* ---------- تحميل / حفظ ---------- */
function normalize(d) {
  d.settings = d.settings || {};
  d.settings.bannerIntervalSec = Math.max(2, parseInt(d.settings.bannerIntervalSec, 10) || 7);
  d.banners = Array.isArray(d.banners) ? d.banners : [];
  d.categories = Array.isArray(d.categories) ? d.categories : [];
  d.products = (Array.isArray(d.products) ? d.products : []).map((p) => ({ ...p, prices: p.prices || {}, images: Array.isArray(p.images) ? p.images : [] }));
  return normalizeCatalogPricing(d);
}
async function loadData() {
  if(DEMO)return;
  toast("جاري التحميل...", "info");
  try {
    const res = await fetch("/api/data", { cache: "no-store", headers: authHeaders() });
    if (res.status === 401) { handleUnauthorized(); return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    VERSION = Number(j._version) || 0; delete j._version;
    DATA = normalize(j); SAVED_DATA = deepClone(DATA);
    renderAll(); updateDirty(); toast("تم التحميل", "success");
  } catch (e) { toast("فشل التحميل: " + (e.message || e), "error"); }
}
async function saveAll(force = false) {
  if (!DATA) return;
  if(DEMO){try{DATA=normalizeCatalogPricing(deepClone(DATA));SAVED_DATA=deepClone(DATA);renderAll();updateDirty();toast("تم الحفظ في المعاينة فقط — لا بيانات حقيقية","success");}catch{toast("تعذر تحديث الأسعار التجريبية","error");}return;}
  $("saveBtnTop").disabled = true; toast("جاري الحفظ...", "info");
  try {
    const before=JSON.stringify(DATA),draft=deepClone(DATA);
    if(["USD_TRY","USD_SYP"].some(k=>decimal(draft.settings.rates?.[k])>1e9))throw Error("سعر الصرف خارج النطاق المدعوم");
    const rates=normalizeRates(draft.settings.rates),previous=normalizeRates(SAVED_DATA?.settings?.rates);
    if(JSON.stringify(rates)!==JSON.stringify(previous)&&(!rates.USD_TRY||!rates.USD_SYP))throw Error("أدخل سعري صرف الدولار بشكل صحيح");
    normalizeCatalogPricing(draft,previous);
    const headers = { "Content-Type": "application/json", ...authHeaders(), "X-Base-Version": String(VERSION) };
    if (force) headers["X-Force"] = "1";
    const res = await fetch("/api/data", { method: "PUT", headers, body: JSON.stringify(draft) });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { handleUnauthorized(); return; }
    if (res.status === 409) {
      if (confirm("⚠️ تم تعديل البيانات من جهاز آخر منذ آخر تحميل.\n\nموافق = الكتابة فوقها بتعديلاتك الحالية\nإلغاء = إبقاء تعديلاتك محلياً دون حفظ (يمكنك تصديرها من تبويب النسخ الاحتياطي ثم إعادة التحميل)")) {
        $("saveBtnTop").disabled = false; return saveAll(true);
      }
      return;
    }
    if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
    VERSION = Number(j.version) || VERSION;
    const unchanged=JSON.stringify(DATA)===before;
    SAVED_DATA=deepClone(draft);
    if(unchanged){DATA=draft;renderProducts();renderRates();}
    updateDirty();renderMaintenanceStatus();
    toast("✓ تم الحفظ ونُشر للجميع", "success");
  } catch (e) { toast("فشل الحفظ: " + (e.message || e), "error"); }
  finally { $("saveBtnTop").disabled = false; }
}
function discardChanges() {
  if (!confirm("إلغاء التعديلات؟")) return;
  DATA = deepClone(SAVED_DATA); renderAll(); updateDirty(); toast("تم استرجاع البيانات", "info");
}
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".tab-pane").forEach((p) => (p.style.display = "none"));
  $("tab-" + tab).style.display = "block";
  if(tab==="feedback"){loadFeedback();window.ckSupportAdmin?.refresh();}
}
function renderAll() {
  $("storeNameLabel").textContent = DATA.settings.storeName ? "— " + DATA.settings.storeName : "";
  renderCategoryDropdowns(); renderProducts(); renderCategories(); renderBanners(); renderRates(); renderSettings(); renderColors();
}

/* ---------- تحليل الأسعار ---------- */
function parsePrice(input,currency){return currency?roundPrice(input,currency):decimal(input);}
const nextProductId = () => Math.max(0, ...DATA.products.map((x) => +x.id || 0)) + 1;

/* ---------- المنتجات ---------- */
function renderCategoryDropdowns() {
  const fc = $("filterCat"), mc = $("mpCategory");
  const keep = fc.value;
  fc.innerHTML = '<option value="">كل الأقسام</option>'; mc.innerHTML = "";
  DATA.categories.forEach((c) => {
    for (const sel of [fc, mc]) { const o = document.createElement("option"); o.value = c.slug; o.textContent = c.name; sel.appendChild(o); }
  });
  fc.value = keep;
}
function renderProducts() {
  const q = ($("searchProd").value || "").trim().toLowerCase();
  const fcat = $("filterCat").value, favail = $("filterAvail").value;
  let list = DATA.products.slice();
  if (q) list = list.filter((p) => (p.name || "").toLowerCase().includes(q) || (p.group || "").toLowerCase().includes(q));
  if (fcat) list = list.filter((p) => p.category === fcat);
  if (favail) list = list.filter((p) => p.availability === favail);
  const body = $("productsBody");
  $("adminProductCount").textContent=list.length+" من "+DATA.products.length+" منتج";
  if (!list.length) { body.innerHTML = '<tr><td colspan="8" class="empty">لا توجد منتجات. اضغط "+ منتج جديد".</td></tr>'; return; }
  const catMap = {}; DATA.categories.forEach((c) => (catMap[c.slug] = c.name));
  body.innerHTML = list.map((p) => {
    const img = safeSrc(p.images[0]);
    const av = ["in", "limited", "out"].includes(p.availability) ? p.availability : "in";
    return `<tr class="admin-product-row">
      <td class="admin-product-image">${img ? `<img class="thumb-mini" src="${img}" alt="" loading="lazy">` : '<div class="thumb-mini"></div>'}</td>
      <td class="admin-product-name"><strong>${esc(p.name)}</strong>${p.group ? `<div class="hint">🧩 ${esc(p.group)}</div>` : ""}${p.variants?.length ? `<div class="hint">${p.variants.length} أنواع داخلية</div>` : ""}</td>
      <td class="admin-product-category" data-label="القسم">${esc(catMap[p.category] || p.category)}</td>
      <td class="admin-product-price" data-label="دولار">${formatAmount(p.prices.USD,"USD")}</td><td class="admin-product-price" data-label="تركي">${formatAmount(p.prices.TRY,"TRY")}</td><td class="admin-product-price" data-label="سوري">${formatAmount(p.prices.SYP,"SYP")}</td>
      <td class="admin-product-status"><span class="pill ${av}" title="${av === "out" ? "مخفي من الموقع — يبقى هنا فقط" : ""}">${av === "in" ? "متوفر" : av === "limited" ? "محدود" : "🚫 مخفي"}</span></td>
      <td class="admin-product-actions"><div class="row-actions">
        <button class="btn btn-info btn-sm" data-edit-product="${p.id}" title="تعديل" aria-label="تعديل ${esc(p.name)}">✏️<span class="action-label">تعديل</span></button>
        <button class="btn btn-ghost btn-sm" data-dup-product="${p.id}" title="نسخ" aria-label="نسخ ${esc(p.name)}">📋<span class="action-label">نسخ</span></button>
        <button class="btn btn-accent btn-sm" data-sibling-product="${p.id}" title="إضافة نوع آخر لنفس المجموعة" aria-label="إضافة نوع آخر">🧩+<span class="action-label">نوع</span></button>
        <button class="btn btn-danger btn-sm" data-del-product="${p.id}" title="حذف" aria-label="حذف ${esc(p.name)}">🗑<span class="action-label">حذف</span></button>
      </div></td></tr>`;
  }).join("");
}
/* ---------- المجموعات ---------- */
const groupKey = (p) => String(p.group || "").trim().toLowerCase();
function refreshGroupOptions() {
  const names = [...new Set(DATA.products.map((p) => String(p.group || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ar"));
  $("groupOptions").innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
}
function refreshGroupMembers() {
  const g = $("mpGroup").value.trim().toLowerCase();
  const box = $("groupMembers");
  if (!g) { box.innerHTML = ""; return; }
  const members = DATA.products.filter((p) => groupKey(p) === g && p.id !== editingProductId);
  box.innerHTML = members.length
    ? `✅ في هذه المجموعة حالياً (${members.length}): ${members.map((m) => `<code>${esc(m.name)}</code>`).join(" ")}`
    : "✨ مجموعة جديدة — أضف أنواعاً أخرى بنفس الاسم لترتبط ببعضها.";
}
/** يفتح نموذجاً جديداً مسبق التعبئة من منتج (لإضافة نوع شقيق) */
function openSiblingModal(src) {
  openProductModal();
  $("mpCategory").value = src.category || "";
  $("mpGroup").value = src.group || src.name || "";
  $("mpPriceUSD").value = src.prices?.USD || ""; $("mpPriceTRY").value = src.prices?.TRY || ""; $("mpPriceSYP").value = src.prices?.SYP || "";
  const sc = src.showCurrencies || {};
  $("mpShowUSD").checked = sc.USD !== false; $("mpShowTRY").checked = sc.TRY !== false; $("mpShowSYP").checked = sc.SYP !== false;
  $("mpAvail").value = src.availability || "in";
  $("mpDesc").value = src.description || "";
  $("mpName").value = ""; $("mpName").focus();
  syncProductPriceInputs("mpPrice",true);
  refreshGroupMembers();
  toast("اكتب اسم النوع الجديد وارفع صورته", "info");
}

function syncProductPriceInputs(prefix,formatUSD=false){
  const rates=normalizeRates(DATA?.settings?.rates);
  const usdField=$(prefix+"USD"),usd=roundPrice(usdField.value,"USD");
  if(formatUSD)usdField.value=usd?formatAmount(usd,"USD"):"";
  for(const c of ["TRY","SYP"]){
    const input=$(prefix+c),rate=rates["USD_"+c];
    input.readOnly=!!rate;
    if(rate){
      try{input.value=usd?formatAmount(convertUSD(usd,rate,c),c):"";}
      catch{input.value="";toast("السعر المحوّل خارج النطاق المدعوم","error");}
    }else if(formatUSD){const value=roundPrice(input.value,c);input.value=value?formatAmount(value,c):"";}
  }
}
function openProductModal(id) {
  editingProductId = id || null; mpImages = []; mpVariants = [];
  const set = (k, v) => ($(k).value = v ?? "");
  refreshGroupOptions();
  if (id) {
    const p = DATA.products.find((x) => x.id === id);
    if (!p) { toast("المنتج غير موجود", "error"); return; }
    $("modalProductTitle").textContent = "تعديل المنتج";
    set("mpName", p.name); set("mpCategory", p.category); set("mpGroup", p.group);
    set("mpPriceUSD", p.prices.USD || ""); set("mpPriceTRY", p.prices.TRY || ""); set("mpPriceSYP", p.prices.SYP || "");
    const op = p.oldPrices || {};
    set("mpOldUSD", op.USD || ""); set("mpOldTRY", op.TRY || ""); set("mpOldSYP", op.SYP || "");
    const sc = p.showCurrencies || {};
    $("mpShowUSD").checked = sc.USD !== false; $("mpShowTRY").checked = sc.TRY !== false; $("mpShowSYP").checked = sc.SYP !== false;
    set("mpAvail", p.availability || "in"); set("mpViews", p.views || 0); set("mpDesc", p.description); set("mpNotes", p.notes);
    mpImages = p.images.slice(); mpVariants = deepClone(p.variants || []);
  } else {
    $("modalProductTitle").textContent = "منتج جديد";
    ["mpName", "mpGroup", "mpPriceUSD", "mpPriceTRY", "mpPriceSYP", "mpOldUSD", "mpOldTRY", "mpOldSYP", "mpViews", "mpDesc", "mpNotes", "mpImgInput"].forEach((k) => set(k, ""));
    $("mpShowUSD").checked = $("mpShowTRY").checked = $("mpShowSYP").checked = true;
    set("mpAvail", "in");
    if (DATA.categories[0]) set("mpCategory", DATA.categories[0].slug);
  }
  syncProductPriceInputs("mpPrice",true);syncProductPriceInputs("mpOld",true);
  renderProductImages(); renderVariants(); refreshGroupMembers();
  $("modalProduct").classList.add("open");
}
function saveProduct(thenAddSibling) {
  const name = $("mpName").value.trim(), category = $("mpCategory").value;
  let prices = { USD: parsePrice($("mpPriceUSD").value, "USD"), TRY: parsePrice($("mpPriceTRY").value, "TRY"), SYP: parsePrice($("mpPriceSYP").value, "SYP") };
  if (!name) { toast("اسم المنتج مطلوب", "error"); return; }
  if (!category) { toast("اختر القسم", "error"); return; }
  if (!prices.USD && !prices.TRY && !prices.SYP) { toast("أدخل سعراً واحداً على الأقل", "error"); return; }
  const old = DATA.products.find((x) => x.id === editingProductId);
  let oldPrices = { USD: parsePrice($("mpOldUSD").value, "USD"), TRY: parsePrice($("mpOldTRY").value, "TRY"), SYP: parsePrice($("mpOldSYP").value, "SYP") };
  const rates=normalizeRates(DATA.settings.rates);
  try{prices=normalizePrices(prices,rates);oldPrices=normalizePrices(oldPrices,rates);}catch{toast("الأسعار خارج النطاق المدعوم","error");return;}
  if(!prices.USD){toast("أدخل سعر المنتج بالدولار","error");return;}
  const variants = mpVariants.map((v) => {
    const out = { name: String(v.name || "").trim().slice(0, 120) };
    if (v.prices && (v.prices.USD || v.prices.TRY || v.prices.SYP)) out.prices = v.prices;
    if(v.showCurrencies)out.showCurrencies=v.showCurrencies;
    if (v.availability) out.availability = v.availability;
    if (v.image) out.image = v.image;
    return out;
  }).filter((v) => v.name);
  const p = {
    ...(old || {}),
    id: editingProductId || nextProductId(), name, category,
    group: $("mpGroup").value.trim(), prices,
    showCurrencies: { USD: $("mpShowUSD").checked, TRY: $("mpShowTRY").checked, SYP: $("mpShowSYP").checked },
    availability: $("mpAvail").value, views: Math.max(0, +$("mpViews").value || 0),
    description: $("mpDesc").value.trim(), notes: $("mpNotes").value.trim(),
    images: mpImages.slice(), created: old?.created || Date.now(),
  };
  if (oldPrices.USD || oldPrices.TRY || oldPrices.SYP) p.oldPrices = oldPrices; else delete p.oldPrices;
  if (variants.length) p.variants = variants; else delete p.variants;
  try{for(const v of variants){if(v.prices)v.prices=normalizePrices(v.prices,rates);}}catch{toast("سعر أحد الأنواع خارج النطاق المدعوم","error");return;}
  if (old) { DATA.products[DATA.products.indexOf(old)] = p; toast("تم التعديل", "success"); }
  else { DATA.products.unshift(p); toast("تمت الإضافة", "success"); }
  $("modalProduct").classList.remove("open");
  renderProducts(); updateDirty();
  if (thenAddSibling) openSiblingModal(p);
}
function deleteProduct(id) {
  const p = DATA.products.find((x) => x.id === id); if (!p) return;
  if (!confirm(`حذف المنتج "${p.name}"؟`)) return;
  DATA.products = DATA.products.filter((x) => x.id !== id);
  renderProducts(); updateDirty(); toast("تم الحذف", "success");
}
function duplicateProduct(id) {
  const p = DATA.products.find((x) => x.id === id); if (!p) return;
  const copy = deepClone(p); copy.id = nextProductId(); copy.name = p.name + " (نسخة)"; copy.created = Date.now();
  DATA.products.unshift(copy); renderProducts(); updateDirty(); toast("تم النسخ", "success");
}
function applyBulk(field, scope) {
  const labels = { showCurrencies: "إظهار/إخفاء العملات", availability: "حالة التوفر" };
  let value;
  if (field === "showCurrencies") value = { USD: $("bulkShowUSD").value === "show", TRY: $("bulkShowTRY").value === "show", SYP: $("bulkShowSYP").value === "show" };
  else if (field === "availability") value = $("bulkAvail").value; else return;
  let targets;
  if (scope === "category") {
    const cat = $("mpCategory").value; if (!cat) { toast("اختر قسماً أولاً", "error"); return; }
    targets = DATA.products.filter((p) => p.category === cat);
  } else targets = DATA.products;
  if (!targets.length) { toast("لا توجد منتجات مستهدفة", "error"); return; }
  if (!confirm(`سيتم تطبيق "${labels[field]}" على ${targets.length} منتج (${scope === "category" ? "القسم الحالي" : "كل الموقع"}). متابعة؟`)) return;
  targets.forEach((p) => { if (field === "showCurrencies") p.showCurrencies = { ...value }; else p.availability = value; });
  renderProducts(); updateDirty(); toast(`✓ طُبّق على ${targets.length} منتج`, "success");
}

/* ---------- صور المنتج ---------- */
function renderProductImages() {
  $("mpImagesList").innerHTML = mpImages.map((src, i) => {
    const s = safeSrc(src); const main = i === 0;
    return `<div class="img-tile${main ? " main" : ""}">
      <img src="${s}" alt="">
      <button type="button" class="img-star" title="${main ? "رئيسية" : "اجعلها الرئيسية"}" data-main-image="${i}">${main ? "★" : "☆"}</button>
      <button type="button" class="img-x" title="حذف" data-remove-image="${i}">×</button>
      ${main ? '<div class="main-badge">الرئيسية</div>' : ""}</div>`;
  }).join("");
}
function addProductImageUrl() {
  const url = $("mpImgInput").value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) { toast("الرابط غير صالح (يجب أن يبدأ بـ https://)", "error"); return; }
  if (mpImages.length >= 12) { toast("الحدّ الأقصى 12 صورة", "error"); return; }
  mpImages.push(url); $("mpImgInput").value = ""; renderProductImages();
}

/* ---------- الأنواع ---------- */
function renderVariants() {
  $("mpVariantsList").innerHTML = mpVariants.map((v, i) => `
    <div class="variant-box">
      <div class="row cols-2">
        <div><label class="label">اسم النوع *</label><input class="field" maxlength="120" value="${esc(v.name)}" data-var-field="${i}|name" placeholder="مثال: كبير"></div>
        <div><label class="label">الحالة</label><select class="field" data-var-field="${i}|availability">
          <option value="" ${!v.availability ? "selected" : ""}>مثل المنتج</option><option value="in" ${v.availability === "in" ? "selected" : ""}>متوفر</option>
          <option value="limited" ${v.availability === "limited" ? "selected" : ""}>كمية محدودة</option><option value="out" ${v.availability === "out" ? "selected" : ""}>غير متوفر</option></select></div>
      </div>
      <div class="row cols-3 mt">
        ${CURS.map((c) => `<div><label class="label">السعر (${CUR_SYM[c]})</label><input class="field" inputmode="decimal" value="${v.prices?.[c]?formatAmount(v.prices[c],c):""}" ${c!=="USD"&&normalizeRates(DATA.settings.rates)["USD_"+c]?"readonly":""} data-var-field="${i}|price${c}" placeholder="اختياري"></div>`).join("")}
      </div>
      <div class="row mt"><div><label class="label">رابط صورة النوع (اختياري)</label><input class="field" dir="ltr" maxlength="2048" value="${esc(v.image || "")}" data-var-field="${i}|image" placeholder="https://..."></div></div>
      <div class="item-actions mt"><button type="button" class="btn btn-danger btn-sm" data-remove-variant="${i}">🗑 حذف النوع</button></div>
    </div>`).join("");
}
function onVariantField(i, field, value) {
  const v = mpVariants[i]; if (!v) return;
  if (field === "name") v.name = value;
  else if (field === "availability") v.availability = value || undefined;
  else if (field === "image") v.image = /^(https?:\/\/|\/)/i.test(value.trim()) ? value.trim() : "";
  else if(field.startsWith("price")){
    const c=field.slice(5);v.prices=v.prices||{USD:0,TRY:0,SYP:0};
    v.prices[c]=parsePrice(value,c);
    if(c==="USD"){
      const rates=normalizeRates(DATA.settings.rates);
      for(const local of ["TRY","SYP"]){
        if(!rates["USD_"+local])continue;
        try{
          v.prices[local]=convertUSD(v.prices.USD,rates["USD_"+local],local);
          const input=$("mpVariantsList").querySelector('[data-var-field="'+i+'|price'+local+'"]');
          if(input)input.value=v.prices[local]?formatAmount(v.prices[local],local):"";
        }catch{toast("سعر النوع خارج النطاق المدعوم","error");}
      }
    }
  }
}

/* ---------- رفع الصور ---------- */
const MAX_IMAGE_DIM = 1400, COMPRESS_QUALITY = 0.85, MAX_FILE_SIZE_MB = 8;
const ALLOWED_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
async function compressImage(file) {
  if (file.type === "image/gif") return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error("تعذّر قراءة الصورة");
  const ratio = Math.min(MAX_IMAGE_DIM / bmp.width, MAX_IMAGE_DIM / bmp.height, 1);
  const w = Math.round(bmp.width * ratio), h = Math.round(bmp.height * ratio);
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h); bmp.close?.();
  const outType = file.type === "image/png" ? "image/png" : file.type === "image/webp" ? "image/webp" : "image/jpeg";
  const blob = await new Promise((res) => canvas.toBlob(res, outType, COMPRESS_QUALITY));
  if (!blob) throw new Error("فشل ضغط الصورة");
  return blob;
}
async function uploadImageBlob(blob) {
  if(DEMO)throw Error("رفع الصور غير متاح في المعاينة");
  const res = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": blob.type || "image/jpeg", ...authHeaders() }, body: blob });
  if (res.status === 401) { handleUnauthorized(); throw new Error("انتهت الجلسة"); }
  const j = await res.json().catch(() => ({ error: "استجابة غير صالحة" }));
  if (!res.ok || !j.url) throw new Error(j.error || "HTTP " + res.status);
  return j.url;
}
function validFiles(fileList) {
  return Array.from(fileList).filter((f) => {
    if (!ALLOWED_MIMES.includes(f.type)) { toast("ملف غير مدعوم: " + f.name, "error"); return false; }
    if (f.size > MAX_FILE_SIZE_MB * 1024 * 1024) { toast(`"${f.name}" أكبر من ${MAX_FILE_SIZE_MB}MB`, "error"); return false; }
    return true;
  });
}
async function processFiles(fileList) {
  const files = validFiles(fileList); if (!files.length) return;
  const wrap = $("mpUploadProgress"), bar = $("mpUploadBarFill"), txt = wrap.querySelector(".dz-progress-text");
  wrap.style.display = "block";
  let done = 0, failed = 0;
  for (const file of files) {
    if (mpImages.length >= 12) { toast("الحدّ الأقصى 12 صورة", "error"); break; }
    txt.textContent = `جارٍ رفع ${done + 1} من ${files.length}…`; bar.style.width = Math.round((done / files.length) * 100) + "%";
    try { mpImages.push(await uploadImageBlob(await compressImage(file))); renderProductImages(); }
    catch (e) { console.error(e); toast(`فشل رفع ${file.name}: ${e.message || e}`, "error"); failed++; }
    done++;
  }
  bar.style.width = "100%";
  setTimeout(() => { wrap.style.display = "none"; bar.style.width = "0%"; }, 500);
  if (done - failed > 0) toast(`✓ تم رفع ${done - failed} صورة${failed ? ` (فشل ${failed})` : ""}`, "success");
}
function bindImageDropzone() {
  const dz = $("mpDropZone"), fi = $("mpFileInput");
  fi.addEventListener("change", async (e) => { if (e.target.files?.length) { await processFiles(e.target.files); fi.value = ""; } });
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag-over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag-over"); }));
  dz.addEventListener("drop", async (e) => { if (e.dataTransfer?.files?.length) await processFiles(e.dataTransfer.files); });
  dz.addEventListener("click", (e) => { if (e.target.closest("button")) return; fi.click(); });
  // رفع صورة الإعلان
  $("mbFileInput").addEventListener("change", async (e) => {
    const files = validFiles(e.target.files || []); if (!files.length) return;
    toast("جارٍ رفع صورة الإعلان...", "info");
    try { const url = await uploadImageBlob(await compressImage(files[0])); $("mbImage").value = url; updateBannerPreview(); toast("✓ تم الرفع", "success"); }
    catch (err) { toast("فشل الرفع: " + (err.message || err), "error"); }
    e.target.value = "";
  });
  $("mbImage").addEventListener("input", updateBannerPreview);
}
function updateBannerPreview() {
  const s = safeSrc($("mbImage").value); const img = $("mbPreview");
  if (s) { img.src = s; img.style.display = "block"; } else { img.style.display = "none"; img.removeAttribute("src"); }
}

/* ---------- أسعار الصرف ---------- */
function renderRates(){
  const rates=normalizeRates(DATA.settings.rates);
  DATA.settings.baseCurrency="USD";DATA.settings.rates=rates;
  $("rRate1").value=rates.USD_TRY||"";
  $("rRate2").value=rates.USD_SYP||"";
  $("rCountLabel").textContent=String(DATA.products.length);
  renderRatesPreview();
}
function readRates(){return {USD_TRY:decimal($("rRate1").value),USD_SYP:decimal($("rRate2").value)};}
function renderRatesPreview(){
  const r=readRates();
  try{
    const sample=[1,1.25,2.50].map(v=>'<div><strong>'+formatAmount(v,"USD")+' $</strong> — '+(r.USD_TRY?formatAmount(convertUSD(v,r.USD_TRY,"TRY"),"TRY")+" ₺":"—")+' · '+(r.USD_SYP?formatAmount(convertUSD(v,r.USD_SYP,"SYP"),"SYP")+" ل.س":"—")+'</div>');
    $("ratesPreview").innerHTML=sample.join("");
  }catch{$("ratesPreview").textContent="أسعار صرف خارج النطاق المدعوم";}
}
function bindRatesTab(){
  ["rRate1","rRate2"].forEach(id=>$(id).addEventListener("input",()=>{
    if(!DATA)return;
    DATA.settings.rates=readRates();renderRatesPreview();updateDirty();
  }));
}
function applyRatesToAll(){
  const rates=readRates();
  if(!rates.USD_TRY||!rates.USD_SYP||rates.USD_TRY>1e9||rates.USD_SYP>1e9){toast("أدخل سعري صرف صالحين للدولار","error");return;}
  try{
    const draft=deepClone(DATA);draft.settings.rates=rates;
    normalizeCatalogPricing(draft,normalizeRates(SAVED_DATA?.settings?.rates));
    DATA=draft;renderProducts();renderRates();updateDirty();
    const missing=DATA.products.filter(p=>!p.prices.USD).length;
    toast(missing?"تم التحويل؛ "+missing+" منتج يحتاج إلى سعر بالدولار":"تم تحديث جميع الأسعار — اضغط حفظ للنشر",missing?"info":"success");
  }catch{toast("تعذر التحويل: الأسعار خارج النطاق المدعوم","error");}
}

/* ---------- الأقسام ---------- */
function renderCategories() {
  const wrap = $("categoriesList");
  if (!DATA.categories.length) { wrap.innerHTML = '<div class="empty">لا توجد أقسام.</div>'; return; }
  wrap.innerHTML = DATA.categories.map((c, i) => `
    <div class="item-box"><div class="item-head">
      <div><div class="item-title">${esc(c.name)}</div><div class="hint">المعرّف: <code dir="ltr">${esc(c.slug)}</code> · المنتجات: ${DATA.products.filter((p) => p.category === c.slug).length}</div></div>
      <div class="item-actions">
        <button class="btn btn-ghost btn-sm" data-move-cat="${i}|-1" ${i === 0 ? "disabled" : ""}>⬆️</button>
        <button class="btn btn-ghost btn-sm" data-move-cat="${i}|1" ${i === DATA.categories.length - 1 ? "disabled" : ""}>⬇️</button>
        <button class="btn btn-info btn-sm" data-edit-cat="${i}">✏️</button>
        <button class="btn btn-danger btn-sm" data-del-cat="${i}">🗑</button>
      </div></div></div>`).join("");
}
function openCategoryModal(idx) {
  editingCategoryIdx = idx == null ? null : idx;
  const c = idx != null ? DATA.categories[idx] : { name: "", slug: "" };
  $("modalCategoryTitle").textContent = idx != null ? "تعديل قسم" : "قسم جديد";
  $("mcName").value = c.name; $("mcSlug").value = c.slug;
  $("modalCategory").classList.add("open");
}
function saveCategory() {
  const name = $("mcName").value.trim(), slug = $("mcSlug").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!name || !slug) { toast("الاسم والمعرّف مطلوبان (المعرّف بحروف إنجليزية)", "error"); return; }
  if (DATA.categories.some((c, i) => c.slug === slug && i !== editingCategoryIdx)) { toast("المعرّف مستخدم", "error"); return; }
  if (editingCategoryIdx != null) {
    const oldSlug = DATA.categories[editingCategoryIdx].slug;
    DATA.categories[editingCategoryIdx] = { slug, name };
    if (oldSlug !== slug) DATA.products.forEach((p) => { if (p.category === oldSlug) p.category = slug; });
    toast("تم التعديل", "success");
  } else { DATA.categories.push({ slug, name }); toast("تمت الإضافة", "success"); }
  $("modalCategory").classList.remove("open");
  renderCategories(); renderCategoryDropdowns(); renderProducts(); updateDirty();
}
function deleteCategory(idx) {
  const c = DATA.categories[idx]; const count = DATA.products.filter((p) => p.category === c.slug).length;
  if (!confirm(count ? `القسم فيه ${count} منتج. حذفه سيتركهم بدون قسم صالح. متابعة؟` : `حذف "${c.name}"؟`)) return;
  DATA.categories.splice(idx, 1);
  renderCategories(); renderCategoryDropdowns(); updateDirty(); toast("تم الحذف", "success");
}
function moveItem(arr, i, dir, rerender) {
  const j = i + dir; if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]]; rerender(); updateDirty();
}

/* ---------- الإعلانات ---------- */
function renderBanners() {
  const wrap = $("bannersList");
  if (!DATA.banners.length) { wrap.innerHTML = '<div class="empty">لا توجد إعلانات.<br><button class="btn btn-primary" style="margin-top:10px" data-action="new-banner">+ إضافة إعلان</button></div>'; return; }
  wrap.innerHTML = DATA.banners.map((b, i) => `
    <div class="item-box"><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <img src="${safeSrc(b.image)}" alt="" style="width:120px;height:70px;object-fit:cover;border-radius:8px;background:var(--elevated)">
      <div style="flex:1;min-width:140px"><div class="item-title">${esc(b.title || "(بدون عنوان)")}</div><div class="hint">${esc(b.eyebrow || "")}${b.link ? " · 🔗" : ""}</div></div>
      <div class="item-actions">
        <button class="btn btn-ghost btn-sm" data-move-banner="${i}|-1" ${i === 0 ? "disabled" : ""}>⬆️</button>
        <button class="btn btn-ghost btn-sm" data-move-banner="${i}|1" ${i === DATA.banners.length - 1 ? "disabled" : ""}>⬇️</button>
        <button class="btn btn-info btn-sm" data-edit-banner="${i}">✏️</button>
        <button class="btn btn-danger btn-sm" data-del-banner="${i}">🗑</button>
      </div></div></div>`).join("");
}
function openBannerModal(idx) {
  editingBannerIdx = idx == null ? null : idx;
  const b = idx != null ? DATA.banners[idx] : { image: "", eyebrow: "", title: "", link: "" };
  $("modalBannerTitle").textContent = idx != null ? "تعديل إعلان" : "إعلان جديد";
  $("mbImage").value = b.image || ""; $("mbEyebrow").value = b.eyebrow || ""; $("mbTitle").value = b.title || ""; $("mbLink").value = b.link || "";
  updateBannerPreview();
  $("modalBanner").classList.add("open");
}
function saveBanner() {
  const image = $("mbImage").value.trim(), link = $("mbLink").value.trim();
  if (!/^(https?:\/\/|\/api\/image\/)\S+$/i.test(image)) { toast("صورة الإعلان مطلوبة (رابط https أو ملف مرفوع)", "error"); return; }
  if (link && !/^https?:\/\/\S+$/i.test(link)) { toast("الرابط غير صالح", "error"); return; }
  if (editingBannerIdx == null && DATA.banners.length >= 20) { toast("الحدّ الأقصى 20 إعلاناً", "error"); return; }
  const b = { image, eyebrow: $("mbEyebrow").value.trim(), title: $("mbTitle").value.trim(), link };
  if (editingBannerIdx != null) DATA.banners[editingBannerIdx] = b; else DATA.banners.push(b);
  $("modalBanner").classList.remove("open");
  renderBanners(); updateDirty(); toast(editingBannerIdx != null ? "تم التعديل" : "تمت الإضافة", "success");
}

/* ---------- الإعدادات ---------- */
function renderMaintenanceStatus() {
  const active=SAVED_DATA?.settings?.maintenanceMode===true;
  const pending=(DATA?.settings?.maintenanceMode===true)!==active;
  $("maintenanceStatus").textContent=(active?"الحالة المنشورة: المتجر قيد الصيانة":"الحالة المنشورة: المتجر مفتوح")+ (pending?" — تغيير غير محفوظ":"");
}
function renderSettings() {
  const s = DATA.settings;
  $("setStoreName").value = s.storeName || ""; $("setDescription").value = s.description || "";
  $("setBannerInterval").value = s.bannerIntervalSec; $("setDelivery").value = s.deliveryNote || "";
  $("setInstagram").value = s.instagram || ""; $("setEmail").value = s.email || "";
  $("setBannersEnabled").checked = s.bannersEnabled !== false;
  $("setMaintenanceMode").checked = s.maintenanceMode === true;
  $("setMaintenanceMessage").value = s.maintenanceMessage || "";
  renderMaintenanceStatus();
  $("setMsgTemplate").value = s.msgTemplate || DEFAULT_MSG_TEMPLATE;
  renderWhatsappList();
}
function ensureWhatsappList() {
  const s = DATA.settings;
  if (!Array.isArray(s.whatsapps) || !s.whatsapps.length) s.whatsapps = s.whatsapp ? [s.whatsapp] : [""];
  return s.whatsapps;
}
function renderWhatsappList() {
  const list = ensureWhatsappList();
  $("whatsappList").innerHTML = list.map((num, i) => `
    <div class="wa-row">
      <span class="hint" style="min-width:20px">${i + 1}.</span>
      <input type="text" class="field" dir="ltr" inputmode="numeric" placeholder="9639xxxxxxxx" maxlength="20" value="${esc(num)}" data-wa-input="${i}">
      ${list.length > 1 ? `<button type="button" class="btn btn-danger btn-sm" data-remove-wa="${i}">🗑</button>` : ""}
    </div>`).join("");
}
function syncWhatsappPrimary() { DATA.settings.whatsapp = ensureWhatsappList().find((n) => n) || ""; }
function bindSettings() {
  const map = { setStoreName: "storeName", setDescription: "description", setDelivery: "deliveryNote", setInstagram: "instagram", setEmail: "email" };
  Object.entries(map).forEach(([id, key]) => $(id).addEventListener("input", (e) => {
    DATA.settings[key] = e.target.value.trim();
    if (key === "storeName") $("storeNameLabel").textContent = DATA.settings.storeName ? "— " + DATA.settings.storeName : "";
    updateDirty();
  }));
  $("setBannerInterval").addEventListener("input", (e) => { DATA.settings.bannerIntervalSec = Math.max(2, Math.min(120, parseInt(e.target.value, 10) || 7)); updateDirty(); });
  $("setBannersEnabled").addEventListener("change", (e) => { DATA.settings.bannersEnabled = e.target.checked; updateDirty(); });
  $("setMaintenanceMode").addEventListener("change", e => { if(!DATA)return; DATA.settings.maintenanceMode=e.target.checked; updateDirty(); renderMaintenanceStatus(); });
  $("setMaintenanceMessage").addEventListener("input", e => { if(!DATA)return; DATA.settings.maintenanceMessage=e.target.value; updateDirty(); });
  $("setMsgTemplate").addEventListener("input", (e) => { DATA.settings.msgTemplate = e.target.value; updateDirty(); });
  $("whatsappList").addEventListener("input", (e) => {
    const i = e.target.dataset.waInput; if (i == null) return;
    ensureWhatsappList()[+i] = e.target.value.replace(/\D/g, ""); syncWhatsappPrimary(); updateDirty();
  });
}

/* ---------- ألوان الموقع ---------- */
const THEME_FIELDS = [
  { key: "brand",      name: "اللون الرئيسي",           desc: "الشعار، الأزرار الرئيسية، العناوين، الأسعار، القسم المحدّد" },
  { key: "brand2",     name: "الرئيسي الداكن",           desc: "عند التمرير على الأزرار وتدرّج الإعلانات" },
  { key: "brandSoft",  name: "الرئيسي الفاتح",           desc: "خلفية شارة المجموعة وتركيز الحقول" },
  { key: "onBrand",    name: "نص فوق اللون الرئيسي",     desc: "لون الكتابة داخل الأزرار الرئيسية" },
  { key: "accent",     name: "اللون المميّز (Accent)",   desc: "شارة جديد، عدّاد السلة، خط العناوين، النقطة في الشعار" },
  { key: "accentDeep", name: "المميّز الداكن",             desc: "اسم القسم في البطاقة، ملاحظة التوصيل" },
  { key: "accentSoft", name: "المميّز الفاتح",             desc: "خلفية الملاحظات ووسم كمية محدودة" },
  { key: "bg",         name: "خلفية الصفحة",              desc: "لون خلفية الموقع العامة" },
  { key: "surface",    name: "خلفية البطاقات",            desc: "بطاقات المنتجات، القوائم، التذييل" },
  { key: "elevated",   name: "خلفية ثانوية",              desc: "مكان الصورة الفارغ، عدّاد الكمية، الأزرار الباهتة" },
  { key: "line",       name: "الحدود",                     desc: "خطوط الفصل وحدود البطاقات والحقول" },
  { key: "fg",         name: "لون النص",                   desc: "النص الأساسي في الموقع" },
  { key: "muted",      name: "النص الثانوي",               desc: "الأوصاف، العدّادات، النصوص الباهتة" },
  { key: "wa",         name: "زر واتساب",                 desc: "أزرار الطلب والاستفسار" },
  { key: "success",    name: "لون متوفر",                 desc: "وسم (متوفر) في صفحة المنتج" },
  { key: "danger",     name: "لون التحذير",                desc: "شارة العرض، زر الحذف، رسائل الخطأ" },
];
const THEME_DEFAULTS = {
  light: { bg: "#F4F7FC", surface: "#FFFFFF", elevated: "#EAF0FA", line: "#DCE4F2", fg: "#1B2333", muted: "#66738A", brand: "#2B5FB3", brand2: "#1F4A8F", brandSoft: "#E3ECFA", accent: "#F39C1F", accentSoft: "#FDE7C4", accentDeep: "#C67C0E", onBrand: "#FFFFFF", wa: "#25D366", danger: "#DC2626", success: "#16A34A" },
  dark:  { bg: "#0E1523", surface: "#161F32", elevated: "#1C2740", line: "#2A3752", fg: "#E8EEF8", muted: "#97A5BF", brand: "#6A9BE8", brand2: "#8AB2F0", brandSoft: "#1F2E4D", accent: "#F7AE45", accentSoft: "#3A2C12", accentDeep: "#F39C1F", onBrand: "#0E1523", wa: "#25D366", danger: "#DC2626", success: "#16A34A" },
};
const THEME_PRESETS = [
  { name: "جامعة المعارف (أزرق/برتقالي)", light: {}, dark: {} },
  { name: "أخضر غابي/ذهبي", light: { brand: "#0F3D2E", brand2: "#164A37", brandSoft: "#E2EFE9", accent: "#C9A46A", accentSoft: "#F3E9D6", accentDeep: "#A4812F", bg: "#F5F7F6", elevated: "#EEF2EF", line: "#E0E5E2" }, dark: { brand: "#C9A46A", brand2: "#E0C28E", brandSoft: "#2A2A1C", accent: "#E0C28E", accentSoft: "#3A3220", accentDeep: "#C9A46A", onBrand: "#0F1614", bg: "#0F1614", surface: "#182320", elevated: "#1E2A26", line: "#2A3835" } },
  { name: "أحمر جامعي", light: { brand: "#B3261E", brand2: "#8C1D17", brandSoft: "#FBE5E3", accent: "#F2B134", accentSoft: "#FDEFD0", accentDeep: "#B8801A" }, dark: { brand: "#F28B82", brand2: "#F6A9A2", brandSoft: "#3A1F1E", accent: "#F7C35F", accentSoft: "#3A2E12", accentDeep: "#F2B134", onBrand: "#1B0F0E" } },
  { name: "بنفسجي عصري", light: { brand: "#6D28D9", brand2: "#5B21B6", brandSoft: "#EDE9FE", accent: "#F59E0B", accentSoft: "#FEF3C7", accentDeep: "#B45309" }, dark: { brand: "#A78BFA", brand2: "#C4B5FD", brandSoft: "#2E1F4D", accent: "#FBBF24", accentSoft: "#3A2E12", accentDeep: "#F59E0B", onBrand: "#120B24" } },
  { name: "أسود/ذهبي فاخر", light: { brand: "#1B1B1F", brand2: "#000000", brandSoft: "#ECECEE", accent: "#D4AF37", accentSoft: "#F6EFD6", accentDeep: "#9C7C1C", bg: "#F7F7F5", line: "#E3E3DF" }, dark: { brand: "#D4AF37", brand2: "#E6C864", brandSoft: "#2A2510", accent: "#E6C864", accentSoft: "#3A3212", accentDeep: "#D4AF37", onBrand: "#111111", bg: "#0D0D0F", surface: "#17171A", elevated: "#1F1F23", line: "#2B2B30" } },
  { name: "فيروزي منعش", light: { brand: "#0E7490", brand2: "#155E75", brandSoft: "#E0F2F7", accent: "#F97316", accentSoft: "#FFEDD5", accentDeep: "#C2410C" }, dark: { brand: "#22D3EE", brand2: "#67E8F9", brandSoft: "#0F2A33", accent: "#FB923C", accentSoft: "#3A2212", accentDeep: "#F97316", onBrand: "#06141A" } },
];
let themeMode = "light";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function ensureTheme() {
  const s = DATA.settings;
  if (!s.theme || typeof s.theme !== "object") s.theme = {};
  if (!s.theme.light) s.theme.light = {};
  if (!s.theme.dark) s.theme.dark = {};
  return s.theme;
}
const themeValue = (mode, key) => { const v = DATA.settings.theme?.[mode]?.[key]; return HEX_RE.test(v || "") ? v.toUpperCase() : THEME_DEFAULTS[mode][key]; };

function renderColors() {
  if (!DATA) return;
  $("modeLightBtn").className = "btn btn-sm " + (themeMode === "light" ? "btn-primary" : "btn-ghost");
  $("modeDarkBtn").className = "btn btn-sm " + (themeMode === "dark" ? "btn-primary" : "btn-ghost");
  $("colorFields").innerHTML = THEME_FIELDS.map((f) => {
    const v = themeValue(themeMode, f.key);
    return `<div class="color-field">
      <input type="color" value="${v}" data-color-key="${f.key}" aria-label="${esc(f.name)}">
      <div class="cf-body"><div class="cf-name">${esc(f.name)}</div><div class="cf-desc">${esc(f.desc)}</div></div>
      <input class="field cf-hex" value="${v}" maxlength="7" data-hex-key="${f.key}" spellcheck="false">
    </div>`;
  }).join("");
  $("themePresets").innerHTML = THEME_PRESETS.map((p, i) => {
    const l = { ...THEME_DEFAULTS.light, ...p.light };
    return `<button type="button" class="preset-btn" data-preset="${i}"><i style="background:${l.brand}"></i><i style="background:${l.accent}"></i>${esc(p.name)}</button>`;
  }).join("");
  renderThemePreview();
}
function renderThemePreview() {
  const tp = $("themePreview");
  for (const f of THEME_FIELDS) tp.style.setProperty("--p-" + f.key, themeValue(themeMode, f.key));
}
function setThemeColor(key, value) {
  if (!HEX_RE.test(value)) return false;
  const t = ensureTheme();
  const v = value.toUpperCase();
  if (v === THEME_DEFAULTS[themeMode][key]) delete t[themeMode][key]; else t[themeMode][key] = v;
  // مزامنة الحقلين (اللون والنص)
  const c = document.querySelector(`[data-color-key="${key}"]`), h = document.querySelector(`[data-hex-key="${key}"]`);
  if (c && c.value.toUpperCase() !== v) c.value = v;
  if (h && h.value.toUpperCase() !== v) h.value = v;
  renderThemePreview(); updateDirty();
  return true;
}
function applyPreset(i) {
  const p = THEME_PRESETS[i]; if (!p) return;
  if (!confirm(`تطبيق حزمة «${p.name}» على الوضعين النهاري والليلي؟ (ستُستبدل الألوان الحالية)`)) return;
  DATA.settings.theme = { light: { ...p.light }, dark: { ...p.dark } };
  renderColors(); updateDirty(); toast(`✓ طُبّقت حزمة ${p.name} — اضغط حفظ للنشر`, "success");
}
function bindColorsTab() {
  $("colorFields").addEventListener("input", (e) => {
    if (e.target.dataset.colorKey) setThemeColor(e.target.dataset.colorKey, e.target.value);
    else if (e.target.dataset.hexKey) { let v = e.target.value.trim(); if (!v.startsWith("#")) v = "#" + v; if (HEX_RE.test(v)) setThemeColor(e.target.dataset.hexKey, v); }
  });
  $("colorFields").addEventListener("change", (e) => {
    if (e.target.dataset.hexKey) { let v = e.target.value.trim(); if (!v.startsWith("#")) v = "#" + v; if (!HEX_RE.test(v)) { e.target.value = themeValue(themeMode, e.target.dataset.hexKey); toast("صيغة اللون: #RRGGBB", "error"); } }
  });
  $("themePresets").addEventListener("click", (e) => { const b = e.target.closest("[data-preset]"); if (b) applyPreset(+b.dataset.preset); });
}

/* ---------- النسخ الاحتياطي ---------- */
function exportJSON() {
  if (!DATA) return;
  const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `campuskart-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast("تم التنزيل", "success");
}
function importJSON() {
  const f = $("importFile").files[0]; if (!f) { toast("اختر ملف JSON", "error"); return; }
  if (f.size > 3 * 1024 * 1024) { toast("الملف أكبر من 3MB", "error"); return; }
  const r = new FileReader();
  r.onload = () => {
    try {
      const obj = JSON.parse(r.result);
      if (!obj.settings || !Array.isArray(obj.products) || !Array.isArray(obj.categories) || !Array.isArray(obj.banners)) throw new Error("بنية الملف غير صالحة");
      if (!confirm(`سيتم استبدال البيانات الحالية بـ ${obj.products.length} منتج و${obj.categories.length} قسم. متابعة؟ (اضغط حفظ بعد المراجعة)`)) return;
      delete obj._version; DATA = normalize(obj); renderAll(); updateDirty(); toast("تم الاستيراد. راجع ثم اضغط حفظ", "info");
    } catch (e) { toast("ملف غير صالح: " + (e.message || e), "error"); }
  };
  r.readAsText(f);
}
async function resetAll() {
  if (!confirm("سيتم حذف جميع المنتجات والأقسام والإعلانات. متابعة؟")) return;
  if (prompt('للتأكيد اكتب كلمة: حذف') !== "حذف") { toast("تم الإلغاء", "info"); return; }
  DATA = normalize({ settings: { storeName: DATA.settings.storeName || "CampusKart", description: "متجر الجامعة", whatsapps: [], bannerIntervalSec: 7 }, banners: [], categories: [], products: [] });
  renderAll(); await saveAll();
}

/* ---------- سجل آراء الزبائن (خاص بالإدارة) ---------- */
let feedbackCursor=null,feedbackRequest=0,feedbackLoading=false;
const feedbackDate=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Damascus",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
function currentFeedbackMonth(){
  const p=feedbackDate.formatToParts(new Date());
  return p.find(x=>x.type==="year").value+"-"+p.find(x=>x.type==="month").value;
}
function renderFeedbackRecord(r){
  const date=new Date(r.timestamp);
  const stamp=Number.isNaN(date.getTime())?"—":feedbackDate.format(date);
  const general=r.status==="general-feedback";
  const products=general?'<p class="hint">لا يوجد طلب مرتبط بهذا الرأي.</p>':`<details><summary>المنتجات المحددة (${r.items?.length||0})</summary><ul>${(r.items||[]).map(i=>`<li>${esc(i.name)} × ${esc(i.qty)} — ${esc(formatAmount(i.total,i.cur))} ${esc(CUR_SYM[i.cur]||i.cur)}</li>`).join("")}</ul></details><p class="hint">محاولة طلب قبل الانتقال إلى واتساب</p>`;
  return `<article class="feedback-record"><div class="feedback-meta"><strong>${general?"رأي عام — مجهول":"رأي مع طلب — مجهول"}</strong><time dir="ltr" datetime="${esc(r.timestamp)}">${esc(stamp)}</time></div><p class="feedback-text">${esc(r.text)}</p>${products}</article>`;
}
async function loadFeedback(append=false){
  if(DEMO){const m=$("feedbackMonth");if(!m.value)m.value=currentFeedbackMonth();const sample={timestamp:new Date().toISOString(),text:"مثال تجريبي: أتمنى إضافة المزيد من المنتجات.",items:[{name:"عصير تجريبي",qty:2,cur:"USD",total:2.5}]};const has=m.value===currentFeedbackMonth();$("feedbackList").innerHTML=has?renderFeedbackRecord(sample):"<p>لا توجد آراء في هذا الشهر.</p>";$("feedbackCount").textContent="آراء تجريبية: "+(has?1:0);$("moreFeedback").hidden=true;return;}
  if(!session)return;
  if(append&&(feedbackLoading||!feedbackCursor))return;
  const seq=++feedbackRequest;feedbackLoading=true;
  const month=$("feedbackMonth");if(!month.value)month.value=currentFeedbackMonth();
  if(!append){feedbackCursor=null;$("feedbackList").textContent="جاري تحميل الآراء…";}
  $("moreFeedback").hidden=true;$("refreshFeedback").disabled=true;
  try{
    const params=new URLSearchParams({month:month.value});
    if(append&&feedbackCursor)params.set("cursor",feedbackCursor);
    const res=await fetch("/api/feedback?"+params,{headers:authHeaders(),cache:"no-store",signal:AbortSignal.timeout(10000)});
    if(seq!==feedbackRequest||!session)return;
    if(res.status===401){handleUnauthorized();return;}
    const j=await res.json();
    if(!res.ok)throw Error(j.error||"تعذر تحميل الآراء");
    const html=(j.records||[]).map(renderFeedbackRecord).join("");
    if(append)$("feedbackList").insertAdjacentHTML("beforeend",html);
    else $("feedbackList").innerHTML=html||'<p class="hint">لا توجد آراء محفوظة لهذا الشهر.</p>';
    feedbackCursor=j.nextCursor||null;$("feedbackCount").textContent="عدد الآراء: "+j.total;
    $("moreFeedback").hidden=!feedbackCursor;
  }catch(e){if(seq===feedbackRequest){if(!append)$("feedbackList").textContent=e.message||"تعذر التحميل";else toast("تعذر تحميل المزيد","error");$("moreFeedback").hidden=!feedbackCursor;}}
  finally{if(seq===feedbackRequest){feedbackLoading=false;$("refreshFeedback").disabled=false;}}
}
$("feedbackMonth").addEventListener("change",()=>loadFeedback());
$("refreshFeedback").addEventListener("click",()=>loadFeedback());
$("moreFeedback").addEventListener("click",()=>loadFeedback(true));

/* ---------- ربط الأحداث ---------- */
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action],[data-tab],[data-close],[data-theme-mode],[data-bulk],[data-edit-product],[data-dup-product],[data-sibling-product],[data-del-product],[data-main-image],[data-remove-image],[data-remove-variant],[data-move-cat],[data-edit-cat],[data-del-cat],[data-move-banner],[data-edit-banner],[data-del-banner],[data-remove-wa]");
  if (!t) return;
  const d = t.dataset;
  if (d.tab) return switchTab(d.tab);
  if (d.close) return $(d.close).classList.remove("open");
  if (d.themeMode) { themeMode = d.themeMode; return renderColors(); }
  if (d.bulk) { const [f, s] = d.bulk.split("|"); return applyBulk(f, s); }
  if (d.editProduct) return openProductModal(+d.editProduct);
  if (d.dupProduct) return duplicateProduct(+d.dupProduct);
  if (d.siblingProduct) { const src = DATA.products.find((x) => x.id === +d.siblingProduct); if (src) openSiblingModal(src); return; }
  if (d.delProduct) return deleteProduct(+d.delProduct);
  if (d.mainImage !== undefined) { const i = +d.mainImage; if (i > 0) { mpImages.unshift(mpImages.splice(i, 1)[0]); renderProductImages(); } return; }
  if (d.removeImage !== undefined) { mpImages.splice(+d.removeImage, 1); return renderProductImages(); }
  if (d.removeVariant !== undefined) { mpVariants.splice(+d.removeVariant, 1); return renderVariants(); }
  if (d.moveCat) { const [i, dir] = d.moveCat.split("|"); return moveItem(DATA.categories, +i, +dir, renderCategories); }
  if (d.editCat !== undefined) return openCategoryModal(+d.editCat);
  if (d.delCat !== undefined) return deleteCategory(+d.delCat);
  if (d.moveBanner) { const [i, dir] = d.moveBanner.split("|"); return moveItem(DATA.banners, +i, +dir, renderBanners); }
  if (d.editBanner !== undefined) return openBannerModal(+d.editBanner);
  if (d.delBanner !== undefined) { if (confirm("حذف الإعلان؟")) { DATA.banners.splice(+d.delBanner, 1); renderBanners(); updateDirty(); } return; }
  if (d.removeWa !== undefined) { const l = ensureWhatsappList(); l.splice(+d.removeWa, 1); if (!l.length) l.push(""); syncWhatsappPrimary(); renderWhatsappList(); updateDirty(); return; }
  switch (d.action) {
    case "new-product": return openProductModal();
    case "new-category": return openCategoryModal();
    case "new-banner": return openBannerModal();
    case "save": return saveAll();
    case "discard": return discardChanges();
    case "save-product": return saveProduct(false);
    case "save-and-add-sibling": return saveProduct(true);
    case "save-category": return saveCategory();
    case "save-banner": return saveBanner();
    case "pick-files": return $("mpFileInput").click();
    case "pick-banner-file": return $("mbFileInput").click();
    case "add-image-url": return addProductImageUrl();
    case "add-variant": if (mpVariants.length >= 30) return toast("الحدّ 30 نوعاً", "error"); mpVariants.push({ name: "" }); return renderVariants();
    case "apply-rates": return applyRatesToAll();
    case "add-whatsapp": if (ensureWhatsappList().length >= 10) return toast("الحدّ 10 أرقام", "error"); ensureWhatsappList().push(""); renderWhatsappList(); return updateDirty();
    case "reset-template": if (confirm("إعادة القالب للافتراضي؟")) { DATA.settings.msgTemplate = DEFAULT_MSG_TEMPLATE; $("setMsgTemplate").value = DEFAULT_MSG_TEMPLATE; updateDirty(); } return;
    case "theme-reset-mode": if (confirm(`استرجاع الألوان الأصلية للوضع ${themeMode === "light" ? "النهاري" : "الليلي"}؟`)) { ensureTheme()[themeMode] = {}; renderColors(); updateDirty(); } return;
    case "theme-reset-all": if (confirm("استرجاع كل الألوان الأصلية (نهاري + ليلي)؟")) { delete DATA.settings.theme; renderColors(); updateDirty(); } return;
    case "export": return exportJSON();
    case "import": return importJSON();
    case "reset-all": return resetAll();
  }
});
$("mpVariantsList").addEventListener("input", (e) => { const f = e.target.dataset.varField; if (f) { const [i, k] = f.split("|"); onVariantField(+i, k, e.target.value); } });
$("mpVariantsList").addEventListener("change", (e) => { const f = e.target.dataset.varField; if (f) { const [i, k] = f.split("|"); onVariantField(+i, k, e.target.value); } });
for(const prefix of ["mpPrice","mpOld"]){
  $(prefix+"USD").addEventListener("input",()=>syncProductPriceInputs(prefix));
  $(prefix+"USD").addEventListener("blur",()=>syncProductPriceInputs(prefix,true));
  for(const c of ["TRY","SYP"])$(prefix+c).addEventListener("blur",()=>syncProductPriceInputs(prefix,true));
}
$("mpGroup").addEventListener("input", refreshGroupMembers);
$("loginForm").addEventListener("submit", (e) => { e.preventDefault(); doLogin(); });
$("logoutBtn").addEventListener("click", doLogout);
$("saveBtnTop").addEventListener("click", () => saveAll());
$("searchProd").addEventListener("input", renderProducts);
$("filterCat").addEventListener("change", renderProducts);
$("filterAvail").addEventListener("change", renderProducts);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); if (DATA && isDirty()) saveAll(); }
  if (e.key === "Escape") document.querySelectorAll(".modal-bg.open").forEach((m) => m.classList.remove("open"));
});
document.querySelectorAll(".modal-bg").forEach((m) => m.addEventListener("mousedown", (e) => { if (e.target === m) m.classList.remove("open"); }));

/* ---------- الوضع الليلي ---------- */
function applyAdminTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("ck_admin_theme", t); } catch {}
  $("themeToggleBtn").textContent = t === "dark" ? "☀️" : "🌙";
}
$("themeToggleBtn").addEventListener("click", () => applyAdminTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"));

/* ---------- تشغيل ---------- */
(async function init() {
  let saved = "light";
  try { saved = localStorage.getItem("ck_admin_theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); } catch {}
  applyAdminTheme(saved);
  bindSettings(); bindImageDropzone(); bindRatesTab(); bindColorsTab();
  if(DEMO){
    const categories=[{slug:"drinks",name:"مشروبات"},{slug:"snacks",name:"وجبات خفيفة"}];
    DATA=normalize({settings:{storeName:"Maaref Market — معاينة",description:"بيانات تجريبية فقط",rates:{USD_TRY:33,USD_SYP:14000},whatsapps:[],bannersEnabled:true,bannerIntervalSec:7},categories,banners:[],products:[{id:1,name:"عصير تجريبي",category:"drinks",prices:{USD:1.25},availability:"in",images:[]},{id:2,name:"بسكويت تجريبي",category:"snacks",prices:{USD:.75},availability:"limited",images:[]},{id:3,name:"شيبس تجريبي",category:"snacks",prices:{USD:1.5},availability:"out",images:[]}]});
    SAVED_DATA=deepClone(DATA);$("loginScreen").style.display="none";$("appScreen").style.display = "grid";$("adminDemoNotice").hidden=false;$("sessionLabel").textContent="معاينة محلية";renderAll();updateDirty();return;
  }
  if (!(await autoLogin())) { $("loginScreen").style.display = "grid"; $("appScreen").style.display = "none"; }
})();

window.ckSupportAdminAuth=()=>authHeaders();
