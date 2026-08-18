/**
 * Netlify Function: /api/upload
 * يستقبل صورة (blob) ويحفظها في Netlify Blobs، ويُرجع URL عام يمكن استخدامه في المتجر.
 */

import { getStore } from "@netlify/blobs";

const STORE_NAME = "campuskart-images";
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function extFromMime(m) {
  return ({ "image/jpeg":"jpg", "image/png":"png", "image/webp":"webp", "image/gif":"gif" })[m] || "bin";
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

  const expectedPwd = process.env.ADMIN_PASSWORD || "";
  if (!expectedPwd) {
    return new Response(JSON.stringify({ error: "ADMIN_PASSWORD غير مضبوط" }), {
      status: 500, headers: CORS_HEADERS,
    });
  }
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== expectedPwd) {
    return new Response(JSON.stringify({ error: "غير مصرّح" }), {
      status: 401, headers: CORS_HEADERS,
    });
  }

  const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED.includes(type)) {
    return new Response(JSON.stringify({ error: "نوع صورة غير مدعوم" }), {
      status: 400, headers: CORS_HEADERS,
    });
  }

  const buf = await req.arrayBuffer();
  if (!buf || buf.byteLength === 0) {
    return new Response(JSON.stringify({ error: "الملف فارغ" }), {
      status: 400, headers: CORS_HEADERS,
    });
  }
  if (buf.byteLength > MAX_SIZE) {
    return new Response(JSON.stringify({ error: "الصورة أكبر من 5MB" }), {
      status: 400, headers: CORS_HEADERS,
    });
  }

  try {
    const store = getStore({ name: STORE_NAME });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const filename = `${id}.${extFromMime(type)}`;
    await store.set(filename, buf, { metadata: { contentType: type } });
    return new Response(JSON.stringify({ ok: true, url: `/api/image/${filename}` }), {
      status: 200, headers: CORS_HEADERS,
    });
  } catch (e) {
    console.error("upload error", e);
    return new Response(JSON.stringify({ error: "تعذّر رفع الصورة", details: String(e) }), {
      status: 500, headers: CORS_HEADERS,
    });
  }
};

export const config = { path: "/api/upload" };
