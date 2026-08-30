import { describe, it, expect } from 'vitest';
import type { EditorState } from '../store/editorState';
import { linkGroupActive, selectedLinkIds } from './linkHighlight';

/**
 * The link highlight reads two references off the store and memoises on them,
 * so the cases worth pinning are: a selection lights its whole group (including
 * the partner that is NOT selected), a hover does the same, and the memo does
 * not survive a selection change.
 */
function state(selectedClipIds: string[], hoveredLinkId: string | null = null): EditorState {
  return {
    selectedClipIds,
    hoveredLinkId,
    project: {
      tracks: [
        { clips: [{ id: 'v1', linkId: 'L1' }, { id: 'v2' }] },
        { clips: [{ id: 'a1', linkId: 'L1' }, { id: 'a2', linkId: 'L2' }] },
      ],
    },
  } as unknown as EditorState;
}

describe('link highlight', () => {
  it('lights the whole group when one of its clips is selected', () => {
    const s = state(['v1']);
    expect(linkGroupActive(s, 'L1')).toBe(true); // the unselected audio partner
    expect(linkGroupActive(s, 'L2')).toBe(false);
  });

  it('lights the hovered group', () => {
    expect(linkGroupActive(state([], 'L2'), 'L2')).toBe(true);
  });

  it('ignores an unlinked clip', () => {
    expect(linkGroupActive(state(['v2']), undefined)).toBe(false);
  });

  it('re-reads when the selection changes', () => {
    expect([...selectedLinkIds(state(['v1']))]).toEqual(['L1']);
    expect([...selectedLinkIds(state(['a2']))]).toEqual(['L2']);
    expect([...selectedLinkIds(state([]))]).toEqual([]);
  });
});
