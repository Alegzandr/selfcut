import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import type { Clip, CompClip, Composition, Project, Track } from '../../types';
import {
  clipEndMs,
  cloneClip,
  compIdOfClip,
  compUsages,
  DEFAULT_COMP_COLOR,
  DEFAULT_TRANSFORM,
  findComp,
  forEachTrackSet,
  isCompClip,
  scaleClipAnimation,
  shiftClipAnimation,
  tracksDurationMs,
  tracksOf,
  uniqueCompName,
  wouldNest,
  type CompId,
} from '../../model';
import { ensureTrack, findClip, withLinkedIds } from '../projectOps';
import { uid } from '../../lib/id';
import { MIN_CLIP_DURATION_MS } from '../../app/config';
import { t as translate } from '../../i18n';

/**
 * Precomposition: wrapping a run of clips into a composition of its own, opening
 * one to edit it, and dissolving one back into its parent.
 *
 * The navigation half lives here too (`openComp`, `revealClip`) because it is
 * inseparable from the edits: precomposing walks you into the new composition's
 * neighbourhood, deleting the one you are standing in has to walk you back out,
 * and both must land the playhead somewhere that makes sense.
 *
 * Everything that reads "which timeline am I editing" goes through the store's
 * `lanes`/`host` helpers, so no other slice had to learn that compositions
 * exist - see `sliceHelpers.ts`.
 */

/**
 * Where the playhead was left in each composition, so stepping out of a precomp
 * and back in returns to the frame you were working on.
 *
 * Module state rather than store state: nothing renders off it (it is read once,
 * at the moment of navigating) and a commit per keystroke of the transport would
 * buy nothing. Keyed by composition id, with the empty string standing for the
 * root - a Map keyed by `null` reads worse than one keyed by a sentinel.
 */
const parkedPlayhead = new Map<string, number>();
const ROOT_KEY = '';

const keyOf = (compId: CompId): string => compId ?? ROOT_KEY;

/** Track fields a precomposed lane keeps: what it SOUNDS and LOOKS like. */
function carryTrackLook(track: Track): Partial<Track> {
  // Monitoring states (mute, hide, solo, lock) stay with the parent lane: they
  // are how the user is listening right now, not part of the cut, and a lane
  // muted while auditioning must not come out of a precompose permanently
  // silent inside a composition nobody can see into.
  const look: Partial<Track> = {};
  if (track.name !== undefined) look.name = track.name;
  if (track.volume !== undefined) look.volume = track.volume;
  if (track.opacity !== undefined) look.opacity = track.opacity;
  if (track.color !== undefined) look.color = JSON.parse(JSON.stringify(track.color));
  if (track.audioFx !== undefined) look.audioFx = JSON.parse(JSON.stringify(track.audioFx));
  return look;
}

/** A fresh comp clip playing a composition whole, from `startMs`. */
function buildCompClip(
  compId: string,
  trackId: string,
  startMs: number,
  durationMs: number,
): CompClip {
  return {
    kind: 'comp',
    id: uid('clip'),
    compId,
    assetId: '',
    trackId,
    timelineStartMs: Math.max(0, startMs),
    sourceInMs: 0,
    sourceOutMs: Math.max(MIN_CLIP_DURATION_MS, durationMs),
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
  };
}

/**
 * The attributes a comp clip carries that only exist because it is ONE layer.
 *
 * Dissolving it back into the parent spreads its content over many layers again,
 * and there is no honest place to put a grade, a mask or a fade that was applied
 * to the group as a whole - so the editor names them and asks before dropping
 * them, rather than losing them quietly.
 */
function carriedAttributes(clip: Clip): boolean {
  return !!(
    clip.color ||
    clip.mask ||
    clip.redactions?.length ||
    clip.localAdjusts?.length ||
    clip.animation ||
    clip.velocity ||
    clip.audioFx?.length ||
    clip.fadeInMs > 0 ||
    clip.fadeOutMs > 0 ||
    clip.volume !== 1 ||
    clip.speed !== 1 ||
    (clip.zoomEnd ?? 1) !== 1 ||
    isFramed(clip)
  );
}

/** Whether a clip's transform has been moved off the untouched default. */
function isFramed(clip: Clip): boolean {
  const t = clip.transform;
  if (!t) return false;
  const d = DEFAULT_TRANSFORM;
  return (
    t.x !== d.x ||
    t.y !== d.y ||
    t.scale !== d.scale ||
    (t.scaleX ?? 1) !== 1 ||
    (t.scaleY ?? 1) !== 1 ||
    (t.rotation ?? 0) !== 0 ||
    t.crop.x !== d.crop.x ||
    t.crop.y !== d.crop.y ||
    t.crop.w !== d.crop.w ||
    t.crop.h !== d.crop.h
  );
}

