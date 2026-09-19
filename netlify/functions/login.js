/**
 * Netlify Function: /api/login
 * POST {password}  → يُرجع توكن جلسة موقّع (لا يحتوي كلمة المرور) صالح 12 ساعة
 * POST {token}     → يتحقّق من صلاحية توكن قائم (تسجيل دخول تلقائي)
 *
 * الحماية: حدّ 8 محاولات / 15 دقيقة لكل IP، مقارنة آمنة زمنياً، Same-Origin فقط.
 */

import {
  json, noContent, corsHeaders, isSameOrigin, clientIp,
  rateLimit, safeEqual, adminPasswordStatus, issueToken, verifyToken,
} from "../lib/auth.js";

export default async (req, context) => {
  const cors = corsHeaders(req, "POST, OPTIONS");
  if (req.method === "OPTIONS") return noContent(cors);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
  if (!isSameOrigin(req, true)) return json({ error: "مصدر الطلب غير مسموح" }, 403, cors);

  const st = adminPasswordStatus();
  if (!st.ok) return json({ error: st.error }, 500, cors);

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON غير صالح" }, 400, cors); }
  body = body && typeof body === "object" ? body : {};

  /* --- التحقق من توكن قائم (دخول تلقائي) --- */
  if (typeof body.token === "string") {
    const session = verifyToken(body.token);
    if (session) return json({ ok: true, exp: session.exp }, 200, cors);
    return json({ ok: false, error: "الجلسة منتهية" }, 401, cors);
  }

  /* --- تسجيل دخول بكلمة المرور --- */
  const ip = clientIp(req, context);
  const rl = await rateLimit("login", ip, { limit: 8, windowMs: 15 * 60 * 1000 });
  if (!rl.allowed) {
    return json(
      { ok: false, error: `محاولات كثيرة. حاول بعد ${Math.ceil(rl.retryAfterSec / 60)} دقيقة.` },
      429, { ...cors, "Retry-After": String(rl.retryAfterSec) }
    );
  }

  const pwd = typeof body.password === "string" ? body.password.slice(0, 256) : "";
  if (!pwd || !safeEqual(pwd, st.password)) {
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 300));
    return json({ ok: false, error: "كلمة المرور غير صحيحة", remaining: rl.remaining }, 401, cors);
  }

  const { token, exp } = issueToken();
  return json({ ok: true, token, exp }, 200, cors);
};

export const config = { path: "/api/login" };
