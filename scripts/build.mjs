import { rm, mkdir, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const output=join(root,"dist");
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
for(const entry of ["index.html","admin.html","css","js","assets","support-sw.js","support.webmanifest"]){
  await cp(join(root,entry),join(output,entry),{recursive:true});
}
console.log("Static storefront and admin assets built into dist.");
