# Scope — Keyframes, Transitions, Video effects, Audio effects

Status: agreed scope for the next epic. Written to fix the decisions before
implementation and to record what is deliberately left out.

## Why this document

The app is stable and users are happy. The features expected next —
**animation (keyframes)**, **transitions**, **video effects** (blur, colour…)
and **audio effects** — are benchmarked against CapCut (mobile reflexes), Vegas
and Premiere/After Effects (desktop reflexes). Every inclusion is filtered
through `PRODUCT.md`: a short-form editor that is *efficient, discreet,
reliable*, borrows reflexes rather than reinventing them, and is explicitly
**not** the Premiere/AE "gas factory" nor a big-buttoned toy.

## The animation vision (the spine of this epic)

The great CapCut mobile edits are smooth and full of flow **because** their
animation is simple and well-eased, not despite it. The goal:

- **Mobile = CapCut**: a keyframe "diamond" button, the value is set at the
  playhead, easing via presets. The "smooth flow" is really **easing quality** —
  keyframes ease-in-out by default, with a few punchy presets for beat-synced
  snaps. That is the real lever, and it is cheap.
- **Desktop = Adobe/Vegas**: the *same* keyframes shown as property rows under
  the clip, draggable in time, easing via Bézier handles.

One data model, two editing surfaces selected by context — literally
`PRODUCT.md`'s "le contexte détermine l'UI".

### The unifying abstraction: animatable channels

Every animatable property (position, scale, rotation, opacity, volume, and every
effect parameter) becomes a **channel**: either a constant value or a list of
keyframes `{ time, value, easing }`. The renderer samples the channel at the
current time. Preview and export both sample it, so animation exports for free
like everything else.

Consequences that make this low-risk:

- The compositor already animates over time (fades, Ken Burns `zoomEnd`,
  crossfades) — the *rendering* is ready; what is missing is the channel data
  model and the keyframe UI.
- Effects are designed as channels **from day one** and ship "static" (one
  implicit keyframe) first, so no scalar field is ever built and then ripped out.
- The highest-flow, most-visible win needs **no new effect**: the transform
  (x/y/scale/rotation/opacity) already renders; keyframing those existing
  properties delivers the CapCut-edit experience first, before any new effect.

## The one principle that drives the rest of the scope

Two facts about the current architecture decide almost everything:

1. **Video is a pure Canvas 2D compositor.** No WebGL pipeline exists
   (`src/lib/gpu.ts` only *probes* WebGL to detect software rendering).
   Preview and export share one `drawClip` (`src/preview/compositor.ts`).
2. **Audio is a native Web Audio graph**, and `scheduleProjectAudio`
   (`src/preview/audioMix.ts`) is shared by preview (`AudioContext`) and export
   (`OfflineAudioContext`).

That yields a sharp **"free line"** — what the existing single pass does cheaply
vs. what needs a structural investment:

| Domain | Free (existing pass) | Costly (WebGL / WASM) |
|---|---|---|
| Video | `ctx.filter`: brightness, contrast, saturate, blur, hue-rotate, grayscale, sepia, invert | temperature/tint, curves, **LUT**, HSL secondary, highlights/shadows, vignette, sharpen |
| Audio | `BiquadFilter` (EQ, hi/lo-pass, "telephone"), `DynamicsCompressor` (VO leveler), `Convolver` (reverb), `Delay` (echo), `WaveShaper` (drive) | constant-duration pitch shift, denoise |
| Transitions | dissolve (done), dip to black/white, slide/push, wipe, iris | glitch, RGB-split, 3D flip, zoom-blur, morph (also off-brand "toy") |

## Decisions locked

1. **Keyframe model — one animatable-channel data model, two context-selected
   UIs** (CapCut-mobile diamonds + easing presets; Adobe/Vegas-desktop property
   rows + Bézier handles). Smooth-by-default easing is the core lever.
2. **Video-effect ceiling — Canvas 2D first, then an isolated WebGL colour
   pass; not a compositor rewrite.** Canvas 2D keeps geometry, compositing and
   transitions unchanged; a per-clip WebGL pass grades pixels *before* the
   existing `drawClipSample` (a WebGL canvas is `drawImage`-able into the 2D
   context). Unlocks temperature/tint/**LUT**/vignette/better blur without
   destabilising the most load-bearing code. LUTs alone unlock a one-tap look
   library (what CapCut "filters" are).
3. **Transition model — overlap / Vegas.** Extend `trackCrossfades`
   (`src/model/timeline.ts`) with a transition *type* on the overlap window,
   rather than a Premiere-style object bound to the cut.
4. **Masks — shapes first (CapCut reflex), Bézier pen later.** Shape masks
   (circle/rectangle/line) + feather are cheap in Canvas 2D (`Path2D` +
   `ctx.clip()`) and cover the short-form 90% (blur a face, spotlight, reveal).
   A full Bézier pen (static, then keyframed path) is a desktop/pro follow-up.

## Deliberately excluded

- **After Effects JS expressions.** The one ask that does not serve the "smooth
  CapCut flow" and carries real in-browser cost: per-property per-frame JS eval
  in the export worker (perf) and sandboxing user JS (security), for a feature
  ~0% of short-form editors use. Out.
- **Full velocity graph editor.** Bézier-handle easing covers the need; the full
  editable velocity graph is a desktop power feature held in reserve until
  desktop users demand it.
- Curves, scopes, HSL secondary, tracking — Premiere depth, off-brand.

## Delivery order

1. **Foundation** — animatable-channel data model + sampling + easing. No UI,
   everything "static" (one implicit keyframe), zero regression.
2. **Keyframe UI on existing properties** (transform, opacity, volume) —
   mobile CapCut / desktop Adobe-Vegas. Delivers the smooth-flow experience
   first, with no new effect.
3. **Audio effects** — named presets (Leveler/`DynamicsCompressor`, Voice EQ /
   Telephone / Bass boost via `BiquadFilter`, Reverb via `Convolver` + short
   bundled IRs, Echo via `Delay`), parameters already channels. **New fields
   must be added to `sameAudioClip`** (`src/preview/audioMix.ts`) or preview
   won't follow edits — called out in that file's comment.
4. **Video effects** — 4a "Adjust" (brightness/contrast/saturation/blur via
   `ctx.filter`) + one-tap `ctx.filter` filter presets; 4b isolated WebGL colour
   pass (temperature/tint, LUT, vignette).
5. **Masks** — shapes, then Bézier pen.
6. **Transitions** — cross-dissolve (done), dip to black/white, slide/push,
   wipe, optional zoom; desktop drag-onto-cut + duration handle, mobile
   tap-the-cut gallery.

## Cross-cutting

- Persistence/undo come for free: channels and effects are plain data on `Clip`,
  snapshotted by the existing history and autosave.
- The existing Ken Burns `zoomEnd` is subsumed by the channel model (an animated
  scale channel) once the foundation lands; keep it working during migration.
