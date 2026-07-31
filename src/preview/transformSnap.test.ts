import { describe, expect, it } from 'vitest';
import {
  edgeHandlePlacements,
  handlePlacements,
  normalizeAngle,
  resizeCursor,
  scaleSnapTargets,
  snapRotation,
  snapScale,
  snapStretch,
  stretchSnapTargets,
} from './transformSnap';

/**
 * The motivating case: a 1920x1080 source in a 1080x1920 project. At scale 1 the
 * "contain" fit makes it span the full width, so its size at scale 1 is
 * 1080 x 607.5 output px.
 */
const LANDSCAPE_IN_PORTRAIT = {
  unitW: 1080,
  unitH: 607.5,
  outW: 1080,
  outH: 1920,
  sourceW: 1920,
};

describe('scaleSnapTargets', () => {
  it('offers fit, cover and 1:1 for a 16:9 clip in a 9:16 frame', () => {
    const targets = scaleSnapTargets(LANDSCAPE_IN_PORTRAIT);
    const scales = targets.map((t) => t.scale);

    // Fit: already flush left/right at scale 1, hence the width axis.
    expect(scales).toContainEqual(1);
    expect(targets.find((t) => t.scale === 1)?.axis).toBe('x');

    // Cover: 1920 / 607.5 ≈ 3.16 - the scale that kills the black bars, and the
    // one the old "snap to 1.0 only" rule had no way to reach.
    const cover = targets.find((t) => Math.abs(t.scale - 1920 / 607.5) < 1e-6);
    expect(cover).toBeDefined();
    expect(cover?.axis).toBe('y');

    // Native: the source drawn at 1:1 pixels.
    expect(scales.some((s) => Math.abs(s - 1920 / 1080) < 1e-6)).toBe(true);
  });

  it('does not list the same detent twice', () => {
    // A source shot at exactly the output size puts fit, 1.0 and native together.
    const targets = scaleSnapTargets({
      unitW: 1080,
      unitH: 1920,
      outW: 1080,
      outH: 1920,
      sourceW: 1080,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.scale).toBe(1);
  });

  it('returns nothing for a degenerate clip rather than dividing by zero', () => {
    expect(scaleSnapTargets({ unitW: 0, unitH: 0, outW: 1080, outH: 1920 })).toEqual([]);
  });
});

describe('snapScale', () => {
  const targets = scaleSnapTargets(LANDSCAPE_IN_PORTRAIT);
  const clip = { centerX: 0.5, centerY: 0.5, unitW: 1080, unitH: 607.5, outW: 1080, outH: 1920 };
  const cover = 1920 / 607.5;

  it('pulls a near-cover scale onto cover', () => {
    expect(snapScale(cover - 0.04, targets, 0.1, clip).scale).toBeCloseTo(cover, 10);
  });

  it('leaves a scale alone when no detent is within the threshold', () => {
    const raw = 2.4;
    expect(snapScale(raw, targets, 0.05, clip).scale).toBe(raw);
  });

  it('takes the NEAREST detent, not the first listed', () => {
    // Native (1.778) is listed after cover (3.16); a huge threshold must still
    // pick the one actually closest to the pointer.
    const raw = 1.8;
    expect(snapScale(raw, targets, 5, clip).scale).toBeCloseTo(1920 / 1080, 10);
  });

  it('draws guides on the edges the clip actually lands on', () => {
    // Snapping to cover makes the clip span the full height: two horizontal
    // lines, at the frame's top and bottom, and nothing vertical.
    const { guides } = snapScale(cover, targets, 0.1, clip);
    expect(guides.v).toEqual([]);
    expect(guides.h).toHaveLength(2);
    expect(guides.h[0]!).toBeCloseTo(0, 10);
    expect(guides.h[1]!).toBeCloseTo(1, 10);
  });

  it('follows an off-center clip instead of claiming the frame border', () => {
    const offset = { ...clip, centerY: 0.4 };
    const { guides } = snapScale(cover, targets, 0.1, offset);
    // Same height, shifted up: the lines report where the edges really are.
    expect(guides.h[0]!).toBeCloseTo(-0.1, 10);
    expect(guides.h[1]!).toBeCloseTo(0.9, 10);
  });
});

/**
 * The stretch case: 4:3 footage (1440x1080) in a 16:9 frame. The "contain" fit
 * draws it 1440 wide, so it sits between two 240px black bars until the width
 * is stretched by 1920/1440.
 */
const FOUR_THREE_IN_SIXTEEN_NINE = { unit: 1440, out: 1920 };
const FILL_X = 1920 / 1440;

describe('stretchSnapTargets', () => {
  it('offers the source ratio and the stretch that fills the axis', () => {
    const targets = stretchSnapTargets(FOUR_THREE_IN_SIXTEEN_NINE);
    expect(targets).toContain(1);
    expect(targets.some((s) => Math.abs(s - FILL_X) < 1e-9)).toBe(true);
  });

  it('offers only the source ratio when the axis already fills the frame', () => {
    // Fill would be 1, sitting on top of the undeformed detent.
    expect(stretchSnapTargets({ unit: 1080, out: 1080 })).toEqual([1]);
  });

  it('offers only the source ratio for a degenerate clip', () => {
    expect(stretchSnapTargets({ unit: 0, out: 1920 })).toEqual([1]);
  });
});

describe('snapStretch', () => {
  const targets = stretchSnapTargets(FOUR_THREE_IN_SIXTEEN_NINE);
  const clip = { center: 0.5, unit: 1440, out: 1920 };

  it('pulls a near-fill stretch onto fill', () => {
    expect(snapStretch(FILL_X - 0.02, targets, 0.1, clip).stretch).toBeCloseTo(FILL_X, 10);
  });

  it('pulls a near-neutral stretch back to the undeformed ratio', () => {
    // The detent that matters most: an accidental stretch is otherwise
    // impossible to undo by hand.
    expect(snapStretch(1.03, targets, 0.1, clip).stretch).toBe(1);
  });

  it('leaves a deliberate stretch alone when no detent is close', () => {
    expect(snapStretch(1.18, targets, 0.05, clip).stretch).toBe(1.18);
  });

  it('draws the guides on the clip edges the snap lands on', () => {
    const { guides } = snapStretch(FILL_X, targets, 0.1, clip);
    expect(guides).toHaveLength(2);
    expect(guides[0]!).toBeCloseTo(0, 10);
    expect(guides[1]!).toBeCloseTo(1, 10);
  });

  it('reports no guide when nothing snapped', () => {
    expect(snapStretch(1.18, targets, 0.05, clip).guides).toEqual([]);
  });
});

describe('edgeHandlePlacements', () => {
  // The same 4:3 clip, letterboxed in a 1920x1080 frame.
  const rect = { dx: 240, dy: 0, dw: 1440, dh: 1080 };

  it('puts one handle at the midpoint of each side', () => {
    const edges = edgeHandlePlacements(rect, 0, 1920, 1080);
    const by = (e: 'n' | 'e' | 's' | 'w') => edges.find((p) => p.edge === e)!;

    expect(by('e').x).toBeCloseTo((240 + 1440) / 1920, 10);
    expect(by('e').y).toBeCloseTo(0.5, 10);
    expect(by('n').x).toBeCloseTo(0.5, 10);
    expect(by('n').y).toBeCloseTo(0, 10);
  });

  it('maps each handle to the axis it stretches', () => {
    const edges = edgeHandlePlacements(rect, 0, 1920, 1080);
    expect(edges.filter((p) => p.axis === 'x').map((p) => p.edge).sort()).toEqual(['e', 'w']);
    expect(edges.filter((p) => p.axis === 'y').map((p) => p.edge).sort()).toEqual(['n', 's']);
  });

  it('turns the handle directions with the clip', () => {
    // Rotated a quarter turn, the clip's right edge points DOWN the screen - so
    // the cursor over it has to be a vertical one.
    const east = edgeHandlePlacements(rect, 90, 1920, 1080).find((p) => p.edge === 'e')!;
    expect(east.dirX).toBeCloseTo(0, 10);
    expect(east.dirY).toBeCloseTo(1, 10);
    expect(resizeCursor(east.dirX, east.dirY)).toBe('ns-resize');
  });

  it('pulls a handle that left the panel back into bounds', () => {
    const bounds = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
    // Stretched well past the frame: the east handle is off-panel.
    const wide = { dx: -500, dy: 0, dw: 2920, dh: 1080 };
    const east = edgeHandlePlacements(wide, 0, 1920, 1080, bounds).find((p) => p.edge === 'e')!;
    expect(east.clamped).toBe(true);
    expect(east.x).toBe(1);
  });
});

describe('snapRotation', () => {
  it('catches the uprights and the diagonals', () => {
    expect(snapRotation(1.5)).toBe(0);
    expect(snapRotation(43)).toBe(45);
    expect(snapRotation(88)).toBe(90);
    expect(snapRotation(-31)).toBe(-30);
  });

  it('leaves a deliberate tilt untouched', () => {
    expect(snapRotation(7.5)).toBe(7.5);
    expect(snapRotation(52)).toBe(52);
  });

  it('snaps across the wrap, where 179° and -179° are neighbours', () => {
    // Both sides of the half-turn resolve to the same canonical 180.
    expect(snapRotation(178)).toBe(180);
    expect(snapRotation(-178)).toBe(180);
  });
});

describe('normalizeAngle', () => {
  it('wraps into [-180, 180]', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(370)).toBe(10);
    expect(normalizeAngle(-370)).toBe(-10);
    expect(normalizeAngle(190)).toBe(-170);
  });
});

