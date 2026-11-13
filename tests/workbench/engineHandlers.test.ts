import { describe, expect, it } from 'vitest';
import { GeometryStore, handleRequest, transferablesOf } from '../../src/workbench/engine/handlers';
import { writeBinaryPly, writeBinaryStl } from '../../src/workbench/core/export';
import { identity, invertRigid, multiply, rotationAngleDeg, translationLength } from '../../src/workbench/core/mat4';
import { archMesh, rigid, transformed, withBump } from '../helpers/syntheticMesh';

const noop = () => {};

describe('geometry worker handlers (protocol, in Node)', () => {
  it('loads two scans, aligns, maps deviation, edits, slices, measures and exports', async () => {
    const store = new GeometryStore();
    const arch = archMesh({ nu: 120, nv: 30 });
    const G = rigid([0.1, 1, 0.3], 3, [0.6, -0.4, 0.3]);
    const visitB = transformed(withBump(arch, [0, 12], 4, 0.15), G);
    const progress: string[] = [];
    const a = await handleRequest(store, { kind: 'load', key: 'A.v0', name: 'upper.stl', buffer: writeBinaryStl(arch) }, (s) => progress.push(s));
    const b = await handleRequest(store, { kind: 'load', key: 'B.v0', name: 'visit.ply', buffer: writeBinaryPly(visitB) }, noop);
    expect(progress).toContain('building spatial index');
    expect(a.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.stats.triangles).toBe(arch.indices.length / 3);
    expect(a.stats.closed).toBe(false);
    expect(a.mesh.bvh.roots.length).toBeGreaterThan(0);
    expect(b.mesh.displayToTopo).toBeNull();
    // results are copies: transferring them must not detach the store's arrays
    expect(transferablesOf(a).length).toBeGreaterThan(3);

    // the store refuses to overwrite an existing (immutable) version
    await expect(handleRequest(store, { kind: 'load', key: 'A.v0', name: 'x.stl', buffer: writeBinaryStl(arch) }, noop)).rejects.toThrow(/immutable/);

    const reg = await handleRequest(store, { kind: 'icp', fixedKey: 'A.v0', movingKey: 'B.v0', initial: identity() }, noop);
    const err = multiply(invertRigid(reg.matrix), invertRigid(G));
    expect(rotationAngleDeg(err)).toBeLessThan(0.02);
    expect(translationLength(err)).toBeLessThan(0.01);

    const dev = await handleRequest(store, { kind: 'deviation', refKey: 'A.v0', testKey: 'B.v0', testToRef: reg.matrix, maxDistance: 1, bands: [0.05, 0.1, 0.2] }, noop);
    expect(dev.stats.max).toBeGreaterThan(0.12);
    expect(dev.stats.max).toBeLessThan(0.17);
    expect(dev.stats.bands[0].areaFraction).toBeGreaterThan(0.8);

    const contact = await handleRequest(store, {
      kind: 'contact', upper: { key: 'A.v0', matrix: identity() }, lower: { key: 'B.v0', matrix: reg.matrix },
      thresholds: { contact: 0, near: 0.1, close: 0.3 },
    }, noop);
    expect(contact.upper.values.length).toBe(a.stats.vertices);

    const edit = await handleRequest(store, { kind: 'edit', parentKey: 'A.v0', key: 'A.v1', request: { op: 'decimate', params: { targetTriangles: 2000 } } }, noop);
    expect(edit.stats.triangles).toBeLessThanOrEqual(2000);
    expect(edit.stats.maxChangeMm).toBeLessThan(0.3);
    expect(edit.outputSha256).not.toBe(a.outputSha256);
    // the original is still there, untouched
    const again = await handleRequest(store, { kind: 'export', key: 'A.v0', format: 'stl' }, noop);
    expect(again.buffer.byteLength).toBe(84 + 50 * (arch.indices.length / 3));
    const v1 = await handleRequest(store, { kind: 'export', key: 'A.v1', format: 'ply' }, noop);
    expect(new TextDecoder().decode(new Uint8Array(v1.buffer, 0, 3))).toBe('ply');
    expect(v1.sha256).toMatch(/^[0-9a-f]{64}$/);

    const section = await handleRequest(store, { kind: 'section', items: [{ key: 'A.v0', matrix: identity() }, { key: 'B.v0', matrix: reg.matrix }], plane: { origin: [0, 0, 12], normal: [1, 0, 0] } }, noop);
    expect(section.items).toHaveLength(2);
    expect(section.items[0].polylines.length).toBeGreaterThan(0);

    const path = await handleRequest(store, { kind: 'surfacePath', key: 'A.v0', a: [arch.positions[0], arch.positions[1], arch.positions[2]], b: [arch.positions[300], arch.positions[301], arch.positions[302]] }, noop);
    expect(path!.length).toBeGreaterThan(0);
    expect(path!.length).toBeLessThanOrEqual(path!.graphLength + 1e-9);

    const area = await handleRequest(store, { kind: 'area', key: 'A.v0', lasso: { polygon: [[-1, -1], [1, -1], [1, 1], [-1, 1]], mvp: [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, -0.01, 0, 0, 0, 0, 1], viewDir: [0, 0, -1], frontOnly: false } }, noop);
    expect(area.triangles).toBeGreaterThan(0);
    expect(area.area).toBeGreaterThan(0);

    await handleRequest(store, { kind: 'dispose', key: 'A.v1' }, noop);
    await expect(handleRequest(store, { kind: 'export', key: 'A.v1', format: 'stl' }, noop)).rejects.toThrow(/not loaded/);
  });
});
