# SelfCut

**A video editor that runs entirely in your browser. Nothing is uploaded.**

👉 **[selfcut.alegzandr.com](https://selfcut.alegzandr.com)** · no account, no install, free

## What it is

Drop your rushes in, cut them, export a finished video. Import, decoding,
compositing and encoding all happen on your own machine: your files never leave
the device, and there is no server to send them to.

Built for short-form editing: a talking head, a few B-roll shots, some music,
out to YouTube or TikTok in a couple of minutes. Everything past that - grading,
masks, keyframes, scopes - is there when the edit asks for it, and out of the
way when it does not.

## What you can do

**Bring it in.** Video (MP4, MOV, WebM, MKV, TS/M2TS, 3GP), audio (MP3, WAV,
Ogg, FLAC, AAC), images (PNG, JPEG, WebP, GIF, AVIF, SVG) and subtitle files
(SRT, VTT, ASS/SSA) as caption clips. Drop five files at once - or a whole
folder - and you get a rough cut immediately. Subtitles embedded in a container
can be pulled out into caption clips; audio tracks WebCodecs cannot decode
(E-AC-3, AC-3, DTS) are transcoded on demand instead of being dropped.

**Cut on a real timeline.** Split at the playhead, trim with handles, drag clips
in time and between tracks, with snapping to edges, markers and playhead.
Unlimited video and audio tracks, reorderable, each mutable, hideable or
lockable, with per-track gain, opacity and level meters. Markers, a loop region
(play it, or export just that span), undo/redo, autosave.

**Adjust each clip.** Volume, pan, mono downmix, speed, fades, crop, position,
scale, non-uniform stretch and rotation - dragged in the preview or typed in
the inspector.

**Grade.** Brightness, contrast, saturation, white balance, tint, vignette and
blur; per-channel tone curves; `.cube` LUTs imported into the project and reused
across clips; chroma key for a green screen. Waveform, RGB parade, histogram and
vectorscope to check the result.

**Animate.** Keyframes on position, scale, stretch, rotation, opacity and every
colour parameter, with easing presets or per-segment Bézier handles, edited on
property lanes under the clip. Ken Burns zoom for the quick version.

**Mask and hide.** Rectangle, ellipse or a bezier pen-tool shape, feathered and
invertible; a planar motion tracker (position, scale, rotation) writes the
motion so a mask follows what it covers. Redactions blur or pixelate a face, a
plate or a screen in place, several per clip, each tracked on its own.

**Add what is not in the footage.** Text and titles (six faces, outline, caption
pill, alignment, wrap), solid colours and gradients, drawn shapes. Nine
transitions rendered from clip overlap: dissolve, dip to black or white, four
slides, wipe, zoom.

**Mix.** Per-clip volume envelopes and audio effects - leveler, voice, bass,
reverb, echo - all native Web Audio, so preview and export sound identical.
Auto-captions transcribe the selected clips locally with Whisper (desktop only;
the model downloads once and the audio never leaves the browser). Pick the
spoken language or let it be detected, aim the pass at any audio track of the
source, and choose the model in front of what this machine can actually run -
downloads are listed and deletable. Voice focus (on by default) filters the
rumble out and evens the voice up before Whisper hears it, which is what stream
footage needs when music and game audio share the track.

**Watch it live.** Real-time preview with synced audio, decoded in a worker;
the picture sharpens to full resolution as soon as you stop scrubbing.

**Keep your work.** Projects live in the browser with a project browser to
switch between them, save to a portable `.selfcut` file (timeline and metadata,
never the media bytes), and relink their sources when the files move. Clip looks
travel as `.sfx` presets.

**Export.** YouTube 16:9, TikTok/Reels/Shorts 9:16, Instagram 1:1 and 4:5, plus
custom presets: H.264, HEVC or AV1, 720p to 4K, a 120 fps cadence, 24p cinema, a
light file for email, or MP3 for the audio mix alone. The frame rate follows the
footage unless the preset pins it.

Interface available in English, French, German, Spanish, Brazilian
Portuguese, Japanese, Simplified Chinese and Korean.

## Requirements

A recent Chrome, Edge or Safari 16.4+ (SelfCut needs the WebCodecs API). Other
browsers get a clear explanation screen instead of a broken editor. Everything
is local, so a faster machine means a faster export.

Your project is saved in the browser, on your device. Clearing site data clears
the project - save a `.selfcut` file if it matters.

---

# Notes for developers

```bash
npm i
npm run dev        # Astro dev server (port 5173)
npm run test       # vitest (unit)
npm run test:e2e   # playwright: `ui` project (parallel) + `render` (serial, real encodes)
npm run bench      # render-budget benchmarks
npm run typecheck
npm run lint       # oxlint
npm run build      # tsc + astro build
```

## Two pages, one build

The site is an Astro static build. The SEO landing ships one page per language
(`src/pages/index.astro` for French at `/`, `src/pages/[lang]/index.astro` for
`/en/`, `/es/`, `/de/`, `/pt-BR/`), assembled from `src/layouts/Landing.astro`
and the sections in `src/components/landing/`. Copy lives in
`src/landing/locales/*.json`, checked against the English key set at typecheck
time; `src/pages/404.astro` renders the same page for unknown paths.

The editor is `src/pages/app/index.astro`: a bare shell whose only script
imports `src/main.tsx`. Deliberately not an Astro island - the app mounts its
own React root - which is why that page installs Vite's React Fast Refresh
preamble by hand in dev.

Astro's own build steps live in `integrations/`: the ffmpeg core copy, the
COOP/COEP dev headers, and the sitemap.

## Two strictly separate pipelines

1. **Preview (real time)** · `src/preview/`. A `requestAnimationFrame` loop
   draws the visible frames for the current time onto a canvas (crop, position,
   scale, stretch, rotation, masks, redactions, transitions, `globalAlpha` for
   fades). Decoding happens in `frameWorker.ts`, one cursor per clip, so
   demuxing never blocks the UI thread. Colour grading is an isolated WebGL2
   pass (`colorPass.ts`) in front of the 2D compositor; without WebGL2 it
   degrades to a no-op instead of breaking playback. Audio runs through a Web
   Audio graph: one `GainNode` per clip, `playbackRate` for speed, effects as
   native nodes. Frames may drop on slower machines; audio stays the clock.
2. **Export (offline, in Web Workers)** · `src/export/`. Iterates frame by frame
   at the export rate, maps output time to source time, decodes with mediabunny
   `Input` + `VideoSampleSink`, composites on an `OffscreenCanvas` through the
   same `FrameRenderer` the preview's compositor backs, and pushes into a
   `CanvasSource`. The audio mix is rendered on the main thread with an
   `OfflineAudioContext` (Web Audio is unavailable in workers), transferred as
   raw channels and encoded in the worker. Muxing via `Output` +
   `Mp4OutputFormat`/`Mp3OutputFormat` with fast start.

The export loop is encoder-bound (measured: ~84% of a 1080p frame is spent
waiting on the encoder, four encodes deep), so a long render is **split across
segment workers** (`segmentPlan.ts`, `segmentWorker.ts`): each renders a
contiguous frame range into a small standalone MP4, and the lead worker demuxes
those and re-muxes the packets - already encoded - into the real output. Nothing
is re-encoded. Slices are at least 4 s, which is about amortizing per-segment
encoder setup and seeks, not about bitrate (`e2e/probeSliceRate.spec.ts` shows
rate control is flat across slice lengths once the track declares its cadence).

A render taps its own frames (`renderPreview.ts`, ~8 downscaled snapshots a
second, fire-and-forget) so the monitor shows the export advancing. Stalled
encoders and decoders are caught by deadlines in `stallGuard.ts` and answered by
`retryPlan.ts` (fall back to a slower, safer configuration) rather than by an
error. When the browser cannot hand us a file to stream into, the sink is a
scratch file in OPFS (`src/lib/opfs.ts`) - a 6 GB "120 fps · 4K" render will not
fit in one ArrayBuffer.

AAC/MP3 encoders are feature-detected (`canEncodeAudio`); when the native
WebCodecs encoder is missing, `@mediabunny/aac-encoder` /
`@mediabunny/mp3-encoder` (WASM) are registered as fallbacks. A preset asking
for HEVC or AV1 falls back to H.264 when the browser cannot encode it, so a
codec choice is a preference and never a way to make an export fail.

## ffmpeg.wasm, on the side

`src/media/ffmpeg.ts` is a shared runtime for what native browser codecs cannot
do: transcoding an undecodable audio track, extracting embedded subtitles. It is
dynamically imported on first job (the core is a 32 MB download) and never
touches a normal import path. Two builds ship - single-threaded, and the
multi-threaded one used when the document is `crossOriginIsolated`.

## Data model

See `src/types.ts`. A clip's timeline duration is
`(sourceOutMs - sourceInMs) / speed`; export maps
`sourceTime = sourceInMs + (t - timelineStartMs) * speed`. Video z-order =
track order (last track on top); audio tracks are mixed together. The model math
(durations, fades, crossfades, output geometry, keyframe sampling, curves,
chroma key, mask motion) lives in `src/model/`; `src/types.ts` is types only.

An animatable property is a `Channel`: a plain number (the common case, costs
nothing) or a sorted keyframe list sampled over clip-local time.

## Layout

```
src/
  app/        app-wide constants (APP_NAME, fps, zoom bounds…), COOP worker, error policy
  store/      Zustand store split into slices, undo/redo (gesture-based transactions)
  model/      pure timeline/clip math: animation, curves, chroma key, masks, redaction
  media/      mediabunny wrappers: probing, thumbnails, decode caches, ffmpeg jobs,
              embedded subtitles, Whisper captions, motion tracking
  preview/    real-time compositor, decode worker, WebGL colour pass, scopes, Web Audio graph
  export/     export worker, segment workers, presets, stall guard, main-thread orchestrator
  effects/    effect catalogue, `.sfx` presets, `.cube` LUT parsing
  timeline/   timeline UI (ruler, markers, tracks, clips, keyframe lanes, snapping, playhead)
  inspector/  selected-clip panel, one section per family
  ui/         menu bar, top bar, transport, libraries, dialogs, toasts, import, unsupported screen
  perf/       frame instrumentation + HUD overlay
  lib/        persistence (IndexedDB), project file, OPFS scratch, fonts, subtitles, helpers
  i18n/       locales (en, fr, de, es, pt-BR)
  landing/    landing copy, schema, language list
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
  is never doubled. A link group is generic - any number of clips across video
  and audio tracks, no master side. Split gives each half a fresh shared link;
  copy/paste drops the link. **Unlink** breaks the group and silences the video
  side (volume 0) *only if the group was delegating its sound*: unlinking video
  clips that never delegated must not mute anything. **Link** re-forms a group:
  select a video and an audio clip on opposite tracks, or select just one and it
  auto-pairs with the same-source clip. A selection straddling two existing
  groups is refused rather than silently merged.
- **Overlaps are allowed** within a track; at a given time the latest-starting
  clip wins, and the overlap is where a transition renders. Permissive beats
  fighting the user mid-drag.
- **Track reordering** uses up/down buttons in the track header, simpler and
  more reliable than vertical drag on mobile. **Locking** is enforced in the
  selection slice: a clip that cannot be selected cannot be edited anywhere.
- **Transform semantics**: crop is normalized over the source; the cropped
  region is contain-fitted into the output, then scaled by `scale` (and
  optionally stretched per axis), rotated around its centre, and centered at
  (`x`, `y`) in normalized output coordinates.
- **Masks and redactions share one shape type.** A `ClipRedaction` extends
  `ClipMask`, so every helper - bounds, dirty rect, bezier tracing, motion
  sampling, the tracker - takes either unchanged. Both are defined in
  output-frame coordinates, which is what split screens and reveals want.
- **The motion tracker is two translational trackers**, not an affine solve:
  two patches matched across frames give translation (midpoint), scale (vector
  length) and rotation (angle). Robust enough for a drifting face, cheap enough
  to run on decoded frames locally.
- **Effects are an index, not a registry.** A clip stores its look in flat
  fields (`color`, `audioFx`, `transform`, `zoomEnd`); `src/effects/catalog.ts`
  is a browsable, draggable index over them that adds no state and no rendering
  path.
- **`.selfcut` holds no media bytes.** The project file keeps the timeline plus
  asset metadata, thumbnails and waveform peaks, so a 4 GB shoot saves in a few
  hundred kilobytes and reopens showing the edit; the sources are relinked by
  name through the same path a moved file uses.
- **Wheel = pan, Ctrl/Cmd+wheel = zoom** on the timeline; on a coarse pointer a
  plain wheel zooms too, since there is no modifier to hold. Timeline zoom is
  anchored at the **playhead** (the viewport centre when it is scrolled out of
  sight), so the frame you are working on keeps its place on screen. The
  *preview* zoom is the one anchored at the cursor. Pinch zoom on touch.
- **Variable preview resolution** · the monitor composites at a fraction of the
  export size (Full / ½ / ¼ / ⅛, default ½), picked from the quality menu. We
  chose a manual pick over an adaptive auto so sharpness never pumps
  mid-playback; the paused still refines to full resolution once the playhead
  settles (Premiere's "Paused Resolution = Full"). Persisted under
  `selfcut.previewResolution`; export is unaffected.
- **Audio decode strategy**: each source audio track is decoded once into a
  full `AudioBuffer`, cached per `(asset, audioTrackIndex)` so a multi-track
  video's tracks never evict one another. Instant to schedule; costs memory
  (~23 MB per stereo minute per track), fine for the short-form editing this
  targets. The cache is **bounded**: a budget derived from the machine
  (`deviceMemory`, capped by `jsHeapSizeLimit` where Chrome exposes it, halved
  on a touch device when neither says anything) and LRU eviction, transcoded PCM
  ranked last since it cost minutes rather than seconds. Import sizes what a
  file will cost before decoding it (`media/audioMemory.ts`): a track past half
  the budget is imported but not warmed, with a warning that carries the remedy,
  because a single buffer that large is one allocation no eviction can rescue.
  An allocation that does fail names the file and the track instead of leaving a
  silent clip behind.
- **Speed does not preserve pitch** (plain `playbackRate`), as scoped.
- **Import degrades instead of rejecting**: probing keeps whatever is usable.
  Undecodable audio tracks are listed and can be transcoded on demand; a file
  whose video codec WebCodecs can't decode still imports as audio-only when it
  has decodable sound (the toast names the codec); an unreadable container is
  remuxed to Matroska and re-imported under the same identity. Only a file with
  nothing decodable is refused.
- **Still images bypass the decoder pipeline** (`src/media/stillImage.ts`): an
  image is rasterized once into an `ImageBitmap` (SVG goes through an
  `<img>`/canvas fallback since `createImageBitmap` rejects it) and drawn
  through the same compositor path via a minimal `DrawableFrame` interface that
  mediabunny's `VideoSample` also satisfies. Export rasterizes on the main
  thread (SVG needs the DOM) and transfers the bitmaps to the worker. An image
  clip defaults to 5 s, trims without an upper bound, and slip is a no-op.
  Animated GIFs import as a still of their first frame.
- **Auto-captions are desktop-only**, by decision: Whisper needs a capable
  machine and a model download, which is not what a phone visit should meet.
- **The caption language defaults to detection, not to the interface
  language.** Forcing the UI language was the single largest source of bad
  transcriptions: a French interface over English audio asked Whisper for
  French words nobody said, and it obliged. The model is a per-machine choice
  rated against a real WebGPU probe (`src/media/captionsCapabilities.ts`), and
  regenerating over existing cues offers to replace them rather than stacking a
  second caption lane.
- **Voice focus levels the audio, it does not separate it.** A high-pass, a
  gentle compressor and RMS levelling to the loudness Whisper was trained on
  (`normalizeSpeech`) cost one offline render that already had to happen for the
  resample. Source separation would mean a second model download for a gain
  Whisper's own robustness mostly already provides, and a noise gate eats word
  onsets - a swallowed first syllable is worse than a noisy one.

## Measuring

`src/perf/probe.ts` instruments every render path (preview loop, compositor,
colour pass, export worker). It is off by default and free when off: no
allocation in the hot loop, thread-local, published to the HUD at most every
few frames. `npm run bench` runs the render-budget benchmarks;
`npm run test:e2e:perf` and the swiftshader config exercise the same paths in a
browser, with and without a real GPU.

## Deployment

`.github/workflows/deploy.yml` builds (`npm ci && npm run build`) on every push
to `main` and publishes `dist/` to GitHub Pages, served at
**selfcut.alegzandr.com** (`public/CNAME`).

- Pages serves over HTTPS, which satisfies WebCodecs' secure-context
  requirement.
- The editor gets **COOP/COEP from a service worker** (`public/coop-sw.js`),
  since a static host sends no headers: cross-origin isolation is what lets the
  multi-threaded ffmpeg core use `SharedArrayBuffer`. It is scoped to the
  editor, and isolation only takes effect from the next navigation - so
  registration is silent and never forces a reload. Dev serves the same headers
  from the Astro server instead (`integrations/crossOriginIsolation.ts`).
- The CSP ships as a meta tag, for the same reason. Astro composes it from
  `security.csp` in `astro.config.ts`, hashing every script it inlines - which
  is how the landing's language script stays allowed without opening
  `script-src` to `'unsafe-inline'`.
- `src/pages/404.astro` renders the landing, so unknown paths show it instead of
  the default Pages 404 (still served with a 404 status, so stray URLs are not
  indexed).
- `base` is `/` for the custom domain; set `VITE_BASE` to build for a
  subpath.

## Out of scope

HDR, pitch preservation, collaborative editing, anything needing a server. The
scope document for the effects epic is in `docs/`.

## License

MIT
