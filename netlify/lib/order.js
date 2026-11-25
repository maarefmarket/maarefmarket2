import { lineAmount, sumTicks, fromTicks, formatMoney } from "../../js/money.js";
import { sanitizeStore, str } from "./validate.js";

const CURRENCIES = ["USD", "TRY", "SYP"];
export function buildOrder(rawStore, body) {
  const data = sanitizeStore(rawStore);
  if(data.settings.maintenanceMode===true)throw new Error("Store under maintenance");
  if (body?.kind === "inquiry") {
    const p = Number.isSafeInteger(body.id) && data.products.find(x => x.id === body.id && x.availability !== "out");
    if (!p) throw new Error("Unavailable product");
    return {kind:"inquiry",store:data.settings.storeName,text:"استفسار واتساب — "+p.name,items:[{id:p.id,name:p.name,image:p.images[0]||"",qty:1}],notes:""};
  }
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
    const amount=lineAmount(prices,show,qty);
    if(!amount)throw new Error("Invalid price or total");
    const {cur,unit,total,totalTicks}=amount;
    sumTicks(totals,cur,totalTicks);
    items.push({id,variant,qty,name:v?p.name+" — "+(v.name||"نوع "+(variant+1)):p.name,image:v?.image||p.images[0]||"",cur,unit,total});
  }
  const fmt = formatMoney;
  const notes = str(body.notes, 500);
  const lines = items.map(i => "• " + i.name + " × " + i.qty + " — " + fmt(i.unit,i.cur) + " = " + fmt(i.total,i.cur));
  const defaultTemplate = "السلام عليكم\nأريد شراء هذه الأشياء:\n\n{items}\n\nالسعر النهائي الإجمالي:\n{totals}\n\n{notes}\n\nشكراً لكم 🌿";
  let template = data.settings.msgTemplate || defaultTemplate;
  if (!template.includes("{items}")) template += "\n\n{items}";
  if (!template.includes("{totals}")) template += "\n\nالسعر النهائي الإجمالي:\n{totals}";
  if (notes && !template.includes("{notes}")) template += "\n\n{notes}";
  const fields = {items:lines.join("\n"),totals:CURRENCIES.filter(c=>totals[c]).map(c=>fmt(fromTicks(totals[c],c),c)).join("\n"),notes:notes?"ملاحظة العميل: "+notes:"",store:data.settings.storeName};
  const text="طلب واتساب — بانتظار تأكيد العميل\n"+template.replace(/\{(items|totals|notes|store)\}/g,(_,key)=>fields[key]).replace(/\n{3,}/g,"\n\n").trim();
  return {kind:"order",store:data.settings.storeName,text,items,notes};
}
