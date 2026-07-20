// ============================================================================
//  Addon core — platform-agnostic logic. Pure async functions that take the
//  decoded config + request params and return plain objects. No Node HTTP, no
//  filesystem, only global fetch — so this same file runs under Node OR an
//  edge runtime (Cloudflare Workers / Deno) behind a thin adapter.
// ============================================================================

const { getCinemetaSeries } = require("./cinemeta");

const ADDON_ID = "org.customwatchorder";
const CATALOG_ID = "cwo_catalog";

function manifest(config) {
  return {
    id: ADDON_ID,
    version: "2.0.0",
    name: "Custom Watch Order",
    description:
      "Watch series episodes in a custom order you define, instead of 1,2,3.",
    behaviorHints: { configurable: true, configurationRequired: false },
    resources: ["catalog", "meta"],
    types: ["series"],
    idPrefixes: ["cwo:"],
    catalogs: [
      {
        type: "series",
        id: CATALOG_ID,
        name: "Custom Watch Order",
        extra: [{ name: "search", isRequired: false }],
      },
    ],
  };
}

async function catalog(config, extra = {}) {
  const shows = (config && config.shows) || {};
  const search = extra.search ? extra.search.toLowerCase() : null;
  const metas = await Promise.all(
    Object.keys(shows).map(async (imdbId) => {
      try {
        const cm = await getCinemetaSeries(imdbId);
        if (search && !cm.name.toLowerCase().includes(search)) return null;
        return {
          id: `cwo:${imdbId}`,
          type: "series",
          name: `${cm.name} (Custom Order)`,
          poster: cm.poster,
          posterShape: "poster",
        };
      } catch {
        return null;
      }
    })
  );
  return { metas: metas.filter(Boolean) };
}

async function meta(config, id) {
  const imdbId = id.replace(/^cwo:/, "");
  const shows = (config && config.shows) || {};
  const entry = shows[imdbId];
  if (!entry) return { meta: null };

  const cm = await getCinemetaSeries(imdbId);
  const videos = buildOrderedVideos(cm, entry.order || [], imdbId);

  // Clean meta only — Stremio's core parser rejects unknown/odd fields.
  return {
    meta: {
      id,
      type: "series",
      name: `${cm.name} — ${entry.name || "Custom Order"}`,
      poster: cm.poster,
      posterShape: cm.posterShape || "poster",
      background: cm.background,
      logo: cm.logo,
      description: cm.description,
      releaseInfo: cm.releaseInfo,
      genres: cm.genres || cm.genre,
      videos,
    },
  };
}

// Reorder + renumber: keep the REAL episode id (so streams resolve) but
// present as season 1 / episode 1,2,3… to force Stremio's display order.
function buildOrderedVideos(cm, order, imdbId) {
  const byKey = {};
  for (const v of cm.videos || []) byKey[`${v.season}:${v.episode}`] = v;
  return order
    .map(([season, episode], i) => {
      const src = byKey[`${season}:${episode}`];
      if (!src) return null;
      return {
        id: `${imdbId}:${season}:${episode}`,
        title: `#${i + 1} · S${String(season).padStart(2, "0")}E${String(
          episode
        ).padStart(2, "0")} — ${src.name}`,
        season: 1,
        episode: i + 1,
        number: i + 1,
        released: src.released,
        thumbnail: src.thumbnail,
        overview: src.overview || src.description,
      };
    })
    .filter(Boolean);
}

module.exports = { manifest, catalog, meta, buildOrderedVideos, CATALOG_ID };
