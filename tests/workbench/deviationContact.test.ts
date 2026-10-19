import { describe, expect, it } from 'vitest';
import { SpatialMesh } from '../../src/workbench/core/spatial';
import { computeDeviation, deviationStats, histogram } from '../../src/workbench/core/deviation';
import { computeContacts, contactBand, DEFAULT_CONTACT_THRESHOLDS } from '../../src/workbench/core/contact';
import { deviationColor, paintDeviation } from '../../src/workbench/core/colormap';
import { identity } from '../../src/workbench/core/mat4';
import type { MeshData } from '../../src/workbench/core/types';
import { icosphere, planeGrid, rigid } from '../helpers/syntheticMesh';

function finite(values: Float32Array): number[] {
  return Array.from(values).filter(Number.isFinite);
}

describe('BVH closest point', () => {
  it('returns a face that actually contains the closest point (indirect BVH keeps canonical order)', () => {
    const mesh = icosphere(10, 3);
    const s = new SpatialMesh(mesh);
    for (const p of [[0, 0, 12], [3, -11, 1], [-7, 7, 7], [0.5, 0.2, 0]] as const) {
      const h = s.closest(p[0], p[1], p[2]);
      expect(h).not.toBeNull();
      const f = h!.face;
      const I = mesh.indices, P = mesh.positions;
      // the hit point must lie on that triangle's plane
      const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3;
      const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
      const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const d = (h!.point[0] - P[a]) * n[0] + (h!.point[1] - P[a + 1]) * n[1] + (h!.point[2] - P[a + 2]) * n[2];
      expect(Math.abs(d) / Math.hypot(n[0], n[1], n[2])).toBeLessThan(1e-4);
    }
  });
});

describe('deviation map', () => {
  it('reads +0.1 mm for a sphere 0.1 mm larger and -0.1 mm the other way round', () => {
    const inner = icosphere(10, 5);
    const outer = icosphere(10.1, 5);
    const out = computeDeviation(new SpatialMesh(inner), outer, identity());
    const vals = finite(out.values);
    expect(vals.length).toBe(outer.positions.length / 3);
    for (const v of vals) expect(v).toBeGreaterThan(0.09);
    expect(out.stats.mean).toBeCloseTo(0.1, 2);
    const back = computeDeviation(new SpatialMesh(outer), inner, identity());
    expect(back.stats.max).toBeLessThan(-0.09);
    expect(back.stats.mean).toBeCloseTo(-0.1, 2);
  });

  it('gives exact signed values on offset planes and honours the search radius', () => {
    const ref = new SpatialMesh(planeGrid({ size: 10, n: 10 }));
    for (const z of [0.05, -0.2, 0.33]) {
      const res = computeDeviation(ref, planeGrid({ size: 6, n: 6, z }), identity());
      for (const v of finite(res.values)) expect(v).toBeCloseTo(z, 5);
    }
    const far = computeDeviation(ref, planeGrid({ size: 6, n: 6, z: 2 }), identity(), { maxDistance: 1 });
    expect(far.stats.matched).toBe(0);
    expect(far.stats.noData).toBe(far.values.length);
    const inverted = computeDeviation(ref, planeGrid({ size: 6, n: 6, z: 0.05 }), identity(), { invertSign: true });
    expect(inverted.stats.mean).toBeCloseTo(-0.05, 5);
  });

  it('applies the test-to-reference transform', () => {
    const ref = new SpatialMesh(planeGrid({ size: 10, n: 10 }));
    // test plane at z=0 but moved up 0.12 mm by its pose
    const res = computeDeviation(ref, planeGrid({ size: 6, n: 6 }), rigid([0, 0, 1], 0, [0, 0, 0.12]));
    expect(res.stats.mean).toBeCloseTo(0.12, 5);
  });

  it('reports tolerance bands by surface area and builds a histogram', () => {
    const values = new Float32Array([0.03, -0.04, 0.08, -0.15, 0.3, NaN]);
    const stats = deviationStats(values, null, [0.05, 0.1, 0.2]);
    expect(stats.matched).toBe(5);
    expect(stats.noData).toBe(1);
    expect(stats.bands.map((b) => b.vertexFraction)).toEqual([0.4, 0.6, 0.8]);
    const areas = new Float64Array([1, 1, 1, 1, 6, 0]);
    expect(deviationStats(values, areas, [0.05]).bands[0].areaFraction).toBeCloseTo(0.2, 6);
    const h = histogram(values, -0.2, 0.2, 4);
    expect(Array.from(h.counts)).toEqual([1, 1, 2, 0]);
    expect(h.above).toBe(1);
    expect(h.noData).toBe(1);
  });

  it('colours inside the tolerance green, positive warm, negative cool, missing grey', () => {
    expect(deviationColor(0.04, 0.3, 0.05)).toEqual(deviationColor(0, 0.3, 0.05));
    const pos = deviationColor(0.3, 0.3, 0.05), neg = deviationColor(-0.3, 0.3, 0.05);
    expect(pos[0]).toBeGreaterThan(pos[2]);
    expect(neg[2]).toBeGreaterThan(neg[0]);
    const out = new Float32Array(6);
    paintDeviation(out, new Float32Array([NaN, 0]), 0.3, 0.05);
    expect(out[0]).toBeCloseTo(out[1], 1);
  });
});

