// Shared decimal arithmetic for storefront, admin and server.
// Rounding: nearest monetary tick, with positive ties rounded up.
export const CURRENCIES=["USD","TRY","SYP"];
const SCALE={USD:100,TRY:2,SYP:0.1};
const MAX=1e12;
const formatters=Object.fromEntries(CURRENCIES.map(c=>[c,new Intl.NumberFormat("en-US",{minimumFractionDigits:c==="USD"?2:c==="TRY"?1:0,maximumFractionDigits:c==="USD"?2:c==="TRY"?1:0})]));
export function decimal(value){
  if(typeof value==="number")return Number.isFinite(value)&&value>=0?value:0;
  let s=String(value??"").trim().replace(/[٠-٩۰-۹]/g,d=>String(d.charCodeAt(0)-(d.charCodeAt(0)>=0x06f0?0x06f0:0x0660))).replace(/٬/g,",").replace(/٫/g,".");
  if(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s))s=s.replace(/,/g,"");
  else if(/^\d+,\d+$/.test(s))s=s.replace(",",".");
  if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)||s.length>40)return 0;
  const n=Number(s);return Number.isFinite(n)&&n>=0?n:0;
}
function fraction(n){
  const [mantissa,exp="0"]=String(n).toLowerCase().split("e");
  const [whole,part=""]=mantissa.split(".");
  let top=BigInt(whole+part),scale=part.length-Number(exp);
  if(scale<0)return [top*10n**BigInt(-scale),1n];
  return [top,10n**BigInt(scale)];
}
function roundFraction(n,d){return (2n*n+d)/(2n*d);}
function ticksFrom(n,c,rate=1){
  const [a,b]=fraction(n),[x,y]=fraction(rate);
  const top=a*x*BigInt(c==="USD"?100:c==="TRY"?2:1);
  const bottom=b*y*BigInt(c==="SYP"?10:1);
  return Number(roundFraction(top,bottom));
}
export function fromTicks(t,c){return c==="SYP"?t*10:t/SCALE[c];}
export function priceTicks(value,c){return ticksFrom(Math.min(MAX,decimal(value)),c);}
export function roundPrice(value,c){return fromTicks(priceTicks(value,c),c);}
export function convertUSD(value,rate,c){
  const usd=roundPrice(value,"USD"),r=Math.min(1e9,decimal(rate));
  if(!usd||!r)return 0;
  const [a,b]=fraction(usd),[x,y]=fraction(r);
  if(a*x>BigInt(MAX)*b*y)throw new RangeError("Converted price exceeds supported range");
  return fromTicks(ticksFrom(usd,c,r),c);
}
export function formatAmount(value,c){return formatters[c].format(value||0);}
export function formatMoney(value,c){return formatAmount(value,c)+" "+({USD:"$",TRY:"₺",SYP:"ل.س"}[c]);}
export function normalizeRates(raw={}){
  raw=raw&&typeof raw==="object"?raw:{};
  const pair=(a,b)=>{
    const n=decimal(raw[a+"_"+b]),inv=decimal(raw[b+"_"+a]);
    return n|| (inv?1/inv:0);
  };
  let tryRate=pair("USD","TRY"),sypRate=pair("USD","SYP");
  if(!tryRate&&sypRate)tryRate=sypRate*pair("SYP","TRY");
  if(!sypRate&&tryRate)sypRate=tryRate*pair("TRY","SYP");
  return {USD_TRY:Math.min(1e9,tryRate),USD_SYP:Math.min(1e9,sypRate)};
}
export function normalizePrices(raw={},rates={},previousRates=rates){
  raw=raw&&typeof raw==="object"?raw:{};
  const p=Object.fromEntries(CURRENCIES.map(c=>[c,roundPrice(raw[c],c)]));
  // Legacy entries without USD are migrated only if a usable rate exists.
  if(!p.USD){
    for(const c of ["TRY","SYP"]){
      const r=decimal(previousRates?.["USD_"+c])||decimal(rates?.["USD_"+c]);
      if(decimal(raw[c])&&r){p.USD=roundPrice(decimal(raw[c])/r,"USD");if(p.USD)break;}
    }
  }
  if(p.USD)for(const c of ["TRY","SYP"]){
    const r=decimal(rates?.["USD_"+c]);
    if(r)p[c]=convertUSD(p.USD,r,c);
  }
  return p;
}
export function normalizeCatalogPricing(data,previousRates){
  data.settings=data.settings||{};
  const rates=normalizeRates(data.settings.rates);
  data.settings.baseCurrency="USD";data.settings.rates=rates;
  for(const p of data.products||[]){
    p.prices=normalizePrices(p.prices,rates,previousRates||rates);
    if(p.oldPrices)p.oldPrices=normalizePrices(p.oldPrices,rates,previousRates||rates);
    for(const v of p.variants||[])if(v.prices)v.prices=normalizePrices(v.prices,rates,previousRates||rates);
  }
  return data;
}
export function billingCurrency(prices,show={}){
  show=show||{};
  return CURRENCIES.find(c=>decimal(prices?.[c])>0&&show[c]!==false)||CURRENCIES.find(c=>decimal(prices?.[c])>0)||null;
}
export function lineAmount(prices,show,qty){
  const cur=billingCurrency(prices,show);
  if(!cur||!Number.isSafeInteger(qty)||qty<1||qty>999)return null;
  const unitTicks=priceTicks(prices[cur],cur),totalTicks=unitTicks*qty;
  if(!unitTicks||!Number.isSafeInteger(totalTicks)||(cur==="SYP"&&!Number.isSafeInteger(totalTicks*10)))return null;
  return {cur,unit:fromTicks(unitTicks,cur),total:fromTicks(totalTicks,cur),unitTicks,totalTicks};
}
export function sumTicks(totals,cur,ticks){
  const next=(totals[cur]||0)+ticks;
  if(!Number.isSafeInteger(next)||(cur==="SYP"&&!Number.isSafeInteger(next*10)))throw new RangeError("Order total too large");
  totals[cur]=next;return next;
}
