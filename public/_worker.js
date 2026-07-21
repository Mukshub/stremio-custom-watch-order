// ============================================================================
//  Cloudflare Pages worker (advanced mode). Web-APIs only.
//
//  Orders are keyed by a unique <orderId>, so ONE show can have MULTIPLE named
//  orders. Each order = { imdbId, name, order:[[s,e],...] }. The catalog item
//  id is cwo:<orderId>; video ids stay real (tt..:S:E) so streams resolve.
//
//  URL modes:
//   • /u/<id>/...  LIVE SYNC — orders in KV (env.ORDERS_KV) keyed by user <id>.
//   • /c/<config>/... STATELESS snapshot (kept for future "publish" button).
//
//  KV value shape: { v:2, orders: { <orderId>: {imdbId,name,order} } }.
//  Back-compat: v1 { shows: { <imdbId>: {name,order} } } is migrated on read.
// ============================================================================

const CINEMETA = "https://v3-cinemeta.strem.io";
const cache = new Map();

async function getCinemetaSeries(imdbId) {
  if (cache.has(imdbId)) return cache.get(imdbId);
  const r = await fetch(`${CINEMETA}/meta/series/${imdbId}.json`);
  if (!r.ok) throw new Error(`cinemeta ${r.status}`);
  const j = await r.json();
  if (!j || !j.meta) throw new Error("no meta");
  cache.set(imdbId, j.meta);
  return j.meta;
}

