import type { StoreApi } from 'zustand';
import type { EditorState } from './editorState';

export type StoreSet = StoreApi<EditorState>['setState'];
export type StoreGet = StoreApi<EditorState>['getState'];

export interface SliceHelpers {
  withHistory: (fn: (p: import('../types').Project) => void, priorityClipId?: string | null) => void;
  pruneSelection: () => void;
  /**
   * The clips a property edit aimed at `clipId` reaches: the whole selection
   * when that clip belongs to one. See `editTargets`.
   */
  targetsOf: (clipId: string) => string[];
}
