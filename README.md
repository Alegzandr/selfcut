# SelfCut

A 100% client-side video editor. No backend, no upload - your media never leaves the device. Decoding, compositing and encoding all happen in the browser through **WebCodecs** and **[mediabunny](https://mediabunny.dev)**.

```bash
npm i
npm run dev
```

Requires a browser with WebCodecs (recent Chrome/Edge, Safari 16.4+). A clean explanation screen is shown otherwise.

## Features (MVP)

- Multi-file import (picker + drag & drop), metadata and thumbnail extraction
- **Wide input support**: every container mediabunny reads (MP4/M4V/MOV, WebM/MKV, MPEG-TS `.ts/.mts/.m2ts`, 3GP, MP3, WAV, Ogg/Opus, FLAC, AAC/ADTS) with any codec the browser's WebCodecs can decode; **still images** (PNG, JPEG, WebP, GIF, AVIF, BMP, SVG) as freely stretchable clips; **subtitles** in SRT, WebVTT and SubStation Alpha (.ass/.ssa) as caption clips. A file whose video codec can't be decoded but that carries decodable audio imports as audio-only (with a warning) instead of failing
- **Media library** (source explorer): every import is registered there AND appended to the timeline (dropping five rushes gives a rough cut); from the panel you can re-add assets or remove them
- Unlimited video/audio tracks, vertically reorderable, per-track mute/hide
- Timeline: horizontal scroll + zoom (buttons, mouse wheel, pinch on mobile), scrubbable playhead, **snapping** to clip edges and the playhead
- **Split** at playhead, **move** (in time and across tracks), **trim** with handles, delete
- Per-clip volume (0–2), speed (0.5× / 1× / 2× + free entry), fade in/out (video opacity to black, audio gain)
- Crop + position + scale set in the inspector
- 16:9 ↔ 9:16 toggle: preview and export presets reconfigure
- Real-time preview with synchronized audio
- Export presets (see `src/export/presets.ts`):
  - **YouTube 16:9**, **TikTok/Reels/Shorts 9:16**, **Instagram 1:1 / 4:5** - H.264 + AAC MP4 (fast start), quality rungs from 720p to 4K, frame rate adapted to the source footage
  - **MP3** - full mix, 128/192/320 kbps

## Architecture

Two strictly separate pipelines:

1. **Preview (real time)** - `src/preview/`. A `requestAnimationFrame` loop draws the visible video frames for the current time onto a canvas (crop, position, scale, `globalAlpha` for fades, black background). Audio goes through a Web Audio graph: one `GainNode` per clip (volume + fade ramps), `playbackRate` for speed. Frames may be dropped on slower devices - audio stays the clock.
2. **Export (offline, in a Web Worker)** - `src/export/exportWorker.ts`. Iterates frame by frame at 60 fps (`PROJECT_FPS`), maps output time to source time, decodes with mediabunny `Input` + `VideoSampleSink`, composites on an `OffscreenCanvas`, pushes into a `CanvasSource` (H.264). The audio mix is rendered on the main thread with an `OfflineAudioContext` (Web Audio is unavailable in workers), transferred to the worker as raw channels and encoded there (AAC for MP4, MP3 for the MP3 preset). Muxing via `Output` + `Mp4OutputFormat`/`Mp3OutputFormat` with fast start; progress is posted back and the resulting Blob is downloaded.

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

- **`SelfCut` is a constant** - `APP_NAME` in `src/app/config.ts`.
- **Undo/redo** snapshots the whole project (small plain object). Drag gestures are wrapped in a transaction (`beginGesture`/`endGesture`) so one drag = one history entry. History capped at 50 entries.
- **Import lands in the media library AND on the timeline.** From the library, "Add to timeline" re-appends the asset at the end of the first track of the matching kind (created if needed). A **video that carries audio lands as an A/V-linked group**: the picture on a video track, and **every** decodable source audio track split onto its own audio lane, all tied to the video by a shared `linkId` (see below). A video that multiplexes several audio tracks (VO + dub, commentary, discrete channels) explodes into one linked audio clip per track, each addressing its source track via `Clip.audioTrackIndex`. Removing an asset also removes its clips; if an undo later restores clips whose asset is gone, they simply render nothing (all asset lookups are guarded).
- **Overlaps are allowed** within a track; at a given time the latest-starting clip wins. Keeping it permissive avoids fighting the user during drags.
- **Track reordering** uses up/down buttons in the track header (simpler and more reliable than vertical drag on mobile).
- **Transform semantics**: crop is normalized over the source; the cropped region is "contain"-fitted into the output, then scaled by `scale` and centered at (`x`, `y`) in normalized output coordinates. Default = centered, fit, no crop.
- **Wheel = pan, Ctrl/Cmd+wheel = zoom** on the timeline (zoom anchored at the cursor, Vegas-style; also covers trackpad pinch). Pinch zoom on touch.
- **Variable preview resolution** - the monitor composites at a fraction of the export size (Full / ½ / ¼ / ⅛, default ½), picked from the quality menu in the monitor's bottom-right corner (Vegas / Premiere convention). A lower rung composites fewer pixels; when even that can't keep up, frames are dropped with audio as the clock - the sharpness never pumps mid-playback (which is why we chose a manual pick over an adaptive "auto" that ramps resolution up and down). The **paused still refines to full resolution** once the playhead settles (draft while scrubbing so weak machines stay responsive, sharp when it stops) - Premiere's "Paused Resolution = Full". The choice persists (`selfcut.previewResolution`); export is unaffected.
- **Audio decode strategy**: each source audio track is decoded once into a full `AudioBuffer`, memoized per `(asset, audioTrackIndex)` so a multi-track video's tracks never share or evict one another's buffer. Simple and instant to schedule; the trade-off is memory (~23 MB per stereo minute per track), fine for short-form editing this MVP targets.
- **Speed does not preserve pitch** (plain `playbackRate`), as scoped.
- **A/V linking**: importing a video that has audio splits each source audio track onto its own audio clip (on its own lane), all linked to the picture by a shared `linkId` (`Clip.linkId`). Linked clips **move, trim, split, delete and duplicate together**; the video side delegates its audio to the linked audio clip (it stays silent in the mix, so the source is never doubled). Split gives each half a fresh shared link; copy/paste drops the link (a pasted clip is standalone). **Unlink** (clip menu / mobile rail) breaks the pair into independent clips: the audio stays on the audio clip and the video side is muted (volume 0) so the sound is not doubled — raise it or delete either clip freely afterwards. **Link** re-forms a pair: select a video clip and an audio clip on opposite tracks (or, with one clip selected, it auto-pairs with the same-source clip on the other track — the inverse of a prior unlink) and they share a fresh link again.
- The export worker bundle is large (~1.8 MB) because the WASM AAC/MP3 fallback encoders are inlined; it only loads when an export starts.
- **Import degrades instead of rejecting**: probing keeps whatever is usable. Undecodable audio tracks are skipped individually; a file whose video codec WebCodecs can't decode still imports as audio-only when it has decodable sound (the toast names the codec). Only a file with nothing decodable is refused.
- **Still images bypass the decoder pipeline** (`src/media/stillImage.ts`): an image asset is rasterized once into an `ImageBitmap` (SVG goes through an `<img>`/canvas fallback since `createImageBitmap` rejects it) and drawn through the same compositor path as video frames via a minimal `DrawableFrame` interface that mediabunny's `VideoSample` also satisfies. Preview caches one bitmap per asset; export rasterizes on the main thread (SVG needs the DOM) and transfers the bitmaps to the worker. An image clip has no intrinsic duration: it defaults to 5 s, trims without an upper bound, and slip is a no-op. Animated GIFs import as a still of their first frame.

## Out of scope (v1)

Filters, transitions other than fades, keyframes, HDR, pitch preservation, multi-project. The data model already accommodates several of these. (Text/titles, waveforms, autosave and preview crop handles have since shipped.)

## Deploying to GitHub Pages

The repo ships with `.github/workflows/deploy.yml`: on every push to `main` it builds (`npm ci && npm run build`) and publishes `dist/` via `actions/upload-pages-artifact` + `actions/deploy-pages`.

1. Push the repo to GitHub under the name **`selfcut`**.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main` - the site appears at `https://<user>.github.io/selfcut/`.

If your repo has a different name, change `BASE_PATH` in `vite.config.ts` (or set the `VITE_BASE` env var at build time).

Notes:

- GitHub Pages serves over HTTPS, which satisfies WebCodecs' secure-context requirement.
- No custom headers are needed - SelfCut uses WebCodecs, not ffmpeg.wasm, so no COOP/COEP.
- The build copies `index.html` to `404.html` as an SPA fallback.

## License

MIT
