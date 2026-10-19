/*
 * Geometry worker request handlers, kept separate from the Worker glue so
 * they run in Node unit tests too. The store owns the canonical topology
 * meshes and their BVHs; the UI only ever receives copies.
 */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { parseMeshBuffer, type DisplayMesh } from '../core/parse';
import { computeVertexNormals, topologyReport } from '../core/meshData';
import { SpatialMesh, now } from '../core/spatial';
import { meshSha256, sha256Hex } from '../core/hash';
import { icp } from '../core/icp';
import { computeDeviation } from '../core/deviation';
import { computeContacts } from '../core/contact';
import { applyEdit } from '../core/edits';
import { decimate } from '../core/edits/decimate';
import { sliceMesh } from '../core/section';
import { surfacePath } from '../core/geodesic';
import { selectTrianglesInLasso } from '../core/edits/trim';
import { triangleArea } from '../core/meshData';
import { writeBinaryPly, writeBinaryStl } from '../core/export';
import { invertRigid, transformPoint, transformDirection } from '../core/mat4';
import { sampleIndices } from '../core/random';
import { computeAutoOrient } from '../../components/ios-viewer/utils/autoOrient';
import type { MeshData } from '../core/types';
import type { EditResult, LoadResult, MeshPayload, WorkerRequest, WorkerResultMap } from './protocol';

interface StoredMesh {
  mesh: MeshData;
  normals: Float32Array;
  spatial: SpatialMesh;
  display: DisplayMesh | null;
  displayToTopo: Uint32Array | null;
}

export type ProgressFn = (stage: string, fraction: number) => void;

export class GeometryStore {
  private meshes = new Map<string, StoredMesh>();

  get(key: string): StoredMesh {
    const m = this.meshes.get(key);
    if (!m) throw new Error(`Scan version ${key} is not loaded.`);
    return m;
  }

  has(key: string): boolean {
    return this.meshes.has(key);
  }

  put(key: string, m: StoredMesh): void {
    if (this.meshes.has(key)) throw new Error(`Scan version ${key} already exists and is immutable.`);
    this.meshes.set(key, m);
  }

  delete(key: string): void {
    this.meshes.delete(key);
  }
}

function serializeBvh(bvh: MeshBVH): MeshPayload['bvh'] {
  const ser = MeshBVH.serialize(bvh, { cloneBuffers: false });
  return {
    roots: ser.roots.map((r) => (r as ArrayBuffer).slice(0)),
    indirectBuffer: ser.indirectBuffer ? (ser.indirectBuffer as Uint32Array).slice() : null,
  };
}

/** Copies for the main thread (the store keeps its own). */
function payloadFor(stored: StoredMesh): MeshPayload {
  const { mesh, normals, display, displayToTopo, spatial } = stored;
  if (!display) {
    return {
      positions: mesh.positions.slice(), indices: mesh.indices.slice(), normals: normals.slice(),
      colors: mesh.colors ? mesh.colors.slice() : null, uvs: null, displayToTopo: null,
      bvh: serializeBvh(spatial.bvh), topoVertices: mesh.positions.length / 3, topoTriangles: mesh.indices.length / 3,
    };
  }
  const dn = new Float32Array(display.positions.length);
  for (let i = 0; i < dn.length / 3; i++) {
    const t = (displayToTopo as Uint32Array)[i];
    dn[i * 3] = normals[t * 3]; dn[i * 3 + 1] = normals[t * 3 + 1]; dn[i * 3 + 2] = normals[t * 3 + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(display.positions, 3));
  g.setIndex(new THREE.BufferAttribute(display.indices, 1));
  const dBvh = new MeshBVH(g, { indirect: true });
  return {
    positions: display.positions.slice(), indices: display.indices.slice(), normals: dn,
    colors: display.colors ? display.colors.slice() : null, uvs: display.uvs ? display.uvs.slice() : null,
    displayToTopo: (displayToTopo as Uint32Array).slice(), bvh: serializeBvh(dBvh),
    topoVertices: mesh.positions.length / 3, topoTriangles: mesh.indices.length / 3,
  };
}

export function transferablesOf(result: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const visit = (v: unknown, depth: number) => {
    if (!v || depth > 6) return;
    if (v instanceof ArrayBuffer) { out.add(v); return; }
    if (ArrayBuffer.isView(v)) { if (v.buffer instanceof ArrayBuffer) out.add(v.buffer); return; }
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) visit(x, depth + 1);
  };
  visit(result, 0);
  return [...out];
}

