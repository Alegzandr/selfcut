import { AspectRatio, Clip, Project, Track } from '../types';
import { clipDurationMs, clipEndMs } from '../model';
import { uid } from '../lib/id';
import { MIN_CLIP_DURATION_MS, PROJECT_FPS } from '../app/config';

/**
 * Pure project operations shared by the store's actions: constructing the empty
 * project, the overlap/crossfade policy, copy-on-write clip edits, and the
 * track/clip lookups. No store access - these take a Project (or an Immer
 * draft) and return/mutate it, which keeps them unit-testable in isolation.
 */

const DEFAULT_ASPECT: AspectRatio = '16:9';

export function createEmptyProject(): Project {
  return { id: uid('proj'), aspectRatio: DEFAULT_ASPECT, fps: PROJECT_FPS, tracks: [], markers: [] };
}

/**
 * Insert a track, keeping video tracks grouped: a new video track goes right
 * after the last existing video track (z-order = array order), audio tracks
 * go at the end. Mutates `p` (called on the withHistory draft).
 */
export function insertTrack(p: Project, track: Track): void {
  if (track.kind === 'video') {
    const lastVideoIdx = p.tracks.map((t) => t.kind).lastIndexOf('video');
    p.tracks.splice(lastVideoIdx + 1, 0, track);
  } else {
    p.tracks.push(track);
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
  let projectChanged = false;
  const tracks = p.tracks.map((track) => {
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
      if (start !== c.timelineStartMs) movedTo.set(c.id, start);
      prevPrevEnd = prev ? prev.end : 0;
      prev = { start, end: start + clipDurationMs(c) };
    }
    if (movedTo.size === 0) return track;
    projectChanged = true;
    return {
      ...track,
      clips: track.clips.map((c) =>
        movedTo.has(c.id) ? { ...c, timelineStartMs: movedTo.get(c.id)! } : c,
      ),
    };
  });
  return projectChanged ? { ...p, tracks } : p;
}

/**
 * Copy-on-write clip edits: only the touched clips (and their tracks) get a
 * new identity, so memoized clip views of untouched clips skip re-rendering.
 * An edit returning the same clip is a no-op; if nothing changed, the same
 * Project reference comes back.
 */
export function patchClips(p: Project, edits: Map<string, (c: Clip) => Clip>): Project {
  let projectChanged = false;
  const tracks = p.tracks.map((track) => {
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
    projectChanged = true;
    return { ...track, clips };
  });
  return projectChanged ? { ...p, tracks } : p;
}

/** Find (or create) the track a clip of the given kind should land on. Mutates `p`. */
export function ensureTrack(p: Project, kind: Track['kind'], preferredTrackId?: string): Track {
  const preferred = preferredTrackId ? p.tracks.find((t) => t.id === preferredTrackId) : undefined;
  if (preferred && preferred.kind === kind) return preferred;
  const existing = p.tracks.find((t) => t.kind === kind);
  if (existing) return existing;
  const track: Track = { id: uid('track'), kind, clips: [] };
  insertTrack(p, track);
  return track;
}

export function findClip(
  project: Project,
  clipId: string,
): { track: Track; clip: Clip; index: number } | null {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index !== -1) return { track, clip: track.clips[index]!, index };
  }
  return null;
}

/** Ids of the clips A/V-linked to `clipId` (same non-empty `linkId`), excluding it. */
export function linkedPartnerIds(project: Project, clipId: string): string[] {
  const linkId = findClip(project, clipId)?.clip.linkId;
  if (!linkId) return [];
  const out: string[] = [];
  for (const track of project.tracks) {
    for (const c of track.clips) {
      if (c.id !== clipId && c.linkId === linkId) out.push(c.id);
    }
  }
  return out;
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
 * The best A/V-link partner for a lone clip, or null. Drives the single-select
 * "Link" path: an unlinked media clip on the OPPOSITE-kind track, from the SAME
 * asset, preferring the one that overlaps it in time (falling back to the
 * closest start). Same-asset matching makes the unlink → re-link round trip
 * pick the original partner back.
 */
export function linkCandidate(project: Project, clipId: string): string | null {
  const found = findClip(project, clipId);
  if (!found) return null;
  const { clip, track } = found;
  if (clip.linkId != null || clip.kind !== 'media' || clip.assetId === '') return null;
  const wantKind: Track['kind'] = track.kind === 'video' ? 'audio' : 'video';
  const start = clip.timelineStartMs;
  const end = clipEndMs(clip);
  let best: { id: string; overlap: number; gap: number } | null = null;
  for (const t of project.tracks) {
    if (t.kind !== wantKind) continue;
    for (const c of t.clips) {
      if (c.linkId != null || c.kind !== 'media' || c.assetId !== clip.assetId) continue;
      const overlap = Math.max(0, Math.min(end, clipEndMs(c)) - Math.max(start, c.timelineStartMs));
      const gap = Math.abs(c.timelineStartMs - start);
      if (!best || overlap > best.overlap || (overlap === best.overlap && gap < best.gap)) {
        best = { id: c.id, overlap, gap };
      }
    }
  }
  return best ? best.id : null;
}

/**
 * Which clips a "Link" action would join, or null if the selection can't be
 * linked. Two selected clips must sit on opposite-kind tracks and both be
 * unlinked; a single selected clip auto-pairs with its `linkCandidate`. Used
 * for both the command's enabled state and its handler, so they never disagree.
 */
export function linkableSelection(
  project: Project,
  selectedClipIds: string[],
): [string, string] | null {
  if (selectedClipIds.length === 2) {
    const [a, b] = selectedClipIds as [string, string];
    const fa = findClip(project, a);
    const fb = findClip(project, b);
    if (!fa || !fb) return null;
    if (fa.clip.linkId != null || fb.clip.linkId != null) return null;
    if (fa.track.kind === fb.track.kind) return null;
    return [a, b];
  }
  if (selectedClipIds.length === 1) {
    const partner = linkCandidate(project, selectedClipIds[0]!);
    return partner ? [selectedClipIds[0]!, partner] : null;
  }
  return null;
}
