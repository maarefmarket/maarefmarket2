import { sanitizeStore, str } from "./validate.js";

const CURRENCIES = ["USD", "TRY", "SYP"];
export function buildOrder(rawStore, body) {
  const data = sanitizeStore(rawStore);
  if (!body || !Array.isArray(body.items) || !body.items.length || body.items.length > 50) throw new Error("Invalid order");
  const seen = new Set(), totals = {}, items = [];
  for (const entry of body.items) {
    const id = entry?.id, variant = entry?.variant ?? -1, qty = entry?.qty;
    if (!Number.isSafeInteger(id) || !Number.isInteger(variant) || variant < -1 || !Number.isInteger(qty) || qty < 1 || qty > 999) throw new Error("Invalid item");
    const key = id + ":" + variant;
    if (seen.has(key)) throw new Error("Duplicate item");
    seen.add(key);
    const p = data.products.find(x => x.id === id);
    if (!p || p.availability === "out") throw new Error("Unavailable product");
    const v = variant < 0 ? null : p.variants?.[variant];
    if (variant >= 0 && !v || v?.availability === "out") throw new Error("Unavailable variant");
    const prices = v?.prices && CURRENCIES.some(c => v.prices[c] > 0) ? v.prices : p.prices;
    const show = v?.showCurrencies || p.showCurrencies || {};
    const cur = CURRENCIES.find(c => prices[c] > 0 && show[c] !== false) || CURRENCIES.find(c => prices[c] > 0);
    if (!cur) throw new Error("Price unavailable");
    const scale = cur === "SYP" ? 1 : 100;
    const unit = Math.round(prices[cur] * scale), total = unit * qty;
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger((totals[cur] || 0) + total)) throw new Error("Invalid total");
    totals[cur] = (totals[cur] || 0) + total;
    items.push({id, variant, qty, name: v ? p.name + " — " + (v.name || "نوع " + (variant + 1)) : p.name, image: v?.image || p.images[0] || "", cur, unit: unit/scale, total: total/scale});
  }
  const fmt = (n, c) => new Intl.NumberFormat("en-US", {maximumFractionDigits: c === "SYP" ? 0 : 2}).format(n) + " " + ({USD:"$",TRY:"₺",SYP:"ل.س"}[c]);
  const notes = str(body.notes, 500);
  const lines = items.map(i => "• " + i.name + " × " + i.qty + " — " + fmt(i.unit,i.cur) + " = " + fmt(i.total,i.cur));
  const text = ["طلب واتساب — بانتظار تأكيد العميل", ...lines, "", "الإجمالي:", ...CURRENCIES.filter(c => totals[c]).map(c => fmt(totals[c]/(c === "SYP" ? 1 : 100),c)), notes ? "ملاحظة العميل: " + notes : ""].join("\n").trim();
  return {store:data.settings.storeName, text, items, notes};
}
