import { AspectRatio, Clip, Project, Track } from '../types';
import {
  clipDurationMs,
  clipEndMs,
  forEachTrackSet,
  type TrackHost,
  tracksHolding,
} from '../model';
import { uid } from '../lib/id';
import { MIN_CLIP_DURATION_MS, PROJECT_FPS } from '../app/config';

/**
 * Pure project operations shared by the store's actions: constructing the empty
 * project, the overlap/crossfade policy, copy-on-write clip edits, and the
 * track/clip lookups. No store access - these take a Project (or an Immer
 * draft) and return/mutate it, which keeps them unit-testable in isolation.
 */

export type { TrackHost };

const DEFAULT_ASPECT: AspectRatio = '16:9';

export function createEmptyProject(): Project {
  return {
    id: uid('proj'),
    aspectRatio: DEFAULT_ASPECT,
    fps: PROJECT_FPS,
    tracks: [],
    markers: [],
    luts: [],
    comps: [],
  };
}

/**
 * Insert a track, keeping video tracks grouped: a new video track goes right
 * after the last existing video track (z-order = array order), audio tracks
 * go at the end. With `atTop`, the track goes to index 0 instead - used for
 * overlays (text, shapes, solids) so they land on top of the existing footage
 * without the user having to reorder tracks. Mutates `p` (called on the
 * withHistory draft).
 */
export function insertTrack(host: TrackHost, track: Track, opts?: { atTop?: boolean }): void {
  if (opts?.atTop) {
    host.tracks.unshift(track);
    return;
  }
  if (track.kind === 'video') {
    const lastVideoIdx = host.tracks.map((t) => t.kind).lastIndexOf('video');
    host.tracks.splice(lastVideoIdx + 1, 0, track);
  } else {
    host.tracks.push(track);
  }
}

/**
 * Overlap policy: two consecutive clips on a track MAY overlap - the overlap
 * is rendered as a crossfade (Vegas-style transition by sliding a clip over
 * its neighbor). What stays forbidden, with offenders pushed right:
 * - a clip overlapping the clip two positions back (no triple overlap);
 * - a clip starting less than MIN_CLIP_DURATION_MS after the previous one
 *   (each clip keeps an exposed head, so ordering stays unambiguous).
 * Copy-on-write: returns the same Project reference when nothing moved, and
 * untouched tracks/clips keep their identity.
 */
export function resolveOverlaps(p: Project, priorityClipId?: string | null): Project {
  const tracks = settleTracks(p.tracks, priorityClipId);
  // Nested compositions are settled too: an edit inside a precomp lands on its
  // own lanes, and a layout left illegal there would surface as an overlap the
  // user cannot see from the timeline they are standing on.
  let comps = p.comps;
  if (comps && comps.length > 0) {
    let compsChanged = false;
    const next = comps.map((comp) => {
      const settled = settleTracks(comp.tracks, priorityClipId);
      if (settled === comp.tracks) return comp;
      compsChanged = true;
      return { ...comp, tracks: settled };
    });
    if (compsChanged) comps = next;
  }
  if (tracks === p.tracks && comps === p.comps) return p;
  return { ...p, tracks, comps };
}

/** One stack of lanes settled; the same array back when nothing had to move. */
function settleTracks(input: Track[], priorityClipId?: string | null): Track[] {
  let changed = false;
  const tracks = input.map((track) => {
    const sorted = [...track.clips].sort((a, b) => {
      if (a.timelineStartMs !== b.timelineStartMs) return a.timelineStartMs - b.timelineStartMs;
      if (a.id === priorityClipId) return -1;
      if (b.id === priorityClipId) return 1;
      return 0;
    });
    const movedTo = new Map<string, number>();
    let prev: { start: number; end: number } | null = null;
    let prevPrevEnd = 0;
    for (const c of sorted) {
      const minStart = prev ? Math.max(prevPrevEnd, prev.start + MIN_CLIP_DURATION_MS) : 0;
      const start = Math.max(c.timelineStartMs, minStart);
      // Sub-frame slack: the minimum head is 16.666…ms, so a clip laid down
      // exactly one frame after its predecessor (a razor cut on frame 1) can
      // read as an ulp short. Nudging it there would be a no-op move that still
      // breaks copy-on-write identity for the whole track.
      if (start - c.timelineStartMs > MIN_CLIP_DURATION_MS / 1000) movedTo.set(c.id, start);
      prevPrevEnd = prev ? prev.end : 0;
      prev = { start, end: start + clipDurationMs(c) };
    }
    if (movedTo.size === 0) return track;
    changed = true;
    return {
      ...track,
      clips: track.clips.map((c) =>
        movedTo.has(c.id) ? { ...c, timelineStartMs: movedTo.get(c.id)! } : c,
      ),
    };
  });
  return changed ? tracks : input;
}