/** Deep-copy a composition's lanes with brand-new track and clip ids. */
function cloneTracks(tracks: Track[]): Track[] {
  return tracks.map((track) => {
    const id = uid('track');
    // Link groups are remapped as a set, not per clip: a video and its audio
    // must land in the SAME new group or the copy comes out unlinked.
    return { ...track, id, clips: track.clips.map((clip) => ({ ...cloneClip(clip), id: uid('clip'), trackId: id })) };
  });
}

/** Give a cloned stack of lanes fresh link ids, keeping the groups intact. */
function remapLinks(tracks: Track[]): void {
  const map = new Map<string, string>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.linkId == null) continue;
      let next = map.get(clip.linkId);
      if (!next) {
        next = uid('link');
        map.set(clip.linkId, next);
      }
      clip.linkId = next;
    }
  }
}

export function createCompsSlice(
  set: StoreSet,
  get: StoreGet,
  { withHistory, setLanes, host }: SliceHelpers,
): Pick<
  EditorState,
  | 'openComp'
  | 'precompose'
  | 'decompose'
  | 'compAttributesLost'
  | 'renameComp'
  | 'setCompColor'
  | 'duplicateComp'
  | 'removeComp'
  | 'addCompClip'
  | 'addCompClipAt'
  | 'revealClip'
  | 'setRenamingComp'
