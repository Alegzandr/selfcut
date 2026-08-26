import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { ClipPatch, EditorState } from '../editorState';
import {
  AspectRatio,
  Clip,
  ClipAnimation,
  ClipColor,
  ClipCurves,
  ClipTransform,
  MaskMotion,
  MaskMotionProp,
  MediaClip,
  Project,
  Track,
  isTrackPlayable,
} from '../../types';
import {
  DEFAULT_TRANSFORM,
  animatedProps,
  clipDurationMs,
  clipEndMs,
  cloneClip,
  curvesAreIdentity,
  delegatedLinkIds,
  keyframesOf,
  outputDimensions,
  removeKeyframe,
  sampleChannel,
  setKeyframe,
  staticValueOf,
  timelineToSourceMs,
  writeChannel,
} from '../../model';
import { uid } from '../../lib/id';
import {
  ensureTrack,
  findClip,
  insertTrack,
  linkedPartnerIds,
  patchClips,
  sourceLinkedIds,
  withLinkedIds,
} from '../projectOps';
import { clamp } from '../../lib/time';
import { announce } from '../../lib/a11yBus';
import { MIN_CLIP_DURATION_MS } from '../../app/config';
import type { SubtitleVAlign } from '../../lib/subtitles';

/**
 * Where each vertical band puts a caption's centre, as a fraction of the output
 * height. Top and bottom keep a margin off the frame edge - a caption flush
 * against it reads as clipped, and players traditionally leave that room.
 *
 * How much room depends on the frame. Landscape follows the broadcast habit of
 * a tight lower third, near the bottom safe area; vertical and square sit
 * noticeably higher, because a phone player paints its own controls, caption
 * button and account handle over the last stretch of the frame and a subtitle
 * placed by broadcast rules ends up underneath them.
 */
const CAPTION_Y: Record<AspectRatio, Record<SubtitleVAlign, number>> = {
  '16:9': { top: 0.1, middle: 0.5, bottom: 0.88 },
  '9:16': { top: 0.14, middle: 0.5, bottom: 0.82 },
  '1:1': { top: 0.12, middle: 0.5, bottom: 0.85 },
  '4:5': { top: 0.13, middle: 0.5, bottom: 0.83 },
};
import { t as translate } from '../../i18n';

/**
 * The `laneIndex`-th audio track of the project, creating enough audio tracks to
 * reach it. A multi-track video explodes onto parallel audio lanes (one per
 * source track), so its extracted clips never overlap or fight for a lane.
 * Mutates `p` (called on the withHistory draft).
 */
function ensureAudioLane(p: Project, laneIndex: number): Track {
  let audioTracks = p.tracks.filter((t) => t.kind === 'audio');
  while (audioTracks.length <= laneIndex) {
    insertTrack(p, { id: uid('track'), kind: 'audio', clips: [] });
    audioTracks = p.tracks.filter((t) => t.kind === 'audio');
  }
  return audioTracks[laneIndex]!;
}

/** An extracted-audio clip for one source track, aligned with its video partner. */
function buildAudioClip(
  assetId: string,
  trackId: string,
  start: number,
  durationMs: number,
  linkId: string,
  audioTrackIndex: number,
): Clip {
  return {
    kind: 'media',
    id: uid('clip'),
    assetId,
    trackId,
    timelineStartMs: start,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    linkId,
    audioTrackIndex,
  };
}

/** Copy-on-write edits shifting each clip's start by `delta` (clamped ≥ 0). */
function shiftEdits(clipIds: string[], delta: number): Map<string, (c: Clip) => Clip> {
  const edits = new Map<string, (c: Clip) => Clip>();
  for (const id of clipIds) {
    edits.set(id, (c) => {
      const next = Math.max(0, c.timelineStartMs + delta);
      return next === c.timelineStartMs ? c : { ...c, timelineStartMs: next };
    });
  }
  return edits;
}

/** Resolve a patch against the clip it is about to land on. */
function resolvePatch(patch: ClipPatch, clip: Clip): Partial<Clip> {
  return typeof patch === 'function' ? patch(clip) : patch;
}

export function createClipsSlice(
  set: StoreSet,
  get: StoreGet,
  { withHistory, pruneSelection, targetsOf }: SliceHelpers,
): Pick<
  EditorState,
  | 'addClipFromAsset'
  | 'addClipFromAssetAt'
  | 'addTextClip'
  | 'addSolidClip'
  | 'addShapeClip'
  | 'updateClip'
  | 'updateClipCommitted'
  | 'updateClipTransformLive'
  | 'updateClipColorLive'
  | 'setClipCurves'
  | 'setClipChromaKey'
  | 'setClipMask'
  | 'setClipMaskMotionLive'
  | 'toggleClipMaskMotionKeyframe'
  | 'addClipRedaction'
  | 'setClipRedaction'
  | 'removeClipRedaction'
  | 'setClipRedactionMotionLive'
  | 'toggleClipRedactionMotionKeyframe'
  | 'toggleClipKeyframe'
  | 'moveClipKeyframes'
  | 'setClipKeyframesEase'
  | 'moveClip'
  | 'moveClips'
  | 'trimClip'
  | 'slipClip'
  | 'cloneClipsForDrag'
  | 'splitAtPlayhead'
  | 'deleteClip'
  | 'deleteClips'
  | 'duplicateClips'
  | 'unlinkClip'
  | 'linkClips'
  | 'punchZoomSelected'
  | 'addSubtitleClips'
  | 'applyStreamLayout'
  | 'setCropEditing'
  | 'attachAudioTrack'
