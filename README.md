# Cutbay

A 100% client-side video editor. No backend, no upload — your media never leaves the device. Decoding, compositing and encoding all happen in the browser through **WebCodecs** and **[mediabunny](https://mediabunny.dev)**.

```bash
npm i
npm run dev
```

Requires a browser with WebCodecs (recent Chrome/Edge, Safari 16.4+). A clean explanation screen is shown otherwise.

## Features (MVP)

- Multi-file import (picker + drag & drop), metadata and thumbnail extraction
- **Media library** (source explorer): imports land there; add assets to the timeline or remove them from the panel
- Unlimited video/audio tracks, vertically reorderable, per-track mute/hide
- Timeline: horizontal scroll + zoom (buttons, mouse wheel, pinch on mobile), scrubbable playhead, **snapping** to clip edges and the playhead
- **Split** at playhead, **move** (in time and across tracks), **trim** with handles, delete
- Per-clip volume (0–2), speed (0.5× / 1× / 2× + free entry), fade in/out (video opacity to black, audio gain)
- Crop + position + scale set in the inspector
- 16:9 ↔ 9:16 toggle: preview and export presets reconfigure
- Real-time preview with synchronized audio
- Export presets:
  - **YouTube 16:9** — 1920×1080 @ 60, H.264 ~12 Mbps, AAC 192 kbps, MP4 fast start
  - **TikTok 9:16** — 1080×1920 @ 60, H.264 ~10 Mbps, AAC 192 kbps, MP4 fast start
  - **MP3** — full mix, 320 kbps

## Architecture

Two strictly separate pipelines:

1. **Preview (real time)** — `src/preview/`. A `requestAnimationFrame` loop draws the visible video frames for the current time onto a canvas (crop, position, scale, `globalAlpha` for fades, black background). Audio goes through a Web Audio graph: one `GainNode` per clip (volume + fade ramps), `playbackRate` for speed. Frames may be dropped on slower devices — audio stays the clock.
2. **Export (offline, in a Web Worker)** — `src/export/exportWorker.ts`. Iterates frame by frame at 60 fps (`PROJECT_FPS`), maps output time to source time, decodes with mediabunny `Input` + `VideoSampleSink`, composites on an `OffscreenCanvas`, pushes into a `CanvasSource` (H.264). The audio mix is rendered on the main thread with an `OfflineAudioContext` (Web Audio is unavailable in workers), transferred to the worker as raw channels and encoded there (AAC for MP4, MP3 for the MP3 preset). Muxing via `Output` + `Mp4OutputFormat`/`Mp3OutputFormat` with fast start; progress is posted back and the resulting Blob is downloaded.

AAC/MP3 encoders are feature-detected (`canEncodeAudio`); when the native WebCodecs encoder is missing, `@mediabunny/aac-encoder` / `@mediabunny/mp3-encoder` (WASM) are registered as fallbacks.

### Data model

See `src/types.ts`. A clip's timeline duration is `(sourceOutMs - sourceInMs) / speed`; export maps `sourceTime = sourceInMs + (t - timelineStartMs) * speed`. Video z-order = track order (last track on top); audio tracks are mixed together.

### Layout

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
```

## Decisions made along the way

- **`Cutbay` is a constant** — `APP_NAME` in `src/app/config.ts`.
- **Undo/redo** snapshots the whole project (small plain object). Drag gestures are wrapped in a transaction (`beginGesture`/`endGesture`) so one drag = one history entry. History capped at 50 entries.
- **Import goes to the media library**, not straight to the timeline. From the library, "Add to timeline" appends the asset at the end of the first track of the matching kind (created if needed). Removing an asset also removes its clips; if an undo later restores clips whose asset is gone, they simply render nothing (all asset lookups are guarded).
- **Overlaps are allowed** within a track; at a given time the latest-starting clip wins. Keeping it permissive avoids fighting the user during drags.
- **Track reordering** uses up/down buttons in the track header (simpler and more reliable than vertical drag on mobile).
- **Transform semantics**: crop is normalized over the source; the cropped region is "contain"-fitted into the output, then scaled by `scale` and centered at (`x`, `y`) in normalized output coordinates. Default = centered, fit, no crop.
- **Wheel = zoom** on the timeline (anchored at the cursor); horizontal panning via drag/trackpad/scrollbar. Pinch zoom on touch.
- **Preview renders at half the export resolution** — sharp on screen, cheaper to composite.
- **Audio decode strategy**: each asset's audio track is decoded once into a full `AudioBuffer` (memoized). Simple and instant to schedule; the trade-off is memory (~23 MB per stereo minute), fine for short-form editing this MVP targets.
- **Speed does not preserve pitch** (plain `playbackRate`), as scoped.
- **Video-with-audio clips** carry their own audio; dedicated audio tracks host audio files. Splitting audio from a video clip is out of scope for v1.
- The export worker bundle is large (~1.8 MB) because the WASM AAC/MP3 fallback encoders are inlined; it only loads when an export starts.

## Out of scope (v1)

Text/titles, filters, transitions other than fades, keyframes, HDR, pitch preservation, multi-project, waveforms, autosave, direct-manipulation crop handles on the preview. The data model already accommodates several of these.

## Deploying to GitHub Pages

The repo ships with `.github/workflows/deploy.yml`: on every push to `main` it builds (`npm ci && npm run build`) and publishes `dist/` via `actions/upload-pages-artifact` + `actions/deploy-pages`.

1. Push the repo to GitHub under the name **`cutbay`**.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main` — the site appears at `https://<user>.github.io/cutbay/`.

If your repo has a different name, change `BASE_PATH` in `vite.config.ts` (or set the `VITE_BASE` env var at build time).

Notes:

- GitHub Pages serves over HTTPS, which satisfies WebCodecs' secure-context requirement.
- No custom headers are needed — Cutbay uses WebCodecs, not ffmpeg.wasm, so no COOP/COEP.
- The build copies `index.html` to `404.html` as an SPA fallback.

## License

MIT
