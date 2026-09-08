import type { Clip, CompClip, Composition, Marker, MarkerColor, Project, Track } from '../types';
import { clipEndMs } from './clip';

/**
 * Nested compositions ("precomps"): the tree the editor navigates and the math
 * the renderer needs to play one composition inside another.
 *
 * The project stores compositions FLAT (`Project.comps`) and expresses nesting
 * through the `CompClip`s that reference them. Everything shaped like a tree -
 * the breadcrumb, the cycle guard, the "where is this used" count, the reachable
 * set an export must walk - is derived here, in one place, so no other module
 * has to know that a composition can hold another one.
 *
 * Pure functions over a Project (or an Immer draft): no store access, no DOM.
 */

/**
 * The composition currently being edited is addressed by id, with `null`
 * standing for the project's own timeline - the root composition, which has no
 * entry in `comps` because it IS the project.
 */
export type CompId = string | null;

/** Accent colour a composition falls back to when it has none of its own. */
export const DEFAULT_COMP_COLOR: MarkerColor = 'violet';

/**
 * How deep the renderer will follow nested compositions before it gives up and
 * draws nothing.
 *
 * Cycles are already impossible (`wouldNest` refuses to create one), so this is
 * not a correctness guard - it is a cost guard. Each level costs a full-frame
 * scratch and a complete composite of everything inside it, so a chain of ten
 * precomps is ten 4K composites for one output frame. Eight is far past any
 * structure a cut actually has and still bounded.
 */
export const MAX_COMP_DEPTH = 8;

/**
 * Anything that owns one stack of tracks: the project's own timeline, or a
 * nested composition. Both shapes carry `tracks`, so every operation that adds
 * to or searches ONE stack takes this - which is what lets the same editing code
 * serve the main timeline and the precomp the user has open.
 */
export type TrackHost = Pick<Project, 'tracks'> | Composition;

/**
 * One timeline, whichever it is: its lanes and its own cues.
 *
 * Everything that reasons about a timeline as a whole - the snap points, a
 * keyframe box selection, a ripple across lanes - takes this rather than a
 * `Project`, so it works unchanged on the main cut and inside a precomp. Both
 * `Project` and `Composition` satisfy it as they are.
 */
export type TimelineView = Pick<Project, 'tracks' | 'markers'>;

/**
 * The stack of tracks an edit lands in, given the composition the editor has
 * open. Falls back to the project when the composition is gone, which only
 * happens for the single render between an undo removing it and the navigation
 * catching up.
 */
export function compHost(project: Project, compId: CompId): Project | Composition {
  if (compId === null) return project;
  return findComp(project, compId) ?? project;
}

/** A clip that plays a nested composition. */
export function isCompClip(clip: Clip): clip is CompClip {
  return clip.kind === 'comp';
}

/** The composition with this id, or undefined when it is gone. */
export function findComp(project: Project, compId: string): Composition | undefined {
  return project.comps?.find((c) => c.id === compId);
}

/**
 * The tracks of the composition being edited: the project's own when `compId` is
 * null (the root), the composition's otherwise.
 *
 * Returns the LIVE array, Immer draft included, so a caller inside a mutation
 * can push/splice into it exactly as it used to do with `project.tracks`. A
 * composition that no longer exists yields an empty array rather than throwing:
 * an undo can delete the composition the editor is standing in, and the editor
 * has to render one more time before the navigation catches up.
 */
export function tracksOf(project: Project, compId: CompId): Track[] {
  if (compId === null) return project.tracks;
  return findComp(project, compId)?.tracks ?? EMPTY_TRACKS;
}

const EMPTY_TRACKS: Track[] = [];

/**
 * Replace the track list of the composition being edited. The counterpart of
 * `tracksOf` for the handful of edits that rebuild the array rather than mutate
 * it (`p.tracks = p.tracks.filter(...)`).
 */
