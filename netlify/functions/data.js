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
        const backup = await store.get(BACKUP_KEY, { type: "json" });
        data = sanitizeStore(backup || (await loadDefaults()));
        version = Date.now();
        if (isProductionRequest(req)) {
          await store.setJSON(KEY, data, { metadata: { version: String(version) } });
          await store.setJSON(BACKUP_KEY, data);
        }
      } else {
        data = sanitizeStore(data);
      }

      const etag = `"${version}"`;
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache", ...cors } });
      }
      return json(withVersion(data, version), 200, { ...cors, ETag: etag, "Cache-Control": "no-cache" });
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

      if (!force && baseVersion && currentVersion && baseVersion !== currentVersion) {
        return json({
          error: "تم تعديل البيانات من جهاز آخر منذ آخر تحميل. أعد التحميل أو اختر (الكتابة فوقها).",
          code: "CONFLICT", currentVersion,
        }, 409, cors);
      }

      const newVersion = Math.max(Date.now(), currentVersion + 1);

      if (currentRec?.data) {
        const prev = sanitizeStore(currentRec.data);
        await store.setJSON(PREV_BACKUP_KEY, prev);
        // سجلّ تاريخي (آخر 20 نسخة) لاسترجاع أي خطأ
        await store.setJSON(`${HISTORY_PREFIX}${currentVersion || Date.now()}.json`, prev).catch(() => {});
        pruneHistory(store).catch(() => {});
      }
      await store.setJSON(KEY, clean, { metadata: { version: String(newVersion) } });
      await store.setJSON(BACKUP_KEY, clean);

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

async function pruneHistory(store) {
  const { blobs } = await store.list({ prefix: HISTORY_PREFIX });
  if (!blobs || blobs.length <= HISTORY_KEEP) return;
  const sorted = blobs.map((b) => b.key).sort(); // الأقدم أولاً (مرقّمة بالطابع الزمني)
  const toDelete = sorted.slice(0, sorted.length - HISTORY_KEEP);
  await Promise.all(toDelete.map((k) => store.delete(k).catch(() => {})));
}

export const config = { path: "/api/data" };
