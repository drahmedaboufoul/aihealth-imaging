/*
 * Planar cross-section of a mesh: triangle/plane intersection segments
 * chained into polylines, plus a 2D profile in the plane's own basis.
 */
import type { MeshData, Plane, Vec3 } from './types';

export interface Polyline3 {
  points: Vec3[];
  closed: boolean;
}

/** Slice in the mesh's local frame. Intersection points are shared per edge, so chains are exact. */
export function sliceMesh(mesh: MeshData, plane: Plane): Polyline3[] {
  const { positions: P, indices: I } = mesh;
  const nV = P.length / 3;
  const [ox, oy, oz] = plane.origin;
  const [nx, ny, nz] = plane.normal;
  const s = new Float64Array(nV);
  for (let v = 0; v < nV; v++) s[v] = (P[v * 3] - ox) * nx + (P[v * 3 + 1] - oy) * ny + (P[v * 3 + 2] - oz) * nz;
  const pos = (v: number) => s[v] >= 0;
  const keyOf = (a: number, b: number) => (a < b ? a * nV + b : b * nV + a);
  const pointOf = new Map<number, Vec3>();
  const ends = new Map<number, number[]>(); // edge key -> segment ids
  const segs: number[] = []; // pairs of edge keys
  const point = (a: number, b: number): number => {
    const k = keyOf(a, b);
    if (!pointOf.has(k)) {
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const t = s[lo] / (s[lo] - s[hi]);
      pointOf.set(k, [
        P[lo * 3] + t * (P[hi * 3] - P[lo * 3]),
        P[lo * 3 + 1] + t * (P[hi * 3 + 1] - P[lo * 3 + 1]),
        P[lo * 3 + 2] + t * (P[hi * 3 + 2] - P[lo * 3 + 2]),
      ]);
    }
    return k;
  };
  for (let t = 0; t < I.length; t += 3) {
    const tri = [I[t], I[t + 1], I[t + 2]];
    const crossing: number[] = [];
    for (let k = 0; k < 3; k++) {
      const a = tri[k], b = tri[(k + 1) % 3];
      if (pos(a) !== pos(b)) crossing.push(point(a, b));
    }
    if (crossing.length !== 2) continue;
    const id = segs.length / 2;
    segs.push(crossing[0], crossing[1]);
    for (const k of crossing) {
      const list = ends.get(k);
      if (list) list.push(id); else ends.set(k, [id]);
    }
  }
  const used = new Uint8Array(segs.length / 2);
  const out: Polyline3[] = [];
  const walk = (startKey: number, seg: number, chain: number[]) => {
    let key = startKey;
    let cur = seg;
    for (;;) {
      used[cur] = 1;
      const a = segs[cur * 2], b = segs[cur * 2 + 1];
      const nextKey = a === key ? b : a;
      chain.push(nextKey);
      const cand = ends.get(nextKey) || [];
      const nxt = cand.find((c) => !used[c]);
      if (nxt === undefined) return nextKey;
      key = nextKey;
      cur = nxt;
    }
  };
  for (let sId = 0; sId < segs.length / 2; sId++) {
    if (used[sId]) continue;
    // extend both directions from this segment
    const a = segs[sId * 2];
    const forward: number[] = [a];
    const endKey = walk(a, sId, forward);
    const backward: number[] = [];
    const startList = ends.get(a) || [];
    const back = startList.find((c) => !used[c]);
    if (back !== undefined) walk(a, back, backward);
    const chain = backward.reverse().concat(forward);
    const closed = chain.length > 2 && endKey === a;
    if (closed) chain.pop();
    out.push({ points: chain.map((k) => pointOf.get(k) as Vec3), closed });
  }
  return out;
}

export interface PlaneBasis {
  origin: Vec3;
  /** In-plane horizontal axis of the profile. */
  u: Vec3;
  /** In-plane vertical axis of the profile. */
  v: Vec3;
  normal: Vec3;
}

export interface Profile2D {
  points: [number, number][];
  closed: boolean;
}

export function toProfile(polylines: Polyline3[], basis: PlaneBasis): Profile2D[] {
  const [ox, oy, oz] = basis.origin;
  return polylines.map((pl) => ({
    closed: pl.closed,
    points: pl.points.map(([x, y, z]) => {
      const dx = x - ox, dy = y - oy, dz = z - oz;
      return [dx * basis.u[0] + dy * basis.u[1] + dz * basis.u[2], dx * basis.v[0] + dy * basis.v[1] + dz * basis.v[2]] as [number, number];
    }),
  }));
}

export function profileExtent(profiles: Profile2D[]): { width: number; height: number; minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of profiles) for (const [x, y] of p.points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { width: 0, height: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { width: maxX - minX, height: maxY - minY, minX, maxX, minY, maxY };
}

/** Distance from a 2D point to a profile polyline set. */
export function distanceToProfiles(x: number, y: number, profiles: Profile2D[]): number {
  let best = Infinity;
  for (const p of profiles) {
    const pts = p.points;
    const n = pts.length;
    const segCount = p.closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
      const ex = bx - ax, ey = by - ay;
      const l2 = ex * ex + ey * ey;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
      const d = Math.hypot(ax + t * ex - x, ay + t * ey - y);
      if (d < best) best = d;
    }
    if (n === 1) best = Math.min(best, Math.hypot(pts[0][0] - x, pts[0][1] - y));
  }
  return best;
}

/** Max and mean gap from profile set A to profile set B (2D, mm). */
export function profileGap(a: Profile2D[], b: Profile2D[]): { max: number; mean: number; samples: number } {
  let max = 0, sum = 0, n = 0;
  for (const p of a) for (const [x, y] of p.points) {
    const d = distanceToProfiles(x, y, b);
    if (!Number.isFinite(d)) continue;
    if (d > max) max = d;
    sum += d; n++;
  }
  return { max, mean: n ? sum / n : NaN, samples: n };
}
