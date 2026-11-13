import { describe, expect, it } from 'vitest';
import { applyEdit, type EditRequest } from '../../src/workbench/core/edits';
import { findBoundaryLoops } from '../../src/workbench/core/edits/fillHoles';
import { selectTrianglesInLasso } from '../../src/workbench/core/edits/trim';
import { meshSha256 } from '../../src/workbench/core/hash';
import { computeBounds, surfaceArea, topologyReport, compactMesh } from '../../src/workbench/core/meshData';
import { SpatialMesh } from '../../src/workbench/core/spatial';
import { computeDeviation } from '../../src/workbench/core/deviation';
import { identity } from '../../src/workbench/core/mat4';
import type { MeshData } from '../../src/workbench/core/types';
import { archMesh, icosphere, planeGrid, rigid } from '../helpers/syntheticMesh';

/** Orthographic top-down view of the XY plane: NDC = (x/10, y/10). */
const topView = (scale = 10) => ({
  mvp: [1 / scale, 0, 0, 0, 0, 1 / scale, 0, 0, 0, 0, -1 / 100, 0, 0, 0, 0, 1],
  viewDir: [0, 0, -1] as [number, number, number],
});

function withHole(): MeshData {
  // grid with the 2x2 centre quads removed -> one interior hole of 8 edges
  const g = planeGrid({ size: 10, n: 10 });
  const keep = new Uint8Array(g.indices.length / 3).fill(1);
  for (const [i, j] of [[4, 4], [5, 4], [4, 5], [5, 5]]) {
    const q = (j * 10 + i) * 2;
    keep[q] = 0; keep[q + 1] = 0;
  }
  return compactMesh(g, keep);
}

const requests = (mesh: MeshData): EditRequest[] => [
  { op: 'trim-plane', params: { plane: { origin: [0.3, 0, 0], normal: [1, 0.2, 0] }, keep: 'positive' } },
  { op: 'trim-lasso', params: { lasso: { polygon: [[-0.2, -0.2], [0.25, -0.2], [0.25, 0.3], [-0.2, 0.3]], ...topView(), frontOnly: true }, mode: 'delete-inside' } },
  { op: 'fill-holes', params: { maxEdges: 50, keepLargestBoundary: true } },
  { op: 'decimate', params: { targetTriangles: Math.floor(mesh.indices.length / 3 / 3) } },
  { op: 'smooth', params: { method: 'taubin', iterations: 5 } },
  { op: 'smooth', params: { method: 'laplacian', iterations: 3, lambda: 0.4 } },
  { op: 'apply-transform', params: { matrix: rigid([0, 0, 1], 10, [1, 2, 3]), acceptedBy: 'Dr Test', acceptedAt: '2026-10-19T10:00:00.000Z' } },
];

describe('edit operations are deterministic', () => {
  const input = withHole();
  for (const req of requests(input)) {
    it(`${req.op}${req.op === 'smooth' ? ` (${req.params.method})` : ''} gives the same output hash twice and never mutates its input`, async () => {
      const before = await meshSha256(input);
      const a = applyEdit(input, req);
      const b = applyEdit(input, JSON.parse(JSON.stringify(req)));
      expect(await meshSha256(a.mesh)).toBe(await meshSha256(b.mesh));
      expect(a.stats).toEqual(b.stats);
      expect(await meshSha256(input)).toBe(before);
      expect(a.mesh.indices.length % 3).toBe(0);
      const maxIndex = a.mesh.indices.reduce((m, v) => Math.max(m, v), 0);
      expect(maxIndex).toBeLessThan(a.mesh.positions.length / 3);
    });
  }
});

describe('trim', () => {
  it('trims at a plane with clean clipping (area and bounds exact)', () => {
    const g = planeGrid({ size: 10, n: 10 });
    const out = applyEdit(g, { op: 'trim-plane', params: { plane: { origin: [1.3, 0, 0], normal: [1, 0, 0] }, keep: 'negative' } });
    const b = computeBounds(out.mesh.positions);
    expect(b.max[0]).toBeCloseTo(1.3, 5);
    expect(surfaceArea(out.mesh)).toBeCloseTo(10 * (1.3 + 5), 4);
    expect(out.stats.trianglesClipped).toBeGreaterThan(0);
    expect(topologyReport(out.mesh).nonManifoldEdges).toBe(0);
  });

  it('selects by lasso only front-facing triangles inside the polygon', () => {
    const g = planeGrid({ size: 10, n: 10 });
    const lasso = { polygon: [[-0.25, -0.25], [0.25, -0.25], [0.25, 0.25], [-0.25, 0.25]] as [number, number][], ...topView(), frontOnly: true };
    const sel = selectTrianglesInLasso(g, lasso);
    expect(sel.reduce((a, b) => a + b, 0)).toBe(50); // 5x5 mm of a 1 mm grid, 2 triangles per quad
    const back = planeGrid({ size: 10, n: 10, flip: true });
    expect(selectTrianglesInLasso(back, lasso).reduce((a, b) => a + b, 0)).toBe(0);
    expect(selectTrianglesInLasso(back, { ...lasso, frontOnly: false }).reduce((a, b) => a + b, 0)).toBe(50);
  });

  it('hides triangles behind other surface when visibleOnly is set', () => {
    // two stacked planes; the camera (looking down -Z) sees only the top one
    const top = planeGrid({ size: 4, n: 4, z: 1 });
    const bottom = planeGrid({ size: 4, n: 4, z: 0 });
    const both: MeshData = {
      positions: Float32Array.from([...top.positions, ...bottom.positions]),
      indices: Uint32Array.from([...top.indices, ...Array.from(bottom.indices, (i) => i + top.positions.length / 3)]),
    };
    const lasso = { polygon: [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][], ...topView(10), frontOnly: true, visibleOnly: true };
    const sel = selectTrianglesInLasso(both, lasso, new SpatialMesh(both));
    expect(sel.slice(0, top.indices.length / 3).every((s) => s === 1)).toBe(true);
    expect(sel.slice(top.indices.length / 3).every((s) => s === 0)).toBe(true);
  });
});

