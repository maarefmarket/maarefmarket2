import { formatOrderItem, formatGrandTotals, fillOrderTemplate } from "../../js/order-format.js";
import { lineAmount, sumTicks } from "../../js/money.js";
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
  const seen = new Set(), totals = {}, items = [], totalRows=[];
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
    totalRows.push({prices,qty});
    items.push({id,variant,qty,name:v?p.name+" — "+(v.name||"نوع "+(variant+1)):p.name,image:v?.image||p.images[0]||"",cur,unit,total});
  }
  const notes=str(body.notes,500);
  const defaultTemplate="السلام عليكم\nأريد شراء هذه الأشياء:\n\n{items}\n\nالسعر النهائي الإجمالي:\n{totals}\n\n{notes}\n\nشكراً لكم 🌿";
  const fields={
    items:items.map(i=>formatOrderItem(i)).join("\n\n"),
    totals:formatGrandTotals(totalRows,data.settings.rates),
    notes:notes?"ملاحظة العميل: "+notes:"",
    store:data.settings.storeName
  };
  const text="طلب واتساب — بانتظار تأكيد العميل\n"+fillOrderTemplate(data.settings.msgTemplate||defaultTemplate,fields);
  return {kind:"order",store:data.settings.storeName,text,items,notes};
}
