// ============================================================================
//  Cloudflare Pages worker (advanced mode). Web-APIs only.
//
//  Orders are keyed by a unique <orderId>, so ONE show can have MULTIPLE named
//  orders. Each order = { imdbId, name, order:[entry,...] }. The catalog item
//  id is cwo:<orderId>; video ids stay real so streams resolve.
//    entry = [s,e]                 -> an episode of the order's show (imdbId)
//    entry = { k:"m", id, name }   -> a MOVIE (any imdb tt id) dropped into the
//                                     sequence. Its video id is the bare tt id;
//                                     Stremio requests streams as type=series
//                                     with that id, which stream addons resolve
//                                     the same as type=movie (verified: Torrentio
//                                     returns identical streams for both).
//
//  URL modes:
//   • /u/<id>/...  LIVE SYNC — orders in KV (env.ORDERS_KV) keyed by user <id>.
//   • /c/<config>/... STATELESS snapshot (kept for future "publish" button).
//
//  KV value shape: { v:3, orders: { <orderId>: {imdbId,name,order,coll,pos?} },
//                         collections: { <collId>: {name,pos} } }.
//  Each COLLECTION is its own catalog row in Stremio; every order belongs to
//  exactly one (`coll`). Back-compat: v1 { shows } and v2 (no collections) are
//  migrated on read into the default collection, whose catalog id stays
//  "cwo_catalog" so manifests cached before collections existed keep working.
//  `pos` (optional) = manual sort position set by drag-reordering on the
//  configure page (orders: within their collection; collections: row order).
//  Items without it fall back to name sort (see NO_POS).
// ============================================================================

const CINEMETA = "https://v3-cinemeta.strem.io";
const cache = new Map();

// Sentinel for orders with no manual position: sort them after positioned
// ones, then alphabetically. Finite so it's safe in numeric subtraction.
const NO_POS = 1e9;
const posOf = (o) => (typeof o.pos === "number" ? o.pos : NO_POS);
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

async function getCinemeta(type, id) {
  const key = `${type}:${id}`;
  if (cache.has(key)) return cache.get(key);
  const r = await fetch(`${CINEMETA}/meta/${type}/${id}.json`);
  if (!r.ok) throw new Error(`cinemeta ${r.status}`);
  const j = await r.json();
  if (!j || !j.meta) throw new Error("no meta");
  cache.set(key, j.meta);
  return j.meta;
}
const getCinemetaSeries = (imdbId) => getCinemeta("series", imdbId);

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

const DEFAULT_COLL = "main";
const DEFAULT_COLL_NAME = "Custom Watch Order";
const MAX_COLLS = 50;
const catalogIdOf = (collId) => (collId === DEFAULT_COLL ? "cwo_catalog" : `cwo_c_${collId}`);
const cleanName = (s, max) => String(s || "").trim().slice(0, max);
// Collections as a list in row order.
const sortedColls = (collections) =>
  Object.keys(collections)
    .map((collId) => ({ collId, ...collections[collId] }))
    .sort((a, b) => posOf(a) - posOf(b) || byName(a.name, b.name));

// Normalize any stored shape -> { orders, collections }, with at least one
// collection and every order pointing at a collection that exists.
function normalizeData(data) {
  const orders = normalizeOrders(data);
  const collections =
    data && data.collections && Object.keys(data.collections).length
      ? data.collections
      : { [DEFAULT_COLL]: { name: DEFAULT_COLL_NAME, pos: 0 } };
  const first = sortedColls(collections)[0].collId;
  for (const o of Object.values(orders)) if (!collections[o.coll]) o.coll = first;
  return { orders, collections };
}

function manifest(collections) {
  return {
    id: "org.customwatchorder",
    version: "3.5.0",
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
    // One row per collection, in the user's chosen order.
    catalogs: sortedColls(collections).map((c) => ({
      type: "series", id: catalogIdOf(c.collId), name: c.name, extra: [{ name: "search", isRequired: false }],
    })),
  };
}

async function catalog(orders, collId, extra = {}) {
  const search = extra.search ? extra.search.toLowerCase() : null;
  const entries = await Promise.all(
    Object.keys(orders).filter((oid) => orders[oid].coll === collId).map(async (oid) => {
      const o = orders[oid];
      try {
        // Movie card: shows the film's own poster/title, sits in the same row.
        if (o.kind === "movie") {
          const mv = await getCinemeta("movie", o.imdbId);
          const label = o.name || mv.name;
          if (search && !label.toLowerCase().includes(search)) return null;
          return { pos: posOf(o), meta: { id: `cwo:${oid}`, type: "series", name: label, poster: mv.poster, posterShape: "poster" } };
        }
        const cm = await getCinemetaSeries(o.imdbId);
        const label = `${cm.name} · ${o.name}`;
        if (search && !label.toLowerCase().includes(search)) return null;
        return { pos: posOf(o), meta: { id: `cwo:${oid}`, type: "series", name: label, poster: cm.poster, posterShape: "poster" } };
      } catch {
        return null;
      }
    })
  );
  const clean = entries.filter(Boolean);
  // Manual position first; name is the tiebreaker (and the default before any
  // reorder, since un-positioned orders all share NO_POS).
  clean.sort((a, b) => a.pos - b.pos || byName(a.meta.name, b.meta.name));
  return { metas: clean.map((e) => e.meta) };
}

