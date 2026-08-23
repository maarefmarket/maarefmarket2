/**
 * Netlify Function: /api/notify
 * يستقبل تفاصيل الطلب من الواجهة ويرسل نسخة إلى بوت Telegram في الخلفية.
 * الزبون لا يرى هذا — تفتح لديه رسالة واتساب عادية مع الرقم الأول.
 *
 * إعداد متغيرات البيئة على Netlify:
 * ─────────────────────────────────────────────────────────────
 * TELEGRAM_BOT_TOKEN     توكن البوت من BotFather (مثل: 123456789:AAH...xyz)
 * TELEGRAM_CHAT_IDS      Chat ID واحد أو أكثر مفصولة بفاصلة (مثل: 12345678,87654321)
 * WA_LOG=1               (اختياري) حفظ الطلبات كسجل في Netlify Blobs
 * ─────────────────────────────────────────────────────────────
 *
 * كيف تحصل على Chat ID:
 *   1) أرسل أي رسالة لبوتك من حسابك
 *   2) افتح: https://api.telegram.org/bot<TOKEN>/getUpdates
 *   3) انسخ الرقم من "chat":{"id":<هنا>}
 */

import { getStore } from "@netlify/blobs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

async function sendToTelegram(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok && json.ok, status: res.status, description: json.description };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function logOrder(order) {
  if (process.env.WA_LOG !== "1") return;
  try {
    const store = getStore({ name: "campuskart-orders" });
    const key = `order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    await store.setJSON(key, {
      timestamp: new Date().toISOString(),
      ...order,
    });
  } catch (e) {
    console.error("logOrder failed", e);
  }
}

// تحويل تنسيق واتساب (*نص*) إلى Markdown صحيح لتلغرام (*نص*)
// تلغرام Markdown يستخدم أيضاً *نص* للعريض، لذا لا يحتاج تحويلاً.
// لكن يجب هروب الرموز الخاصة: _ [ ]
function safeForMarkdown(text) {
  return String(text || "");
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: CORS_HEADERS,
    });
  }

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "JSON غير صالح" }), { status: 400, headers: CORS_HEADERS });
  }

  const text = (body && body.text) ? String(body.text) : "";
  if (!text) {
    return new Response(JSON.stringify({ error: "لا يوجد نص للإرسال" }), { status: 400, headers: CORS_HEADERS });
  }

  // سجّل الطلب دائماً (يمكن استرجاعه لاحقاً)
  await logOrder({ text, meta: body.meta || {} });

  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatIds = (process.env.TELEGRAM_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

  if (!token || !chatIds.length) {
    return new Response(JSON.stringify({
      ok: false,
      error: "TELEGRAM_BOT_TOKEN أو TELEGRAM_CHAT_IDS غير مضبوطة في Netlify Environment variables",
    }), { status: 500, headers: CORS_HEADERS });
  }

  // بناء رسالة تلغرام مع عنوان واضح
  const meta = body.meta || {};
  const header = `🛒 *طلب جديد من ${meta.store || "المتجر"}*\n━━━━━━━━━━━━━━━━━━\n`;
  const footer = `\n━━━━━━━━━━━━━━━━━━\n📅 ${new Date().toLocaleString("ar-SY", { hour12: false })}`;
  const finalMessage = header + safeForMarkdown(text) + footer;

  const results = [];
  for (const chatId of chatIds) {
    const r = await sendToTelegram(token, chatId, finalMessage);
    results.push({ chatId, ...r });
  }

  const allOk = results.every(r => r.ok);
  return new Response(JSON.stringify({
    ok: allOk,
    sent: results.filter(r => r.ok).length,
    total: results.length,
    results,
    logged: process.env.WA_LOG === "1",
  }), {
    status: allOk ? 200 : 207,
    headers: CORS_HEADERS,
  });
};

export const config = { path: "/api/notify" };
