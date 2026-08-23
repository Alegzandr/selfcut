# Pitch preservation on clip speed - analysis

Status: **analysis only, nothing decided**. The README lists pitch preservation
under "Out of scope"; this note reopens the question, states what each option
would actually cost here, and ends on a recommendation.

## Where we stand today

`Clip.speed` is a plain number in `0.1 .. 8` (`SpeedControl.tsx`), constant over
a clip - there is no speed ramp, and a clip's timeline duration is exactly
`(sourceOutMs - sourceInMs) / speed`. On the audio side that number reaches the
graph in one place:

```ts
// preview/audioMix.ts - scheduleClip
source.playbackRate.value = clip.speed * rate;   // `rate` = J/L shuttle
```

`AudioBufferSourceNode.playbackRate` resamples: 2x is the tape sped up, an
octave higher. That single line is shared by both pipelines, which is exactly
why preview and export sound identical today - `scheduleProjectAudio` is called
by the preview's `AudioContext` and by the export's `OfflineAudioContext` with
the same buffers and the same numbers.

Two properties of the current design constrain every option below, and they are
the whole difficulty:

1. **The export mix is rendered in 5-second slices** (`AUDIO_CHUNK_FRAMES` in
   `export/protocol.ts`). Each slice builds a *fresh* `OfflineAudioContext`,
   schedules the whole project seeked to that absolute timeline position, and
   renders. This is what keeps the mix at a 1.9 MB peak instead of 690 MB for an
   hour. Every slice is therefore a **seek**: any DSP in the chain starts from
   zero at every 5-second boundary.
2. **Audio is the clock** in the preview (`PlaybackEngine` derives the timeline
   position from `audioCtx.currentTime`). Video frames may drop; the audio graph
   may not. Today the graph is native nodes only, so it physically cannot
   underrun in application code.

## The hard constraint, restated precisely

"Preview and export must sound identical" means: the sample produced at timeline
position *t* by the real-time graph and the sample produced at *t* by the offline
render must come from the same computation.

A time-stretcher is a **stateful, recursive** filter. A phase vocoder carries an
accumulated phase per bin; WSOLA picks each output block by correlating against
*the block it just emitted*. In both, the output at *t* depends on the whole
history since the stretcher was started - it is not a function of *t*.

Put that next to property (1) and the conflict is structural, not an
implementation detail:

- the preview runs one continuous stretcher from wherever playback started;
- the export runs a stretcher **restarted every 5 seconds**, from a different
  internal phase each time.

They will not match, and the export additionally gets a seam (phase
discontinuity, i.e. a click or a smeared transient) at every 5-second boundary.
Any option that puts a stretcher *in the graph* has to answer this. An option
that puts it *before* the graph does not.

## Options

### 0. Do nothing

Cost: zero. Behaviour: speed stays a tape effect, which is what most short-form
speed use actually wants (2x b-roll, 0.5x slow-mo, usually muted or under
music). The status quo is a real gap for one case only: a talking head at
1.25x-1.5x with a usable voice.

### 1. `<audio>` + `preservesPitch` (the browser's own stretcher)

`HTMLMediaElement.playbackRate` already preserves pitch by default
(`preservesPitch`), and Chrome's implementation is a decent WSOLA. Routed
through a `MediaElementAudioSourceNode` it costs **0 bytes of bundle** and none
of our own DSP.

Disqualified, and cleanly so:

- `MediaElementAudioSourceNode` cannot be rendered by an `OfflineAudioContext` -
  a media element plays against the wall clock; there is nothing offline to pull
  from it. The export would have to capture it in real time (an hour of timeline
  = an hour of export) or render silence.
- It also loses sample-accurate scheduling: one element per clip, `currentTime`
  seeks with unspecified precision, no `start(when, offset, duration)`.

So it fails the hard constraint outright. Worth writing down because it looks
free until the offline side is checked.

### 2. An AudioWorklet stretcher of our own (phase vocoder or WSOLA)

A worklet spliced into `scheduleClip`'s chain, in both contexts (`addModule`
does work on an `OfflineAudioContext`).

- **Weight**: a few kB of JS for WSOLA, ~10 kB for a phase vocoder with a
  hand-written FFT. Effectively free.
- **CPU, real time**: the worklet runs on the audio render thread with a
  128-frame deadline (2.7 ms at 48 kHz). A 1024-point phase vocoder at 4x
  overlap is roughly 3-8% of one core *per voice*; WSOLA is cheaper, ~1-2%. A
  fast-cut sequence with a crossfade has several voices live at once, and every
  speed-changed clip is a voice. In plain JS the allocator is in play too:
  garbage in a worklet is a dropout, and a dropout in *the clock* stutters the
  whole editor, not just the sound.
