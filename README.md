# SelfCut

**A video editor that runs entirely in your browser. Nothing is uploaded.**

👉 **[selfcut.alegzandr.com](https://selfcut.alegzandr.com)** · no account, no install, free

## What it is

Drop your rushes in, cut them, export a finished video. Import, decoding,
compositing and encoding all happen on your own machine: your files never leave
the device, and there is no server to send them to.

Built for short-form editing: a talking head, a few B-roll shots, some music,
out to YouTube or TikTok in a couple of minutes.

## What you can do

- **Drop in anything.** Video (MP4, MOV, WebM, MKV, TS, 3GP), audio (MP3, WAV,
  Ogg, FLAC, AAC), images (PNG, JPEG, WebP, GIF, AVIF, SVG) and subtitle files
  (SRT, VTT, ASS) as caption clips. Drop five files at once and you get a rough
  cut immediately.
- **Cut on a real timeline.** Split at the playhead, trim with handles, drag
  clips in time and between tracks, with snapping to edges and playhead.
  Unlimited video and audio tracks, reorderable, each mutable or hideable.
- **Adjust each clip.** Volume, speed (0.5× to 2× or free entry), fade in/out,
  crop, position and scale, all in the inspector.
- **Watch it live.** Real-time preview with synced audio; the picture sharpens
  to full resolution as soon as you stop scrubbing.
- **Switch format.** One toggle flips the project between 16:9 and 9:16.
- **Export.** YouTube 16:9, TikTok/Reels/Shorts 9:16, Instagram 1:1 and 4:5
  (H.264 + AAC MP4, 720p to 4K), or MP3 for the audio mix alone.

Also there: text and titles, waveforms, undo/redo, autosave, and a media
library that keeps every import at hand.

Interface available in English, French, German, Spanish and Brazilian
Portuguese.

## Requirements

A recent Chrome, Edge or Safari 16.4+ (SelfCut needs the WebCodecs API). Other
browsers get a clear explanation screen instead of a broken editor. Everything
is local, so a faster machine means a faster export.

Your project is saved in the browser, on your device. Clearing site data clears
the project.

---

# Notes for developers

```bash
npm i
npm run dev      # Vite dev server
npm run test     # vitest
npm run typecheck
npm run lint     # oxlint
npm run build    # tsc + vite build + SPA fallback
```

## Two pages, one build

The site is an MPA: a static SEO landing at `/` (`index.html`) and the editor
SPA at `/app/` (`app/index.html`). Both are declared as Rollup inputs in
`vite.config.ts`.

## Two strictly separate pipelines

1. **Preview (real time)** · `src/preview/`. A `requestAnimationFrame` loop
   draws the visible frames for the current time onto a canvas (crop, position,
   scale, `globalAlpha` for fades). Audio runs through a Web Audio graph: one
   `GainNode` per clip, `playbackRate` for speed. Frames may drop on slower
   machines; audio stays the clock.
2. **Export (offline, in a Web Worker)** · `src/export/exportWorker.ts`.
   Iterates frame by frame at `PROJECT_FPS` (60), maps output time to source
   time, decodes with mediabunny `Input` + `VideoSampleSink`, composites on an
   `OffscreenCanvas` and pushes into a `CanvasSource` (H.264). The audio mix is
   rendered on the main thread with an `OfflineAudioContext` (Web Audio is
   unavailable in workers), transferred as raw channels and encoded in the
   worker. Muxing via `Output` + `Mp4OutputFormat`/`Mp3OutputFormat` with fast
   start.

AAC/MP3 encoders are feature-detected (`canEncodeAudio`); when the native
WebCodecs encoder is missing, `@mediabunny/aac-encoder` /
`@mediabunny/mp3-encoder` (WASM) are registered as fallbacks. That is why the
export worker bundle is large (~1.8 MB); it only loads when an export starts.

## Data model

See `src/types.ts`. A clip's timeline duration is
`(sourceOutMs - sourceInMs) / speed`; export maps
`sourceTime = sourceInMs + (t - timelineStartMs) * speed`. Video z-order =
track order (last track on top); audio tracks are mixed together.

## Layout

```
src/
  app/        app-wide constants (APP_NAME, fps, zoom bounds…)
  store/      Zustand store, undo/redo (gesture-based transactions)
  media/      mediabunny wrappers: probing, thumbnails, decode caches
  preview/    real-time compositor + Web Audio graph
  export/     export worker, presets, main-thread orchestrator
  timeline/   timeline UI (ruler, tracks, clips, snapping, playhead)
  inspector/  selected-clip bottom sheet
  ui/         top bar, transport, toasts, import, unsupported screen
  i18n/       locales (en, fr, de, es, pt-BR)
```

## Decisions made along the way

- **`SelfCut` is a constant** · `APP_NAME` in `src/app/config.ts`.
- **Undo/redo** snapshots the whole project (small plain object). Drag gestures
  are wrapped in a transaction (`beginGesture`/`endGesture`) so one drag = one
  history entry. History capped at 50 entries.
- **Import lands in the media library AND on the timeline.** A video carrying
  audio lands as an A/V-linked group: the picture on a video track, and *every*
  decodable source audio track split onto its own lane, all tied by a shared
  `linkId`. Each audio clip addresses its source track via `Clip.audioTrackIndex`,
  so a file multiplexing VO + dub + commentary explodes into one clip per track.
  Removing an asset removes its clips; if undo restores clips whose asset is
  gone they render nothing (all asset lookups are guarded).
- **A/V linking**: linked clips move, trim, split, delete and duplicate
  together; the video side delegates its audio to the linked clip so the source
  is never doubled. Split gives each half a fresh shared link; copy/paste drops
  the link. **Unlink** breaks the pair and mutes the video side (volume 0).
  **Link** re-forms one: select a video and an audio clip on opposite tracks,
  or select just one and it auto-pairs with the same-source clip.
- **Overlaps are allowed** within a track; at a given time the latest-starting
  clip wins. Permissive beats fighting the user mid-drag.
- **Track reordering** uses up/down buttons in the track header, simpler and
  more reliable than vertical drag on mobile.
- **Transform semantics**: crop is normalized over the source; the cropped
  region is contain-fitted into the output, then scaled by `scale` and centered
  at (`x`, `y`) in normalized output coordinates.
- **Wheel = pan, Ctrl/Cmd+wheel = zoom** on the timeline (zoom anchored at the
  cursor, Vegas-style). Pinch zoom on touch.
- **Variable preview resolution** · the monitor composites at a fraction of the
  export size (Full / ½ / ¼ / ⅛, default ½), picked from the quality menu. We
  chose a manual pick over an adaptive auto so sharpness never pumps
  mid-playback; the paused still refines to full resolution once the playhead
  settles (Premiere's "Paused Resolution = Full"). Persisted under
  `selfcut.previewResolution`; export is unaffected.
- **Audio decode strategy**: each source audio track is decoded once into a
  full `AudioBuffer`, memoized per `(asset, audioTrackIndex)` so a multi-track
  video's tracks never evict one another. Instant to schedule; costs memory
  (~23 MB per stereo minute per track), fine for the short-form editing this
  targets.
- **Speed does not preserve pitch** (plain `playbackRate`), as scoped.
- **Import degrades instead of rejecting**: probing keeps whatever is usable.
  Undecodable audio tracks are skipped individually; a file whose video codec
  WebCodecs can't decode still imports as audio-only when it has decodable
  sound (the toast names the codec). Only a file with nothing decodable is
  refused.
- **Still images bypass the decoder pipeline** (`src/media/stillImage.ts`): an
  image is rasterized once into an `ImageBitmap` (SVG goes through an
  `<img>`/canvas fallback since `createImageBitmap` rejects it) and drawn
  through the same compositor path via a minimal `DrawableFrame` interface that
  mediabunny's `VideoSample` also satisfies. Export rasterizes on the main
  thread (SVG needs the DOM) and transfers the bitmaps to the worker. An image
  clip defaults to 5 s, trims without an upper bound, and slip is a no-op.
  Animated GIFs import as a still of their first frame.

## Out of scope (v1)

Filters, transitions other than fades, keyframes, HDR, pitch preservation,
multi-project. The data model already accommodates several of these.

## Deployment

`.github/workflows/deploy.yml` builds (`npm ci && npm run build`) on every push
to `main` and publishes `dist/` to GitHub Pages, served at
**selfcut.alegzandr.com** (`public/CNAME`).

- Pages serves over HTTPS, which satisfies WebCodecs' secure-context
  requirement.
- No COOP/COEP headers needed: SelfCut uses WebCodecs, not ffmpeg.wasm.
- The CSP ships as a build-time meta tag (`injectCsp` in `vite.config.ts`),
  since Pages allows no custom headers.
- `scripts/spa-fallback.mjs` copies the landing to `404.html`, so unknown paths
  show the landing instead of the default Pages 404 (still served with a 404
  status, so stray URLs are not indexed).
- `base` is `/` for the custom domain; set `VITE_BASE` to build for a
  subpath.

## License

MIT
