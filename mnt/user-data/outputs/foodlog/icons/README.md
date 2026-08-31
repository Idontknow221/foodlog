# icons/

`manifest.json` references three icon files that are **not included** here
(this is a code-only deliverable — no binary image generation):

- `icon-192.png` — 192×192, `purpose: "any"`
- `icon-512.png` — 512×512, `purpose: "any"`
- `icon-maskable-512.png` — 512×512, `purpose: "maskable"` (keep the visual
  subject inside the center ~80% safe zone; the outer ring may be cropped by
  the OS mask)

## Quick way to generate them

Any square PNG works as a starting point. From the project root, with
ImageMagick installed:

```bash
convert source.png -resize 192x192 icons/icon-192.png
convert source.png -resize 512x512 icons/icon-512.png
convert source.png -resize 512x512 -gravity center -extent 640x640 -resize 512x512 icons/icon-maskable-512.png
```

Until real files are added here, `manifest.json`'s icon entries will simply
404 — this does not block the app shell, Service Worker install, or any core
offline functionality; it only affects the "Add to Home Screen" icon quality.
