/**
 * Netlify Function: /api/data
 * GET  → بيانات المتجر (عامة، مع ETag)
 * PUT  → حفظ البيانات (يتطلب توكن جلسة صالح + Same-Origin)
 *        ترويسة X-Base-Version تمنع الكتابة فوق تعديل أحدث من جهاز آخر (Optimistic locking)
 *        ترويسة X-Force: 1 لتجاوز التعارض عمداً
 */

import { getStore } from "@netlify/blobs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { json, noContent, corsHeaders, requireAuth, clientIp, rateLimit, isProductionRequest } from "../lib/auth.js";
import { sanitizeStore, hasValidShape, LIMITS } from "../lib/validate.js";

const STORE_NAME = "campuskart-data";
const KEY = "store.json";
const BACKUP_KEY = "store.backup.latest.json";
const PREV_BACKUP_KEY = "store.backup.previous.json";
const HISTORY_PREFIX = "history/";
const HISTORY_KEEP = 20;

const FALLBACK = {
  settings: {
    storeName: "CampusKart", description: "متجر الجامعة", email: "", whatsapp: "", whatsapps: [],
    instagram: "", deliveryNote: "توصيل داخل الحرم الجامعي.", bannerIntervalSec: 7,
  },
  banners: [], categories: [], products: [],
};

async function loadDefaults() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "data-default.json"),
    join(here, "..", "..", "..", "data-default.json"),
    join(process.cwd(), "data-default.json"),
  ];
  for (const p of candidates) {
    try { return JSON.parse(await readFile(p, "utf-8")); } catch {}
  }
  return FALLBACK;
}

function withVersion(data, version) {
  return { ...data, _version: version };
}

