import { formatMoney } from "./money.js";

// Keep each mixed-language name and each numeric amount in its own bidi
// isolate. Explicit RTL paragraph starts keep labels and bullets aligned.
const RTL="\u200f", LRI="\u2066", FSI="\u2068", PDI="\u2069";
const inline=value=>String(value??"").replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,"").replace(/\s+/gu," ").trim();
const name=value=>FSI+inline(value)+PDI;
const number=value=>LRI+inline(value)+PDI;
const amount=(value,cur)=>LRI+formatMoney(value,cur).replace(/ /g,"\u00a0")+PDI;
const labels={USD:"بالدولار",TRY:"بالتركي",SYP:"بالسوري"};
export function formatOrderItem(item,{bold=false}={}){
  const title=name(item.name);
  const emphasis=bold?"*"+title+"*":title;
  return [
    RTL+"• "+emphasis,
    RTL+"الكمية: "+number(item.qty),
    RTL+"سعر القطعة: "+amount(item.unit,item.cur),
    RTL+"الإجمالي: "+amount(item.total,item.cur)
  ].join("\n");
}
export function formatOrderTotal(cur,value,count,{bold=false}={}){
  const sum=amount(value,cur);
  return RTL+"• "+labels[cur]+": "+(bold?"*"+sum+"*":sum)+(count==null?"":" ("+number(count)+" صنف)");
}
export function formatOrderCaption(item){
  return RTL+name(item.name)+"\n"+RTL+"الكمية: "+number(item.qty);
}
export function fillOrderTemplate(template,fields){
  let result=String(template);
  if(!result.includes("{items}"))result+="\n\n{items}";
  if(!result.includes("{totals}"))result+="\n\nالسعر النهائي الإجمالي:\n{totals}";
  if(fields.notes&&!result.includes("{notes}"))result+="\n\n{notes}";
  return result.replace(/\{(items|totals|notes|store)\}/g,(_,key)=>fields[key]??"").replace(/\n{3,}/g,"\n\n").trim();
}
// Prefer complete product blocks, then complete lines; never split a normal
// product or amount between Telegram messages just to hit the old chunk size.
export function splitOrderText(text,max=1800){
  const result=[];let chunk="";
  const push=()=>{if(chunk)result.push(chunk);chunk="";};
  const append=(piece,separator)=>{
    const joined=chunk?chunk+separator+piece:piece;
    if(joined.length<=max){chunk=joined;return;}
    push();
    if(piece.length<=max){chunk=piece;return;}
    // Only unusually long custom template lines reach this branch.
    for(const char of piece){
      if(chunk.length+char.length>max)push();
      chunk+=char;
    }
  };
  for(const block of String(text).split("\n\n")){
    if(block.length<=max)append(block,"\n\n");
    else{
      push();
      for(const line of block.split("\n"))append(line,"\n");
    }
  }
  push();return result;
}