export function setTracksOf(project: Project, compId: CompId, tracks: Track[]): void {
  if (compId === null) {
    project.tracks = tracks;
    return;
  }
  const comp = findComp(project, compId);
  if (comp) comp.tracks = tracks;
}

/** The markers of the composition being edited (the project's own at the root). */
export function markersOf(project: Project, compId: CompId): Marker[] {
  if (compId === null) return project.markers;
  return findComp(project, compId)?.markers ?? EMPTY_MARKERS;
}

const EMPTY_MARKERS: Marker[] = [];

/** Replace the marker list of the composition being edited. */
export function setMarkersOf(project: Project, compId: CompId, markers: Marker[]): void {
  if (compId === null) {
    project.markers = markers;
    return;
  }
  const comp = findComp(project, compId);
  if (comp) comp.markers = markers;
}

/**
 * Every track list in the project, root first then one per composition - what a
 * whole-project pass (asset garbage collection, LUT rewrites, a `.selfcut`
 * import remapping ids) has to visit so nothing hidden inside a precomp is
 * missed.
 */
export function forEachTrackSet(project: Project, fn: (tracks: Track[], compId: CompId) => void): void {
  fn(project.tracks, null);
  for (const comp of project.comps ?? []) fn(comp.tracks, comp.id);
}

/** Every clip in the project, wherever it lives. Order is root first, then comps. */
export function forEachProjectClip(project: Project, fn: (clip: Clip, track: Track) => void): void {
  forEachTrackSet(project, (tracks) => {
    for (const track of tracks) for (const clip of track.clips) fn(clip, track);
  });
}

// Duration is asked for on every frame (the transport clamp, the ruler, the
// comp-clip retrim) and answering it means scanning a whole composition, so it
// is memoized on the track array's identity: copy-on-write keeps that reference
// stable until the composition is actually edited.
const compDurationCache = new WeakMap<Track[], number>();

/**
 * How long a composition runs: the end of its last clip. A composition has no
 * stored duration - it lasts exactly as long as what is in it, which is what
 * makes a freshly precomposed selection come out the length of the selection.
 */
export function tracksDurationMs(tracks: Track[]): number {
  const cached = compDurationCache.get(tracks);
  if (cached !== undefined) return cached;
  let max = 0;
  for (const track of tracks) {
    for (const clip of track.clips) max = Math.max(max, clipEndMs(clip));
  }
  compDurationCache.set(tracks, max);
  return max;
}

/** Duration of the composition being edited (the whole project at the root). */
export function compDurationMs(project: Project, compId: CompId): number {
  return tracksDurationMs(tracksOf(project, compId));
}

/**
 * The compositions a composition reaches, directly or through further nesting -
 * itself excluded. Used to refuse a nesting that would close a cycle and to
 * decide what an operation on a composition drags along with it.
 */
export function nestedCompIds(project: Project, compId: CompId, seen = new Set<string>()): Set<string> {
  for (const track of tracksOf(project, compId)) {
    for (const clip of track.clips) {
      if (!isCompClip(clip) || seen.has(clip.compId)) continue;
      seen.add(clip.compId);
      nestedCompIds(project, clip.compId, seen);
    }
  }
  return seen;
}

/**
 * Whether putting `compId` inside `hostId` would make a composition contain
 * itself - the one structure the renderer cannot survive.
 *
 * True when they are the same composition, and true when the host is already
 * somewhere inside the candidate. Every action that creates a `CompClip` asks
 * this first; nothing downstream then has to defend against a cycle.
 */
export function wouldNest(project: Project, hostId: CompId, compId: string): boolean {
  if (hostId === compId) return true;
  if (hostId === null) return false;
  return nestedCompIds(project, compId).has(hostId);
}

/** One step of the breadcrumb: a composition and the clip the parent plays it with. */
export interface CompCrumb {
  compId: CompId;
  /** The composition's name, or the project's for the root step. */
  name: string;
  color?: MarkerColor;
  /** The `CompClip` in the PARENT that opens this step. Absent on the root. */
  viaClipId?: string;
}

