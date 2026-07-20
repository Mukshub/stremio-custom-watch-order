// ============================================================================
//  Node HTTP adapter. Stateless. URL scheme:
//    /manifest.json                              -> empty (prompts configure)
//    /configure                                  -> drag-to-reorder page
//    /c/<config>/manifest.json                   -> configured manifest
//    /c/<config>/configure                       -> page pre-filled from config
//    /c/<config>/catalog/series/cwo_catalog.json -> catalog (+ /search=Q)
//    /c/<config>/meta/series/<id>.json           -> reordered meta
//    /api/search?q= , /api/episodes?imdb=        -> Cinemeta proxies (page use)
//
//  <config> is URL-safe base64 of the orders JSON (see config-codec.js).
//  Run: npm start   (PORT from env, else 7000)
// ============================================================================

const http = require("http");
const core = require("./addon-core");
const { decodeConfig } = require("./config-codec");
const { handleConfigRequest } = require("./config-server");

function send(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  console.log(new Date().toISOString(), req.method, req.url);
  try {
    let path = new URL(req.url, "http://localhost").pathname;

    // Peel off an optional /c/<config>/ prefix.
    let config = { v: 1, shows: {} };
    const cm = path.match(/^\/c\/([^/]+)(\/.*)?$/);
    if (cm) {
      config = decodeConfig(cm[1]);
      path = cm[2] || "/";
    }

    // Configure page + Cinemeta proxies get first crack.
    if (await handleConfigRequest(req, res, path)) return;

    // Manifest
    if (path === "/manifest.json") return send(res, 200, core.manifest(config));

    // Catalog:  /catalog/series/cwo_catalog.json
    //        or /catalog/series/cwo_catalog/search=Breaking%20Bad.json
    const cat = path.match(/^\/catalog\/series\/([^/]+?)(?:\/(.+))?\.json$/);
    if (cat) {
      const extra = {};
      if (cat[2]) {
        cat[2].split("&").forEach((kv) => {
          const i = kv.indexOf("=");
          if (i > -1) extra[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
        });
      }
      return send(res, 200, await core.catalog(config, extra));
    }

    // Meta:  /meta/series/<id>.json
    const met = path.match(/^\/meta\/series\/(.+)\.json$/);
    if (met) {
      return send(res, 200, await core.meta(config, decodeURIComponent(met[1])));
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error("server error:", e);
    send(res, 500, { error: e.message });
  }
});

const PORT = process.env.PORT || 7000;
server.listen(PORT, () => {
  console.log(`Addon running on port ${PORT}`);
  console.log(`  configure: http://127.0.0.1:${PORT}/configure`);
});
