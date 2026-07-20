# Legacy — v2 Node dev server (archived)

> **This is not the deployed addon.** The live addon is a single Cloudflare
> Pages Worker at [`../public/_worker.js`](../public/_worker.js). This folder is
> kept only for reference/history.

## What this was

The original **v2.0.0** implementation: a hand-rolled Node `http` server for the
**stateless, config-in-URL** scheme, where a user's orders were encoded into the
install link (`/c/<base64>/manifest.json`) and the server stored nothing.

- `index.js` — Node `http` router (run with `npm start`)
- `addon-core.js` — platform-agnostic manifest / catalog / meta + `buildOrderedVideos`
- `config-codec.js` — URL-safe base64 encode/decode of the orders object
- `config-server.js` — serves the configure page + Cinemeta search/episode proxies
- `cinemeta.js` — fetch + in-memory cache of Cinemeta metadata

No npm dependencies — Node 18+ (for global `fetch`) is all it needs.

## Why it's legacy

The project moved to **v3**, which added **live sync** via Cloudflare KV (orders
stored server-side under a stable per-user id, `/u/<id>/...`) so the install link
never changes when you add or edit orders. All of that lives in the deployed
`../public/_worker.js`, which supersedes every file here.

## Caveats

- These files have **no KV and no `/u/<id>/` live-sync** — only the old `/c/`
  stateless scheme.
- The shared [`../public/configure.html`](../public/configure.html) is now the
  **v3** page (it talks to the `/u/<id>/` API), so it will **not** function fully
  against this legacy server. The `/c/` addon routes (manifest/catalog/meta)
  still work if you hand-build a config string.

To actually run the current addon locally, use the Worker runtime from the
project root instead:

```
npx wrangler pages dev public
```
