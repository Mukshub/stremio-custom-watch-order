// ============================================================================
//  Plumbing — fetches real series metadata from Cinemeta (Stremio's default
//  metadata provider) and caches it in memory so we don't hammer it.
//
//  Cinemeta series meta endpoint:
//    https://v3-cinemeta.strem.io/meta/series/<imdbId>.json
//  Returns: { meta: { id, name, poster, ..., videos: [ {id, season, episode,
//                     title, released, thumbnail, overview}, ... ] } }
// ============================================================================

const CINEMETA = "https://v3-cinemeta.strem.io";
const cache = new Map(); // imdbId -> meta object

async function getCinemetaSeries(imdbId) {
  if (cache.has(imdbId)) return cache.get(imdbId);

  const url = `${CINEMETA}/meta/series/${imdbId}.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Cinemeta ${res.status} for ${imdbId}`);
  }
  const json = await res.json();
  if (!json || !json.meta) {
    throw new Error(`Cinemeta returned no meta for ${imdbId}`);
  }

  cache.set(imdbId, json.meta);
  return json.meta;
}

module.exports = { getCinemetaSeries };