/**
 * The trail from the root composition down to `compId`, for the breadcrumb.
 *
 * Found by searching downwards rather than stored as a parent pointer: a
 * composition can be used in several places at once, so "the" parent does not
 * exist as data - only the path the user actually walked in does, and this
 * returns the first one that reaches the target, which is the one the breadcrumb
 * can guarantee is real. A composition that is used nowhere (freshly created,
 * or orphaned by a delete) still gets a two-step trail so the editor can show
 * where the user is standing.
 */
export function compPath(project: Project, compId: CompId, rootName: string): CompCrumb[] {
  const root: CompCrumb = { compId: null, name: rootName };
  if (compId === null) return [root];
  const trail = findTrail(project, null, compId, new Set());
  if (!trail) {
    const comp = findComp(project, compId);
    return [root, { compId, name: comp?.name ?? '', color: comp?.color }];
  }
  return [root, ...trail];
}

function findTrail(
  project: Project,
  from: CompId,
  target: string,
  visited: Set<string>,
): CompCrumb[] | null {
  for (const track of tracksOf(project, from)) {
    for (const clip of track.clips) {
      if (!isCompClip(clip)) continue;
      const comp = findComp(project, clip.compId);
      if (!comp) continue;
      const step: CompCrumb = {
        compId: comp.id,
        name: comp.name,
        color: comp.color,
        viaClipId: clip.id,
      };
      if (comp.id === target) return [step];
      if (visited.has(comp.id)) continue;
      visited.add(comp.id);
      const deeper = findTrail(project, comp.id, target, visited);
      if (deeper) return [step, ...deeper];
    }
  }
  return null;
}

/**
 * Which composition holds a track: `null` for the project's own timeline, the
 * composition's id when it lives inside one, and `undefined` when the track is
 * nowhere (already deleted).
 */
export function compIdOfTrack(project: Project, trackId: string): CompId | undefined {
  if (project.tracks.some((t) => t.id === trackId)) return null;
  for (const comp of project.comps ?? []) {
    if (comp.tracks.some((t) => t.id === trackId)) return comp.id;
  }
  return undefined;
}

/** The same for a clip - what "reveal this clip" needs before it can navigate. */
export function compIdOfClip(project: Project, clipId: string): CompId | undefined {
  let out: CompId | undefined;
  forEachTrackSet(project, (tracks, compId) => {
    if (out !== undefined) return;
    for (const track of tracks) {
      if (track.clips.some((c) => c.id === clipId)) {
        out = compId;
        return;
      }
    }
  });
  return out;
}

/** The stack of lanes a track belongs to (empty when it belongs to none). */
export function tracksHolding(project: Project, trackId: string): Track[] {
  const compId = compIdOfTrack(project, trackId);
  return compId === undefined ? [] : tracksOf(project, compId);
}

/** Where a composition is played: one entry per `CompClip` that references it. */
export interface CompUsage {
  /** The composition holding the clip (null = the project's own timeline). */
  hostId: CompId;
  clipId: string;
  trackId: string;
  timelineStartMs: number;
}

/**
 * Every place a composition is played, anywhere in the project. Drives the "used
 * N times" badge on the library card and the warning a delete has to give: a
 * composition removed while three clips still play it takes those clips with it.
 */
export function compUsages(project: Project, compId: string): CompUsage[] {
  const out: CompUsage[] = [];
  forEachTrackSet(project, (tracks, hostId) => {
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (isCompClip(clip) && clip.compId === compId) {
          out.push({ hostId, clipId: clip.id, trackId: track.id, timelineStartMs: clip.timelineStartMs });
        }
      }
    }
  });
  return out;
}

/**
 * A composition-time instant for a parent-time instant, following the comp
 * clip's trim and speed. Exactly `timelineToSourceMs` - a nested composition is
 * a source like any other - and named apart only so the render path reads as
 * what it is.
 */
