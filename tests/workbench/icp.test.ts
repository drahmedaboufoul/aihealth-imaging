import { describe, expect, it } from 'vitest';
import { SpatialMesh } from '../../src/workbench/core/spatial';
import { icp } from '../../src/workbench/core/icp';
import { fitRigid, nearlyCollinear } from '../../src/workbench/core/rigid';
import { identity, invertRigid, multiply, rotationAngleDeg, transformPoint, translationLength } from '../../src/workbench/core/mat4';
import type { Vec3 } from '../../src/workbench/core/types';
import { archMesh, rigid, transformed, withBump } from '../helpers/syntheticMesh';

/** Residual between two rigid transforms: angle (deg) and translation (mm) of a^-1 b. */
function residual(a: number[], b: number[]) {
  const d = multiply(invertRigid(a), b);
  return { deg: rotationAngleDeg(d), mm: translationLength(d) };
}

describe('landmark (3-point) rigid fit', () => {
  it('recovers a rigid transform exactly from three non-collinear pairs', () => {
    const G = rigid([0.3, 1, 0.2], 37, [4, -2, 7]);
    const fixed: Vec3[] = [[10, 2, 3], [-12, 4, 1], [3, 9, -15]];
    const moving = fixed.map((p) => transformPoint(invertRigid(G), p));
    const fit = fitRigid(moving, fixed);
    expect(fit.rms).toBeLessThan(1e-9);
    const r = residual(fit.matrix, G);
    expect(r.deg).toBeLessThan(1e-6);
    expect(r.mm).toBeLessThan(1e-6);
  });
  it('flags collinear landmark picks', () => {
    expect(nearlyCollinear([[0, 0, 0], [1, 0, 0], [2, 0.001, 0]])).toBe(true);
    expect(nearlyCollinear([[0, 0, 0], [10, 0, 0], [0, 10, 0]])).toBe(false);
  });
});

describe('ICP refinement', () => {
  const fixedMesh = archMesh({ nu: 180, nv: 40 });
  const fixed = new SpatialMesh(fixedMesh);

  it('recovers a known rigid transform within 0.01 deg / 0.005 mm (point-to-plane)', () => {
    const G = rigid([0.2, 1, 0.4], 4, [0.8, -0.5, 0.6]); // fixed -> moving
    const moving = transformed(fixedMesh, G);
    const res = icp(fixed, moving, identity(), { maxCorrespondence: 3 });
    const expected = invertRigid(G); // moving -> fixed
    const r = residual(res.matrix, expected);
    expect(res.converged).toBe(true);
    expect(res.method).toBe('point-to-plane');
    expect(r.deg).toBeLessThan(0.01);
    expect(r.mm).toBeLessThan(0.005);
    expect(res.rms).toBeLessThan(0.002);
    expect(res.iterations).toBeGreaterThan(1);
    expect(res.history[0].rms).toBeGreaterThan(res.rms);
    expect(res.inlierFraction).toBeGreaterThan(0.95);
  });

  it('handles a large misalignment after a noisy 3-point landmark pre-alignment', () => {
    const G = rigid([1, 0.3, -0.5], 35, [6, 3, -4]);
    const moving = transformed(fixedMesh, G);
    // landmarks picked on each scan with ~0.3 mm picking error
    const idx = [0, Math.floor(fixedMesh.positions.length / 6), fixedMesh.positions.length / 3 - 1];
    const fixedPts: Vec3[] = idx.map((v) => [fixedMesh.positions[v * 3], fixedMesh.positions[v * 3 + 1], fixedMesh.positions[v * 3 + 2]]);
    const noise: Vec3[] = [[0.2, -0.1, 0.15], [-0.2, 0.2, 0.1], [0.1, 0.25, -0.2]];
    const movingPts: Vec3[] = fixedPts.map((p, i) => {
      const q = transformPoint(G, p);
      return [q[0] + noise[i][0], q[1] + noise[i][1], q[2] + noise[i][2]];
    });
    const pre = fitRigid(movingPts, fixedPts);
    const before = residual(pre.matrix, invertRigid(G));
    expect(before.deg).toBeGreaterThan(0.05); // landmarks alone are not exact
    const res = icp(fixed, moving, pre.matrix);
    const after = residual(res.matrix, invertRigid(G));
    expect(after.deg).toBeLessThan(0.01);
    expect(after.mm).toBeLessThan(0.005);
  });

  it('rejects outliers: a locally changed region does not pull the fit', () => {
    const G = rigid([0, 1, 0], 2, [0.4, 0.2, -0.3]);
    const changed = withBump(fixedMesh, [0, 12], 6, 1.5); // 1.5 mm local change (e.g. a new restoration)
    const moving = transformed(changed, G);
    const res = icp(fixed, moving, identity(), { maxCorrespondence: 3 });
    const r = residual(res.matrix, invertRigid(G));
    expect(r.deg).toBeLessThan(0.05);
    expect(r.mm).toBeLessThan(0.02);
    expect(res.inlierFraction).toBeLessThan(1);
  });

  it('is deterministic for the same seed', () => {
    const moving = transformed(fixedMesh, rigid([1, 1, 0], 3, [0.3, 0, 0.2]));
    const a = icp(fixed, moving, identity(), { seed: 7 });
    const b = icp(fixed, moving, identity(), { seed: 7 });
    expect(a.matrix).toEqual(b.matrix);
    expect(a.iterations).toBe(b.iterations);
  });

  it('reports failure instead of a fake fit when surfaces do not overlap', () => {
    const far = transformed(fixedMesh, rigid([0, 1, 0], 0, [100, 0, 0]));
    const res = icp(fixed, far, identity());
    expect(res.converged).toBe(false);
    expect(res.reason).toMatch(/too few/);
  });
});