> {
  /** Move the editor into a composition, parking the playhead it is leaving. */
  const navigate = (compId: CompId, at?: number) => {
    const state = get();
    if (state.activeCompId === compId && at === undefined) return;
    parkedPlayhead.set(keyOf(state.activeCompId), state.currentTimeMs);
    const resumeAt = at ?? parkedPlayhead.get(keyOf(compId)) ?? 0;
    set({
      activeCompId: compId,
      // A selection is a set of clips on ONE timeline: carrying it across would
      // leave the inspector editing something the user can no longer see.
      selectedClipId: null,
      selectedClipIds: [],
      selectedKeyframes: [],
      inspectorOpen: false,
      currentTimeMs: Math.max(0, resumeAt),
      // Every timeline has its own length, so a loop taken on one is meaningless
      // on the next.
      loopRegion: null,
      renamingCompId: null,
      // Force the preview to re-seek: the frame on screen belongs to the
      // timeline being left, and nothing about the time alone says so.
      seekVersion: state.seekVersion + 1,
      playing: false,
    });
  };

  return {
    openComp: (compId) => {
      if (compId !== null && !findComp(get().project, compId)) return;
      navigate(compId);
    },

    setRenamingComp: (compId) => set({ renamingCompId: compId }),

    precompose: (clipIds, name) => {
      const state = get();
      const project = state.project;
      const activeCompId = state.activeCompId;
      const sourceTracks = tracksOf(project, activeCompId);
      // Linked partners come along: precomposing a shot without the sound that
      // belongs to it would leave a link group straddling two timelines, which
      // is a group no gesture can move as a unit any more.
      const wanted = new Set(
        withLinkedIds(project, clipIds ?? state.selectedClipIds).filter((id) => {
          const found = findClip(project, id);
          return !!found && sourceTracks.includes(found.track);
        }),
      );
      if (wanted.size === 0) return null;

      const compId = uid('comp');
      let compClipId = '';
      withHistory((p) => {
        const from = tracksOf(p, activeCompId);
        // Contributing lanes in z-order, so the composition comes out stacked
        // exactly as it looked in the parent.
        const contributors = from.filter((track) => track.clips.some((c) => wanted.has(c.id)));
        const moved = contributors.flatMap((track) => track.clips.filter((c) => wanted.has(c.id)));
        const originMs = Math.min(...moved.map((c) => c.timelineStartMs));

        const compTracks: Track[] = contributors.map((track) => {
          const id = uid('track');
          return {
            ...carryTrackLook(track),
            id,
            kind: track.kind,
            clips: track.clips
              .filter((c) => wanted.has(c.id))
              .map((c) => ({
                ...cloneClip(c),
                trackId: id,
                // The earliest clip of the selection becomes time 0 inside the
                // composition: a precomp that starts with ten seconds of nothing
                // is a precomp whose every trim is off by ten seconds.
                timelineStartMs: c.timelineStartMs - originMs,
              })),
          };
        });

        const comp: Composition = {
          id: compId,
          name: name?.trim() || uniqueCompName(p, translate('comp.defaultName')),
          tracks: compTracks,
          markers: [],
          color: DEFAULT_COMP_COLOR,
        };
        (p.comps ??= []).push(comp);

        // Take the clips out of the parent, then drop the lanes the move left
        // empty - a precompose that leaves three bare lanes behind has not
        // really collapsed anything.
        const emptied = new Set<string>();
        for (const track of from) {
          const before = track.clips.length;
          if (before === 0) continue;
          track.clips = track.clips.filter((c) => !wanted.has(c.id));
          if (track.clips.length === 0) emptied.add(track.id);
        }

        // The comp clip is a picture layer, so it wants the topmost VIDEO lane
        // that contributed. An audio-only selection has no such lane and keeps
        // its own kind, which is exactly right: the composition it wraps has no
        // picture either.
        const target =
          contributors.find((track) => track.kind === 'video') ?? contributors[0]!;
        emptied.delete(target.id);
        setLanes(
          p,
          tracksOf(p, activeCompId).filter((track) => !emptied.has(track.id)),
        );

        const clip = buildCompClip(compId, target.id, originMs, tracksDurationMs(compTracks));
        compClipId = clip.id;
        target.clips.push(clip);
      }, null);

      set({ selectedClipId: compClipId, selectedClipIds: [compClipId] });
      return compId;
    },

    compAttributesLost: (clipId) => {
      const found = findClip(get().project, clipId);
      return !!found && isCompClip(found.clip) && carriedAttributes(found.clip);
    },

    decompose: (clipId) => {
      const state = get();
      const found = findClip(state.project, clipId);
      if (!found || !isCompClip(found.clip)) return;
      const hostCompId = compIdOfClip(state.project, clipId);
      if (hostCompId === undefined) return;
      const laid: string[] = [];

      withHistory((p) => {
        const target = findClip(p, clipId);
        if (!target || !isCompClip(target.clip)) return;
        const clip = target.clip;
        const comp = findComp(p, clip.compId);
        if (!comp) return;
        const parentTracks = tracksOf(p, hostCompId);
        const at = parentTracks.indexOf(target.track);
        const speed = clip.speed || 1;
        const startMs = clip.timelineStartMs;
        const endMs = clipEndMs(clip);

        // Take the comp clip out first: what lands in its place has to settle
        // against the rest of the lane, not against the layer it replaces.
        target.track.clips.splice(target.index, 1);

        // The composition's lanes are inserted ABOVE the comp clip's own lane,
        // in the order they had inside, so the stack that was collapsed comes
        // back out looking the way it went in.
        comp.tracks.forEach((inner, i) => {
          const lane: Track = { ...carryTrackLook(inner), id: uid('track'), kind: inner.kind, clips: [] };
          for (const source of inner.clips) {
            const placed = projectIntoParent(source, clip, speed, startMs, endMs);
            if (!placed) continue;
            placed.trackId = lane.id;
            lane.clips.push(placed);
            laid.push(placed.id);
          }
          if (lane.clips.length > 0) parentTracks.splice(Math.max(0, at) + i, 0, lane);
        });

        // The composition itself goes only when nothing plays it any more: it may
        // well be used elsewhere, and dissolving one instance must not take the
        // others with it.
        if (compUsages(p, clip.compId).length === 0) {
          p.comps = (p.comps ?? []).filter((c) => c.id !== clip.compId);
        }
      }, null);

      set({ selectedClipId: laid[laid.length - 1] ?? null, selectedClipIds: laid });
    },

    renameComp: (compId, name) => {
      const trimmed = name.trim();
      withHistory((p) => {
        const comp = findComp(p, compId);
        if (comp && trimmed) comp.name = trimmed;
      }, null);
      set({ renamingCompId: null });
    },

    setCompColor: (compId, color) => {
      withHistory((p) => {
        const comp = findComp(p, compId);
        if (comp) comp.color = color;
      }, null);
    },

    duplicateComp: (compId) => {
      const source = findComp(get().project, compId);
      if (!source) return null;
      const copyId = uid('comp');
      withHistory((p) => {
        const original = findComp(p, compId);
        if (!original) return;
        const tracks = cloneTracks(original.tracks);
        remapLinks(tracks);
        (p.comps ??= []).push({
          id: copyId,
          name: uniqueCompName(p, original.name),
          markers: original.markers.map((m) => ({ ...m, id: uid('marker') })),
          color: original.color,
          tracks,
        });
      }, null);
      return copyId;
    },

    removeComp: (compId) => {
      const state = get();
      // Standing inside what is about to disappear (or inside something that
      // only existed within it): step back out to the root first, so the editor
      // never renders a timeline that has been deleted.
      if (state.activeCompId === compId) navigate(null);
      withHistory((p) => {
        forEachTrackSet(p, (tracks) => {
          for (const track of tracks) {
            track.clips = track.clips.filter((c) => !(isCompClip(c) && c.compId === compId));
          }
        });
        p.comps = (p.comps ?? []).filter((c) => c.id !== compId);
      }, null);
      if (get().activeCompId !== null && !findComp(get().project, get().activeCompId!)) {
        navigate(null);
      }
    },

    addCompClip: (compId) => {
      const state = get();
      if (!canPlaceHere(state.project, state.activeCompId, compId)) {
        get().setNotice(translate('comp.cycleRefused'));
        return;
      }
      let newClipId = '';
      withHistory((p) => {
        const comp = findComp(p, compId);
        if (!comp) return;
        const track = ensureTrack(host(p), comp.tracks.some((t) => t.kind === 'video') ? 'video' : 'audio');
        const start = track.clips.reduce((max, c) => Math.max(max, clipEndMs(c)), 0);
        const clip = buildCompClip(compId, track.id, start, tracksDurationMs(comp.tracks));
        newClipId = clip.id;
        track.clips.push(clip);
      });
      if (newClipId) set({ selectedClipId: newClipId, selectedClipIds: [newClipId] });
    },

    addCompClipAt: (compId, timelineMs, targetTrackId) => {
      const state = get();
      if (!canPlaceHere(state.project, state.activeCompId, compId)) {
        get().setNotice(translate('comp.cycleRefused'));
        return;
      }
      const newClipId = uid('clip');
      withHistory((p) => {
        const comp = findComp(p, compId);
        if (!comp) return;
        const kind = comp.tracks.some((t) => t.kind === 'video') ? 'video' : 'audio';
        const track = ensureTrack(host(p), kind, targetTrackId);
        const clip = buildCompClip(compId, track.id, timelineMs, tracksDurationMs(comp.tracks));
        clip.id = newClipId;
        track.clips.push(clip);
      }, newClipId);
      set({ selectedClipId: newClipId, selectedClipIds: [newClipId] });
    },

    revealClip: (clipId) => {
      const state = get();
      const compId = compIdOfClip(state.project, clipId);
      if (compId === undefined) return;
      const clip = findClip(state.project, clipId)?.clip;
      if (compId !== state.activeCompId) navigate(compId, clip?.timelineStartMs ?? 0);
      set({ selectedClipId: clipId, selectedClipIds: [clipId] });
    },
  };

  /** Whether a composition may be laid down in the one currently open. */
  function canPlaceHere(project: Project, activeCompId: CompId, compId: string): boolean {
    return !wouldNest(project, activeCompId, compId);
  }

  /**
   * A clip from inside a composition, expressed on the PARENT timeline that was
   * playing it - the whole of what dissolving a comp clip has to compute.
   *
   * Composition time maps to parent time affinely (`parentMs = start +
   * (compMs - sourceIn) / speed`), so the clip's own speed simply multiplies and
   * its keyframes stretch by the same factor. What is left is the trim: the comp
   * clip may have been playing only a window of the composition, and a clip
   * sticking out of that window has to be cut back to it - or dropped when it
   * lies outside it entirely.
   *
   * Returns null when the clip was never on screen.
   */
  function projectIntoParent(
    source: Clip,
    compClip: CompClip,
    speed: number,
    windowStartMs: number,
    windowEndMs: number,
  ): Clip | null {
    const toParent = (compMs: number) =>
      compClip.timelineStartMs + (compMs - compClip.sourceInMs) / speed;
    const rawStart = toParent(source.timelineStartMs);
    const rawEnd = toParent(clipEndMs(source));
    const start = Math.max(rawStart, windowStartMs);
    const end = Math.min(rawEnd, windowEndMs);
    if (end - start < MIN_CLIP_DURATION_MS) return null;

    let clip = cloneClip(source);
    clip.id = uid('clip');
    // The nested clip now runs at the product of both rates. A velocity ramp
    // rides along untouched: its keys are multipliers OF `speed`, so scaling the
    // scalar scales the whole ramp with it.
    clip.speed = source.speed * speed;

    const headMs = start - rawStart;
    const tailMs = rawEnd - end;
    if (headMs > 0 || tailMs > 0) {
      // A ramped clip has no linear source window to cut into - the integral
      // that gives its duration is not invertible here - so it keeps its whole
      // source and gets clamped by the lane instead of silently mistrimmed.
      if (!source.velocity?.length) {
        const headSrc = headMs * clip.speed;
        const tailSrc = tailMs * clip.speed;
        clip.sourceInMs = source.sourceInMs + headSrc;
        clip.sourceOutMs = source.sourceOutMs - tailSrc;
      }
    }
    // Keyframes live in clip-local timeline ms: the head that was cut moves the
    // local origin, and the new rate stretches everything that is left.
    if (headMs > 0) clip = shiftClipAnimation(clip, -headMs * speed);
    if (speed !== 1) clip = scaleClipAnimation(clip, 1 / speed);
    clip.timelineStartMs = Math.max(0, start);
    return clip;
  }
}