function decodeConfig(seg) {
  if (!seg) return {};
  try {
    const bin = atob(seg.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

// Normalize any stored shape -> { <orderId>: {imdbId,name,order} }
function normalizeOrders(data) {
  if (!data) return {};
  if (data.orders) return data.orders;
  if (data.shows) {
    const out = {};
    for (const imdbId of Object.keys(data.shows)) {
      out[imdbId] = { imdbId, name: data.shows[imdbId].name, order: data.shows[imdbId].order };
    }
    return out;
  }
  return {};
}

function manifest() {
  return {
    id: "org.customwatchorder",
    version: "3.2.0",
    name: "Custom Watch Order",
    description:
      "Watch a series in whatever episode order you want, instead of just 1, 2, 3. Set up a release order, a chronological one, a skip-the-filler cut, or your own chaos rewatch by dragging episodes into place. Your orders sync across all your devices, and your usual stream addons still play every episode.",
    logo: "https://stremio-custom-order.pages.dev/logo.png",
    stremioAddonsConfig: {
      issuer: "https://stremio-addons.net",
      signature:
        "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..inkrhrH0IT8ln8qWQO6YTg.5zFEei53Rzch1mc-tLzl3oaA6cqkTIvC6cEPJY5fAP4B99KwT8RMPO2h70QOtriXnBiDv8bi6AyMrJzLY3AoKkMYGv-88WefCbBzbDeCJyhUlKXodELCMTp77es_2_E1.W4PJk7Qs77yuo1g4Bv-dZw",
    },
    behaviorHints: { configurable: true, configurationRequired: false },
    resources: ["catalog", "meta"],
    types: ["series"],
    idPrefixes: ["cwo:"],
    catalogs: [
      { type: "series", id: "cwo_catalog", name: "Custom Watch Order", extra: [{ name: "search", isRequired: false }] },
    ],
  };
}

async function catalog(orders, extra = {}) {
  const search = extra.search ? extra.search.toLowerCase() : null;
  const metas = await Promise.all(
    Object.keys(orders).map(async (oid) => {
      const o = orders[oid];
      try {
        const cm = await getCinemetaSeries(o.imdbId);
        const label = `${cm.name} · ${o.name}`;
        if (search && !label.toLowerCase().includes(search)) return null;
        return { id: `cwo:${oid}`, type: "series", name: label, poster: cm.poster, posterShape: "poster" };
      } catch {
        return null;
      }
    })
  );
  return { metas: metas.filter(Boolean) };
}

async function meta(orders, id) {
  const oid = id.replace(/^cwo:/, "");
  const o = orders[oid];
  if (!o) return { meta: null };
  const cm = await getCinemetaSeries(o.imdbId);
  const byKey = {};
  for (const v of cm.videos || []) byKey[`${v.season}:${v.episode}`] = v;
  const videos = (o.order || [])
    .map(([season, episode], i) => {
      const src = byKey[`${season}:${episode}`];
      if (!src) return null;
      return {
        id: `${o.imdbId}:${season}:${episode}`,
        title: `#${i + 1} · S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} — ${src.name}`,
        season: 1, episode: i + 1, number: i + 1,
        released: src.released, thumbnail: src.thumbnail, overview: src.overview || src.description,
      };
    })
    .filter(Boolean);
  return {
    meta: {
      id, type: "series", name: `${cm.name} — ${o.name || "Custom Order"}`,
      poster: cm.poster, posterShape: cm.posterShape || "poster", background: cm.background,
      logo: cm.logo, description: cm.description, releaseInfo: cm.releaseInfo,
      genres: cm.genres || cm.genre, videos,
    },
  };
}

// Analytics Engine — privacy-light usage counting. No-op when the binding is
// absent (local Node dev / `pages dev`), so it can never break a request.
// index1 = user id (or "anon") so unique-user queries sample per user.
function track(env, event, userId, mode) {
  try {
    if (!env || !env.ANALYTICS) return;
    env.ANALYTICS.writeDataPoint({
      blobs: [event, userId || "-", mode || "-"],
      doubles: [1],
      indexes: [userId || "anon"],
    });
  } catch {}
}

function json(obj, code = 200) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-cache",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname;

    let userId = null;
    let snapshot = null;
    const um = path.match(/^\/u\/([^/]+)(\/.*)?$/);
    const cm = path.match(/^\/c\/([^/]+)(\/.*)?$/);
    if (um) { userId = um[1]; path = um[2] || "/"; }
    else if (cm) { snapshot = decodeConfig(cm[1]); path = cm[2] || "/"; }
    const mode = userId ? "u" : snapshot ? "c" : "bare";

    const getOrders = async () => {
      if (userId) return normalizeOrders(await env.ORDERS_KV.get(userId, "json"));
      if (snapshot) return normalizeOrders(snapshot);
      return {};
    };
    const putOrders = async (orders) => env.ORDERS_KV.put(userId, JSON.stringify({ v: 2, orders }));

    try {
      // Configure page (static asset, canonical /configure).
      if (path === "/" || path === "/configure" || path === "/configure/") {
        track(env, "configure", userId, mode);
        return env.ASSETS.fetch(new Request(new URL("/configure", url.origin), request));
      }

      // Cinemeta proxies (no id needed).
      if (path === "/api/search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json({ results: [] });
        const r = await fetch(`${CINEMETA}/catalog/series/top/search=${encodeURIComponent(q)}.json`);
        const jj = await r.json();
        return json({ results: (jj.metas || []).slice(0, 20).map((x) => ({ imdbId: x.id, name: x.name, poster: x.poster })) });
      }
      if (path === "/api/episodes") {
        const imdbId = url.searchParams.get("imdb");
        if (!imdbId) return json({ error: "missing imdb" }, 400);
        const c = await getCinemetaSeries(imdbId);
        const episodes = (c.videos || [])
          .filter((v) => v.season > 0)
          .map((v) => ({ season: v.season, episode: v.episode, title: v.name, thumbnail: v.thumbnail }))
          .sort((a, b) => a.season - b.season || a.episode - b.episode);
        return json({ imdbId, name: c.name, poster: c.poster, episodes });
      }

      // Live-sync write API (needs a user id).
      if (path === "/api/orders") {
        if (!userId) return json({ error: "no user id" }, 400);
        const orders = await getOrders();
        const list = await Promise.all(
          Object.keys(orders).map(async (oid) => {
            const o = orders[oid];
            let cinemetaName = o.imdbId, poster = null;
            try { const c = await getCinemetaSeries(o.imdbId); cinemetaName = c.name; poster = c.poster; } catch {}
            return { orderId: oid, imdbId: o.imdbId, cinemetaName, poster, name: o.name, order: o.order, count: o.order.length };
          })
        );
        return json({ orders: list });
      }
      if (path === "/api/order" && request.method === "POST") {
        if (!userId) return json({ error: "no user id" }, 400);
        const body = await request.json().catch(() => ({}));
        if (!body.imdbId || !Array.isArray(body.order)) return json({ error: "imdbId and order[] required" }, 400);
        const orders = await getOrders();
        const oid = body.orderId || `${body.imdbId}-${Math.random().toString(36).slice(2, 8)}`;
        orders[oid] = { imdbId: body.imdbId, name: body.name || body.imdbId, order: body.order };
        await putOrders(orders);
        track(env, "save", userId, mode);
        return json({ ok: true, orderId: oid });
      }
      if (path === "/api/order/delete" && request.method === "POST") {
        if (!userId) return json({ error: "no user id" }, 400);
        const body = await request.json().catch(() => ({}));
        if (!body.orderId) return json({ error: "orderId required" }, 400);
        const orders = await getOrders();
        delete orders[body.orderId];
        await putOrders(orders);
        return json({ ok: true });
      }

      // Addon routes.
      if (path === "/manifest.json") { track(env, "manifest", userId, mode); return json(manifest()); }
      const orders = await getOrders();

      const cat = path.match(/^\/catalog\/series\/([^/]+?)(?:\/(.+))?\.json$/);
      if (cat) {
        const extra = {};
        if (cat[2]) cat[2].split("&").forEach((kv) => { const i = kv.indexOf("="); if (i > -1) extra[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
        track(env, "catalog", userId, mode);
        return json(await catalog(orders, extra));
      }

      const met = path.match(/^\/meta\/series\/(.+)\.json$/);
      if (met) { track(env, "meta", userId, mode); return json(await meta(orders, decodeURIComponent(met[1]))); }

      // Static assets from public/ (logo.png, background.png, etc.).
      if (request.method === "GET" && /\.[a-z0-9]+$/i.test(path)) {
        return env.ASSETS.fetch(new Request(new URL(path, url.origin), request));
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