/**
 * Copy-on-write clip edits: only the touched clips (and their tracks) get a
 * new identity, so memoized clip views of untouched clips skip re-rendering.
 * An edit returning the same clip is a no-op; if nothing changed, the same
 * Project reference comes back.
 */
export function patchClips(p: Project, edits: Map<string, (c: Clip) => Clip>): Project {
  const tracks = patchTracks(p.tracks, edits);
  // Clip ids are unique across the whole project, so a patch is applied
  // everywhere rather than only to the composition the user has open: an edit
  // that names a clip by id is about THAT clip, and having to also say which
  // composition holds it would be a second source of truth waiting to disagree
  // with the first. Untouched compositions keep their identity.
  let comps = p.comps;
  if (comps && comps.length > 0) {
    let compsChanged = false;
    const next = comps.map((comp) => {
      const patched = patchTracks(comp.tracks, edits);
      if (patched === comp.tracks) return comp;
      compsChanged = true;
      return { ...comp, tracks: patched };
    });
    if (compsChanged) comps = next;
  }
  if (tracks === p.tracks && comps === p.comps) return p;
  return { ...p, tracks, comps };
}

/** One stack of lanes patched; the same array back when no clip was touched. */
function patchTracks(input: Track[], edits: Map<string, (c: Clip) => Clip>): Track[] {
  let changed = false;
  const tracks = input.map((track) => {
    let trackChanged = false;
    const clips = track.clips.map((c) => {
      const edit = edits.get(c.id);
      if (!edit) return c;
      const next = edit(c);
      if (next === c) return c;
      trackChanged = true;
      return next;
    });
    if (!trackChanged) return track;
    changed = true;
    return { ...track, clips };
  });
  return changed ? tracks : input;
}

/**
 * Sentinel accepted as `preferredTrackId` by {@link ensureTrack}: always create
 * a fresh track instead of reusing an existing one (drop below the last row).
 */
export const NEW_TRACK_TARGET = '__new-track__';

/**
 * The EXISTING track a clip of the given kind would land on, or null when it
 * would take a fresh one. Pure, unlike {@link ensureTrack}: the drop preview
 * asks the same question the drop itself answers, so the ghost can never
 * promise a row the drop then refuses.
 */
export function resolveTargetTrack(
  host: TrackHost,
  kind: Track['kind'],
  preferredTrackId?: string,
): Track | null {
  if (preferredTrackId === NEW_TRACK_TARGET) return null;
  const preferred = preferredTrackId
    ? host.tracks.find((t) => t.id === preferredTrackId)
    : undefined;
  if (preferred && preferred.kind === kind && !preferred.locked) return preferred;
  // A locked track accepts no new clips: fall through to the next free one, or
  // to a fresh track, rather than dropping content onto a track the user froze.
  return host.tracks.find((t) => t.kind === kind && !t.locked) ?? null;
}

/** Find (or create) the track a clip of the given kind should land on. Mutates `host`. */
export function ensureTrack(
  host: TrackHost,
  kind: Track['kind'],
  preferredTrackId?: string,
): Track {
  const existing = resolveTargetTrack(host, kind, preferredTrackId);
  if (existing) return existing;
  const track: Track = { id: uid('track'), kind, clips: [] };
  insertTrack(host, track);
  return track;
}

/**
 * The clip with this id, anywhere in the project - inside a nested composition
 * included, since clip ids are unique project-wide.
 *
 * Searching everywhere rather than only the open composition is deliberate: an
 * edit that names a clip by id is about THAT clip, and having to also say which
 * composition holds it would be a second source of truth waiting to disagree
 * with the first.
 */
export function findClip(
  project: Project,
  clipId: string,
): { track: Track; clip: Clip; index: number } | null {
  let found: { track: Track; clip: Clip; index: number } | null = null;
  forEachTrackSet(project, (tracks) => {
    if (found) return;
    for (const track of tracks) {
      const index = track.clips.findIndex((c) => c.id === clipId);
      if (index !== -1) {
        found = { track, clip: track.clips[index]!, index };
        return;
      }
    }
  });
  return found;
}

/** Ids of the clips A/V-linked to `clipId` (same non-empty `linkId`), excluding it. */
export function linkedPartnerIds(project: Project, clipId: string): string[] {
  const found = findClip(project, clipId);
  const linkId = found?.clip.linkId;
  if (!found || !linkId) return [];
  const out: string[] = [];
  // Scoped to the clip's own composition, like `linkCandidates`: a link group
  // never straddles two timelines.
  for (const track of tracksHolding(project, found.track.id)) {
    for (const c of track.clips) {
      if (c.id !== clipId && c.linkId === linkId) out.push(c.id);
    }
  }
  return out;
}

/**
 * The linked partners that share `clipId`'s SOURCE geometry, i.e. every partner
 * except caption/text clips. Trim and slip re-aim a clip into its media, an
 * edit a text clip has no source to absorb: subtitles linked to their footage
 * must follow its moves and deletes, but keep their own cue timings when the
 * shot is trimmed.
 */
