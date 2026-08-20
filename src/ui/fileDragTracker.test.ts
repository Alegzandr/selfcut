import { describe, expect, it } from 'vitest';
import {
  DRAG_IDLE_MS,
  DRAG_LEAVE_GRACE_MS,
  createFileDragTracker,
} from './fileDragTracker';

function track() {
  const seen: boolean[] = [];
  const t = createFileDragTracker((active) => seen.push(active));
  return { t, seen };
}

describe('createFileDragTracker', () => {
  it('raises the overlay on the first enter and reports it once', () => {
    const { t, seen } = track();
    t.enter(0);
    t.over(10);
    t.enter(20);
    expect(t.active).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('keeps the overlay up while the drag crosses nested elements', () => {
    const { t, seen } = track();
    t.enter(0);
    // Child crossed: leave on the old element, enter on the new one.
    t.leave(10);
    t.enter(11);
    t.tick(200);
    expect(t.active).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('closes the overlay a beat after the last element is left', () => {
    const { t, seen } = track();
    t.enter(0);
    t.leave(10);
    t.tick(10 + DRAG_LEAVE_GRACE_MS - 1);
    expect(t.active).toBe(true);
    t.tick(10 + DRAG_LEAVE_GRACE_MS);
    expect(t.active).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('closes the overlay when the drag goes silent without a leave', () => {
    const { t } = track();
    t.enter(0);
    t.over(300);
    t.tick(300 + DRAG_IDLE_MS - 1);
    expect(t.active).toBe(true);
    t.tick(300 + DRAG_IDLE_MS);
    expect(t.active).toBe(false);
  });

  it('closes the overlay outright on a drop', () => {
    const { t, seen } = track();
    t.enter(0);
    t.enter(1);
    t.end();
    expect(t.active).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('never lets an unbalanced leave push the counter negative', () => {
    const { t } = track();
    t.leave(0);
    t.leave(1);
    t.enter(2);
    t.leave(3);
    t.tick(3 + DRAG_LEAVE_GRACE_MS);
    expect(t.active).toBe(false);
  });

  it('raises the overlay for a drag that was already in flight', () => {
    const { t } = track();
    t.over(0);
    t.tick(DRAG_LEAVE_GRACE_MS);
    expect(t.active).toBe(true);
  });
});