describe('handlePlacements', () => {
  const OUT = { outW: 1080, outH: 1920 };
  /** A clip fitted inside the frame: nothing to clamp. */
  const inside = { dx: 240, dy: 660, dw: 600, dh: 600 };
  /** The cover case: a landscape clip blown up past every frame edge. */
  const overflowing = { dx: -1000, dy: -100, dw: 3080, dh: 2120 };

  it('leaves the corners alone when the clip fits in the frame', () => {
    const hs = handlePlacements(inside, 0, OUT.outW, OUT.outH);
    expect(hs.every((h) => !h.clamped)).toBe(true);
    const nw = hs.find((h) => h.corner === 'nw')!;
    expect(nw.x).toBeCloseTo(240 / 1080, 10);
    expect(nw.y).toBeCloseTo(660 / 1920, 10);
  });

  it('pulls off-frame corners back inside, so cover stays resizable', () => {
    const hs = handlePlacements(overflowing, 0, OUT.outW, OUT.outH);
    expect(hs.every((h) => h.clamped)).toBe(true);
    // Every handle lands on the frame, which is the visible, grabbable area.
    for (const h of hs) {
      expect(h.x).toBeGreaterThanOrEqual(0);
      expect(h.x).toBeLessThanOrEqual(1);
      expect(h.y).toBeGreaterThanOrEqual(0);
      expect(h.y).toBeLessThanOrEqual(1);
    }
  });

  it('lets the corners leave the frame when the panel still shows them', () => {
    // A panel twice as wide as the 9:16 frame: the clip's own left/right edges
    // are on screen, so the handles belong there and not on the frame border.
    const bounds = { minX: -0.5, maxX: 1.5, minY: 0, maxY: 1 };
    const wide = { dx: -540, dy: 660, dw: 2160, dh: 600 };
    const hs = handlePlacements(wide, 0, OUT.outW, OUT.outH, bounds);
    const nw = hs.find((h) => h.corner === 'nw')!;
    expect(nw.clamped).toBe(false);
    expect(nw.x).toBeCloseTo(-0.5, 10);
  });

  it('follows the rotation: a quarter turn sends NW where NE was', () => {
    const hs = handlePlacements(inside, 90, OUT.outW, OUT.outH);
    const nw = hs.find((h) => h.corner === 'nw')!;
    const unrotated = handlePlacements(inside, 0, OUT.outW, OUT.outH);
    const ne = unrotated.find((h) => h.corner === 'ne')!;
    expect(nw.x).toBeCloseTo(ne.x, 8);
    expect(nw.y).toBeCloseTo(ne.y, 8);
  });

  it('points each direction vector away from the clip centre', () => {
    const hs = handlePlacements(inside, 0, OUT.outW, OUT.outH);
    const nw = hs.find((h) => h.corner === 'nw')!;
    expect(nw.dirX).toBeLessThan(0);
    expect(nw.dirY).toBeLessThan(0);
    expect(Math.hypot(nw.dirX, nw.dirY)).toBeCloseTo(1, 10);
  });
});

describe('resizeCursor', () => {
  it('matches the diagonal a handle actually pulls along', () => {
    expect(resizeCursor(-1, -1)).toBe('nwse-resize');
    expect(resizeCursor(1, -1)).toBe('nesw-resize');
    // A clip rotated 90° turns its corner diagonals into the other pair.
    expect(resizeCursor(1, 0)).toBe('ew-resize');
    expect(resizeCursor(0, 1)).toBe('ns-resize');
  });
});
