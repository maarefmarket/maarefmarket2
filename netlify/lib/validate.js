import { roundPrice, normalizeCatalogPricing, normalizeRates } from "../../js/money.js";
/**
 * تحقّق وتنظيف عميق لبيانات المتجر قبل حفظها.
 * يمنع حقن روابط javascript:, النصوص العملاقة, والأنواع الخاطئة.
 */

export const LIMITS = {
  bodyBytes: 3 * 1024 * 1024,   // 3MB حدّ أقصى لحجم البيانات
  products: 2000,
  categories: 100,
  banners: 20,
  images: 12,
  variants: 30,
  whatsapps: 10,
  short: 120,
  medium: 400,
  long: 2000,
  template: 3000,
  url: 2048,
};

const AVAIL = new Set(["in", "limited", "out"]);
const CURS = ["USD", "TRY", "SYP"];

export function str(v, max) {
  if (v == null) return "";
  // إزالة محارف التحكم غير المطبوعة (نحتفظ بالأسطر الجديدة)
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, max).trim();
}

export function num(v, { min = 0, max = 1e12, int = false } = {}) {
  let n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
  if (!isFinite(n)) return 0;
  n = Math.min(max, Math.max(min, n));
  return int ? Math.round(n) : Math.round(n * 100) / 100;
}

/** رابط آمن: http(s) مطلق أو مسار نسبي داخلي يبدأ بـ / (مثل /api/image/..) */
export function safeUrl(v) {
  const s = str(v, LIMITS.url);
  if (!s || /[\u0000-\u0020\u007F\\]/.test(s)) return "";
  if (/^\/(?!\/)/.test(s)) return s;
  try {
    const u = new URL(s);
    if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) return u.href;
  } catch {}
  return "";
}

export function slug(v) {
  return str(v, 60).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 60);
}

