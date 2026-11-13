/*
 * Performance check on a synthetic 2M-triangle scan (opt-in: it allocates
 * a ~100 MB STL). Run with:  WORKBENCH_PERF=1 npx vitest run tests/workbench/perf2m.test.ts
 * Numbers are printed as one JSON line prefixed with PERF2M.
 */
import { describe, expect, it } from 'vitest';
import { writeBinaryStl } from '../../src/workbench/core/export';
import { parseMeshBuffer } from '../../src/workbench/core/parse';
import { SpatialMesh } from '../../src/workbench/core/spatial';
import { computeDeviation } from '../../src/workbench/core/deviation';
import { icp } from '../../src/workbench/core/icp';
import { meshSha256 } from '../../src/workbench/core/hash';
import { computeVertexNormals } from '../../src/workbench/core/meshData';
import { identity } from '../../src/workbench/core/mat4';
import { applyEdit } from '../../src/workbench/core/edits';
import { archMesh, rigid, transformed } from '../helpers/syntheticMesh';

const run = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.WORKBENCH_PERF === '1';

describe.skipIf(!run)('2M-triangle performance (Node, single thread)', () => {
  it('parses, welds, indexes and analyses a 2M-triangle scan', async () => {
    const t = () => performance.now();
    const arch = archMesh({ nu: 2000, nv: 500 }); // 2,000,000 triangles
    const stl = writeBinaryStl(arch);
    const out: Record<string, number> = { triangles: arch.indices.length / 3, stlMB: +(stl.byteLength / 1e6).toFixed(1) };
    let t0 = t();
    const parsed = parseMeshBuffer(stl, 'synthetic.stl');
    out.parseMs = Math.round(parsed.stats.parseMs);
    out.weldMs = Math.round(parsed.stats.weldMs);
    out.loadTotalMs = Math.round(t() - t0);
    t0 = t();
    const normals = computeVertexNormals(parsed.topo.positions, parsed.topo.indices);
    out.normalsMs = Math.round(t() - t0);
    t0 = t();
    const spatial = new SpatialMesh(parsed.topo, normals);
    out.bvhMs = Math.round(t() - t0);
    t0 = t();
    await meshSha256(parsed.topo);
    out.sha256Ms = Math.round(t() - t0);
    const moving = transformed(parsed.topo, rigid([0.2, 1, 0.1], 1.5, [0.3, -0.2, 0.1]));
    t0 = t();
    const reg = icp(spatial, moving, identity());
    out.icpMs = Math.round(t() - t0);
    out.icpIterations = reg.iterations;
    out.icpRmsMm = +reg.rms.toExponential(2);
    t0 = t();
    const dev = computeDeviation(spatial, moving, reg.matrix, { maxDistance: 1 });
    out.deviationMs = Math.round(t() - t0);
    out.deviationVertices = dev.values.length;
    t0 = t();
    const dec = applyEdit(parsed.topo, { op: 'decimate', params: { targetTriangles: 200_000 } });
    out.decimateTo200kMs = Math.round(t() - t0);
    out.decimatedTriangles = dec.mesh.indices.length / 3;
    console.log(`PERF2M ${JSON.stringify(out)}`);
    expect(parsed.topo.indices.length / 3).toBe(2_000_000);
    expect(reg.converged).toBe(true);
  }, 600_000);
});
