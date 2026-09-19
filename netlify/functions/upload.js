/**
 * Netlify Function: /api/upload
 * يستقبل صورة (raw body) ويحفظها في Netlify Blobs ويُرجع رابطاً داخلياً /api/image/<id>.<ext>
 *
 * الحماية: توكن جلسة، Same-Origin، حدّ للحجم، فحص "Magic bytes" لمحتوى الملف الحقيقي
 * (لا نثق بترويسة Content-Type وحدها)، حدّ للمعدّل.
 */

import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";
import { json, noContent, corsHeaders, requireAuth, clientIp, rateLimit } from "../lib/auth.js";

const STORE_NAME = "campuskart-images";
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

/** التعرّف على نوع الصورة من البايتات الأولى */
function sniff(buf) {
  const b = new Uint8Array(buf.slice(0, 16));
  const ascii = (s, e) => String.fromCharCode(...b.slice(s, e));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return { mime: "image/png", ext: "png" };
  if (ascii(0, 4) === "GIF8") return { mime: "image/gif", ext: "gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

export default async (req, context) => {
  const cors = corsHeaders(req, "POST, OPTIONS");
  if (req.method === "OPTIONS") return noContent(cors);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  const denied = requireAuth(req);
  if (denied) return denied;

  const rl = await rateLimit("upload", clientIp(req, context), { limit: 120, windowMs: 10 * 60 * 1000 });
  if (!rl.allowed) return json({ error: "رفع صور كثير، انتظر قليلاً" }, 429, { ...cors, "Retry-After": String(rl.retryAfterSec) });

  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_SIZE) return json({ error: "الصورة أكبر من 5MB" }, 413, cors);

  let buf;
  try { buf = await req.arrayBuffer(); } catch { return json({ error: "تعذّر قراءة الملف" }, 400, cors); }
  if (!buf || buf.byteLength === 0) return json({ error: "الملف فارغ" }, 400, cors);
  if (buf.byteLength > MAX_SIZE) return json({ error: "الصورة أكبر من 5MB" }, 413, cors);

  const kind = sniff(buf);
  if (!kind) return json({ error: "الملف ليس صورة صالحة (JPG/PNG/WEBP/GIF فقط)" }, 400, cors);

  try {
    const store = getStore({ name: STORE_NAME });
    const id = Date.now().toString(36) + randomBytes(6).toString("hex");
    const filename = `${id}.${kind.ext}`;
    await store.set(filename, buf, { metadata: { contentType: kind.mime, size: String(buf.byteLength) } });
    return json({ ok: true, url: `/api/image/${filename}`, size: buf.byteLength, type: kind.mime }, 200, cors);
  } catch (e) {
    console.error("upload error", e);
    return json({ error: "تعذّر رفع الصورة" }, 500, cors);
  }
};

export const config = { path: "/api/upload" };
