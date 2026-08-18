/**
 * Netlify Function: /api/data
 * GET  => يُرجع بيانات المتجر
 * PUT  => يحفظ البيانات (يتطلب Authorization: Bearer <ADMIN_PASSWORD>)
 */

import { getStore } from "@netlify/blobs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const STORE_NAME = "campuskart-data";
const KEY = "store.json";
const BACKUP_KEY = "store.backup.latest.json";
const PREV_BACKUP_KEY = "store.backup.previous.json";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

async function loadDefaults() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "..", "data-default.json"),
      join(here, "..", "..", "data-default.json"),
      join(process.cwd(), "data-default.json"),
    ];
    for (const p of candidates) {
      try {
        const txt = await readFile(p, "utf-8");
        return JSON.parse(txt);
      } catch (_) {}
    }
  } catch (e) {
    console.error("loadDefaults error", e);
  }
  return {
    settings: {
      storeName: "CampusKart",
      description: "متجر الجامعة",
      email: "",
      whatsapp: "",
      instagram: "",
      deliveryNote: "توصيل داخل الحرم الجامعي.",
      bannerIntervalSec: 7
    },
    banners: [],
    categories: [
      { slug: "chips", name: "شيبسات" },
      { slug: "drinks", name: "مشروبات" }
    ],
    products: []
  };
}

function normalizeData(data) {
  const fallback = {
    settings: {
      storeName: "CampusKart",
      description: "متجر الجامعة",
      email: "",
      whatsapp: "",
      instagram: "",
      deliveryNote: "توصيل داخل الحرم الجامعي.",
      bannerIntervalSec: 7,
    },
    banners: [],
    categories: [],
    products: [],
  };
  const safe = data && typeof data === "object" ? data : {};
  const settings = { ...fallback.settings, ...(safe.settings || {}) };
  settings.bannerIntervalSec = Math.max(2, parseInt(settings.bannerIntervalSec, 10) || 7);
  return {
    settings,
    banners: Array.isArray(safe.banners) ? safe.banners : fallback.banners,
    categories: Array.isArray(safe.categories) ? safe.categories : fallback.categories,
    products: Array.isArray(safe.products) ? safe.products : fallback.products,
  };
}

export default async (req) => {
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response("", { status: 204, headers: CORS_HEADERS });
  }

  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  if (method === "GET") {
    try {
      let data = await store.get(KEY, { type: "json" });
      if (!data) {
        const backup = await store.get(BACKUP_KEY, { type: "json" });
        if (backup) {
          data = normalizeData(backup);
          await store.setJSON(KEY, data);
        } else {
          data = normalizeData(await loadDefaults());
          await store.setJSON(KEY, data);
          await store.setJSON(BACKUP_KEY, data);
        }
      } else {
        data = normalizeData(data);
      }
      return new Response(JSON.stringify(data), { status: 200, headers: CORS_HEADERS });
    } catch (e) {
      console.error("GET error", e);
      return new Response(
        JSON.stringify({ error: "تعذّر قراءة البيانات", details: String(e) }),
        { status: 500, headers: CORS_HEADERS }
      );
    }
  }

  if (method === "PUT") {
    const expectedPwd = process.env.ADMIN_PASSWORD || "";
    if (!expectedPwd) {
      return new Response(
        JSON.stringify({
          error: "لم يتم ضبط ADMIN_PASSWORD في Environment variables على Netlify.",
        }),
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== expectedPwd) {
      return new Response(JSON.stringify({ error: "كلمة المرور غير صحيحة" }), {
        status: 401,
        headers: CORS_HEADERS,
      });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "JSON غير صالح" }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    if (
      !body || typeof body !== "object" ||
      !body.settings ||
      !Array.isArray(body.products) ||
      !Array.isArray(body.categories) ||
      !Array.isArray(body.banners)
    ) {
      return new Response(
        JSON.stringify({ error: "بنية البيانات غير صالحة" }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    body = normalizeData(body);

    try {
      const current = await store.get(KEY, { type: "json" });
      if (current) await store.setJSON(PREV_BACKUP_KEY, normalizeData(current));
      await store.setJSON(KEY, body);
      await store.setJSON(BACKUP_KEY, body);
      return new Response(JSON.stringify({ ok: true, savedAt: Date.now() }), {
        status: 200,
        headers: CORS_HEADERS,
      });
    } catch (e) {
      console.error("PUT error", e);
      return new Response(
        JSON.stringify({ error: "تعذّر حفظ البيانات", details: String(e) }),
        { status: 500, headers: CORS_HEADERS }
      );
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: CORS_HEADERS,
  });
};

export const config = { path: "/api/data" };
