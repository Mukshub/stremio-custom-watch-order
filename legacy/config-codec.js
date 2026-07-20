// ============================================================================
//  Config codec — the user's orders travel inside the install URL as a
//  URL-safe base64 segment. Stateless: the server stores nothing.
//
//  Config shape:
//    { v: 1, shows: { "tt0903747": { name: "...", order: [[s,e], ...] } } }
//
//  MUST stay byte-for-byte compatible with the encode/decode in configure.html
//  (browser side), so keep both in sync if you change the format.
// ============================================================================

function toB64Url(str) {
  const b64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(str, "utf8").toString("base64")
      : btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(seg) {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  return typeof Buffer !== "undefined"
    ? Buffer.from(b64, "base64").toString("utf8")
    : decodeURIComponent(escape(atob(b64)));
}

function encodeConfig(cfg) {
  return toB64Url(JSON.stringify(cfg));
}

function decodeConfig(seg) {
  if (!seg) return { v: 1, shows: {} };
  try {
    const o = JSON.parse(fromB64Url(seg));
    return o && o.shows ? o : { v: 1, shows: {} };
  } catch {
    return { v: 1, shows: {} };
  }
}

module.exports = { encodeConfig, decodeConfig, toB64Url, fromB64Url };
