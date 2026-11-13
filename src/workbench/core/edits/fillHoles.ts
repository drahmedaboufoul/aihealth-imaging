/*
 * Fill small holes: find closed boundary loops and triangulate the ones
 * with at most `maxEdges` edges by ear clipping in the loop's best-fit
 * plane (orientation consistent with the surrounding surface). The longest
 * loop of an open intraoral scan is its outer rim and is skipped by
 * default.
 */
import type { MeshData } from '../types';
import { EdgeTable } from '../meshData';
import type { EditOutput } from './trim';

export interface FillHolesParams {
  /** Only fill loops with this many edges or fewer. */
  maxEdges: number;
  /** Never fill the longest loop (the open scan's outer border). */
  keepLargestBoundary: boolean;
}

export interface BoundaryLoop {
  vertices: number[];
  perimeter: number;
}

/** Closed boundary loops, following boundary half-edges head to tail. */
export function findBoundaryLoops(mesh: MeshData): { loops: BoundaryLoop[]; openChains: number } {
  const { positions: P, indices: I } = mesh;
  const nV = P.length / 3;
  const table = EdgeTable.fromIndices(I);
  // outgoing boundary half-edges per vertex (first two kept; more = non-manifold)
  const next = new Int32Array(nV).fill(-1);
  for (let s = 0; s < table.a.length; s++) {
    if (table.a[s] === -1 || table.count[s] !== 1) continue;
    const he = table.firstHalfEdge[s];
    const t = he - (he % 3);
    const from = I[he], to = I[t + (((he % 3) + 1) % 3)];
    if (next[from] === -1) next[from] = to;
  }
  const used = new Uint8Array(nV);
  const loops: BoundaryLoop[] = [];
  let openChains = 0;
  for (let start = 0; start < nV; start++) {
    if (next[start] === -1 || used[start]) continue;
    const verts: number[] = [];
    let v = start;
    let closed = false;
    while (v !== -1 && !used[v]) {
      used[v] = 1;
      verts.push(v);
      // At a non-manifold vertex (several outgoing boundary edges) the first
      // stored edge is followed; loops that do not close are left alone.
      const nxt = next[v];
      if (nxt === start) { closed = true; break; }
      v = nxt;
    }
    if (!closed || verts.length < 3) { openChains++; continue; }
    let perimeter = 0;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i] * 3, b = verts[(i + 1) % verts.length] * 3;
      perimeter += Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
    }
    loops.push({ vertices: verts, perimeter });
  }
  return { loops, openChains };
}

/** Ear-clip a polygon (vertex ids, already in fill orientation). Returns triangles or null. */
function earClip(poly: number[], P: Float32Array): number[] | null {
  const n = poly.length;
  if (n === 3) return [poly[0], poly[1], poly[2]];
  // Newell normal of the polygon
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i] * 3, b = poly[(i + 1) % n] * 3;
    nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
    ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
    nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    cx += P[a]; cy += P[a + 1]; cz += P[a + 2];
  }
  const nl = Math.hypot(nx, ny, nz);
  if (!(nl > 1e-12)) return null;
  nx /= nl; ny /= nl; nz /= nl;
  cx /= n; cy /= n; cz /= n;
  // basis u, v with u x v = n
  let ux = Math.abs(nx) < 0.9 ? 1 : 0, uy = Math.abs(nx) < 0.9 ? 0 : 1, uz = 0;
  const d = ux * nx + uy * ny + uz * nz;
  ux -= d * nx; uy -= d * ny; uz -= d * nz;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = poly[i] * 3;
    const px = P[a] - cx, py = P[a + 1] - cy, pz = P[a + 2] - cz;
    xs[i] = px * ux + py * uy + pz * uz;
    ys[i] = px * vx + py * vy + pz * vz;
  }
  const idx = Array.from({ length: n }, (_, i) => i);
  const tris: number[] = [];
  const cross = (i: number, j: number, k: number) => (xs[j] - xs[i]) * (ys[k] - ys[i]) - (ys[j] - ys[i]) * (xs[k] - xs[i]);
  const inTri = (p: number, i: number, j: number, k: number) =>
    cross(i, j, p) >= -1e-12 && cross(j, k, p) >= -1e-12 && cross(k, i, p) >= -1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let e = 0; e < idx.length; e++) {
      const i = idx[(e + idx.length - 1) % idx.length], j = idx[e], k = idx[(e + 1) % idx.length];
      if (cross(i, j, k) <= 1e-14) continue; // reflex or degenerate
      let contains = false;
      for (const p of idx) {
        if (p === i || p === j || p === k) continue;
        if (inTri(p, i, j, k)) { contains = true; break; }
      }
      if (contains) continue;
      tris.push(poly[i], poly[j], poly[k]);
      idx.splice(e, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  if (idx.length === 3) tris.push(poly[idx[0]], poly[idx[1]], poly[idx[2]]);
  return tris;
}

export function fillHoles(mesh: MeshData, params: FillHolesParams): EditOutput {
  const { loops } = findBoundaryLoops(mesh);
  let largest = -1;
  if (params.keepLargestBoundary && loops.length) {
    largest = 0;
    for (let i = 1; i < loops.length; i++) if (loops[i].perimeter > loops[largest].perimeter) largest = i;
  }
  const added: number[] = [];
  const addedPos: number[] = [];
  const addedCol: number[] = [];
  const nV = mesh.positions.length / 3;
  let filled = 0, skippedLarge = 0, fanFallback = 0;
  for (let li = 0; li < loops.length; li++) {
    if (li === largest) continue;
    const loop = loops[li];
    if (loop.vertices.length > params.maxEdges) { skippedLarge++; continue; }
    // Boundary half-edges run v_i -> v_{i+1}; the patch needs the reverse.
    const poly = loop.vertices.slice().reverse();
    let tris = earClip(poly, mesh.positions);
    if (!tris) {
      // centroid fan fallback
      fanFallback++;
      const c = nV + addedPos.length / 3;
      const cen = [0, 0, 0], col = [0, 0, 0];
      for (const v of poly) for (let k = 0; k < 3; k++) {
        cen[k] += mesh.positions[v * 3 + k] / poly.length;
        if (mesh.colors) col[k] += mesh.colors[v * 3 + k] / poly.length;
      }
      addedPos.push(...cen);
      if (mesh.colors) addedCol.push(...col);
      tris = [];
      for (let i = 0; i < poly.length; i++) tris.push(poly[i], poly[(i + 1) % poly.length], c);
    }
    added.push(...tris);
    filled++;
  }
  const positions = new Float32Array(mesh.positions.length + addedPos.length);
  positions.set(mesh.positions); positions.set(addedPos, mesh.positions.length);
  let colors: Float32Array | null = null;
  if (mesh.colors) { colors = new Float32Array(mesh.colors.length + addedCol.length); colors.set(mesh.colors); colors.set(addedCol, mesh.colors.length); }
  const indices = new Uint32Array(mesh.indices.length + added.length);
  indices.set(mesh.indices); indices.set(added, mesh.indices.length);
  return {
    mesh: { positions, indices, colors },
    stats: {
      holesFound: loops.length - (largest >= 0 ? 1 : 0),
      holesFilled: filled,
      holesSkippedTooLarge: skippedLarge,
      trianglesAdded: added.length / 3,
      fanFallback,
      triangles: indices.length / 3,
    },
  };
}
