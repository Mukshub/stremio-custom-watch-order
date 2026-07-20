# Demo assets

Two demo GIFs are embedded in the main [`../README.md`](../README.md).

- **demo-configure.gif** — building an order on the configure page (640px,
  ~12fps, ~15s, ~2.9 MB). The intro/search frames have the personal install
  link blurred. Committed.
- **demo-stremio.gif** — the order playing in Stremio: catalog → custom-order
  episode list → streams → playback (640px, ~12fps, ~14s, ~2.1 MB). Committed.
- The raw source recordings (`*.mp4`) and any render scratch (`_*`) are
  **gitignored** — they'd bloat the repo. Keep the sources locally if you want
  to re-edit.

## How the current GIF was built

Jump-cut edit from the raw screen recording using ffmpeg: selected segments are
trimmed and concatenated, the intro/search segments have the personal install
link (`/u/<id>/`) **blurred** (it's a private key — never publish it), then the
whole thing is sped up ~1.4x and encoded with a generated palette.

Rough recipe (a single `filter_complex`):

```
# per kept segment:  trim=start=A:end=B,setpts=PTS-STARTPTS
# blur the link box on top-of-page segments:
#   split[a][b];[b]crop=838:60:74:190,gblur=sigma=24[bb];[a][bb]overlay=74:190
# join:   concat=n=N:v=1:a=0
# finish: setpts=PTS/1.4,fps=12,scale=640:-1:flags=lanczos + palettegen/paletteuse
```

⚠️ If you re-record, the install-link blur region (`crop=838:60:74:190`) assumes
the page is scrolled to the top at 1280x720. Re-check it, and verify a frame
before publishing so the `/u/<id>/` secret is never readable.
