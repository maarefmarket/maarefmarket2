/* ============================================================
   CampusKart — منطق واجهة المتجر
   - كل النصوص القادمة من البيانات تُهرَّب (esc) قبل الإدراج في HTML
   - الأحداث تُربط عبر data-attributes بدل onclick المضمّن
   ============================================================ */
"use strict";

/* ---------- أدوات عامة ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeSrc = (u) => {
  const s = String(u || "").trim();
  if (/^\/(?!\/)/.test(s)) return esc(s);
  if (/^https?:\/\//i.test(s)) return esc(s);
  return "";
};
const $ = (id) => document.getElementById(id);

/* ---------- البيانات ---------- */
let SETTINGS = {}, BANNERS = [], CATEGORIES = [], PRODUCTS = [];
const HOUR = 3600000;
const CUR = [["USD", "$"], ["TRY", "₺"], ["SYP", "ل.س"]];
const CUR_LABEL = { SYP: "الليرة السورية", USD: "الدولار الأمريكي", TRY: "الليرة التركية" };
const PRIMARY = "USD";
const state = { q: "", sort: "newest" };

async function loadData() {
  for (const url of ["api/data", "data-default.json"]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) continue;
      const data = await res.json();
      SETTINGS = data.settings || {};
      SETTINGS.bannerIntervalSec = Math.max(2, parseInt(SETTINGS.bannerIntervalSec, 10) || 7);
      BANNERS = Array.isArray(data.banners) ? data.banners : [];
      CATEGORIES = Array.isArray(data.categories) ? data.categories : [];
      // المنتجات غير المتوفرة تُخفى من الموقع كلياً (تبقى في لوحة التحكم فقط)
      PRODUCTS = (Array.isArray(data.products) ? data.products : [])
        .filter((p) => p && p.availability !== "out")
        .map((p) => ({ ...p, prices: p.prices || {}, images: Array.isArray(p.images) ? p.images : [] }));
      applyTheme(SETTINGS.theme);
      return true;
    } catch (e) { console.warn("loadData fallback", url, e); }
  }
  $("app").innerHTML = `<div class="empty"><h2 class="section-title center">تعذّر تحميل المتجر</h2><p style="margin-top:8px">حدّث الصفحة بعد قليل.</p></div>`;
  return false;
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
  const num = parseFloat(v) || 0;
  if (c === "SYP") return new Intl.NumberFormat("en-US").format(Math.round(num)) + " ل.س";
  return fmtN(num) + " " + (c === "USD" ? "$" : c === "TRY" ? "₺" : c);
}
const catName = (s) => (CATEGORIES.find((c) => c.slug === s) || {}).name || "";
const availText = (a) => (a === "in" ? "متوفر" : a === "limited" ? "كمية محدودة" : "غير متوفر");
const isNew = (p) => Date.now() - (p.created || 0) < 48 * HOUR;
const byId = (id) => PRODUCTS.find((p) => p.id === id);
function visibleCurs(p) {
  const sc = p.showCurrencies || {};
  return CUR.filter(([c]) => sc[c] !== false && (p.prices?.[c] || 0) > 0).map(([c]) => c);
}
function hasOffer(p) {
  return !!(p.oldPrices && (p.oldPrices[PRIMARY] || 0) > (p.prices[PRIMARY] || 0));
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
  if (!PRODUCTS.length) return;
  let changed = false;
  for (const k of Object.keys(cart)) {
    const q = parseInt(cart[k], 10);
    if (!resolveItem(k) || !(q > 0)) { delete cart[k]; changed = true; }
    else cart[k] = Math.min(999, q);
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
  return {
    p, vi, v,
    prices: v?.prices || p.prices,
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
// كل منتج يُحاسب بعملة واحدة: الدولار إن كان مرئياً، وإلا أول عملة مرئية له (تركي ثم سوري)
function billingCur(it) {
  const vis = visibleCurs({ prices: it.prices, showCurrencies: it.showCurrencies });
  return vis.includes(PRIMARY) ? PRIMARY : vis[0] || null;
}
// العمليات بالقروش (×100) لتجنّب مثل 0.1+0.2=0.30000000000000004
const toCents = (v) => Math.round((parseFloat(v) || 0) * 100);
const fromCents = (c) => c / 100;
function lineTotal(it, q) {
  const c = billingCur(it);
  if (!c) return null;
  return { cur: c, unit: fromCents(toCents(it.prices[c])), total: fromCents(toCents(it.prices[c]) * q) };
}
/** يُرجع { USD:{sum,count}, TRY:{...}, SYP:{...} } — كل عملة تجمع منتجاتها فقط */
function cartTotals(src) {
  src = src || cart;
  const cents = { USD: 0, TRY: 0, SYP: 0 }, count = { USD: 0, TRY: 0, SYP: 0 };
  for (const key in src) {
    const it = resolveItem(key); if (!it) continue;
    const q = parseInt(src[key], 10) || 0; if (q <= 0) continue;
    const c = billingCur(it); if (!c) continue;
    cents[c] += toCents(it.prices[c]) * q; count[c] += 1;
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
  const keys = Object.keys(src).filter((k) => resolveItem(k) && (parseInt(src[k], 10) || 0) > 0);
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
async function notifyBackground(text, meta) {
  try {
    await fetch("api/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, meta: meta || {} }), keepalive: true });
  } catch {}
}
function openWhatsapp(text) {
  const nums = whatsappNumbers();
  if (!nums.length) { toast("لم يتم ضبط رقم واتساب", "err"); return false; }
  window.open(`https://wa.me/${nums[0]}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  notifyBackground(text, { store: SETTINGS.storeName || "", numbers: nums.slice(1) });
  return true;
}
function buyNowWA(id) {
  const p = byId(id); if (!p) return;
  let vi = -1;
  if (p.variants?.length) { vi = p.variants.findIndex((v) => v.availability !== "out"); if (vi < 0) vi = 0; }
  const key = vKey(id, vi);
  const it = resolveItem(key);
  if (!it || it.availability === "out") { toast("غير متوفر", "err"); return; }
  const msg = buildOrderMessage("", { [key]: 1 });
  if (msg) openWhatsapp(msg);
}
function inquireWA(id) {
  const p = byId(id); if (!p) return;
  openWhatsapp(`مرحباً ${SETTINGS.storeName || ""}، مهتم بمنتج: ${p.name}`);
}
function checkout() {
  const notes = ($("cNotes")?.value || "").trim();
  const err = $("cErr");
  if (!whatsappNumbers().length) { err.textContent = "لم يتم ضبط رقم واتساب المتجر"; return; }
  const msg = buildOrderMessage(notes);
  if (!msg) { err.textContent = "السلة فارغة"; return; }
  openWhatsapp(msg);
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
window.addEventListener("pageshow", async (e) => { if (e.persisted) { await loadData(); loadCart(); pruneCart(); updateCartCount(); route(); } });

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
  const dots = BANNERS.length > 1 ? `<div class="banner-dots">${BANNERS.map((_, i) => `<i class="${i === 0 ? "active" : ""}"></i>`).join("")}</div>` : "";
  return `<section class="banner-area" aria-label="إعلانات"><div class="banner" id="bannerBox"></div>${dots}</section>`;
}
function renderBanner() {
  const box = $("bannerBox"); const b = BANNERS[bannerIdx];
  if (!box || !b) return;
  const src = safeSrc(b.image);
  const link = safeSrc(b.link);
  const inner = `${src ? `<img src="${src}" alt="">` : ""}<div class="ov"></div><div class="txt">${b.eyebrow ? `<div class="ey">${esc(b.eyebrow)}</div>` : ""}${b.title ? `<h2>${esc(b.title)}</h2>` : ""}</div>`;
  box.innerHTML = link ? `<a href="${link}" target="_blank" rel="noopener" style="position:absolute;inset:0">${inner}</a>` : inner;
  document.querySelectorAll(".banner-dots i").forEach((d, i) => d.classList.toggle("active", i === bannerIdx));
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
  const pr = (p) => p.prices[PRIMARY] || 0;
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
    <div class="thumb" data-open="${p.id}">
      ${img ? `<img loading="lazy" src="${img}" alt="${esc(p.name)}">` : `<div class="ph">🛍️</div>`}
      <div class="badges">${badges.join("")}</div>
      ${out ? '<div class="soldout"><span>غير متوفر</span></div>' : ""}
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
  return CUR.filter(([c]) => vis.includes(c)).map(([c]) => `<div class="pr"><span class="cur">${CUR_LABEL[c]}</span><span class="val">${money(prices[c], c)}${oldPrices && (oldPrices[c] || 0) > (prices[c] || 0) ? `<s>${money(oldPrices[c], c)}</s>` : ""}</span></div>`).join("");
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
  const imgs = p.images.map(safeSrc).filter(Boolean);
  const varBlock = p.variants?.length ? `<div class="block"><h3>اختر النوع</h3><div class="variants-bar" id="varBox">${p.variants.map((v, i) => `<button type="button" class="var-chip${i === 0 ? " active" : ""}" data-var="${i}">${esc(v.name || "نوع " + (i + 1))}</button>`).join("")}</div></div>` : "";
  $("app").innerHTML = `
    <nav class="crumb" aria-label="مسار"><button data-nav="">الرئيسية</button><span>/</span><button data-nav="category/${esc(p.category)}">${esc(catName(p.category))}</button><span>/</span><span style="color:var(--fg)">${esc(p.name)}</span></nav>
    <div class="pview">
      <div class="gallery">
        <div class="main">
          ${imgs[0] ? `<img id="gMain" src="${imgs[0]}" alt="${esc(p.name)}">` : `<div class="ph" style="display:grid;place-items:center;height:100%;font-size:60px">🛍️</div>`}
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
}
function gSet(i) {
  const p = byId(curProductId()); if (!p) return;
  const imgs = p.images.map(safeSrc).filter(Boolean);
  gImg = i; const m = $("gMain"); if (m && imgs[i]) m.src = imgs[i];
  document.querySelectorAll(".thumbs img").forEach((t, idx) => t.classList.toggle("active", idx === i));
}
function pickVariant(vi) {
  const p = byId(curProductId()); if (!p?.variants?.[vi]) return;
  curVariant = vi; const v = p.variants[vi];
  $("pPricesBox").innerHTML = priceRows(v.prices || p.prices, v.showCurrencies || p.showCurrencies);
  const avail = v.availability || p.availability;
  const tag = $("pAvailTag"); tag.className = "tag " + esc(avail); tag.textContent = availText(avail);
  const gm = $("gMain"); const vimg = safeSrc(v.image); if (gm && vimg) gm.src = vimg;
  document.querySelectorAll("#varBox .var-chip").forEach((c, i) => c.classList.toggle("active", i === vi));
  const addBtn = $("pAddBtn"); if (addBtn) addBtn.disabled = avail === "out";
}

/* ---------- السلة ---------- */
function renderCart() {
  pruneCart();
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
      ${img ? `<img src="${img}" alt="${esc(it.p.name)}" data-open="${it.p.id}" style="cursor:pointer">` : '<div class="ph">🛍️</div>'}
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
      <button class="btn btn-wa" style="width:100%;margin-top:10px" id="checkoutBtn">📲 إتمام الطلب عبر واتساب</button>
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
function route() {
  stopBanner();
  const h = location.hash.replace(/^#/, "");
  let active = "";
  if (h.startsWith("category/")) active = h.split("/")[1];
  else if (h === "new") active = "new";
  renderChips(active);
  if (h.startsWith("product/")) return renderProduct(+h.split("/")[1]);
  if (h.startsWith("category/")) return renderListing("category", decodeURIComponent(h.split("/")[1] || ""));
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
  const t = e.target.closest("[data-nav],[data-open],[data-step],[data-add],[data-buy],[data-var],[data-gstep],[data-gset],[data-pstep],[data-addpage],[data-inquire],[data-cstep],[data-cremove],#checkoutBtn");
  if (!t) return;
  const d = t.dataset;
  if (d.nav !== undefined) { e.stopPropagation(); return navTo(d.nav); }
  if (d.open !== undefined) return go("product/" + d.open);
  if (d.step) { const [id, dir] = d.step.split("|"); return cardStep(+id, +dir); }
  if (d.add) return addToCart(+d.add, 1);
  if (d.buy) return buyNowWA(+d.buy);
  if (d.var !== undefined) return pickVariant(+d.var);
  if (d.gstep) { const p = byId(curProductId()); if (!p) return; const n = p.images.length; return gSet((gImg + +d.gstep + n) % n); }
  if (d.gset !== undefined) return gSet(+d.gset);
  if (d.pstep) { pQ = Math.max(1, Math.min(999, pQ + +d.pstep)); $("pQty").textContent = pQ; return; }
  if (d.addpage) { addToCart(+d.addpage, pQ, curVariant); pQ = 1; $("pQty").textContent = 1; return; }
  if (d.inquire) return inquireWA(+d.inquire);
  if (d.cstep) { const [key, dir] = d.cstep.split("|"); setQty(key, (cart[key] || 0) + +dir); return renderCart(); }
  if (d.cremove) { delete cart[d.cremove]; saveCart(); return renderCart(); }
  if (t.id === "checkoutBtn") return checkout();
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
  if (!(await loadData())) return;
  loadCart(); pruneCart();
  renderFooter(); updateCartCount(); route();
})();
