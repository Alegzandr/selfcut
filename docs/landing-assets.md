# Landing assets - how to regenerate them

The landing shows the editor twice over: as a **replica** built from the app's
own tokens and dictionaries, and as **stills of a real edit**. Both are
regenerable, on purpose - a landing whose picture of the product has gone stale
is the failure mode this setup exists to avoid.

## What lives where

| Asset | What it is | Regenerate when |
|---|---|---|
| `src/components/landing/Editor.astro` | The replica: chrome, timeline, inspector | The editor's chrome changes shape |
| `src/landing/icons.ts` | Radix icon bodies the replica draws with | `@radix-ui/react-icons` is upgraded |
| `src/styles/landing.css` `:root` | The app's Tailwind zinc/sky values, spelled out | Tailwind's palette moves, or the app's accent changes |
| `public/landing/*.webp` | Frames and waveform from a real edit | New footage, or a different look wanted |
| `public/og-image.jpg` | The share card, shot from `/og/` | Any of the above changes |

Labels inside the replica are **not** in this list: they are read from
`src/i18n/locales/*.json`, the editor's own dictionaries, so they follow the app
and translate into all five languages by themselves. See
`src/landing/appStrings.ts`.

## The footage

The frames come from one screen recording of a gameplay session, which is the
short-form use case the product is aimed at. Crops are chosen to keep player
names and the kill feed out of frame; check any new crop for the same thing.

```sh
V="path/to/footage.mp4"

# Monitor shots. The replica cuts between these three as the playhead crosses
# the three clips on V1, so they must be in the same order as the filmstrips.
for t in 16 36 73; do
  ffmpeg -y -ss $t -i "$V" -frames:v 1 \
    -vf "crop=iw*0.82:ih*0.82:iw*0.12:ih*0.17,scale=960:540:flags=lanczos" \
    -q:v 65 "public/landing/monitor-$t.webp"
done

# Filmstrips: six 16:9 tiles side by side, tiled by the clip as background-repeat,
# which is how the app's own Filmstrip lays thumbnails out.
ffmpeg -y -ss 14 -t 6 -i "$V" \
  -vf "fps=1,scale=170:96:flags=lanczos,tile=6x1" -frames:v 1 \
  -q:v 62 public/landing/strip-a.webp

# The audio clip's waveform, from the footage's own audio, in the emerald the
# app draws waveforms in. yuva420p keeps the alpha so it sits over the clip body.
ffmpeg -y -ss 20 -t 30 -i "$V" -filter_complex \
  "[0:a]aformat=channel_layouts=mono,showwavespic=s=1600x120:colors=0x6ee7b7,format=rgba" \
  -frames:v 1 -pix_fmt yuva420p -q:v 72 public/landing/waveform.webp
```

`monitor-*.webp` filenames carry their timestamp and are referenced from
`Editor.astro`; renaming one means editing that file too.

## The share card

`src/pages/og.astro` renders the card at 1200×630 from the same replica. With
the dev server running:

```sh
npx playwright screenshot --viewport-size=1200,630 --wait-for-timeout=1500 \
  http://localhost:5173/og/ public/og-image.png
ffmpeg -y -i public/og-image.png -q:v 4 public/og-image.jpg && rm public/og-image.png
```

The page carries `noindex` and is absent from the sitemap: it is an asset
source, not a page.

## The icon sprite

`src/landing/icons.ts` holds the inner markup of each 15×15 Radix icon the
replica uses. To refresh it, render the components and strip the outer `<svg>`:

```js
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Icons from '@radix-ui/react-icons';

const html = renderToStaticMarkup(createElement(Icons.ViewVerticalIcon))
  .replace(/^<svg[^>]*>/, '')
  .replace(/<\/svg>$/, '');
```
