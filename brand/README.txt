Custom Watch Order — brand assets
=================================

logo.png = the MASTER copy of the addon logo (256x256 PNG recommended,
square, transparent background, reads on a dark surface).

This folder is NOT served to the web. It's just a safe backup / source
of truth so you always have the original.

--------------------------------------------------------------------
TO CHANGE THE LOGO
--------------------------------------------------------------------
1. Drop your new image here as brand/logo.png (keep the master updated).
2. Copy it into the served folder:
      cp brand/logo.png public/logo.png
3. Redeploy:
      npx wrangler pages deploy public --project-name stremio-custom-order --branch main --commit-dirty=true

That's it. The SAME public/logo.png powers all three places:
  - the Stremio addons list  (manifest "logo" field in public/_worker.js)
  - the configure web page header  (img src="/logo.png")
  - the browser tab favicon  (link rel="icon")

So there's only one file to replace. Note Stremio caches manifests —
remove & re-add the addon to see a new logo there.