export function sourceLinkedIds(project: Project, clipId: string): string[] {
  return linkedPartnerIds(project, clipId).filter(
    (id) => findClip(project, id)?.clip.kind !== 'text',
  );
}

/** Expand a set of clip ids to also include every A/V-linked partner. */
export function withLinkedIds(project: Project, clipIds: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const id of clipIds) {
    set.add(id);
    for (const partner of linkedPartnerIds(project, id)) set.add(partner);
  }
  return [...set];
}

/**
 * The A/V-link partners for a lone clip (empty if none). Drives the
 * single-select "Link" path: media clips on the OPPOSITE-kind tracks, from the
 * SAME asset, preferring the one that overlaps it in time (falling back to the
 * closest start). Same-asset matching makes the unlink → re-link round trip
 * pick the original partners back.
 *
 * The best candidate from EACH opposite-kind track is taken, in both
 * directions: an import splits a multi-stream source into one audio lane per
 * stream, and a group may equally hold several video clips. Candidates that
 * already carry a `linkId` are kept only when they all belong to the SAME
 * group, so linking joins that existing group instead of tearing it apart.
 */
export function linkCandidates(project: Project, clipId: string): string[] {
  const found = findClip(project, clipId);
  if (!found) return [];
  const { clip, track } = found;
  if (clip.linkId != null || clip.kind !== 'media' || clip.assetId === '') return [];
  const wantKind: Track['kind'] = track.kind === 'video' ? 'audio' : 'video';
  // Candidates come from the clip's OWN composition: a link group is a set of
  // clips that move together on one timeline, and there is no gesture that could
  // move a clip in a precomp and one in its parent as a unit.
  const siblings = tracksHolding(project, track.id);
  const start = clip.timelineStartMs;
  const end = clipEndMs(clip);
  const perTrack: { id: string; overlap: number; gap: number; linkId?: string }[] = [];
  for (const t of siblings) {
    if (t.kind !== wantKind) continue;
    let best: { id: string; overlap: number; gap: number; linkId?: string } | null = null;
    for (const c of t.clips) {
      if (c.kind !== 'media' || c.assetId !== clip.assetId) continue;
      const overlap = Math.max(0, Math.min(end, clipEndMs(c)) - Math.max(start, c.timelineStartMs));
      const gap = Math.abs(c.timelineStartMs - start);
      if (!best || overlap > best.overlap || (overlap === best.overlap && gap < best.gap)) {
        best = { id: c.id, overlap, gap, linkId: c.linkId };
      }
    }
    if (best) perTrack.push(best);
  }
  if (perTrack.length === 0) return [];
  // Joining is only unambiguous when the candidates are all free or all in one
  // group - straddling two groups would silently merge them.
  const groups = new Set(perTrack.map((c) => c.linkId).filter((id) => id != null));
  if (groups.size > 1) return [];
  if (groups.size === 1) {
    // Pull in the whole group, including members on tracks that held no
    // candidate of their own, so the result is the full merged set.
    const linkId = [...groups][0]!;
    const out = new Set(perTrack.map((c) => c.id));
    for (const t of siblings) {
      for (const c of t.clips) {
        if (c.linkId === linkId) out.add(c.id);
      }
    }
    return [...out];
  }
  return perTrack.map((c) => c.id);
}

/**
 * Which clips a "Link" action would join, or null if the selection can't be
 * linked. A link group is generic: any mix of clips on video and audio tracks,
 * with no master side. A multi-clip selection must hold at least one clip that
 * is not already in the group and must not straddle two existing groups (that
 * would silently merge them); a single selected clip auto-pairs with its
 * `linkCandidates`. Used for both the command's enabled state and its handler,
 * so they never disagree.
 */
export function linkableSelection(project: Project, selectedClipIds: string[]): string[] | null {
  if (selectedClipIds.length >= 2) {
    const groups = new Set<string>();
    let unlinked = 0;
    for (const id of selectedClipIds) {
      const found = findClip(project, id);
      if (!found) return null;
      if (found.clip.linkId != null) groups.add(found.clip.linkId);
      else unlinked++;
    }
    if (groups.size > 1) return null;
    // Everything already in the same group: nothing left to join.
    if (unlinked === 0) return null;
    if (groups.size === 0) return [...selectedClipIds];
    // Adding to an existing group: carry along the members not selected, so the
    // group stays whole rather than splitting off a subset.
    const linkId = [...groups][0]!;
    const out = new Set(selectedClipIds);
    for (const track of tracksHolding(project, findClip(project, selectedClipIds[0]!)!.track.id)) {
      for (const c of track.clips) {
        if (c.linkId === linkId) out.add(c.id);
      }
    }
    return [...out];
  }
  if (selectedClipIds.length === 1) {
    const partners = linkCandidates(project, selectedClipIds[0]!);
    return partners.length > 0 ? [selectedClipIds[0]!, ...partners] : null;
  }
  return null;
}

