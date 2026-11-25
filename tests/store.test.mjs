import test from "node:test";
import assert from "node:assert/strict";
import { buildOrder } from "../netlify/lib/order.js";
import { safeUrl, sanitizeStore } from "../netlify/lib/validate.js";
import { noContent, issueToken, verifyToken, isProductionRequest } from "../netlify/lib/auth.js";
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const catalog = {settings:{storeName:"Test",msgTemplate:"{store}\n{items}\n{totals}\n{notes}"},categories:[],banners:[],products:[
  {id:1,name:"Example A",prices:{USD:1.25,TRY:50},images:["/api/image/abcdef.jpg"],variants:[{name:"Large",prices:{TRY:60},showCurrencies:{USD:false}},{name:"Unavailable",availability:"out"}]},
  {id:2,name:"Example B",availability:"out",prices:{USD:2}},
  {id:3,name:"Example C",prices:{USD:3,TRY:100},showCurrencies:{USD:false}}
]};
test("order amount and image are taken from catalog", () => {
  const order = buildOrder(catalog,{items:[{id:1,qty:3,price:0,image:"invalid"}],text:"invalid"});
  assert.equal(order.items[0].total,3.75);
  assert.equal(order.items[0].image,"/api/image/abcdef.jpg");
  assert.doesNotMatch(order.text,/invalid/);
});
test("variant and currency visibility", () => {
  assert.equal(buildOrder(catalog,{items:[{id:1,variant:0,qty:2}]}).items[0].total,120);
  assert.equal(buildOrder(catalog,{items:[{id:3,qty:1}]}).items[0].cur,"TRY");
});
test("invalid or unavailable items are rejected", () => {
  for (const item of [{id:2,qty:1},{id:999,qty:1},{id:1,variant:1,qty:1}, ...[-1,0,1.5,1000,"1"].map(qty=>({id:1,qty}))]) {
    assert.throws(()=>buildOrder(catalog,{items:[item]}));
  }
  assert.throws(()=>buildOrder(catalog,{items:[{id:1,qty:1},{id:1,qty:1}]}));
});
test("inquiry, custom order template and note constraints", () => {
  assert.equal(buildOrder(catalog,{kind:"inquiry",id:1}).kind,"inquiry");
  assert.throws(()=>buildOrder(catalog,{kind:"inquiry",id:2}));
  assert.match(buildOrder(catalog,{items:[{id:1,qty:1}],notes:"{store}"}).text,/\{store\}/);
  assert.equal(buildOrder(catalog,{items:[{id:1,qty:1}],notes:"x".repeat(1000)}).notes.length,500);
});
test("URL restrictions and default catalog shape", async () => {
  for(const url of ["javascript:alert(1)","//example.com/x","/\\example.com/x","https://user:pass@example.com/x"]) assert.equal(safeUrl(url),"");
  assert.equal(safeUrl("/api/image/abcdef.jpg"),"/api/image/abcdef.jpg");
  const data=JSON.parse(await readFile(new URL("../data-default.json",import.meta.url),"utf8"));
  assert.equal(sanitizeStore(data).products.length,data.products.length);
});
test("empty response and preview isolation", () => {
  assert.equal(noContent().status,204);
  assert.equal(noContent().body,null);
  assert.equal(isProductionRequest(new Request("https://deploy-preview-1--maarefmarket.netlify.app/api/data")),false);
  assert.equal(isProductionRequest(new Request("https://maarefmarket.netlify.app/api/data")),true);
});
test("session signature and invalidation", () => {
  const prev=process.env.ADMIN_PASSWORD;
  try {
    process.env.ADMIN_PASSWORD="test-only-password-123";
    const {token}=issueToken();
    assert.ok(verifyToken(token));
    assert.equal(verifyToken(token.slice(0,-1)+(token.endsWith("x")?"y":"x")),null);
    process.env.ADMIN_PASSWORD="different-test-password";
    assert.equal(verifyToken(token),null);
    assert.equal(verifyToken(issueToken(-1).token),null);
  } finally { if(prev===undefined)delete process.env.ADMIN_PASSWORD;else process.env.ADMIN_PASSWORD=prev; }
});
test("all shipped JavaScript files have valid syntax", async () => {
  for(const dir of ["js","netlify/lib","netlify/functions","scripts"]) {
    for(const file of await readdir(dir)) {
      if(!/\.(js|mjs)$/.test(file))continue;
      const result=spawnSync(process.execPath,["--check",dir+"/"+file],{encoding:"utf8"});
      assert.equal(result.status,0,result.stderr);
    }
  }
});