describe('fill holes', () => {
  it('closes small holes, keeps the outer rim open and keeps orientation consistent', () => {
    const m = withHole();
    expect(findBoundaryLoops(m).loops.length).toBe(2);
    const out = applyEdit(m, { op: 'fill-holes', params: { maxEdges: 20, keepLargestBoundary: true } });
    expect(out.stats.holesFilled).toBe(1);
    expect(findBoundaryLoops(out.mesh).loops.length).toBe(1);
    expect(surfaceArea(out.mesh)).toBeCloseTo(100, 4);
    const topo = topologyReport(out.mesh);
    expect(topo.nonManifoldEdges).toBe(0);
    // consistent winding: every patch triangle faces +Z like the grid
    const P = out.mesh.positions, I = out.mesh.indices;
    for (let t = m.indices.length; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const nz = (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]);
      expect(nz).toBeGreaterThan(0);
    }
  });

  it('leaves holes larger than maxEdges alone', () => {
    const out = applyEdit(withHole(), { op: 'fill-holes', params: { maxEdges: 4, keepLargestBoundary: true } });
    expect(out.stats.holesFilled).toBe(0);
    expect(out.stats.holesSkippedTooLarge).toBe(1);
  });
});

describe('decimate', () => {
  it('reaches the target and stays within a small distance of the original surface', () => {
    const arch = archMesh({ nu: 120, nv: 30 });
    const target = 1500;
    const out = applyEdit(arch, { op: 'decimate', params: { targetTriangles: target } });
    expect(out.mesh.indices.length / 3).toBeLessThanOrEqual(target);
    expect(out.mesh.indices.length / 3).toBeGreaterThan(target * 0.9);
    const topo = topologyReport(out.mesh);
    expect(topo.nonManifoldEdges).toBe(0);
    // decimated surface stays close to the original
    const dev = computeDeviation(new SpatialMesh(arch), out.mesh, identity(), { maxDistance: 2 });
    expect(dev.stats.noData).toBe(0);
    expect(Math.max(Math.abs(dev.stats.min), Math.abs(dev.stats.max))).toBeLessThan(0.25);
    // bounds preserved (rim held by boundary quadrics)
    const b0 = computeBounds(arch.positions), b1 = computeBounds(out.mesh.positions);
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(b0.min[k] - b1.min[k])).toBeLessThan(0.3);
      expect(Math.abs(b0.max[k] - b1.max[k])).toBeLessThan(0.3);
    }
  });
});

describe('smooth', () => {
  it('Taubin shrinks a noisy sphere far less than plain Laplacian', () => {
    const s = icosphere(10, 3);
    // deterministic noise
    for (let i = 0; i < s.positions.length; i++) s.positions[i] += 0.05 * Math.sin(i * 12.9898);
    const meanR = (m: MeshData) => {
      let r = 0;
      for (let v = 0; v < m.positions.length / 3; v++) r += Math.hypot(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
      return r / (m.positions.length / 3);
    };
    const lap = applyEdit(s, { op: 'smooth', params: { method: 'laplacian', iterations: 10, lambda: 0.5 } });
    const tau = applyEdit(s, { op: 'smooth', params: { method: 'taubin', iterations: 10 } });
    expect(Math.abs(10 - meanR(tau.mesh))).toBeLessThan(Math.abs(10 - meanR(lap.mesh)) / 3);
    expect(tau.stats.maxDisplacementMm).toBeGreaterThan(0);
  });

  it('holds boundary vertices fixed by default', () => {
    const g = planeGrid({ size: 10, n: 10 });
    for (let i = 2; i < g.positions.length; i += 3) g.positions[i] = 0.1 * Math.sin(i);
    const out = applyEdit(g, { op: 'smooth', params: { method: 'laplacian', iterations: 5 } });
    expect(out.stats.fixedBoundaryVertices).toBe(40);
    expect(out.mesh.positions[2]).toBe(g.positions[2]); // corner vertex unchanged
  });
});

describe('apply accepted alignment', () => {
  it('refuses an unaccepted or non-rigid transform', () => {
    const g = planeGrid({ n: 2 });
    expect(() => applyEdit(g, { op: 'apply-transform', params: { matrix: rigid([0, 0, 1], 5, [0, 0, 0]), acceptedBy: '', acceptedAt: '' } })).toThrow(/accepted/);
    const scaled = rigid([0, 0, 1], 0, [0, 0, 0]);
    scaled[0] = 2;
    expect(() => applyEdit(g, { op: 'apply-transform', params: { matrix: scaled, acceptedBy: 'Dr Test', acceptedAt: 'x' } })).toThrow(/rigid/);
  });
});