describe('occlusal contact map', () => {
  // lower arch surface: plane at y=0 facing up (+Y). upper: plane at y=g facing down (-Y).
  const lowerAt = (): MeshData => {
    const g = planeGrid({ size: 10, n: 20 });
    // rotate XY grid (normal +Z) to XZ (normal +Y): (x, y, z) -> (x, z, -y)
    const P = g.positions;
    for (let i = 0; i < P.length; i += 3) { const y = P[i + 1]; P[i + 1] = P[i + 2]; P[i + 2] = -y; }
    return g;
  };
  const upperAt = (gap: number): MeshData => {
    const g = lowerAt();
    for (let t = 0; t < g.indices.length; t += 3) { const x = g.indices[t + 1]; g.indices[t + 1] = g.indices[t + 2]; g.indices[t + 2] = x; }
    for (let i = 1; i < g.positions.length; i += 3) g.positions[i] += gap;
    return g;
  };
  const run = (gap: number, thresholds = DEFAULT_CONTACT_THRESHOLDS) => {
    const lower = lowerAt(), upper = upperAt(gap);
    return computeContacts(
      { mesh: upper, spatial: new SpatialMesh(upper), matrix: identity() },
      { mesh: lower, spatial: new SpatialMesh(lower), matrix: identity() },
      thresholds,
    );
  };

  it('classifies by the brief thresholds: <0 contact, 0-0.1 near, 0.1-0.3 close', () => {
    expect(contactBand(-0.01)).toBe('contact');
    expect(contactBand(0)).toBe('near');
    expect(contactBand(0.099)).toBe('near');
    expect(contactBand(0.1)).toBe('close');
    expect(contactBand(0.299)).toBe('close');
    expect(contactBand(0.3)).toBe('clear');
    expect(contactBand(NaN)).toBe('clear');
  });

  it('measures clearance and interpenetration on both arches with area estimates', () => {
    const near = run(0.05);
    expect(near.upper.vertices.near).toBe(near.upper.values.length);
    expect(near.lower.vertices.near).toBe(near.lower.values.length);
    expect(near.upper.areaNear).toBeCloseTo(100, 3);
    expect(near.upper.areaContact).toBe(0);

    const close = run(0.2);
    expect(close.lower.areaClose).toBeCloseTo(100, 3);

    const contact = run(-0.04);
    expect(contact.upper.vertices.contact).toBe(contact.upper.values.length);
    expect(contact.upper.areaContact).toBeCloseTo(100, 3);
    expect(contact.upper.deepest).toBeCloseTo(-0.04, 4);
    expect(contact.upper.contactPatches).toBe(1);

    const clear = run(0.5);
    expect(clear.upper.areaContact + clear.upper.areaNear + clear.upper.areaClose).toBe(0);
    expect(clear.warnings.join(' ')).toMatch(/not be in occlusion/);
  });

  it('respects custom thresholds and the arch poses', () => {
    const custom = run(0.15, { contact: 0, near: 0.2, close: 0.4 });
    expect(custom.upper.vertices.near).toBe(custom.upper.values.length);
    const lower = lowerAt(), upper = upperAt(0);
    // move the upper arch 0.25 mm up through its pose only
    const res = computeContacts(
      { mesh: upper, spatial: new SpatialMesh(upper), matrix: rigid([0, 1, 0], 0, [0, 0.25, 0]) },
      { mesh: lower, spatial: new SpatialMesh(lower), matrix: identity() },
    );
    expect(res.upper.vertices.close).toBe(res.upper.values.length);
  });

  it('counts separate contact patches', () => {
    const lower = lowerAt();
    const upper = upperAt(0.2);
    // push two separate cusps down through the lower surface
    const P = upper.positions;
    for (let v = 0; v < P.length / 3; v++) {
      const x = P[v * 3], z = P[v * 3 + 2];
      if (Math.hypot(x + 3, z) < 1.2 || Math.hypot(x - 3, z) < 1.2) P[v * 3 + 1] = -0.05;
    }
    const res = computeContacts(
      { mesh: upper, spatial: new SpatialMesh(upper), matrix: identity() },
      { mesh: lower, spatial: new SpatialMesh(lower), matrix: identity() },
    );
    expect(res.upper.contactPatches).toBe(2);
    expect(res.upper.areaContact).toBeGreaterThan(0);
  });
});