async function meta(orders, id) {
  const oid = id.replace(/^cwo:/, "");
  const o = orders[oid];
  if (!o) return { meta: null };
  // Movie card: a one-item "series" whose single video is the real movie id,
  // so the user's stream addons resolve it (verified). One extra click to play.
  if (o.kind === "movie") {
    const mv = await getCinemeta("movie", o.imdbId);
    return {
      meta: {
        id, type: "series", name: o.name || mv.name,
        poster: mv.poster, posterShape: mv.posterShape || "poster", background: mv.background,
        logo: mv.logo, description: mv.description, releaseInfo: mv.releaseInfo || mv.year,
        genres: mv.genres || mv.genre,
        videos: [{
          id: o.imdbId, title: `▶ ${mv.name}`, season: 1, episode: 1, number: 1,
          released: mv.released, thumbnail: mv.background || mv.poster, overview: mv.description,
        }],
      },
    };
  }
  const cm = await getCinemetaSeries(o.imdbId);
  const byKey = {};
  for (const v of cm.videos || []) byKey[`${v.season}:${v.episode}`] = v;
  // Build videos in order. Numbering is by final position (contiguous 1..N),
  // renumbered into a single fake season so Stremio shows our exact sequence.
  const videos = [];
  for (const entry of o.order || []) {
    const n = videos.length + 1;
    if (Array.isArray(entry)) {
      const [season, episode] = entry;
      const src = byKey[`${season}:${episode}`];
      if (!src) continue;
      videos.push({
        id: `${o.imdbId}:${season}:${episode}`,
        title: `#${n} · S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} — ${src.name}`,
        season: 1, episode: n, number: n,
        released: src.released, thumbnail: src.thumbnail, overview: src.overview || src.description,
      });
    } else if (entry && entry.k === "m" && entry.id) {
      let mv;
      try { mv = await getCinemeta("movie", entry.id); } catch { continue; }
      videos.push({
        id: entry.id, // bare tt id — resolves streams under type=series (see header)
        title: `#${n} · 🎬 ${mv.name}`,
        season: 1, episode: n, number: n,
        released: mv.released, thumbnail: mv.background || mv.poster, overview: mv.description,
      });
    }
  }
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

    const getData = async () => normalizeData(userId ? await env.ORDERS_KV.get(userId, "json") : snapshot);
    const putData = async ({ orders, collections }) => env.ORDERS_KV.put(userId, JSON.stringify({ v: 3, orders, collections }));

    try {
      // Configure page (static asset, canonical /configure).
      if (path === "/" || path === "/configure" || path === "/configure/") {
        track(env, "configure", userId, mode);
        return env.ASSETS.fetch(new Request(new URL("/configure", url.origin), request));
      }

      // Cinemeta proxies (no id needed).
      if (path === "/api/search") {
        const q = (url.searchParams.get("q") || "").trim();
        const type = url.searchParams.get("type") === "movie" ? "movie" : "series";
        if (!q) return json({ results: [] });
        const r = await fetch(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(q)}.json`);
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
        const { orders, collections } = await getData();
        const list = await Promise.all(
          Object.keys(orders).map(async (oid) => {
            const o = orders[oid];
            const kind = o.kind === "movie" ? "movie" : "series";
            let cinemetaName = o.imdbId, poster = null;
            try { const c = await getCinemeta(kind, o.imdbId); cinemetaName = c.name; poster = c.poster; } catch {}
            return { orderId: oid, imdbId: o.imdbId, kind, cinemetaName, poster, name: o.name, order: o.order || [], count: (o.order || []).length, pos: posOf(o), coll: o.coll };
          })
        );
        // Same order the catalog uses, so the chips match Stremio.
        list.sort((a, b) => a.pos - b.pos || byName(`${a.cinemetaName} · ${a.name}`, `${b.cinemetaName} · ${b.name}`));
        const colls = sortedColls(collections).map((c) => ({ collId: c.collId, name: c.name, catalogId: catalogIdOf(c.collId) }));
        return json({ orders: list, collections: colls });
      }
      if (path === "/api/order" && request.method === "POST") {
        if (!userId) return json({ error: "no user id" }, 400);
        const body = await request.json().catch(() => ({}));
        const isMovie = body.kind === "movie";
        if (!body.imdbId || (!isMovie && !Array.isArray(body.order))) return json({ error: "imdbId and order[] required" }, 400);
        const data = await getData();
        const { orders, collections } = data;
        const oid = body.orderId || `${body.imdbId}-${Math.random().toString(36).slice(2, 8)}`;
        const prev = orders[oid] || {};
        // Requested collection, else the one it was already in, else the first row.
        const coll = collections[body.coll] ? body.coll : collections[prev.coll] ? prev.coll : sortedColls(collections)[0].collId;
        orders[oid] = isMovie
          ? { kind: "movie", imdbId: body.imdbId, name: body.name || body.imdbId, order: [], coll }
          : { imdbId: body.imdbId, name: body.name || body.imdbId, order: body.order, coll };
        // Keep manual position across edits, unless it moved to another collection.
        if (typeof prev.pos === "number" && prev.coll === coll) orders[oid].pos = prev.pos;
        await putData(data);
        track(env, "save", userId, mode);
        return json({ ok: true, orderId: oid });
      }
      if (path === "/api/order/reorder" && request.method === "POST") {
        if (!userId) return json({ error: "no user id" }, 400);
        const body = await request.json().catch(() => ({}));
        if (!Array.isArray(body.orderIds)) return json({ error: "orderIds[] required" }, 400);
        const data = await getData();
        // Assign pos by the sequence sent; unknown ids are ignored.
        body.orderIds.forEach((oid, i) => { if (data.orders[oid]) data.orders[oid].pos = i; });
        await putData(data);
        return json({ ok: true });
      }
      if (path === "/api/order/delete" && request.method === "POST") {
        if (!userId) return json({ error: "no user id" }, 400);
        const body = await request.json().catch(() => ({}));
        if (!body.orderId) return json({ error: "orderId required" }, 400);
        const data = await getData();
        delete data.orders[body.orderId];
        await putData(data);
        return json({ ok: true });
      }
      // Create (no collId) or rename a collection.
      if (path === "/api/collection" && request.method === "POST") {
        if (!userId) return json({ error: "no user id" }, 400);
        const body = await request.json().catch(() => ({}));
        const name = cleanName(body.name, 60);
        if (!name) return json({ error: "name required" }, 400);
        const data = await getData();
        const { collections } = data;
        let collId = body.collId;
        if (collId && collections[collId]) collections[collId].name = name;
        else {
          if (Object.keys(collections).length >= MAX_COLLS) return json({ error: "too many collections" }, 400);
          collId = `c${Math.random().toString(36).slice(2, 8)}`;
          const maxPos = Math.max(-1, ...Object.values(collections).map((c) => (typeof c.pos === "number" ? c.pos : -1)));
          collections[collId] = { name, pos: maxPos + 1 };
        }
        await putData(data);
        return json({ ok: true, collId });
      }
      // Delete a collection; its orders move to `moveTo` (or the first other row).
      if (path === "/api/collection/delete" && request.method === "POST") {
        if (!userId) return json({ error: "no user id" }, 400);
        const body = await request.json().catch(() => ({}));
        const data = await getData();
        const { orders, collections } = data;
        if (!collections[body.collId]) return json({ error: "unknown collection" }, 400);
        const others = sortedColls(collections).filter((c) => c.collId !== body.collId);
        if (!others.length) return json({ error: "can't delete the last collection" }, 400);
        const target = others.some((c) => c.collId === body.moveTo) ? body.moveTo : others[0].collId;
        for (const o of Object.values(orders)) if (o.coll === body.collId) { o.coll = target; delete o.pos; }
        delete collections[body.collId];
        await putData(data);
        return json({ ok: true, movedTo: target });
      }
      // Whole board layout from the configure page in ONE write: row order of
      // collections + which collection each order is in + order within it.
      if (path === "/api/layout" && request.method === "POST") {
        if (!userId) return json({ error: "no user id" }, 400);
        const body = await request.json().catch(() => ({}));
        if (!Array.isArray(body.collections)) return json({ error: "collections[] required" }, 400);
        const data = await getData();
        const { orders, collections } = data;
        body.collections.forEach((c, i) => {
          if (!c || !collections[c.collId]) return; // unknown ids are ignored
          collections[c.collId].pos = i;
          (Array.isArray(c.orderIds) ? c.orderIds : []).forEach((oid, j) => {
            if (orders[oid]) { orders[oid].coll = c.collId; orders[oid].pos = j; }
          });
        });
        await putData(data);
        return json({ ok: true });
      }

      // Addon routes.
      const { orders, collections } = await getData();
      if (path === "/manifest.json") { track(env, "manifest", userId, mode); return json(manifest(collections)); }

      const cat = path.match(/^\/catalog\/series\/([^/]+?)(?:\/(.+))?\.json$/);
      if (cat) {
        const extra = {};
        if (cat[2]) cat[2].split("&").forEach((kv) => { const i = kv.indexOf("="); if (i > -1) extra[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
        track(env, "catalog", userId, mode);
        // A stale cached manifest may still ask for a deleted collection: empty row.
        const coll = sortedColls(collections).find((c) => catalogIdOf(c.collId) === cat[1]);
        return json(coll ? await catalog(orders, coll.collId, extra) : { metas: [] });
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
