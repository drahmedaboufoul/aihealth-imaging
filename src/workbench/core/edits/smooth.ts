/*
 * Uniform (umbrella) Laplacian smoothing and Taubin lambda|mu smoothing
 * (Taubin 1995), which smooths without the shrinkage of plain Laplacian.
 * Boundary vertices are held fixed by default so trimmed edges do not creep.
 */
import type { MeshData } from '../types';
import { buildAdjacency, EdgeTable } from '../meshData';
import type { EditOutput } from './trim';

export interface SmoothParams {
  method: 'laplacian' | 'taubin';
  iterations: number;
  /** Positive step (0..1). Default 0.5. */
  lambda?: number;
  /** Taubin's negative step. Default -0.53. */
  mu?: number;
  fixBoundary?: boolean;
}

export function boundaryVertexMask(mesh: MeshData): Uint8Array {
  const nV = mesh.positions.length / 3;
  const mask = new Uint8Array(nV);
  const table = EdgeTable.fromIndices(mesh.indices);
  for (let s = 0; s < table.a.length; s++) {
    if (table.a[s] === -1 || table.count[s] === 2) continue;
    mask[table.a[s]] = 1; mask[table.b[s]] = 1;
  }
  return mask;
}

export function smoothMesh(mesh: MeshData, params: SmoothParams): EditOutput {
  const nV = mesh.positions.length / 3;
  const iterations = Math.max(0, Math.min(200, Math.floor(params.iterations)));
  const lambda = params.lambda ?? 0.5;
  const mu = params.mu ?? -0.53;
  const fixBoundary = params.fixBoundary ?? true;
  const adj = buildAdjacency(nV, mesh.indices);
  const fixed = fixBoundary ? boundaryVertexMask(mesh) : new Uint8Array(nV);
  let cur = Float64Array.from(mesh.positions);
  let nxt = new Float64Array(cur.length);
  const step = (factor: number) => {
    for (let v = 0; v < nV; v++) {
      const s = adj.offsets[v], e = adj.offsets[v + 1];
      if (fixed[v] || e === s) {
        nxt[v * 3] = cur[v * 3]; nxt[v * 3 + 1] = cur[v * 3 + 1]; nxt[v * 3 + 2] = cur[v * 3 + 2];
        continue;
      }
      let ax = 0, ay = 0, az = 0;
      for (let i = s; i < e; i++) {
        const u = adj.neighbors[i] * 3;
        ax += cur[u]; ay += cur[u + 1]; az += cur[u + 2];
      }
      const k = e - s;
      nxt[v * 3] = cur[v * 3] + factor * (ax / k - cur[v * 3]);
      nxt[v * 3 + 1] = cur[v * 3 + 1] + factor * (ay / k - cur[v * 3 + 1]);
      nxt[v * 3 + 2] = cur[v * 3 + 2] + factor * (az / k - cur[v * 3 + 2]);
    }
    const t = cur; cur = nxt; nxt = t;
  };
  for (let it = 0; it < iterations; it++) {
    step(lambda);
    if (params.method === 'taubin') step(mu);
  }
  let maxMove = 0;
  for (let i = 0; i < cur.length; i += 3) {
    const d = Math.hypot(cur[i] - mesh.positions[i], cur[i + 1] - mesh.positions[i + 1], cur[i + 2] - mesh.positions[i + 2]);
    if (d > maxMove) maxMove = d;
  }
  return {
    mesh: { positions: Float32Array.from(cur), indices: mesh.indices.slice(), colors: mesh.colors ? mesh.colors.slice() : null },
    stats: { iterations, maxDisplacementMm: maxMove, fixedBoundaryVertices: fixBoundary ? fixed.reduce((a, b) => a + b, 0) : 0, triangles: mesh.indices.length / 3 },
  };
}
