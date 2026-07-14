import { describe, it, expect } from 'vitest';
import {
  severityColor,
  typeLabel,
  boxToCanvasCorners,
  anchorFindingToWorld,
  projectAnchoredBox,
  SEVERITY_COLORS,
} from '../src/lib/aiOverlay';

describe('severityColor', () => {
  it('maps known severities', () => {
    expect(severityColor('high')).toBe(SEVERITY_COLORS.high);
    expect(severityColor('moderate')).toBe(SEVERITY_COLORS.moderate);
    expect(severityColor('low')).toBe(SEVERITY_COLORS.low);
  });
  it('falls back to low for unknown', () => {
    expect(severityColor('banana')).toBe(SEVERITY_COLORS.low);
    expect(severityColor(undefined)).toBe(SEVERITY_COLORS.low);
  });
});

describe('typeLabel', () => {
  it('humanizes known slugs', () => {
    expect(typeLabel('periapical_radiolucency')).toBe('Periapical radiolucency');
    expect(typeLabel('caries')).toBe('Caries');
  });
  it('falls back to Finding', () => {
    expect(typeLabel('mystery')).toBe('Finding');
  });
});

describe('boxToCanvasCorners', () => {
  it('scales a normalized box to canvas px corners (tl,tr,br,bl)', () => {
    const box = { x: 0.25, y: 0.5, w: 0.25, h: 0.25 };
    const corners = boxToCanvasCorners(box, 400, 200);
    // x: 0.25*400=100 → 0.5*400=200 ; y: 0.5*200=100 → 0.75*200=150
    expect(corners).toEqual([
      [100, 100],
      [200, 100],
      [200, 150],
      [100, 150],
    ]);
  });

  it('maps a full-frame box to the whole canvas', () => {
    const corners = boxToCanvasCorners({ x: 0, y: 0, w: 1, h: 1 }, 512, 512);
    expect(corners[0]).toEqual([0, 0]);
    expect(corners[2]).toEqual([512, 512]);
  });
});

// A fake Cornerstone viewport with a controllable canvas↔world mapping so we
// can exercise anchor+project without a real renderer. Model: world = canvas
// scaled by `zoom` and offset by `pan` — the round trip must recover the box.
function fakeViewport({ zoom = 1, panX = 0, panY = 0 } = {}) {
  return {
    canvasToWorld: ([cx, cy]) => [cx / zoom - panX, cy / zoom - panY, 0],
    worldToCanvas: ([wx, wy]) => [(wx + panX) * zoom, (wy + panY) * zoom],
  };
}

describe('anchor + project round trip', () => {
  it('recovers the same screen rect when the camera has not moved', () => {
    const vp = fakeViewport({ zoom: 1 });
    const finding = { box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, severity: 'high' };
    const anchored = anchorFindingToWorld(finding, vp, 1000, 1000);
    expect(anchored.worldCorners).toHaveLength(4);
    const rect = projectAnchoredBox(anchored.worldCorners, vp);
    expect(rect.left).toBeCloseTo(100, 6);   // 0.1 * 1000
    expect(rect.top).toBeCloseTo(200, 6);    // 0.2 * 1000
    expect(rect.width).toBeCloseTo(300, 6);  // 0.3 * 1000
    expect(rect.height).toBeCloseTo(400, 6); // 0.4 * 1000
  });

  it('tracks the box under a later zoom (anchored to world, not screen)', () => {
    const captureVp = fakeViewport({ zoom: 1 });
    const finding = { box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, severity: 'low' };
    const anchored = anchorFindingToWorld(finding, captureVp, 400, 400);
    // Now the user zooms 2x — same world anchors project to a 2x-larger rect.
    const zoomedVp = fakeViewport({ zoom: 2 });
    const rect = projectAnchoredBox(anchored.worldCorners, zoomedVp);
    expect(rect.left).toBeCloseTo(200, 6);   // (0.25*400) * 2
    expect(rect.width).toBeCloseTo(400, 6);  // (0.5*400) * 2
  });

  it('tracks the box under a later pan', () => {
    const captureVp = fakeViewport({ zoom: 1 });
    const finding = { box: { x: 0, y: 0, w: 0.5, h: 0.5 }, severity: 'moderate' };
    const anchored = anchorFindingToWorld(finding, captureVp, 200, 200);
    const pannedVp = fakeViewport({ zoom: 1, panX: 30, panY: 10 });
    const rect = projectAnchoredBox(anchored.worldCorners, pannedVp);
    expect(rect.left).toBeCloseTo(30, 6);
    expect(rect.top).toBeCloseTo(10, 6);
  });

  it('returns null for non-finite projections', () => {
    const badVp = { worldToCanvas: () => [NaN, NaN] };
    expect(projectAnchoredBox([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], badVp)).toBeNull();
  });

  it('returns null for missing corners', () => {
    expect(projectAnchoredBox(null, fakeViewport())).toBeNull();
    expect(projectAnchoredBox([[0, 0, 0]], fakeViewport())).toBeNull();
  });
});
