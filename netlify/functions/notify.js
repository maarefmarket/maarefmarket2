/**
 * Netlify Function: /api/notify
 * يستقبل نص الطلب من واجهة المتجر ويرسل نسخة إلى بوت Telegram في الخلفية.
 *
 * متغيرات البيئة على Netlify:
 *   TELEGRAM_BOT_TOKEN   توكن البوت من BotFather
 *   TELEGRAM_CHAT_IDS    معرّف محادثة أو أكثر مفصولة بفاصلة
 *   WA_LOG=1             (اختياري) حفظ نسخة من كل طلب في Netlify Blobs
 *
 * الحماية: Same-Origin إلزامي، حدّ 10 طلبات/10 دقائق لكل IP، حدّ لطول النص،
 * إرسال كنص خام (بدون Markdown) لتجنّب فشل التنسيق أو الحقن.
 * لا تُرجع أي تفاصيل عن الإعدادات للزبون.
 */

import { getStore } from "@netlify/blobs";
import { json, noContent, corsHeaders, isSameOrigin, clientIp, rateLimit } from "../lib/auth.js";

const MAX_TEXT = 4000; // حدّ تلغرام 4096

async function sendToTelegram(token, chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    const j = await res.json().catch(() => ({}));
    return !!(res.ok && j.ok);
  } catch (e) {
    console.error("telegram error", e);
    return false;
  }
}

async function logOrder(entry) {
  if (process.env.WA_LOG !== "1") return;
  try {
    const store = getStore({ name: "campuskart-orders" });
    const key = `order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    await store.setJSON(key, { timestamp: new Date().toISOString(), ...entry });
  } catch (e) { console.error("logOrder failed", e); }
}

export default async (req, context) => {
  const cors = corsHeaders(req, "POST, OPTIONS");
  if (req.method === "OPTIONS") return noContent(cors);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
  if (!isSameOrigin(req, true)) return json({ error: "غير مسموح" }, 403, cors);

  const ip = clientIp(req, context);
  const rl = await rateLimit("notify", ip, { limit: 10, windowMs: 10 * 60 * 1000 });
  if (!rl.allowed) return json({ ok: false }, 429, { ...cors, "Retry-After": String(rl.retryAfterSec) });

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON غير صالح" }, 400, cors); }

  const text = String(body?.text || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, MAX_TEXT).trim();
  if (!text) return json({ error: "لا يوجد نص" }, 400, cors);

  const store = String(body?.meta?.store || "").slice(0, 80);
  const numbers = Array.isArray(body?.meta?.numbers) ? body.meta.numbers.map((n) => String(n).replace(/\D/g, "").slice(0, 20)).slice(0, 10) : [];

  await logOrder({ text, store, numbers, ip });

  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatIds = (process.env.TELEGRAM_CHAT_IDS || "").split(",").map((s) => s.trim()).filter((s) => /^-?\d+$/.test(s));
  if (!token || !chatIds.length) {
    // غير مضبوط → نُرجع نجاحاً صامتاً للزبون؛ الطلب الأساسي يمرّ عبر واتساب على أي حال
    return json({ ok: true, sent: 0 }, 200, cors);
  }

  const header = `🛒 طلب جديد من ${store || "المتجر"}\n━━━━━━━━━━━━━━━━━━\n`;
  const footer = `\n━━━━━━━━━━━━━━━━━━\n📅 ${new Date().toLocaleString("ar-SY", { hour12: false, timeZone: "Asia/Damascus" })}`;
  const message = header + text + footer;

  const results = await Promise.all(chatIds.map((id) => sendToTelegram(token, id, message)));
  const sent = results.filter(Boolean).length;
  return json({ ok: sent > 0, sent }, 200, cors);
};

export const config = { path: "/api/notify" };