/** لون hex سداسي فقط (#RRGGBB) */
export function hexColor(v) {
  const s = String(v ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : "";
}
const THEME_KEYS = ["bg", "surface", "elevated", "line", "fg", "muted", "brand", "brand2", "brandSoft", "accent", "accentSoft", "accentDeep", "onBrand", "wa", "danger", "success"];
function themeMode(v) {
  if (!v || typeof v !== "object") return undefined;
  const out = {};
  for (const k of THEME_KEYS) { const c = hexColor(v[k]); if (c) out[k] = c; }
  return Object.keys(out).length ? out : undefined;
}
export function sanitizeTheme(v) {
  if (!v || typeof v !== "object") return undefined;
  const light = themeMode(v.light), dark = themeMode(v.dark);
  if (!light && !dark) return undefined;
  const out = {};
  if (light) out.light = light;
  if (dark) out.dark = dark;
  return out;
}

export function digits(v, max = 20) {
  return String(v ?? "").replace(/\D/g, "").slice(0, max);
}

function prices(v) {
  const p = v && typeof v === "object" ? v : {};
  const out = {};
  for (const c of CURS) out[c] = roundPrice(p[c],c);
  return out;
}

function showCurrencies(v) {
  if (!v || typeof v !== "object") return undefined;
  const out = {};
  for (const c of CURS) out[c] = v[c] !== false;
  return out;
}

function variant(v) {
  if (!v || typeof v !== "object") return null;
  const out = { name: str(v.name, LIMITS.short) };
  if (v.prices) out.prices = prices(v.prices);
  if (v.availability && AVAIL.has(v.availability)) out.availability = v.availability;
  const img = safeUrl(v.image);
  if (img) out.image = img;
  const sc = showCurrencies(v.showCurrencies);
  if (sc) out.showCurrencies = sc;
  return out;
}

function product(p, idx, seenIds) {
  if (!p || typeof p !== "object") return null;
  let id = num(p.id, { min: 1, max: 1e9, int: true });
  if (!id || seenIds.has(id)) return null;
  seenIds.add(id);

  const name = str(p.name, LIMITS.short);
  if (!name) return null;

  const out = {
    id,
    name,
    category: slug(p.category),
    group: str(p.group, LIMITS.short),
    prices: prices(p.prices),
    availability: AVAIL.has(p.availability) ? p.availability : "in",
    views: num(p.views, { int: true, max: 1e9 }),
    description: str(p.description, LIMITS.medium),
    notes: str(p.notes, LIMITS.long),
    images: (Array.isArray(p.images) ? p.images : []).map(safeUrl).filter(Boolean).slice(0, LIMITS.images),
    created: num(p.created, { int: true, max: 4e12 }) || Date.now(),
  };
  const sc = showCurrencies(p.showCurrencies);
  if (sc) out.showCurrencies = sc;
  if (p.oldPrices && typeof p.oldPrices === "object") out.oldPrices = prices(p.oldPrices);
  if (Array.isArray(p.variants) && p.variants.length) {
    out.variants = p.variants.map(variant).filter(Boolean).slice(0, LIMITS.variants);
  }
  return out;
}

export function sanitizeStore(input) {
  const safe = input && typeof input === "object" ? input : {};
  const s = safe.settings && typeof safe.settings === "object" ? safe.settings : {};

  const whatsapps = (Array.isArray(s.whatsapps) ? s.whatsapps : [s.whatsapp])
    .map((x) => digits(x)).filter((x) => x.length >= 7).slice(0, LIMITS.whatsapps);

  const rates = normalizeRates(s.rates);

  const settings = {
    storeName: str(s.storeName, LIMITS.short) || "CampusKart",
    description: str(s.description, LIMITS.medium),
    email: str(s.email, LIMITS.short).replace(/[^\w.@+-]/g, ""),
    whatsapp: whatsapps[0] || "",
    whatsapps,
    instagram: str(s.instagram, 60).replace(/^@/, "").replace(/[^\w.]/g, ""),
    deliveryNote: str(s.deliveryNote, LIMITS.medium),
    bannerIntervalSec: Math.max(2, Math.min(120, num(s.bannerIntervalSec, { int: true }) || 7)),
    bannersEnabled: s.bannersEnabled !== false,
    maintenanceMode: s.maintenanceMode === true,
    maintenanceMessage: str(s.maintenanceMessage, LIMITS.medium),
    msgTemplate: str(s.msgTemplate, LIMITS.template),
    baseCurrency: "USD",
    rates,
  };
  const theme = sanitizeTheme(s.theme);
  if (theme) settings.theme = theme;

  const seenSlugs = new Set();
  const categories = (Array.isArray(safe.categories) ? safe.categories : [])
    .map((c) => {
      if (!c || typeof c !== "object") return null;
      const sl = slug(c.slug); const name = str(c.name, LIMITS.short);
      if (!sl || !name || seenSlugs.has(sl)) return null;
      seenSlugs.add(sl);
      return { slug: sl, name };
    })
    .filter(Boolean).slice(0, LIMITS.categories);

  const banners = (Array.isArray(safe.banners) ? safe.banners : [])
    .map((b) => {
      if (!b || typeof b !== "object") return null;
      const image = safeUrl(b.image);
      if (!image) return null;
      return { image, eyebrow: str(b.eyebrow, LIMITS.short), title: str(b.title, LIMITS.short), link: safeUrl(b.link) };
    })
    .filter(Boolean).slice(0, LIMITS.banners);

  const seenIds = new Set();
  const products = (Array.isArray(safe.products) ? safe.products : [])
    .slice(0, LIMITS.products)
    .map((p, i) => product(p, i, seenIds))
    .filter(Boolean);

  return normalizeCatalogPricing({ settings, banners, categories, products });
}

/** فحص البنية العامة قبل التنظيف */
export function hasValidShape(body) {
  return !!(
    body && typeof body === "object" &&
    body.settings && typeof body.settings === "object" &&
    Array.isArray(body.products) &&
    Array.isArray(body.categories) &&
    Array.isArray(body.banners)
  );
}
