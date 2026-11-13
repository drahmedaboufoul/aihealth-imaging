/*
 * Surface distance between two points: Dijkstra over the mesh graph
 * augmented with 2-ring neighbours (straight chords to the neighbours of
 * neighbours). Edge-only Dijkstra can over-estimate by up to ~40% on
 * regular triangulations because it may only move in three directions;
 * the 2-ring graph gives many more directions and stays within a few
 * percent on dense scans, while chords this short (about two edge lengths)
 * hug the surface.
 *
 * With a spatial index, the graph path is then straightened on the surface
 * (coarse-to-fine: move each point to the surface point closest to the
 * midpoint of its neighbours), which converges to the locally shortest
 * surface curve. That is the value the workbench reports.
 */
import type { MeshData, Vec3 } from './types';
import { buildAdjacency, type Adjacency } from './meshData';
import type { SpatialMesh } from './spatial';

export interface SurfacePath {
  length: number;
  points: Vec3[];
  visited: number;
  /** Length of the unrefined graph path (always >= length). */
  graphLength: number;
  method: 'graph' | 'graph+shortening';
}

function polylineLength(pts: Vec3[]): number {
  let length = 0;
  for (let i = 1; i < pts.length; i++) {
    length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  }
  return length;
}

function resample(pts: Vec3[], segments: number): Vec3[] {
  const total = polylineLength(pts);
  if (!(total > 0) || segments < 1) return pts.slice();
  const out: Vec3[] = [pts[0]];
  const step = total / segments;
  let acc = 0;
  let next = step;
  for (let i = 1; i < pts.length && out.length < segments; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    while (l > 0 && acc + l >= next && out.length < segments) {
      const t = (next - acc) / l;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
      next += step;
    }
    acc += l;
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Shorten a surface polyline toward the local geodesic (endpoints fixed). */
export function shortenOnSurface(pts: Vec3[], spatial: SpatialMesh, opts: { finalSpacing?: number; iterations?: number } = {}): Vec3[] {
  const total = polylineLength(pts);
  if (!(total > 0) || pts.length < 2) return pts.slice();
  const finalSpacing = opts.finalSpacing ?? 0.2;
  const iterations = opts.iterations ?? 40;
  let segments = Math.max(2, Math.min(64, Math.ceil(total / 1.0)));
  let cur = resample(pts, segments);
  for (;;) {
    for (let it = 0; it < iterations; it++) {
      for (let i = 1; i < cur.length - 1; i++) {
        const a = cur[i - 1], b = cur[i + 1];
        const h = spatial.closest((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
        if (h) cur[i] = [h.point[0], h.point[1], h.point[2]];
      }
    }
    const spacing = polylineLength(cur) / segments;
    if (spacing <= finalSpacing || segments >= 512) break;
    segments *= 2;
    cur = resample(cur, segments);
  }
  return cur;
}

export function nearestVertex(mesh: MeshData, p: Vec3, face?: number): number {
  const P = mesh.positions;
  let best = -1, bestD = Infinity;
  const consider = (v: number) => {
    const d = (P[v * 3] - p[0]) ** 2 + (P[v * 3 + 1] - p[1]) ** 2 + (P[v * 3 + 2] - p[2]) ** 2;
    if (d < bestD) { bestD = d; best = v; }
  };
  if (face !== undefined && face >= 0) {
    for (let k = 0; k < 3; k++) consider(mesh.indices[face * 3 + k]);
    return best;
  }
  for (let v = 0; v < P.length / 3; v++) consider(v);
  return best;
}

export function surfacePath(
  mesh: MeshData, a: Vec3, b: Vec3,
  opts: { faceA?: number; faceB?: number; adjacency?: Adjacency; maxVisited?: number; spatial?: SpatialMesh | null } = {},
): SurfacePath | null {
  const P = mesh.positions;
  const nV = P.length / 3;
  const adj = opts.adjacency ?? buildAdjacency(nV, mesh.indices);
  const s = nearestVertex(mesh, a, opts.faceA);
  const t = nearestVertex(mesh, b, opts.faceB);
  if (s < 0 || t < 0) return null;
  const dist = new Float64Array(nV).fill(Infinity);
  const prev = new Int32Array(nV).fill(-1);
  const done = new Uint8Array(nV);
  // binary heap of (dist, vertex)
  let hd = new Float64Array(1024), hv = new Int32Array(1024), size = 0;
  const push = (d: number, v: number) => {
    if (size >= hd.length) {
      const nd = new Float64Array(hd.length * 2); nd.set(hd); hd = nd;
      const nv = new Int32Array(hv.length * 2); nv.set(hv); hv = nv;
    }
    let i = size++;
    hd[i] = d; hv[i] = v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hd[p] < hd[i] || (hd[p] === hd[i] && hv[p] <= hv[i])) break;
      [hd[p], hd[i]] = [hd[i], hd[p]]; [hv[p], hv[i]] = [hv[i], hv[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const v = hv[0];
    size--;
    if (size > 0) {
      hd[0] = hd[size]; hv[0] = hv[size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < size && (hd[l] < hd[m] || (hd[l] === hd[m] && hv[l] < hv[m]))) m = l;
        if (r < size && (hd[r] < hd[m] || (hd[r] === hd[m] && hv[r] < hv[m]))) m = r;
        if (m === i) break;
        [hd[m], hd[i]] = [hd[i], hd[m]]; [hv[m], hv[i]] = [hv[i], hv[m]];
        i = m;
      }
    }
    return v;
  };
  dist[s] = 0;
  push(0, s);
  let visited = 0;
  const maxVisited = opts.maxVisited ?? nV;
  while (size > 0) {
    const v = pop();
    if (done[v]) continue;
    done[v] = 1;
    if (++visited > maxVisited) return null;
    if (v === t) break;
    const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
    const relax = (u: number) => {
      if (done[u]) return;
      const nd = dist[v] + Math.hypot(P[u * 3] - px, P[u * 3 + 1] - py, P[u * 3 + 2] - pz);
      if (nd < dist[u]) { dist[u] = nd; prev[u] = v; push(nd, u); }
    };
    for (let i = adj.offsets[v]; i < adj.offsets[v + 1]; i++) {
      const u = adj.neighbors[i];
      relax(u);
      for (let j = adj.offsets[u]; j < adj.offsets[u + 1]; j++) {
        const w = adj.neighbors[j];
        if (w !== v) relax(w);
      }
    }
  }
  if (!Number.isFinite(dist[t])) return null;
  const chain: number[] = [];
  for (let v = t; v !== -1; v = prev[v]) chain.push(v);
  chain.reverse();
  const points: Vec3[] = [a, ...chain.map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]] as Vec3), b];
  const graphLength = polylineLength(points);
  if (opts.spatial) {
    const refined = shortenOnSurface(points, opts.spatial);
    const refinedLength = polylineLength(refined);
    if (refinedLength <= graphLength) return { length: refinedLength, points: refined, visited, graphLength, method: 'graph+shortening' };
  }
  return { length: graphLength, points, visited, graphLength, method: 'graph' };
}
