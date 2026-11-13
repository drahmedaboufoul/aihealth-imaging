import { describe, expect, it } from 'vitest';
import { sliceMesh, toProfile, profileExtent, profileGap } from '../../src/workbench/core/section';
import { surfacePath } from '../../src/workbench/core/geodesic';
import { SpatialMesh } from '../../src/workbench/core/spatial';
import { angleDeg, buildMeasurementsFile, distance, MEASUREMENTS_SCHEMA, parseMeasurementsFile, type MeasurementRecord } from '../../src/workbench/core/measurements';
import { SessionPersistence } from '../../src/workbench/core/persistence';
import { selectTrianglesInLasso } from '../../src/workbench/core/edits/trim';
import { surfaceArea, compactMesh } from '../../src/workbench/core/meshData';
import { icosphere, planeGrid } from '../helpers/syntheticMesh';

describe('cross-section', () => {
  it('slices a sphere through its centre into one closed circle of the right radius', () => {
    const s = icosphere(10, 4);
    const lines = sliceMesh(s, { origin: [0, 0, 0.0123], normal: [0, 0, 1] });
    expect(lines.length).toBe(1);
    expect(lines[0].closed).toBe(true);
    for (const [x, y] of lines[0].points) expect(Math.hypot(x, y)).toBeGreaterThan(9.9);
    const profile = toProfile(lines, { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] });
    const ext = profileExtent(profile);
    expect(ext.width).toBeGreaterThan(19.8);
    expect(ext.width).toBeLessThanOrEqual(20.0001);
  });

  it('measures the gap between two profiles', () => {
    const a = sliceMesh(icosphere(10, 4), { origin: [0, 0, 0.01], normal: [0, 0, 1] });
    const b = sliceMesh(icosphere(10.2, 4), { origin: [0, 0, 0.01], normal: [0, 0, 1] });
    const basis = { origin: [0, 0, 0] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };
    const gap = profileGap(toProfile(a, basis), toProfile(b, basis));
    expect(gap.mean).toBeGreaterThan(0.15);
    expect(gap.mean).toBeLessThan(0.25);
  });

  it('returns open polylines on an open surface', () => {
    const lines = sliceMesh(planeGrid({ size: 10, n: 10 }), { origin: [0.37, 0, 0], normal: [1, 0, 0] });
    expect(lines.length).toBe(1);
    expect(lines[0].closed).toBe(false);
    expect(lines[0].points.length).toBe(11 + 10); // vertical edges + diagonals crossed
  });
});

describe('surface path and area', () => {
  it('surface path on a regular grid: graph path is an upper bound, shortening reaches the straight line', () => {
    const g = planeGrid({ size: 10, n: 40 });
    const straight = Math.hypot(8, 5);
    const graph = surfacePath(g, [-4, -3, 0], [4, 2, 0]);
    expect(graph!.method).toBe('graph');
    expect(graph!.length).toBeGreaterThanOrEqual(straight - 1e-6);
    expect(graph!.length).toBeLessThan(straight * 1.08); // edge-only Dijkstra would be 38% over here
    const refined = surfacePath(g, [-4, -3, 0], [4, 2, 0], { spatial: new SpatialMesh(g) });
    expect(refined!.method).toBe('graph+shortening');
    expect(refined!.length).toBeLessThan(straight * 1.005);
    expect(refined!.length).toBeGreaterThanOrEqual(straight - 1e-4);
  });

  it('surface path on a sphere approximates the great-circle distance', () => {
    const r = 10;
    const s = icosphere(r, 4);
    const res = surfacePath(s, [r, 0, 0], [0, r, 0], { spatial: new SpatialMesh(s) });
    const gc = (r * Math.PI) / 2;
    expect(res!.length).toBeGreaterThan(gc * 0.99); // faceted sphere is slightly inside the true one
    expect(res!.length).toBeLessThan(gc * 1.01);
  });

  it('area of a lasso selection on a 1 mm grid is the enclosed square', () => {
    const g = planeGrid({ size: 10, n: 10 });
    const sel = selectTrianglesInLasso(g, {
      polygon: [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]],
      mvp: [0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, -0.01, 0, 0, 0, 0, 1], viewDir: [0, 0, -1], frontOnly: true,
    });
    expect(surfaceArea(compactMesh(g, sel))).toBeCloseTo(36, 6);
  });

  it('distance and angle helpers', () => {
    expect(distance([0, 0, 0], [3, 4, 0])).toBe(5);
    expect(angleDeg([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(90, 9);
    expect(angleDeg([1, 0, 0], [0, 0, 0], [1, 1, 0])).toBeCloseTo(45, 9);
  });
});

describe('measurements JSON', () => {
  const rec: MeasurementRecord = {
    id: 'm-1', kind: 'distance', slot: 'A', versionId: 'A.v0', versionSha256: 'a'.repeat(64),
    points: [[0, 0, 0], [1, 2, 2]], value: 3, unit: 'mm', method: 'euclidean', createdAt: '2026-10-19T08:00:00.000Z',
  };

  it('round-trips through the file format and the session persistence', async () => {
    const file = buildMeasurementsFile([rec], new Date('2026-10-19T09:00:00Z'));
    expect(file.schema).toBe(MEASUREMENTS_SCHEMA);
    const back = parseMeasurementsFile(JSON.stringify(file));
    expect(back.measurements).toEqual([rec]);
    const p = new SessionPersistence();
    await p.saveMeasurements({ kind: 'local', id: null }, [rec]);
    expect(await p.loadMeasurements({ kind: 'local', id: null })).toEqual([rec]);
    expect(p.exportMeasurementsFile({ kind: 'local', id: null }).measurements).toEqual([rec]);
  });

  it('rejects files that are not workbench measurements or carry bad values', () => {
    expect(() => parseMeasurementsFile('not json')).toThrow(/JSON/);
    expect(() => parseMeasurementsFile(JSON.stringify({ schema: 'other' }))).toThrow(/schema/);
    const bad = (patch: Partial<MeasurementRecord>) => JSON.stringify(buildMeasurementsFile([{ ...rec, ...patch }]));
    expect(() => parseMeasurementsFile(bad({ value: NaN }))).toThrow(/numeric/);
    expect(() => parseMeasurementsFile(bad({ slot: 'patient-123' }))).toThrow(/slot/);
    expect(() => parseMeasurementsFile(bad({ points: [[0, 0]] as never }))).toThrow(/points/);
    expect(() => parseMeasurementsFile(bad({ versionSha256: 'x' }))).toThrow(/hash/);
  });

  it('never writes patient or study identifiers', () => {
    const text = JSON.stringify(buildMeasurementsFile([rec]));
    expect(text).not.toMatch(/patient|study|customer|name/i);
  });
});