export function compTimeAt(clip: CompClip, parentMs: number): number {
  return clip.sourceInMs + (parentMs - clip.timelineStartMs) * clip.speed;
}

/**
 * Whether a comp clip is playing its composition from its first frame to its
 * last - untrimmed.
 *
 * What the inspector's "fit to composition" reads to know it has nothing to do.
 * Loose by a frame so a length that lands a fraction of a millisecond off (a
 * ramp integral, a rounded speed) is still read as whole.
 */
export function playsWholeComp(clip: CompClip, fullLengthMs: number): boolean {
  return clip.sourceInMs <= 1 && Math.abs(clip.sourceOutMs - fullLengthMs) <= 34;
}

/**
 * Retrim the comp clips that were playing a composition WHOLE so they keep
 * playing it whole now that it has changed length, and cut back the ones whose
 * composition has shrunk past their out point.
 *
 * An edit INSIDE a composition changes how long its clips are ELSEWHERE, which
 * is a thing no single action can know about itself - so the store runs this
 * after every committed edit, with the project as it was before it.
 *
 * "Was playing it whole" is decided against the PREVIOUS length, not against a
 * flag: a clip whose out point sat exactly on the old end had not been trimmed,
 * and one that sat short of it had. That keeps a user's trim untouched while a
 * freshly precomposed clip grows with the shots added inside it, and it needs
 * nothing written down anywhere.
 *
 * Mutates `next`; a project with no compositions returns after one lookup.
 */
export function syncCompClips(prev: Project, next: Project): void {
  if (!next.comps?.length) return;
  /** Compositions whose length changed, mapped old length -> new length. */
  let changed: Map<string, { from: number; to: number }> | null = null;
  for (const comp of next.comps) {
    const before = prev.comps?.find((c) => c.id === comp.id);
    // A composition that did not exist a moment ago has no clip to retrim yet.
    if (!before) continue;
    const from = tracksDurationMs(before.tracks);
    const to = tracksDurationMs(comp.tracks);
    if (from === to || to <= 0) continue;
    (changed ??= new Map()).set(comp.id, { from, to });
  }
  if (!changed) return;
  forEachTrackSet(next, (tracks) => {
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (!isCompClip(clip)) continue;
        const move = changed!.get(clip.compId);
        if (!move) continue;
        // Sub-frame slack: a duration that comes out of a ramp integral or a
        // fractional speed lands a hair off the end it was cut to.
        if (Math.abs(clip.sourceOutMs - move.from) <= 1) {
          clip.sourceOutMs = move.to;
        } else if (clip.sourceOutMs > move.to) {
          // Trimmed, but the composition has shrunk out from under the trim:
          // pull the out point back rather than leave the clip playing frames
          // that no longer exist (which renders as a black tail).
          clip.sourceOutMs = move.to;
        }
        if (clip.sourceInMs >= clip.sourceOutMs) clip.sourceInMs = 0;
      }
    }
  });
}

/**
 * Whether a composition carries any sound at all, however deep - the question
 * "does this layer have audio" for a clip that has no asset to ask.
 *
 * Bounded by `MAX_COMP_DEPTH` and by the visited set, like every other walk
 * here: it is asked from the inspector on every selection change.
 */
export function compCarriesAudio(
  project: Project,
  compId: string,
  assets: Record<string, { hasAudio: boolean }>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(compId) || seen.size >= MAX_COMP_DEPTH) return false;
  seen.add(compId);
  for (const track of tracksOf(project, compId)) {
    for (const clip of track.clips) {
      if (isCompClip(clip)) {
        if (compCarriesAudio(project, clip.compId, assets, seen)) return true;
      } else if (clip.kind === 'media' && assets[clip.assetId]?.hasAudio) {
        return true;
      }
    }
  }
  return false;
}

/** A name no other composition in the project carries ("Comp 1", "Comp 2"…). */
export function uniqueCompName(project: Project, base: string): string {
  const taken = new Set((project.comps ?? []).map((c) => c.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
