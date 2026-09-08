import type { StoreApi } from 'zustand';
import type { EditorState } from './editorState';
import type { Marker, Project, Track } from '../types';
import type { TrackHost } from '../model';

export type StoreSet = StoreApi<EditorState>['setState'];
export type StoreGet = StoreApi<EditorState>['getState'];

export interface SliceHelpers {
  withHistory: (fn: (p: Project) => void, priorityClipId?: string | null) => void;
  pruneSelection: () => void;
  /**
   * The clips a property edit aimed at `clipId` reaches: the whole selection
   * when that clip belongs to one. See `editTargets`.
   */
  targetsOf: (clipId: string) => string[];
  /**
   * The lanes the editor is working in right now: the project's own timeline, or
   * those of the nested composition the user has opened.
   *
   * Every slice reads its tracks through this instead of `project.tracks`, which
   * is what makes precomposition invisible to the edit code - a split, a drag or
   * a track insert behaves identically two levels deep because it never learns
   * how deep it is. Returns the live array (Immer draft included), so callers
   * push and splice into it exactly as they did before.
   */
  lanes: (p: Project) => Track[];
  /** Replace those lanes inside a draft (`p.tracks = ...`). */
  setLanes: (p: Project, tracks: Track[]) => void;
  /** The same, copy-on-write: a new Project with the edited lanes swapped in. */
  withLanes: (p: Project, tracks: Track[]) => Project;
  /** The edited lanes as an insertion target (`insertTrack`, `ensureTrack`). */
  host: (p: Project) => TrackHost;
  /** The cues of the composition being edited - a precomp keeps its own. */
  cues: (p: Project) => Marker[];
  setCues: (p: Project, markers: Marker[]) => void;
  withCues: (p: Project, markers: Marker[]) => Project;
}