export default async (req, context) => {
  const method = req.method.toUpperCase();
  const cors = corsHeaders(req, "GET, PUT, OPTIONS");
  if (method === "OPTIONS") return noContent(cors);

  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  /* ---------------------------- GET ---------------------------- */
  if (method === "GET") {
    try {
      let rec = await store.getWithMetadata(KEY, { type: "json" });
      let data = rec?.data || null;
      let version = Number(rec?.metadata?.version) || 0;

      if (!data) {
        const backup = await store.getWithMetadata(BACKUP_KEY, {type:"json"});
        data = sanitizeStore(backup?.data || await loadDefaults());
        version = Math.max(Date.now(), Number(backup?.metadata?.version)||0);
        if (isProductionRequest(req)) {
          const initialized=await store.setJSON(KEY,data,{onlyIfNew:true,metadata:{version:String(version)}});
          if(!initialized.modified) {
            rec=await store.getWithMetadata(KEY,{type:"json"});
            if(!rec?.data)throw new Error("Catalog initialization conflict");
            data=sanitizeStore(rec.data);version=Number(rec.metadata?.version)||0;
          } else {
            try{await saveLatestBackup(store,data,version);}catch{console.error("Catalog backup unavailable");}
          }
        }
      } else {
        data = sanitizeStore(data);
      }

      const mode=data.settings.maintenanceMode===true;
      const status={maintenanceMode:mode,maintenanceMessage:data.settings.maintenanceMessage||""};
      if(new URL(req.url).searchParams.get("status")==="1")return json(status,200,cors);
      const adminRequested=!!req.headers.get("authorization");
      if(adminRequested){const denied=requireAuth(req);if(denied)return denied;}
      if(mode&&!adminRequested)return json({settings:{storeName:data.settings.storeName,theme:data.settings.theme,...status},banners:[],categories:[],products:[]},503,{...cors,"Retry-After":"60"});
      const etag = `"${version}"`;
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache", ...cors } });
      }
      return json(withVersion(data, version), 200, { ...cors, ETag: etag, "Cache-Control": "no-store", Vary: "Authorization, Origin" });
    } catch (e) {
      console.error("GET error", e);
      return json({ error: "تعذّر قراءة البيانات" }, 500, cors);
    }
  }

  /* ---------------------------- PUT ---------------------------- */
  if (method === "PUT") {
    const denied = requireAuth(req);
    if (denied) return denied;

    const rl = await rateLimit("save", clientIp(req, context), { limit: 60, windowMs: 10 * 60 * 1000 });
    if (!rl.allowed) return json({ error: "طلبات حفظ كثيرة، انتظر قليلاً" }, 429, { ...cors, "Retry-After": String(rl.retryAfterSec) });

    const len = Number(req.headers.get("content-length") || 0);
    if (len > LIMITS.bodyBytes) return json({ error: "حجم البيانات كبير جداً (الحدّ 3MB)" }, 413, cors);

    let raw;
    try { raw = await req.text(); } catch { return json({ error: "تعذّر قراءة الطلب" }, 400, cors); }
    if (Buffer.byteLength(raw, "utf8") > LIMITS.bodyBytes) return json({ error: "حجم البيانات كبير جداً (الحدّ 3MB)" }, 413, cors);

    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "JSON غير صالح" }, 400, cors); }
    if (!hasValidShape(body)) return json({ error: "بنية البيانات غير صالحة" }, 400, cors);

    const clean = sanitizeStore(body);

    try {
      const currentRec = await store.getWithMetadata(KEY, { type: "json" });
      const currentVersion = Number(currentRec?.metadata?.version) || 0;
      const baseVersion = Number(req.headers.get("x-base-version") || 0);
      const force = req.headers.get("x-force") === "1";

      if (!force && currentVersion && baseVersion !== currentVersion) {
        return json({
          error: "تم تعديل البيانات من جهاز آخر منذ آخر تحميل. أعد التحميل أو اختر (الكتابة فوقها).",
          code: "CONFLICT", currentVersion,
        }, 409, cors);
      }

      const newVersion = Math.max(Date.now(), currentVersion + 1);

      if (currentRec?.data) {
        const prev = sanitizeStore(currentRec.data);
        // Preserve the previous authoritative version before attempting a conditional write.
        await store.setJSON(`${HISTORY_PREFIX}${currentVersion || Date.now()}.json`, prev, {onlyIfNew:true});
      }
      if(currentRec && !currentRec.etag) throw new Error("Missing catalog ETag");
      const condition=currentRec ? {onlyIfMatch:currentRec.etag} : {onlyIfNew:true};
      const result=await store.setJSON(KEY,clean,{...condition,metadata:{version:String(newVersion)}});
      if(!result.modified) {
        const latest=await store.getWithMetadata(KEY,{type:"json"});
        return json({error:"تم تعديل البيانات من جهاز آخر. أعد التحميل قبل الحفظ.",code:"CONFLICT",currentVersion:Number(latest?.metadata?.version)||0},409,cors);
      }
      // A successful primary commit must not be reported as failed if a secondary backup fails.
      try {
        await saveLatestBackup(store,clean,newVersion);
        if(currentRec?.data) await saveVersionedBackup(store,PREV_BACKUP_KEY,sanitizeStore(currentRec.data),currentVersion||0);
        await pruneHistory(store);
      } catch { console.error("Catalog committed; secondary backup update failed"); }

      return json({ ok: true, savedAt: newVersion, version: newVersion, counts: {
        products: clean.products.length, categories: clean.categories.length, banners: clean.banners.length,
      } }, 200, cors);
    } catch (e) {
      console.error("PUT error", e);
      return json({ error: "تعذّر حفظ البيانات" }, 500, cors);
    }
  }

  return json({ error: "Method not allowed" }, 405, cors);
};

async function saveVersionedBackup(store,key,data,version) {
  for(let attempt=0;attempt<3;attempt++) {
    const prev=await store.getWithMetadata(key,{type:"json"});
    if(prev && Number(prev.metadata?.version)>=version) return;
    if(prev && !prev.etag) throw new Error("Missing backup ETag");
    const result=await store.setJSON(key,data,{...(prev?{onlyIfMatch:prev.etag}:{onlyIfNew:true}),metadata:{version:String(version)}});
    if(result.modified) return;
  }
  throw new Error("Backup write contention");
}
async function saveLatestBackup(store,data,version) { return saveVersionedBackup(store,BACKUP_KEY,data,version); }

async function pruneHistory(store) {
  const { blobs } = await store.list({ prefix: HISTORY_PREFIX });
  if (!blobs || blobs.length <= HISTORY_KEEP) return;
  const sorted = blobs.map((b) => b.key).sort(); // الأقدم أولاً (مرقّمة بالطابع الزمني)
  const toDelete = sorted.slice(0, sorted.length - HISTORY_KEEP);
  await Promise.all(toDelete.map((k) => store.delete(k).catch(() => {})));
}

export const config = { path: "/api/data" };
