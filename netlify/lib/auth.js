/**
 * مكتبة مشتركة لدوال Netlify — مصادقة، حدّ المحاولات، ترويسات آمنة.
 * تُستورد من netlify/functions/*.js عبر  ../lib/auth.js
 */

import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // صلاحية الجلسة 12 ساعة
export const MIN_PASSWORD_LEN = 8;

/* ------------------------------------------------------------------ */
/* استجابات JSON بترويسات آمنة                                         */
/* ------------------------------------------------------------------ */
export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extra,
    },
  });
}

export function noContent(extra = {}) {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", ...extra } });
}

/* ------------------------------------------------------------------ */
/* Same-origin / CORS                                                   */
/* ------------------------------------------------------------------ */
// Preview deployments must never mutate shared site-wide Blobs or send real orders.
export function isProductionRequest(req) {
  try {
    const origin = new URL(req.url).origin;
    const canonical = new URL(process.env.URL || "https://maarefmarket.netlify.app").origin;
    return origin === canonical || origin === "https://maarefmarket.netlify.app";
  } catch { return false; }
}

export function siteOrigins(req) {
  const set = new Set();
  try { set.add(new URL(req.url).origin); } catch {}
  for (const k of ["URL", "DEPLOY_PRIME_URL", "DEPLOY_URL"]) {
    const v = process.env[k];
    if (v) { try { set.add(new URL(v).origin); } catch {} }
  }
  // Local development origin is accepted only for a local request.
  if (new URL(req.url).hostname === "localhost") set.add("http://localhost:8888");
  return set;
}

/**
 * strict=true  → يجب أن يكون Origin أو Referer موجوداً ومطابقاً (لنقاط النهاية غير المصادَق عليها)
 * strict=false → إن وُجد Origin/Referer يجب أن يطابق، وإن غاب نسمح (المصادقة بالتوكن تحمي)
 */
export function isSameOrigin(req, strict = false) {
  const allowed = siteOrigins(req);
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  if (origin) return allowed.has(origin);
  if (referer) { try { return allowed.has(new URL(referer).origin); } catch { return false; } }
  return !strict;
}

/** ترويسات CORS: تُعاد فقط عندما يكون الطالب من نفس الموقع */
export function corsHeaders(req, methods = "GET, POST, OPTIONS") {
  const origin = req.headers.get("origin");
  if (origin && siteOrigins(req).has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Base-Version, X-Force",
      "Vary": "Origin",
    };
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* IP العميل                                                            */
/* ------------------------------------------------------------------ */
export function clientIp(req, context) {
  return (
    (context && context.ip) ||
    req.headers.get("x-nf-client-connection-ip") ||
    "unknown"
  );
}

/* ------------------------------------------------------------------ */
/* حدّ المحاولات (Rate limiting) عبر Netlify Blobs                      */
/* ------------------------------------------------------------------ */
export async function rateLimit(bucket, key, { limit, windowMs }) {
  try {
    const store = getStore({ name: "campuskart-ratelimit", consistency: "strong" });
    const k = `${bucket}:${String(key).replace(/[^a-zA-Z0-9:._-]/g, "_").slice(0, 80)}`;
    for (let attempt=0;attempt<4;attempt++) {
      const now=Date.now();
      const entry=await store.getWithMetadata(k,{type:"json"});
      let rec=entry?.data;
      if(!rec || !Number.isSafeInteger(rec.count) || typeof rec.resetAt!=="number" || rec.resetAt<=now) rec={count:0,resetAt:now+windowMs};
      const retryAfterSec=Math.max(1,Math.ceil((rec.resetAt-now)/1000));
      if(rec.count>=limit)return {allowed:false,remaining:0,retryAfterSec};
      if(entry && !entry.etag)throw new Error("Missing rate-limit ETag");
      const next={count:rec.count+1,resetAt:rec.resetAt};
      const written=await store.setJSON(k,next,entry?{onlyIfMatch:entry.etag}:{onlyIfNew:true});
      if(written.modified)return {allowed:true,remaining:Math.max(0,limit-next.count),retryAfterSec};
    }
    return {allowed:false,remaining:0,retryAfterSec:2};
  } catch (e) {
    // عند تعطل التخزين نوقف العمليات المحددة بالمعدل مؤقتاً.
    console.error("Rate-limit storage unavailable");
    return { allowed: false, remaining: 0, retryAfterSec: 60 };
  }
}

/* ------------------------------------------------------------------ */
/* مقارنة آمنة ضد هجمات التوقيت                                          */
/* ------------------------------------------------------------------ */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) {
    // نُنفّذ مقارنة وهمية للحفاظ على زمن ثابت تقريباً
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/* ------------------------------------------------------------------ */
/* كلمة المرور                                                          */
/* ------------------------------------------------------------------ */
export function adminPasswordStatus() {
  const pwd = process.env.ADMIN_PASSWORD || "";
  if (!pwd) return { ok: false, error: "لم يتم ضبط ADMIN_PASSWORD في Environment variables على Netlify." };
  if (pwd.length < MIN_PASSWORD_LEN) {
    return { ok: false, error: `كلمة المرور ADMIN_PASSWORD قصيرة جداً — استخدم ${MIN_PASSWORD_LEN} أحرف على الأقل ثم أعد النشر.` };
  }
  return { ok: true, password: pwd };
}

/* ------------------------------------------------------------------ */
/* توكن جلسة موقّع HMAC-SHA256 (لا يحتوي كلمة المرور)                   */
/* المفتاح مشتقّ من كلمة المرور → تغييرها يُبطل كل الجلسات تلقائياً      */
/* ------------------------------------------------------------------ */
function secretKey() {
  const pwd = process.env.ADMIN_PASSWORD || "";
  const extra = process.env.SESSION_SECRET || "";
  return createHash("sha256").update(`campuskart-v3|${pwd}|${extra}`).digest();
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");

export function issueToken(ttlMs = TOKEN_TTL_MS) {
  const now = Date.now();
  const payload = b64u(JSON.stringify({ v: 3, iat: now, exp: now + ttlMs }));
  const sig = b64u(createHmac("sha256", secretKey()).update(payload).digest());
  return { token: `${payload}.${sig}`, exp: now + ttlMs };
}

export function verifyToken(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = b64u(createHmac("sha256", secretKey()).update(payload).digest());
  if (!safeEqual(sig, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!data || data.v !== 3 || typeof data.exp !== "number" || data.exp < Date.now()) return null;
  return data;
}

export function bearer(req) {
  const auth = req.headers.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

/** يُرجع null إذا كانت الجلسة صالحة، أو Response خطأ جاهزة */
export function requireAuth(req) {
  if (!isProductionRequest(req)) return json({ error: "النسخة التجريبية للقراءة فقط" }, 403, corsHeaders(req));
  const st = adminPasswordStatus();
  if (!st.ok) return json({ error: "إعدادات الإدارة غير متاحة" }, 503, corsHeaders(req));
  if (!isSameOrigin(req, false)) return json({ error: "مصدر الطلب غير مسموح" }, 403, corsHeaders(req));
  const session = verifyToken(bearer(req));
  if (!session) return json({ error: "الجلسة غير صالحة أو منتهية — سجّل الدخول مجدداً", code: "UNAUTHORIZED" }, 401, corsHeaders(req));
  return null;
}