- **Identity**: fails, per the section above - the stretcher is restarted at
  every export slice. Two half-fixes exist, neither good:
  - render the entire export mix in one `OfflineAudioContext`. That undoes the
    slicing and puts 690 MB/hour back, straight into the memory problem we are
    separately trying to bound;
  - give each slice a **pre-roll**: render ~200-500 ms before the slice start and
    discard it so the stretcher converges. Approximately identical, never
    provably so (WSOLA's block search has no convergence guarantee), 4-10% more
    mix work per slice, and "approximately" is exactly what comes back as a bug
    report about a click at 0:05.
- **Quality**: a stretcher that holds up on speech at 1.5x, without phasiness or
  transient smear, is weeks of work, not days. That is the part always
  underestimated.

### 3. A WASM library in the graph (SoundTouch, Rubber Band, Signalsmith)

Same architecture as option 2, someone else's DSP.

- **Weight**: SoundTouch ~100-200 kB of wasm; Signalsmith Stretch in the same
  range; Rubber Band closer to 1 MB. All lazy-loadable on the first
  pitch-preserving clip, the way `media/ffmpeg.ts` is - so the landing and a
  normal edit pay nothing.
- **Licensing** (to verify before any adoption; SelfCut is MIT): Rubber Band is
  GPL-or-commercial, a non-starter for a bundled MIT app. SoundTouch is LGPL,
  awkward for a statically linked wasm blob. Signalsmith Stretch is MIT and is
  the only obviously clean candidate.
- **CPU**: better than a hand-written vocoder, same order of magnitude. Same
  audio-thread deadline risk.
- **Identity**: fails for exactly the same reason as option 2. Buying the DSP
  does not buy determinism across a seek.

### 4. Offline pre-render: stretch the source, leave the graph alone

Instead of stretching *in* the graph, produce a stretched **AudioBuffer** and
schedule it at `playbackRate = 1`.

For a clip with `speed = s`, take the source region `[sourceInMs, sourceOutMs]`,
run it once through a stretcher (wasm, off the audio thread), and cache the
result under `(assetId, audioTrackIndex, region, s)`. `scheduleClip` picks the
stretched buffer when one exists and sets `playbackRate = 1`.

- **Identity**: holds by construction, for free. Both pipelines read the same
  immutable buffer through the same code path; there is no state to seek and no
  boundary to converge across. The export keeps its 5-second slices.
- **CPU, real time**: zero. The audio thread stays native nodes only, so the
  clock keeps the guarantee it has today.
- **Latency**: a stretch runs at maybe 30-100x real time in wasm, so a
  30-second clip is well under a second and a 10-minute one is several. It runs
  on a speed *commit*, not on every keystroke (`SpeedControl` already commits on
  blur/enter and on the preset buttons), so a spinner on the clip is an honest
  UI for it. Playback before it finishes falls back to today's resampled
  behaviour - degradation, not silence.
- **Memory**: the real price, and it lands on the scale we are already trying to
  bound. A stretched copy is another full PCM buffer, ~23 MB per stereo minute
  of *output*. It has to live inside `mediaCache`'s budget and eviction (it is
  reconstructible, so it evicts like anything else), and the import-time
  estimate has to know it can exist. **This option depends on the memory guard
  landing first.**
- **What makes it possible here**: `speed` is a constant per clip. Were speed
  ever a `Channel` (a ramp), a pre-render would have to re-run continuously
  while a curve is dragged, and this option would collapse into option 2.
  Constant speed is the enabling property, and it is worth stating.
- **Cache churn**: trimming a clip changes the region and invalidates the
  stretch. Either stretch the whole track once per speed value (simpler
  invalidation, more memory) or stretch the region with a margin and re-stretch
  when a trim leaves it. The first is probably right for short-form material.

## Behaviour on a modest machine

Options 2 and 3 move work onto the audio render thread. That thread has no
frame-dropping escape hatch: it either fills its 128-frame quantum on time or
the output glitches. Because the preview derives the timeline position from
`audioCtx.currentTime`, a glitch is not merely an audible artifact - the whole
preview hitches, and the added load arrives exactly on the machines that are
already dropping video frames, i.e. where there is least room for it. Today that
failure mode does not exist at all, and that is a property worth keeping.

Option 4 adds nothing to the audio thread. Its cost is a bounded, visible,
interruptible wait at edit time plus memory the existing eviction policy already
knows how to reclaim. On a modest machine that is the difference between "the
editor took a moment once" and "playback is unreliable".

## Recommendation

**Do not do it now.** If it is done later, do option 4 - offline pre-render with
an MIT-licensed wasm stretcher - and nothing else.

The reasoning, in order:

1. Options 1, 2 and 3 fail the hard constraint. The sliced offline mix restarts
   any in-graph stretcher every 5 seconds, so preview and export diverge by
   construction. The only ways out are re-introducing a whole-timeline mix
   (which fights the memory work) or a pre-roll fudge that is approximate where
   the requirement is exact.
2. Option 4 satisfies the constraint trivially, precisely because it does not
   touch it: the DSP moves out of the real-time path entirely and both pipelines
   get a plain buffer - the same trick the rest of the audio design already uses
   (native nodes only, one code path, decoded once).
3. But option 4's price is memory, on top of a decode strategy that is already
   the heaviest thing the editor holds. Adding a second full-size PCM copy per
   speed-changed clip before the import-time guard exists would make a known
   problem worse, for a feature nobody has asked for in these terms yet.
4. And the value is genuinely uncertain for this product. Short-form speed use
   is mostly 2x b-roll and slow-mo, usually under music. The case that needs
   pitch preservation - a talking head at 1.25x-1.5x - is real, but it is one
   case, and it has a cheaper neighbour: "speed up speech" is not the same
   feature as "every speed change preserves pitch".

### What would have to be true to change this

- The memory guard is shipped, so a stretched buffer is a first-class entry in
  the audio budget rather than an unaccounted allocation.
- Users actually ask for it, and specifically for **speech** at 1.25x-2x. If the
  asks are about slow-motion b-roll, this is the wrong fix.
- An MIT-licensed wasm stretcher under ~200 kB, lazily loaded, has been measured
  on real speech at 0.5x and 2x and sounds acceptable. If it does not, shipping
  it is worse than not having it.
- Speed is still constant per clip. A speed ramp invalidates option 4's premise
  and pushes the question back to option 2, with all of its problems.
