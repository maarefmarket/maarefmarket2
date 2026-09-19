/**
 * Netlify Function: /api/image/:filename
 * يعرض صورة من Netlify Blobs — عام للقراءة.
 * الحماية: اسم الملف مقيّد بنمط صارم (لا path traversal)، Content-Type محصور بأنواع الصور،
 * nosniff + CSP sandbox لمنع أي تنفيذ محتوى.
 */

import { getStore } from "@netlify/blobs";

const STORE_NAME = "campuskart-images";
const NAME_RE = /^[a-z0-9]{6,40}\.(jpg|png|webp|gif)$/;
const MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export default async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  try {
    const filename = decodeURIComponent(new URL(req.url).pathname.split("/").pop() || "");
    if (!NAME_RE.test(filename)) return new Response("Not found", { status: 404 });

    const store = getStore({ name: STORE_NAME });
    const blob = await store.get(filename, { type: "arrayBuffer" });
    if (!blob) return new Response("Not found", { status: 404 });

    const ext = filename.split(".").pop();
    return new Response(req.method === "HEAD" ? null : blob, {
      status: 200,
      headers: {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Content-Length": String(blob.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Content-Disposition": "inline",
      },
    });
  } catch (e) {
    console.error("image serve error", e);
    return new Response("Server error", { status: 500 });
  }
};

export const config = { path: "/api/image/*" };