> {
  /**
   * The same copy-on-write edit, aimed at every clip this edit reaches: the
   * control names the primary clip, but a multi-selection takes the change as
   * a whole. The edit runs per clip, so it must read the clip it is given
   * rather than close over the primary's values.
   */
  const spread = (clipId: string, edit: (c: Clip) => Clip) =>
    new Map(targetsOf(clipId).map((id) => [id, edit] as const));

  /**
   * Whether the playhead falls inside `clip`. A keyframe is written at a
   * clip-local time, so a selected clip the playhead has already passed has no
   * instant to write at: it keeps its animation instead of taking a key beyond
   * its own edges.
   */
  const spansPlayhead = (clip: Clip, timelineMs: number) => {
    const local = timelineMs - clip.timelineStartMs;
    return local >= 0 && local <= clipDurationMs(clip);
  };

  return {
    addClipFromAsset: (assetId) => {
      const asset = get().assets[assetId];
      if (!asset) return;
      // A video that carries audio lands as an A/V-linked group: the picture on a
      // video track, and EVERY source audio track split onto its own audio lane
      // so each can be edited independently while staying tied to the video.
      // A video multiplexing several audio tracks (VO + dub, commentary, discrete
      // channels) explodes into one linked audio clip per track.
      // Undecodable tracks get no lane: they would lay down a silent clip with
      // no waveform. Transcoding one adds its lane afterwards.
      const audioTracks = asset.audioTracks.filter(isTrackPlayable);
      const splitAudio = asset.kind === 'video' && audioTracks.length > 0;
      let newClipId = '';
      withHistory((p) => {
        const trackEnd = (t: Track) => t.clips.reduce((max, c) => Math.max(max, clipEndMs(c)), 0);
        // Stills are picture content: they land on video tracks like footage.
        const track = ensureTrack(p, asset.kind === 'audio' ? 'audio' : 'video');
        const lanes = splitAudio ? audioTracks.map((_, i) => ensureAudioLane(p, i)) : [];
        // The group shares one start, placed past the end of the video track AND
        // every audio lane it touches, so no side overlaps and gets nudged
        // independently (which would desync the group).
        const start = Math.max(trackEnd(track), ...lanes.map(trackEnd));
        const linkId = splitAudio ? uid('link') : undefined;
        const clip: Clip = {
          kind: 'media',
          id: uid('clip'),
          assetId,
          trackId: track.id,
          timelineStartMs: start,
          sourceInMs: 0,
          sourceOutMs: asset.durationMs,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
          ...(linkId ? { linkId } : {}),
        };
        newClipId = clip.id;
        track.clips.push(clip);
        if (splitAudio && linkId) {
          audioTracks.forEach((info, i) => {
            lanes[i]!.clips.push(
              buildAudioClip(assetId, lanes[i]!.id, start, asset.durationMs, linkId, info.index),
            );
          });
        }
      });
      set({ selectedClipId: newClipId, selectedClipIds: [newClipId] });
    },

    addClipFromAssetAt: (assetId, timelineMs, targetTrackId) => {
      const asset = get().assets[assetId];
      if (!asset) return;
      const audioTracks = asset.audioTracks.filter(isTrackPlayable);
      const splitAudio = asset.kind === 'video' && audioTracks.length > 0;
      const newClipId = uid('clip');
      const start = Math.max(0, timelineMs);
      // The dropped clip keeps its position (priority) when overlaps settle.
      withHistory((p) => {
        const track = ensureTrack(p, asset.kind === 'audio' ? 'audio' : 'video', targetTrackId);
        const linkId = splitAudio ? uid('link') : undefined;
        track.clips.push({
          kind: 'media',
          id: newClipId,
          assetId,
          trackId: track.id,
          timelineStartMs: start,
          sourceInMs: 0,
          sourceOutMs: asset.durationMs,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
          ...(linkId ? { linkId } : {}),
        });
        if (splitAudio && linkId) {
          // Every extracted audio track drops at the same instant, each on its
          // own lane so a multi-track source lands as parallel audio clips.
          audioTracks.forEach((info, i) => {
            const lane = ensureAudioLane(p, i);
            lane.clips.push(
              buildAudioClip(assetId, lane.id, start, asset.durationMs, linkId, info.index),
            );
          });
        }
      }, newClipId);
      set({ selectedClipId: newClipId, selectedClipIds: [newClipId] });
    },

    attachAudioTrack: (assetId, audioTrackIndex) => {
      const asset = get().assets[assetId];
      if (!asset) return;
      // The lane a track owns is its rank among the playable ones, matching how
      // addClipFromAsset lays a multi-track source out.
      const lane = asset.audioTracks.filter(isTrackPlayable).findIndex(
        (tr) => tr.index === audioTrackIndex,
      );
      if (lane < 0) return;
      withHistory((p) => {
        const isThisAsset = (c: Clip): c is MediaClip =>
          c.kind === 'media' && c.assetId === assetId;
        // Snapshot the picture clips first: pushing into a lane while iterating
        // would revisit the clips being added.
        const placed = p.tracks
          .filter((tr) => tr.kind === 'video')
          .flatMap((tr) => tr.clips)
          .filter(isThisAsset);
        if (placed.length === 0) return;
        // Re-running a transcode must not lay a second copy of the same sound.
        const existing = new Set(
          p.tracks
            .filter((tr) => tr.kind === 'audio')
            .flatMap((tr) => tr.clips)
            .filter(isThisAsset)
            .map((c) => `${c.linkId ?? ''}#${c.audioTrackIndex ?? ''}`),
        );
        const laneTrack = ensureAudioLane(p, lane);
        for (const clip of placed) {
          // An unlinked picture clip gets a group id now so its new sound stays
          // tied to it through moves and trims.
          const linkId = clip.linkId ?? uid('link');
          clip.linkId = linkId;
          if (existing.has(`${linkId}#${audioTrackIndex}`)) continue;
          laneTrack.clips.push({
            ...buildAudioClip(
              assetId,
              laneTrack.id,
              clip.timelineStartMs,
              asset.durationMs,
              linkId,
              audioTrackIndex,
            ),
            // Match the picture clip's trim and speed, or the sound would run
            // against a cut made before the track existed.
            sourceInMs: clip.sourceInMs,
            sourceOutMs: clip.sourceOutMs,
            speed: clip.speed,
          });
        }
      });
    },

    addTextClip: () => {
      const { currentTimeMs } = get();
      const newClipId = uid('clip');
      const durMs = 3000;
      withHistory((p) => {
        const start = Math.max(0, currentTimeMs);
        // Topmost video track with the interval free - a text clip is an overlay,
        // it must not crossfade with the footage it sits on. Otherwise stack a
        // new track at the top so the overlay is visible without reordering.
        let track = p.tracks.find(
          (t) =>
            t.kind === 'video' &&
            t.clips.every((c) => clipEndMs(c) <= start || c.timelineStartMs >= start + durMs),
        );
        if (!track) {
          track = { id: uid('track'), kind: 'video', clips: [] };
          insertTrack(p, track, { atTop: true });
        }
        track.clips.push({
          kind: 'text',
          id: newClipId,
          assetId: '',
          trackId: track.id,
          timelineStartMs: start,
          sourceInMs: 0,
          sourceOutMs: durMs,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
          text: { content: translate('clip.defaultText'), color: '#ffffff', sizeFrac: 0.08, bold: true },
        });
      }, newClipId);
      set({ selectedClipId: newClipId, selectedClipIds: [newClipId] });
    },

    addSolidClip: (kind) => {
      const { currentTimeMs } = get();
      const newClipId = uid('clip');
      const durMs = 3000;
      withHistory((p) => {
        const start = Math.max(0, currentTimeMs);
        // Overlay: topmost free video lane, or a fresh track at the top so the
        // new clip is visible without the user reordering tracks.
        let track = p.tracks.find(
          (t) =>
            t.kind === 'video' &&
            t.clips.every((c) => clipEndMs(c) <= start || c.timelineStartMs >= start + durMs),
        );
        if (!track) {
          track = { id: uid('track'), kind: 'video', clips: [] };
          insertTrack(p, track, { atTop: true });
        }
        track.clips.push({
          kind: 'solid',
          id: newClipId,
          assetId: '',
          trackId: track.id,
          timelineStartMs: start,
          sourceInMs: 0,
          sourceOutMs: durMs,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
          solid:
            kind === 'color'
              ? { kind, color: '#6366f1' }
              : { kind, color: '#7c3aed', color2: '#ec4899', angle: 45 },
        });
      }, newClipId);
      set({ selectedClipId: newClipId, selectedClipIds: [newClipId] });
    },

    addShapeClip: (shape, center) => {
      const { currentTimeMs } = get();
      const newClipId = uid('clip');
      const durMs = 3000;
      withHistory((p) => {
        const start = Math.max(0, currentTimeMs);
        // Shapes are overlays: they belong on top of whatever is already at the
        // playhead, so take the first free lane from the top rather than
        // reusing a busy one. When none is free, stack a fresh track at the
        // top so the shape is visible without reordering.
        let track = p.tracks.find(
          (t) =>
            t.kind === 'video' &&
            t.clips.every((c) => clipEndMs(c) <= start || c.timelineStartMs >= start + durMs),
        );
        if (!track) {
          track = { id: uid('track'), kind: 'video', clips: [] };
          insertTrack(p, track, { atTop: true });
        }
        track.clips.push({
          kind: 'shape',
          id: newClipId,
          assetId: '',
          trackId: track.id,
          timelineStartMs: start,
          sourceInMs: 0,
          sourceOutMs: durMs,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
          shape,
          // The drawn centre. Scale stays 1 so the corner handles and the
          // inspector read 100% on a freshly drawn shape.
          transform: { ...DEFAULT_TRANSFORM, x: center.x, y: center.y },
        });
      }, newClipId);
      set({ selectedClipId: newClipId, selectedClipIds: [newClipId] });
    },

    updateClip: (clipId, patch) =>
      set({
        // The spread preserves the clip's discriminant `kind`; the cast tells TS
        // the patched object is still a valid Clip (a Partial<Clip> spread widens).
        project: patchClips(
          get().project,
          spread(clipId, (c: Clip): Clip => ({ ...c, ...resolvePatch(patch, c) }) as Clip),
        ),
      }),

    updateClipCommitted: (clipId, patch) => {
      const ids = targetsOf(clipId);
      withHistory((p) => {
        for (const id of ids) {
          const found = findClip(p, id);
          if (!found) continue;
          const fields = resolvePatch(patch, found.clip);
          Object.assign(found.clip, fields);
          // Speed changes a clip's timeline duration; linked partners must take
          // the same speed or picture and sound drift apart immediately.
          if (fields.speed !== undefined) {
            for (const pid of linkedPartnerIds(p, id)) {
              const partner = findClip(p, pid);
              if (partner) partner.clip.speed = fields.speed;
            }
          }
        }
      });
    },

    updateClipTransformLive: (clipId, patch, timelineMs) =>
      set({
        project: patchClips(
          get().project,
          spread(clipId, (c: Clip): Clip => {
            const local = timelineMs - c.timelineStartMs;
            const canKey = spansPlayhead(c, timelineMs);
            let animation: ClipAnimation | undefined = c.animation;
            let transform = c.transform ?? DEFAULT_TRANSFORM;
            let transformChanged = false;
            for (const [key, value] of Object.entries(patch)) {
              if (value === undefined) continue;
              const prop = key as 'x' | 'y' | 'scale' | 'scaleX' | 'scaleY' | 'rotation';
              const existing = animation?.[prop];
              if (existing && existing.length) {
                // Already animated: write/update the keyframe at the playhead.
                if (canKey) {
                  animation = { ...animation, [prop]: setKeyframe(existing, local, value) };
                }
              } else {
                transform = { ...transform, [prop]: value };
                transformChanged = true;
              }
            }
            return { ...c, transform: transformChanged ? transform : c.transform, animation } as Clip;
          }),
        ),
      }),

    updateClipColorLive: (clipId, prop, value, timelineMs) =>
      set({
        project: patchClips(
          get().project,
          spread(clipId, (c: Clip): Clip => {
            const next = { ...c } as Clip;
            const existing = keyframesOf(next, prop);
            // Same rule as the transform sliders: once a parameter animates,
            // dragging it writes the key under the playhead rather than a
            // constant that would silently wipe the animation.
            if (existing && !spansPlayhead(c, timelineMs)) return c;
            writeChannel(
              next,
              prop,
              existing ? setKeyframe(existing, timelineMs - c.timelineStartMs, value) : value,
            );
            return next;
          }),
        ),
      }),

    setClipCurves: (clipId, curves) =>
      set({
        project: patchClips(
          get().project,
          spread(clipId, (c: Clip): Clip => {
            const color: ClipColor = { ...(c.color ?? {}) };
            if (!curves || curvesAreIdentity(curves)) delete color.curves;
            else color.curves = curves as ClipCurves;
            const nextColor = Object.keys(color).length ? color : undefined;
            return { ...c, color: nextColor } as Clip;
          }),
        ),
      }),

    setClipChromaKey: (clipId, key) =>
      set({
        project: patchClips(
          get().project,
          spread(clipId, (c: Clip): Clip => {
            const color: ClipColor = { ...(c.color ?? {}) };
            if (!key) delete color.chromaKey;
            else color.chromaKey = key;
            const nextColor = Object.keys(color).length ? color : undefined;
            return { ...c, color: nextColor } as Clip;
          }),
        ),
      }),

    setClipMask: (clipId, mask) =>
      set({
        project: patchClips(
          get().project,
          spread(clipId, (c: Clip): Clip => ({ ...c, mask: mask ?? undefined }) as Clip),
        ),
      }),

    setClipMaskMotionLive: (clipId, prop, value, timelineMs) =>
      set({
        project: patchClips(
          get().project,
          spread(clipId, (c: Clip): Clip => {
            const mask = c.mask;
            if (!mask) return c;
            const local = timelineMs - c.timelineStartMs;
            const motion: MaskMotion = { ...(mask.motion ?? {}) };
            const ch = motion[prop];
            // Same rule as the colour/transform sliders: once the axis is
            // animated, a drag writes the key under the playhead instead of a
            // constant that would wipe the animation.
            if (Array.isArray(ch) && ch.length) {
              if (!spansPlayhead(c, timelineMs)) return c;
              motion[prop] = setKeyframe(ch, local, value);
            } else {
              motion[prop] = value;
            }
            return { ...c, mask: { ...mask, motion } } as Clip;
          }),
        ),
      }),

    toggleClipMaskMotionKeyframe: (clipId, prop, timelineMs) => {
      const ids = targetsOf(clipId);
      withHistory((p) => {
        // The diamond reads the addressed clip, so its outcome - animate or
        // de-animate - is the one the whole selection follows. Toggling each
        // clip against its own state would leave a mixed selection flipping
        // back and forth forever.
        const lead = findClip(p, clipId)?.clip;
        const leadCh = lead?.mask?.motion?.[prop];
        if (!lead) return;
        const removing =
          Array.isArray(leadCh) &&
          leadCh.some((k) => Math.abs(k.t - (timelineMs - lead.timelineStartMs)) < 1);
        const identity: Record<MaskMotionProp, number> = { tx: 0, ty: 0, scale: 1, rotation: 0 };
        for (const id of ids) {
          const clip = findClip(p, id)?.clip;
          const mask = clip?.mask;
          if (!clip || !mask || !spansPlayhead(clip, timelineMs)) continue;
          const local = timelineMs - clip.timelineStartMs;
          const motion: MaskMotion = { ...(mask.motion ?? {}) };
          const ch = motion[prop];
          if (Array.isArray(ch) && ch.length) {
            // A key on the playhead is removed; otherwise one is added holding
            // the current sampled value, so toggling never makes the mask jump.
            motion[prop] = removing
              ? removeKeyframe(ch, local)
              : setKeyframe(ch, local, sampleChannel(ch, local));
          } else {
            if (removing) continue;
            const cur = typeof ch === 'number' ? ch : identity[prop];
            motion[prop] = setKeyframe([], local, cur);
          }
          clip.mask = { ...mask, motion };
        }
      });
    },

    addClipRedaction: (clipId, redaction) => {
      const id = uid();
      withHistory((p) => {
        const clip = findClip(p, clipId)?.clip;
        if (!clip) return;
        // Appended, so the list reads in the order the regions were added and a
        // new one never renumbers the ones already on screen.
        clip.redactions = [...(clip.redactions ?? []), { ...redaction, id }];
      });
      return id;
    },

    /**
     * Aimed at one redaction on one clip, never spread across the selection:
     * region ids are per clip, so "the same region" does not exist on a second
     * clip to apply the edit to.
     */
    setClipRedaction: (clipId, redactionId, patch) =>
      set({
        project: patchClips(
          get().project,
          new Map([
            [
              clipId,
              (c: Clip): Clip => {
                const list = c.redactions;
                if (!list?.some((r) => r.id === redactionId)) return c;
                return {
                  ...c,
                  redactions: list.map((r) => (r.id === redactionId ? { ...r, ...patch } : r)),
                } as Clip;
              },
            ],
          ]),
        ),
      }),

    removeClipRedaction: (clipId, redactionId) => {
      withHistory((p) => {
        const clip = findClip(p, clipId)?.clip;
        if (!clip?.redactions) return;
        const left = clip.redactions.filter((r) => r.id !== redactionId);
        // Dropped entirely rather than left as `[]`: an empty list would send
        // every frame of the clip through the redaction scratch for nothing.
        clip.redactions = left.length ? left : undefined;
      });
      if (get().selectedRedactionId === redactionId) set({ selectedRedactionId: null });
    },

    setClipRedactionMotionLive: (clipId, redactionId, prop, value, timelineMs) =>
      set({
        project: patchClips(
          get().project,
          new Map([
            [
              clipId,
              (c: Clip): Clip => {
                const list = c.redactions;
                const target = list?.find((r) => r.id === redactionId);
                if (!list || !target) return c;
                const local = timelineMs - c.timelineStartMs;
                const motion: MaskMotion = { ...(target.motion ?? {}) };
                const ch = motion[prop];
                // Same rule as the mask motion sliders: once the axis animates,
                // a drag writes the key under the playhead rather than a
                // constant that would wipe the tracked motion.
                if (Array.isArray(ch) && ch.length) {
                  if (!spansPlayhead(c, timelineMs)) return c;
                  motion[prop] = setKeyframe(ch, local, value);
                } else {
                  motion[prop] = value;
                }
                return {
                  ...c,
                  redactions: list.map((r) => (r.id === redactionId ? { ...r, motion } : r)),
                } as Clip;
              },
            ],
          ]),
        ),
      }),

    toggleClipRedactionMotionKeyframe: (clipId, redactionId, prop, timelineMs) => {
      withHistory((p) => {
        const clip = findClip(p, clipId)?.clip;
        const list = clip?.redactions;
        const target = list?.find((r) => r.id === redactionId);
        if (!clip || !list || !target || !spansPlayhead(clip, timelineMs)) return;
        const local = timelineMs - clip.timelineStartMs;
        const identity: Record<MaskMotionProp, number> = { tx: 0, ty: 0, scale: 1, rotation: 0 };
        const motion: MaskMotion = { ...(target.motion ?? {}) };
        const ch = motion[prop];
        if (Array.isArray(ch) && ch.length) {
          // A key on the playhead is removed; otherwise one is added holding the
          // current sampled value, so toggling never makes the region jump.
          motion[prop] = ch.some((k) => Math.abs(k.t - local) < 1)
            ? removeKeyframe(ch, local)
            : setKeyframe(ch, local, sampleChannel(ch, local));
        } else {
          motion[prop] = setKeyframe([], local, typeof ch === 'number' ? ch : identity[prop]);
        }
        clip.redactions = list.map((r) => (r.id === redactionId ? { ...r, motion } : r));
      });
    },

    toggleClipKeyframe: (clipId, prop, timelineMs) => {
      const ids = targetsOf(clipId);
      withHistory((p) => {
        // Same rule as the mask diamond: the addressed clip decides, and the
        // rest of the selection follows that outcome.
        const lead = findClip(p, clipId)?.clip;
        if (!lead) return;
        const leadKeys = keyframesOf(lead, prop);
        const removing = !!leadKeys?.some(
          (k) => Math.abs(k.t - (timelineMs - lead.timelineStartMs)) < 1,
        );
        for (const id of ids) {
          const clip = findClip(p, id)?.clip;
          if (!clip || !spansPlayhead(clip, timelineMs)) continue;
          const local = timelineMs - clip.timelineStartMs;
          const existing = keyframesOf(clip, prop);
          if (existing) {
            // A key on the playhead is removed; otherwise one is added at the
            // value the property currently shows, so toggling never makes the
            // clip jump. Collapsing back to a constant on the last removal -
            // and where that constant has to be stored - is `writeChannel`'s
            // business.
            writeChannel(
              clip,
              prop,
              removing
                ? removeKeyframe(existing, local)
                : setKeyframe(existing, local, sampleChannel(existing, local)),
            );
          } else if (!removing) {
            // Not animated yet: enable it, seeding one keyframe at the current value.
            writeChannel(clip, prop, [{ t: local, value: staticValueOf(clip, prop) }]);
          }
        }
      });
    },

    moveClipKeyframes: (clipId, fromT, toT) =>
      set({
        project: patchClips(
          get().project,
          new Map([
            [
              clipId,
              (c: Clip): Clip => {
                const animated = animatedProps(c);
                if (!animated.length) return c;
                const dest = Math.max(0, Math.min(clipDurationMs(c), toT));
                // Cloned before mutating: `writeChannel` writes into the clip it
                // is given, and this path is outside the immer draft.
                const next = { ...c } as Clip;
                let changed = false;
                for (const { prop, keys } of animated) {
                  if (!keys.some((k) => Math.abs(k.t - fromT) < 1)) continue;
                  writeChannel(
                    next,
                    prop,
                    keys
                      .map((k) => (Math.abs(k.t - fromT) < 1 ? { ...k, t: dest } : k))
                      .sort((a, b) => a.t - b.t),
                  );
                  changed = true;
                }
                return changed ? next : c;
              },
            ],
          ]),
        ),
      }),

    setClipKeyframesEase: (clipId, atT, ease) => {
      const ids = targetsOf(clipId);
      withHistory((p) => {
        const lead = findClip(p, clipId)?.clip;
        if (!lead) return;
        // `atT` is local to the addressed clip: re-read it as a timeline instant
        // so the other selected clips re-ease the column under the SAME
        // playhead rather than at their own offset into the same number.
        const timelineMs = lead.timelineStartMs + atT;
        for (const id of ids) {
          const clip = findClip(p, id)?.clip;
          if (!clip) continue;
          const local = timelineMs - clip.timelineStartMs;
          // Both families: a column under the playhead can hold a scale key and a
          // contrast key, and the picker re-eases the column, not one of them.
          for (const { keys } of animatedProps(clip)) {
            const k = keys.find((kk) => Math.abs(kk.t - local) < 1);
            if (k) k.ease = ease;
          }
        }
      });
    },

    moveClip: (clipId, timelineStartMs, targetTrackId) => {
      const p = get().project;
      const found = findClip(p, clipId);
      if (!found) return;
      const start = Math.max(0, timelineStartMs);
      const delta = start - found.clip.timelineStartMs;
      // Linked partners follow the same time delta, staying on their own track.
      const shiftBy = shiftEdits(linkedPartnerIds(p, clipId), delta);
      const target =
        targetTrackId && targetTrackId !== found.track.id
          ? p.tracks.find((t) => t.id === targetTrackId)
          : undefined;
      if (target && target.kind === found.track.kind) {
        const moved: Clip = { ...found.clip, timelineStartMs: start, trackId: target.id };
        const tracks = p.tracks.map((t) => {
          if (t.id === found.track.id) return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
          if (t.id === target.id) return { ...t, clips: [...t.clips, moved] };
          return t;
        });
        const next: Project = { ...p, tracks };
        set({ project: shiftBy.size ? patchClips(next, shiftBy) : next });
        return;
      }
      if (delta === 0) return;
      const edits = new Map(shiftBy);
      edits.set(clipId, (c: Clip) => ({ ...c, timelineStartMs: start }));
      set({ project: patchClips(p, edits) });
    },

    moveClips: (entries) => {
      const p = get().project;
      const inSet = new Set(entries.map((e) => e.clipId));
      const edits = new Map<string, (c: Clip) => Clip>();
      for (const { clipId, timelineStartMs } of entries) {
        const start = Math.max(0, timelineStartMs);
        edits.set(clipId, (c) => (c.timelineStartMs === start ? c : { ...c, timelineStartMs: start }));
        const found = findClip(p, clipId);
        if (!found) continue;
        // Drag a linked clip's partner along, unless it is already moving on its own.
        const delta = start - found.clip.timelineStartMs;
        for (const [id, edit] of shiftEdits(linkedPartnerIds(p, clipId), delta)) {
          if (!inSet.has(id) && !edits.has(id)) edits.set(id, edit);
        }
      }
      set({ project: patchClips(p, edits) });
    },

    trimClip: (clipId, edge, timelineMs) => {
      const assets = get().assets;
      const edit = (clip: Clip): Clip => {
        const asset = assets[clip.assetId];
        const minSourceSpan = MIN_CLIP_DURATION_MS * clip.speed;
        // A clip with no fixed-length media - a generated clip (text, solid,
        // shape) or a still - has no source to run out of, on either side.
        const unbounded = !asset || asset.kind === 'image';
        if (edge === 'left') {
          const proposed = Math.max(0, timelineMs);
          const sourceIn = clip.sourceInMs + (proposed - clip.timelineStartMs) * clip.speed;
          if (unbounded && sourceIn < 0) {
            // Nothing to reveal, so the left edge LENGTHENS the clip instead of
            // stopping at source 0: keep the right edge and the source window's
            // head where they are, and grow the window to cover the new span.
            const endMs = clipEndMs(clip);
            const start = Math.min(proposed, endMs - MIN_CLIP_DURATION_MS);
            if (start === clip.timelineStartMs) return clip;
            return {
              ...clip,
              timelineStartMs: start,
              sourceInMs: 0,
              sourceOutMs: (endMs - start) * clip.speed,
            };
          }
          const clamped = clamp(sourceIn, 0, clip.sourceOutMs - minSourceSpan);
          if (clamped === clip.sourceInMs) return clip;
          return {
            ...clip,
            timelineStartMs: clip.timelineStartMs + (clamped - clip.sourceInMs) / clip.speed,
            sourceInMs: clamped,
          };
        }
        let sourceOut = clip.sourceInMs + (timelineMs - clip.timelineStartMs) * clip.speed;
        // A still has no intrinsic duration: its clips stretch without bound.
        const maxOut = unbounded ? Infinity : asset.durationMs;
        sourceOut = clamp(sourceOut, clip.sourceInMs + minSourceSpan, maxOut);
        if (sourceOut === clip.sourceOutMs) return clip;
        return { ...clip, sourceOutMs: sourceOut };
      };
      const p = get().project;
      // Linked partners share the source geometry, so the same edit trims the
      // extracted audio in lockstep with the video (and vice versa).
      const edits = new Map<string, (c: Clip) => Clip>([[clipId, edit]]);
      for (const id of sourceLinkedIds(p, clipId)) edits.set(id, edit);
      set({ project: patchClips(p, edits) });
    },

    slipClip: (clipId, sourceInMs) => {
      const assets = get().assets;
      // Slide the source window under a fixed timeline footprint: position and
      // duration never change, only which part of the media plays.
      const edit = (clip: Clip): Clip => {
        const asset = assets[clip.assetId];
        // A still always shows the same frame: there is nothing to slip.
        if (!asset || asset.kind === 'image') return clip;
        const span = clip.sourceOutMs - clip.sourceInMs;
        const nextIn = clamp(sourceInMs, 0, asset.durationMs - span);
        if (nextIn === clip.sourceInMs) return clip;
        return { ...clip, sourceInMs: nextIn, sourceOutMs: nextIn + span };
      };
      const p = get().project;
      // Linked partners share the source geometry: slip both sides in lockstep.
      const edits = new Map<string, (c: Clip) => Clip>([[clipId, edit]]);
      for (const id of sourceLinkedIds(p, clipId)) edits.set(id, edit);
      set({ project: patchClips(p, edits) });
    },

    cloneClipsForDrag: (clipIds) => {
      // Ctrl+drag (Vegas-style copy drag): clone the clips in place - the drag
      // then moves the clones while the originals stay put. Linked partners are
      // cloned along, re-paired under a fresh linkId per group. No history here:
      // the caller's begin/endGesture makes clone+move one undo step.
      const p = get().project;
      const all = withLinkedIds(p, clipIds);
      const idMap: Record<string, string> = {};
      const linkMap = new Map<string, string>();
      const tracks = p.tracks.map((track) => {
        const copies: Clip[] = [];
        for (const clip of track.clips) {
          if (!all.includes(clip.id)) continue;
          const copy: Clip = { ...cloneClip(clip), id: uid('clip') };
          if (clip.linkId) {
            let nextLink = linkMap.get(clip.linkId);
            if (!nextLink) {
              nextLink = uid('link');
              linkMap.set(clip.linkId, nextLink);
            }
            copy.linkId = nextLink;
          }
          idMap[clip.id] = copy.id;
          copies.push(copy);
        }
        return copies.length ? { ...track, clips: [...track.clips, ...copies] } : track;
      });
      const primaries = clipIds.map((id) => idMap[id]).filter((id): id is string => !!id);
      set({
        project: { ...p, tracks },
        selectedClipIds: primaries,
        selectedClipId: primaries[primaries.length - 1] ?? null,
        cropEditing: false,
        selectedRedactionId: null,
      });
      return idMap;
    },

    splitAtPlayhead: () => {
      const { currentTimeMs, selectedClipId, project } = get();
      // Keep the playhead a frame away from both edges - the razor can cut on
      // any frame but the first and the last, which would produce an empty half.
      // The tolerance absorbs float drift: a frame boundary is 16.666…ms, so an
      // exactly-one-frame-in playhead must not miss the comparison by an ulp.
      const eps = MIN_CLIP_DURATION_MS / 1000;
      const crosses = (clip: Clip) =>
        currentTimeMs >= clip.timelineStartMs + MIN_CLIP_DURATION_MS - eps &&
        currentTimeMs <= clipEndMs(clip) - MIN_CLIP_DURATION_MS + eps;
      // Target: the selected clip if the playhead is inside it, otherwise every clip under it.
      const collect = (onlySelected: boolean): string[] => {
        const out: string[] = [];
        for (const track of project.tracks) {
          for (const clip of track.clips) {
            if (crosses(clip) && (!onlySelected || clip.id === selectedClipId)) out.push(clip.id);
          }
        }
        return out;
      };
      let targets = selectedClipId ? collect(true) : [];
      if (targets.length === 0) targets = collect(false);
      // A linked clip splits together with its partner, so long as the playhead
      // crosses it too - otherwise the halves would desync.
      const targetSet = new Set(targets);
      for (const id of targets) {
        for (const pid of linkedPartnerIds(project, id)) {
          const partner = findClip(project, pid)?.clip;
          if (partner && crosses(partner)) targetSet.add(pid);
        }
      }
      if (targetSet.size === 0) return;
      withHistory((p) => {
        // Each linked group's right halves get one fresh linkId, so a split pair
        // stays paired with its own side instead of all four sharing one link.
        const relink = new Map<string, string>();
        for (const track of p.tracks) {
          const additions: Clip[] = [];
          for (const clip of track.clips) {
            if (!targetSet.has(clip.id)) continue;
            const splitSource = timelineToSourceMs(clip, currentTimeMs);
            const right: Clip = {
              ...cloneClip(clip),
              id: uid('clip'),
              timelineStartMs: currentTimeMs,
              sourceInMs: splitSource,
              fadeInMs: 0,
            };
            if (clip.linkId) {
              let nextLink = relink.get(clip.linkId);
              if (!nextLink) {
                nextLink = uid('link');
                relink.set(clip.linkId, nextLink);
              }
              right.linkId = nextLink;
            }
            clip.sourceOutMs = splitSource;
            clip.fadeOutMs = 0;
            additions.push(right);
          }
          track.clips.push(...additions);
        }
      });
      announce('a11y.announce.split', { count: targetSet.size });
    },

    deleteClip: (clipId) => get().deleteClips([clipId], false),

    deleteClips: (clipIds, ripple) => {
      if (clipIds.length === 0) return;
      // Deleting one side of an A/V link removes its partner too.
      const targets = withLinkedIds(get().project, clipIds);
      withHistory((p) => {
        for (const track of p.tracks) {
          // Right-to-left so each ripple shift leaves the earlier targets in place.
          const doomed = track.clips
            .filter((c) => targets.includes(c.id))
            .sort((a, b) => b.timelineStartMs - a.timelineStartMs);
          for (const clip of doomed) {
            const start = clip.timelineStartMs;
            const gap = clipDurationMs(clip);
            track.clips = track.clips.filter((c) => c.id !== clip.id);
            if (ripple) {
              for (const c of track.clips) {
                if (c.timelineStartMs >= start) {
                  c.timelineStartMs = Math.max(0, c.timelineStartMs - gap);
                }
              }
            }
          }
        }
      });
      pruneSelection();
      announce('a11y.announce.deleted', { count: targets.length });
    },

    duplicateClips: (clipIds) => {
      const project = get().project;
      // Whole linked groups, deduped: duplicating half an A/V pair would leave
      // an orphan audio clip behind.
      const ids = new Set<string>();
      for (const id of clipIds) {
        if (!findClip(project, id)) continue;
        ids.add(id);
        for (const partner of linkedPartnerIds(project, id)) ids.add(partner);
      }
      if (ids.size === 0) return;

      // The copy lands right after the block it came from, keeping the block's
      // internal shape (one clip: right after itself, as before).
      const clips = [...ids].map((id) => findClip(project, id)!.clip);
      const shiftMs =
        Math.max(...clips.map(clipEndMs)) - Math.min(...clips.map((c) => c.timelineStartMs));

      // Fresh link ids, so the duplicate is a pair of its own.
      const linkIds = new Map<string, string>();
      const newIds: string[] = [];
      withHistory((p) => {
        for (const id of ids) {
          const found = findClip(p, id);
          if (!found) continue;
          const copy: Clip = {
            ...cloneClip(found.clip),
            id: uid('clip'),
            timelineStartMs: found.clip.timelineStartMs + shiftMs,
          };
          if (found.clip.linkId) {
            const next = linkIds.get(found.clip.linkId) ?? uid('link');
            linkIds.set(found.clip.linkId, next);
            copy.linkId = next;
          } else {
            delete copy.linkId;
          }
          newIds.push(copy.id);
          found.track.clips.push(copy);
        }
      });
      if (newIds.length) {
        set({ selectedClipId: newIds[newIds.length - 1]!, selectedClipIds: newIds });
      }
    },

    unlinkClip: (clipId) => {
      const partners = linkedPartnerIds(get().project, clipId);
      if (partners.length === 0) return;
      const ids = new Set([clipId, ...partners]);
      // Whether the group delegated its sound at all: a group of video clips
      // alone never did, so unlinking it must not silence anything.
      const wasDelegating = delegatedLinkIds(get().project).has(
        findClip(get().project, clipId)!.clip.linkId!,
      );
      withHistory((p) => {
        for (const track of p.tracks) {
          for (const clip of track.clips) {
            if (!ids.has(clip.id)) continue;
            // The extracted audio stays on the audio clips, so silence the video
            // side (volume 0) - otherwise dropping the link would double the
            // sound. The user can raise it again or delete either clip freely.
            if (wasDelegating && track.kind === 'video') clip.volume = 0;
            delete clip.linkId;
          }
        }
      });
    },

    linkClips: (clipIds) => {
      const ids = new Set(clipIds);
      if (ids.size < 2) return;
      // Join the given clips into one link group, so they move/trim/split/delete
      // together again. A group is generic: any number of clips on video and
      // audio tracks, no master side. When some of them already share a group,
      // reuse that id so the others are ADDED to it rather than re-grouped under
      // a new id (which would orphan the members left out of the selection).
      // The mix already mutes the video side of a group that holds audio, so no
      // volume change is needed here - if the video was silenced by a prior
      // unlink it simply stays delegated.
      const existing = new Set<string>();
      for (const track of get().project.tracks) {
        for (const clip of track.clips) {
          if (ids.has(clip.id) && clip.linkId != null) existing.add(clip.linkId);
        }
      }
      // Straddling two groups would silently merge them - refuse.
      if (existing.size > 1) return;
      const linkId = existing.size === 1 ? [...existing][0]! : uid('link');
      withHistory((p) => {
        for (const track of p.tracks) {
          for (const clip of track.clips) {
            if (ids.has(clip.id)) clip.linkId = linkId;
          }
        }
      });
    },

    punchZoomSelected: () => {
      const { selectedClipId, currentTimeMs, project } = get();
      // Fall back to the topmost video clip under the playhead, so the
      // J/K/L → S → P flow works without ever touching the mouse.
      let targetId = selectedClipId;
      if (!targetId) {
        for (const track of project.tracks) {
          if (track.kind !== 'video') continue;
          const hit = track.clips.find(
            (c) => currentTimeMs >= c.timelineStartMs && currentTimeMs < clipEndMs(c),
          );
          if (hit) {
            targetId = hit.id;
            break;
          }
        }
      }
      if (!targetId) return;
      // Punching in is a property change like any other: with several clips
      // selected they all step to the same rung of the ladder, which the
      // primary clip's current scale picks.
      const ids = targetsOf(targetId);
      withHistory((p) => {
        const lead = findClip(p, targetId!)?.clip;
        if (!lead) return;
        const leadScale = (lead.transform ?? DEFAULT_TRANSFORM).scale;
        const next = leadScale < 1.1 ? 1.2 : leadScale < 1.3 ? 1.4 : 1;
        for (const id of ids) {
          const found = findClip(p, id);
          if (!found) continue;
          const tf = found.clip.transform ?? structuredClone(DEFAULT_TRANSFORM);
          found.clip.transform = { ...tf, scale: next };
        }
      }, targetId);
      // The fallback path selects what it acted on; an existing selection stays
      // whole rather than collapsing onto its primary.
      if (get().selectedClipIds.length === 0) {
        set({ selectedClipId: targetId, selectedClipIds: [targetId] });
      }
    },

    addSubtitleClips: (cues, anchorAssetId, replaceClipIds) => {
      if (cues.length === 0) return;
      withHistory((p) => {
        const captionY = CAPTION_Y[p.aspectRatio];
        // Out with the previous pass first, so a regenerated track replaces the
        // old cues instead of stacking a second lane of them on top.
        if (replaceClipIds?.length) {
          const doomed = new Set(replaceClipIds);
          const emptied = new Set<string>();
          for (const track of p.tracks) {
            const kept = track.clips.filter((c) => !doomed.has(c.id));
            if (kept.length === track.clips.length) continue;
            track.clips = kept;
            if (kept.length === 0) emptied.add(track.id);
          }
          // A caption lane emptied by that filter has nothing left to say: drop
          // it rather than leave a bare track header behind. Only lanes this
          // replacement emptied - an empty lane the user just added by hand is
          // theirs, not ours to collect.
          p.tracks = p.tracks.filter((track) => !emptied.has(track.id));
        }
        // Captions always live on their own dedicated video track, composited
        // above any footage. Z-order = array order the way the timeline shows
        // it: index 0 is the top lane and paints last, so the caption track is
        // inserted BEFORE its footage, not pushed to the end.
        const track: Track = { id: uid('track'), kind: 'video', clips: [] };
        // Embedded tracks know the asset they came from: sit right on top of
        // the lane carrying it, so captions and footage read as a pair. A
        // loose .srt has no anchor and goes above every video lane.
        const anchorIdx = anchorAssetId
          ? p.tracks.findIndex(
              (t) => t.kind === 'video' && t.clips.some((c) => c.assetId === anchorAssetId),
            )
          : -1;
        // Captions extracted from a container start out A/V-linked to the
        // footage they were burned alongside, so dragging the shot carries its
        // subtitles instead of desyncing them. Joining the picture clip's
        // existing group (rather than making a new one) keeps any extracted
        // audio in the same set. Unlink breaks it when the user wants the
        // captions to stand alone.
        let linkId: string | undefined;
        if (anchorIdx >= 0) {
          const anchor = p.tracks[anchorIdx]!.clips
            .filter((c) => c.assetId === anchorAssetId)
            .sort((a, b) => a.timelineStartMs - b.timelineStartMs)[0];
          if (anchor) {
            linkId = anchor.linkId ?? uid('link');
            anchor.linkId = linkId;
          }
        }
        const firstVideoIdx = p.tracks.findIndex((t) => t.kind === 'video');
        const at = anchorIdx >= 0 ? anchorIdx : firstVideoIdx >= 0 ? firstVideoIdx : 0;
        p.tracks.splice(at, 0, track);
        for (const cue of cues) {
          track.clips.push({
            kind: 'text',
            id: uid('clip'),
            assetId: '',
            trackId: track.id,
            ...(linkId ? { linkId } : {}),
            timelineStartMs: cue.startMs,
            sourceInMs: 0,
            sourceOutMs: Math.max(MIN_CLIP_DURATION_MS, cue.endMs - cue.startMs),
            speed: 1,
            volume: 1,
            fadeInMs: 0,
            fadeOutMs: 0,
            // Caption defaults: outlined, slightly smaller than a title, in the
            // band the file asked for (lower third unless it says otherwise).
            transform: { ...structuredClone(DEFAULT_TRANSFORM), y: captionY[cue.vAlign ?? 'bottom'] },
            text: {
              content: cue.text,
              color: '#ffffff',
              sizeFrac: 0.05,
              bold: true,
              outline: true,
              // Left undefined when the file states nothing: centered captions.
              ...(cue.align ? { align: cue.align } : {}),
            },
          });
        }
      }, null);
    },

    applyStreamLayout: (clipId) => {
      const state = get();
      const found = findClip(state.project, clipId);
      const asset = found ? state.assets[found.clip.assetId] : undefined;
      if (!found || found.track.kind !== 'video' || !asset?.width || !asset?.height) return;
      const { width: outW, height: outH } = outputDimensions(state.project.aspectRatio);
      const srcW = asset.width;
      const srcH = asset.height;

      /** Transform that makes `crop` COVER a zone centered at (cx,cy), sized w×h (output px). */
      const coverZone = (
        crop: ClipTransform['crop'],
        cx: number,
        cy: number,
        w: number,
        h: number,
      ): ClipTransform => {
        const cropW = Math.max(1, crop.w * srcW);
        const cropH = Math.max(1, crop.h * srcH);
        const fit = Math.min(outW / cropW, outH / cropH);
        const scale = Math.max(w / (cropW * fit), h / (cropH * fit));
        return { crop, x: cx / outW, y: cy / outH, scale };
      };

      // Facecam: top-left corner of the source by default (adjust in crop mode).
      const camCrop = { x: 0, y: 0, w: 0.3, h: 0.35 };
      // Gameplay: centered band matching the bottom zone's aspect ratio.
      const zoneH = outH * 0.7;
      const gameW = Math.min(1, (outW / zoneH) * (srcH / srcW));
      const gameCrop = { x: (1 - gameW) / 2, y: 0, w: gameW, h: 1 };

      const camClipId = uid('clip');
      withHistory((p) => {
        const inner = findClip(p, clipId);
        if (!inner) return;
        // Gameplay stays on its track, filling the bottom zone.
        inner.clip.transform = coverZone(gameCrop, outW / 2, outH * 0.3 + zoneH / 2, outW, zoneH);
        // Facecam duplicate on a NEW track above (captions/titles keep their own).
        const camTrack: Track = { id: uid('track'), kind: 'video', clips: [] };
        const idx = p.tracks.findIndex((t) => t.id === inner.track.id);
        p.tracks.splice(idx, 0, camTrack);
        camTrack.clips.push({
          ...cloneClip(inner.clip),
          id: camClipId,
          trackId: camTrack.id,
          // The facecam layer is a picture layer: it must not add audio on top.
          volume: 0,
          transform: coverZone(camCrop, outW / 2, (outH * 0.3) / 2, outW, outH * 0.3),
        });
      }, clipId);
      set({ selectedClipId: camClipId, selectedClipIds: [camClipId], cropEditing: true });
    },

    setCropEditing: (v) => set({ cropEditing: v }),
  };
}
