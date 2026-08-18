/**
 * Netlify Function: /api/image/:filename
 * يعرض الصورة المخزّنة في Netlify Blobs
 */

import { getStore } from "@netlify/blobs";

const STORE_NAME = "campuskart-images";

export default async (req) => {
  try {
    const url = new URL(req.url);
    const filename = url.pathname.split("/").pop();
    if (!filename) {
      return new Response("Not found", { status: 404 });
    }

    const store = getStore({ name: STORE_NAME });
    const blob = await store.get(filename, { type: "arrayBuffer" });
    if (!blob) {
      return new Response("Not found", { status: 404 });
    }

    const meta = await store.getMetadata(filename).catch(() => null);
    const contentType = meta?.metadata?.contentType || "image/jpeg";

    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    console.error("image serve error", e);
    return new Response("Server error", { status: 500 });
  }
};

export const config = { path: "/api/image/*" };