/** Sampled distance of a derived mesh from its parent surface (how much an edit moved the surface). */
function changeFromParent(parent: StoredMesh, child: MeshData): { maxChangeMm: number; rmsChangeMm: number } {
  const n = child.positions.length / 3;
  const idx = sampleIndices(n, Math.min(n, 20000), 11);
  let max = 0, sum = 0, m = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const h = parent.spatial.closest(child.positions[i * 3], child.positions[i * 3 + 1], child.positions[i * 3 + 2], 5);
    if (!h) continue;
    if (h.distance > max) max = h.distance;
    sum += h.distance * h.distance; m++;
  }
  return { maxChangeMm: max, rmsChangeMm: m ? Math.sqrt(sum / m) : 0 };
}

export async function handleRequest<K extends WorkerRequest['kind']>(
  store: GeometryStore, req: Extract<WorkerRequest, { kind: K }>, progress: ProgressFn,
): Promise<WorkerResultMap[K]> {
  const r = req as WorkerRequest;
  switch (r.kind) {
    case 'load': {
      const t0 = now();
      progress('hashing source', 0.02);
      const sourceSha256 = await sha256Hex(new Uint8Array(r.buffer));
      const t1 = now();
      progress('parsing', 0.1);
      const parsed = parseMeshBuffer(r.buffer, r.name, r.format);
      progress('normals', 0.5);
      const t2 = now();
      const normals = computeVertexNormals(parsed.topo.positions, parsed.topo.indices);
      const t3 = now();
      progress('building spatial index', 0.6);
      const spatial = new SpatialMesh(parsed.topo, normals);
      const t4 = now();
      const outputSha256 = await meshSha256(parsed.topo);
      const t5 = now();
      const topo = topologyReport(parsed.topo);
      const t6 = now();
      const stored: StoredMesh = { mesh: parsed.topo, normals, spatial, display: parsed.display, displayToTopo: parsed.displayToTopo };
      store.put(r.key, stored);
      const orient = computeAutoOrient([spatial.geometry]);
      progress('preparing view', 0.9);
      const mesh = payloadFor(stored);
      const t7 = now();
      const result: LoadResult = {
        key: r.key,
        mesh,
        sourceSha256,
        outputSha256,
        autoOrient: orient.confident ? Array.from(orient.transform.elements) : null,
        stats: {
          sourceTriangles: parsed.stats.sourceTriangles,
          triangles: parsed.topo.indices.length / 3,
          vertices: parsed.topo.positions.length / 3,
          degenerateDropped: parsed.stats.degenerateDropped,
          boundaryEdges: topo.boundaryEdges,
          closed: topo.closed,
          sourceHashMs: t1 - t0,
          parseMs: parsed.stats.parseMs,
          weldMs: parsed.stats.weldMs,
          normalsMs: t3 - t2,
          bvhMs: t4 - t3,
          hashMs: (t1 - t0) + (t5 - t4),
          topologyMs: t6 - t5,
          payloadMs: t7 - t6,
          totalMs: now() - t0,
        },
      };
      return result as WorkerResultMap[K];
    }
    case 'icp': {
      const fixed = store.get(r.fixedKey);
      const moving = store.get(r.movingKey);
      return icp(fixed.spatial, moving.mesh, r.initial, r.options, moving.normals) as WorkerResultMap[K];
    }
    case 'deviation': {
      const ref = store.get(r.refKey);
      const test = store.get(r.testKey);
      return computeDeviation(ref.spatial, test.mesh, r.testToRef, { maxDistance: r.maxDistance, invertSign: r.invertSign }, r.bands) as WorkerResultMap[K];
    }
    case 'contact': {
      const up = store.get(r.upper.key);
      const low = store.get(r.lower.key);
      return computeContacts(
        { mesh: up.mesh, spatial: up.spatial, matrix: r.upper.matrix },
        { mesh: low.mesh, spatial: low.spatial, matrix: r.lower.matrix },
        r.thresholds, { searchRadius: r.searchRadius, invertSign: r.invertSign },
      ) as WorkerResultMap[K];
    }
    case 'edit': {
      const parent = store.get(r.parentKey);
      if (store.has(r.key)) throw new Error(`Version ${r.key} already exists.`);
      progress(r.request.op, 0.05);
      const out = r.request.op === 'decimate'
        ? decimate(parent.mesh, r.request.params, (f) => progress('decimate', 0.05 + 0.75 * f))
        : applyEdit(parent.mesh, r.request, parent.spatial);
      if (out.mesh.indices.length === 0) throw new Error('The edit would remove the whole surface.');
      progress('indexing result', 0.85);
      const normals = computeVertexNormals(out.mesh.positions, out.mesh.indices);
      const spatial = new SpatialMesh(out.mesh, normals);
      const outputSha256 = await meshSha256(out.mesh);
      const stored: StoredMesh = { mesh: out.mesh, normals, spatial, display: null, displayToTopo: null };
      const change = r.request.op === 'apply-transform' ? { maxChangeMm: NaN, rmsChangeMm: NaN } : changeFromParent(parent, out.mesh);
      store.put(r.key, stored);
      const res: EditResult = {
        key: r.key, mesh: payloadFor(stored), outputSha256,
        stats: { ...out.stats, ...change, vertices: out.mesh.positions.length / 3 },
      };
      return res as WorkerResultMap[K];
    }
    case 'section': {
      const items = r.items.map(({ key, matrix }) => {
        const m = store.get(key);
        const inv = invertRigid(matrix);
        const o = transformPoint(inv, r.plane.origin);
        const n = transformDirection(inv, r.plane.normal);
        const lines = sliceMesh(m.mesh, { origin: o, normal: n });
        return { key, polylines: lines.map((l) => ({ closed: l.closed, points: l.points.map((p) => transformPoint(matrix, p)) })) };
      });
      return { items } as WorkerResultMap[K];
    }
    case 'surfacePath': {
      const m = store.get(r.key);
      const res = surfacePath(m.mesh, r.a, r.b, { faceA: r.faceA, faceB: r.faceB, spatial: m.spatial });
      return (res ? { length: res.length, graphLength: res.graphLength, method: res.method, points: res.points } : null) as WorkerResultMap[K];
    }
    case 'area': {
      const m = store.get(r.key);
      const sel = selectTrianglesInLasso(m.mesh, r.lasso, m.spatial);
      let area = 0, tris = 0;
      const I = m.mesh.indices;
      for (let t = 0; t < sel.length; t++) {
        if (!sel[t]) continue;
        area += triangleArea(m.mesh.positions, I[t * 3], I[t * 3 + 1], I[t * 3 + 2]);
        tris++;
      }
      return { area, triangles: tris, mask: sel } as WorkerResultMap[K];
    }
    case 'export': {
      const m = store.get(r.key);
      const buffer = r.format === 'stl' ? writeBinaryStl(m.mesh) : writeBinaryPly(m.mesh);
      const sha256 = await sha256Hex(new Uint8Array(buffer));
      return { buffer, sha256 } as WorkerResultMap[K];
    }
    case 'dispose': {
      store.delete(r.key);
      return { ok: true } as WorkerResultMap[K];
    }
    default:
      throw new Error('Unknown request');
  }
}
