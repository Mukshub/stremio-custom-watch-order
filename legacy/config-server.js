// ============================================================================
//  Configure-page backend. STATELESS now — no saving. Serves the drag page and
//  two read-only Cinemeta proxies the page uses (search shows, list episodes).
//  Orders themselves live in the install URL, built entirely client-side.
//
//  handleConfigRequest returns true if it handled the request, else false so
//  index.js can fall through to the addon routes.
//  `path` is the config-stripped pathname (e.g. "/configure", "/api/search").
// ============================================================================

const fs = require("fs");
const path = require("path");
const { getCinemetaSeries } = require("./cinemeta");

const CINEMETA = "https://v3-cinemeta.strem.io";

function sendJSON(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
  return true;
}

async function handleConfigRequest(req, res, reqPath) {
  const url = new URL(req.url, "http://localhost");
  const p = reqPath || url.pathname;

  // --- the configure page (works with or without a config prefix) ---
  if (p === "/configure" || p === "/configure/" || p === "/" ) {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "configure.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  }

  if (!p.startsWith("/api/")) return false;

  try {
    // Search Cinemeta for a series to configure.
    if (p === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return sendJSON(res, 200, { results: [] });
      const r = await fetch(
        `${CINEMETA}/catalog/series/top/search=${encodeURIComponent(q)}.json`
      );
      const j = await r.json();
      const results = (j.metas || [])
        .slice(0, 20)
        .map((m) => ({ imdbId: m.id, name: m.name, poster: m.poster }));
      return sendJSON(res, 200, { results });
    }

    // Full episode list for a show (used to populate the drag columns).
    if (p === "/api/episodes") {
      const imdbId = url.searchParams.get("imdb");
      if (!imdbId) return sendJSON(res, 400, { error: "missing imdb" });
      const cm = await getCinemetaSeries(imdbId);
      const episodes = (cm.videos || [])
        .filter((v) => v.season > 0)
        .map((v) => ({
          season: v.season,
          episode: v.episode,
          title: v.name,
          thumbnail: v.thumbnail,
        }))
        .sort((a, b) => a.season - b.season || a.episode - b.episode);
      return sendJSON(res, 200, { imdbId, name: cm.name, poster: cm.poster, episodes });
    }

    return sendJSON(res, 404, { error: "unknown api route" });
  } catch (e) {
    console.error("[api] error:", e.message);
    return sendJSON(res, 500, { error: e.message });
  }
}

module.exports = { handleConfigRequest };
