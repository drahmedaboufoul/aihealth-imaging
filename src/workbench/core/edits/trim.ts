/*
 * Trim by plane (with exact clipping of crossing triangles, so the cut edge
 * is clean and watertight) and trim by lasso selection.
 */
import type { MeshData, Plane } from '../types';
import { compactMesh } from '../meshData';
import type { SpatialMesh } from '../spatial';
import * as THREE from 'three';

export interface PlaneTrimParams {
  plane: Plane;
  /** Which side of the plane to KEEP: the side the normal points to, or the other. */
  keep: 'positive' | 'negative';
}

export interface EditOutput {
  mesh: MeshData;
  stats: Record<string, number>;
}

export function trimByPlane(mesh: MeshData, params: PlaneTrimParams): EditOutput {
  const { positions: P, indices: I, colors: C } = mesh;
  const nV = P.length / 3;
  const [ox, oy, oz] = params.plane.origin;
  let [nx, ny, nz] = params.plane.normal;
  const nl = Math.hypot(nx, ny, nz);
  if (!(nl > 0)) throw new Error('Trim plane needs a non-zero normal.');
  nx /= nl; ny /= nl; nz /= nl;
  const sgn = params.keep === 'positive' ? 1 : -1;
  const s = new Float64Array(nV);
  for (let v = 0; v < nV; v++) s[v] = sgn * ((P[v * 3] - ox) * nx + (P[v * 3 + 1] - oy) * ny + (P[v * 3 + 2] - oz) * nz);
  const EPS = 1e-9;
  const inside = (v: number) => s[v] >= -EPS;

  const newPos: number[] = [];
  const newCol: number[] = [];
  const edgeVertex = new Map<number, number>();
  const intersect = (u: number, w: number): number => {
    const lo = u < w ? u : w, hi = u < w ? w : u;
    const key = lo * nV + hi;
    const found = edgeVertex.get(key);
    if (found !== undefined) return found;
    const t = s[lo] / (s[lo] - s[hi]);
    const id = nV + newPos.length / 3;
    for (let k = 0; k < 3; k++) newPos.push(P[lo * 3 + k] + t * (P[hi * 3 + k] - P[lo * 3 + k]));
    if (C) for (let k = 0; k < 3; k++) newCol.push(C[lo * 3 + k] + t * (C[hi * 3 + k] - C[lo * 3 + k]));
    edgeVertex.set(key, id);
    return id;
  };

  const out: number[] = [];
  let removed = 0, clipped = 0;
  const poly: number[] = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ia = inside(a), ib = inside(b), ic = inside(c);
    if (ia && ib && ic) { out.push(a, b, c); continue; }
    if (!ia && !ib && !ic) { removed++; continue; }
    clipped++;
    poly.length = 0;
    const tri = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const u = tri[k], w = tri[(k + 1) % 3];
      const iu = inside(u), iw = inside(w);
      if (iu) poly.push(u);
      if (iu !== iw) poly.push(intersect(u, w));
    }
    for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1]);
  }
  const added = newPos.length / 3;
  const positions = new Float32Array(P.length + newPos.length);
  positions.set(P);
  positions.set(newPos, P.length);
  let colors: Float32Array | null = null;
  if (C) { colors = new Float32Array(C.length + newCol.length); colors.set(C); colors.set(newCol, C.length); }
  const merged: MeshData = { positions, indices: Uint32Array.from(out), colors };
  const compact = compactMesh(merged, null);
  return {
    mesh: compact,
    stats: { trianglesRemoved: removed, trianglesClipped: clipped, verticesAdded: added, triangles: compact.indices.length / 3 },
  };
}

/** Lasso in normalised device coordinates plus the view it was drawn in. */
export interface LassoSpec {
  /** Closed polygon in NDC (-1..1), at least three points. */
  polygon: [number, number][];
  /** Column-major model-view-projection matrix (scan local -> clip). */
  mvp: number[];
  /** Direction the camera looks along, in scan-local coordinates (orthographic view). */
  viewDir: [number, number, number];
  /** Only triangles facing the camera. */
  frontOnly: boolean;
  /** Also drop triangles hidden behind other surface (needs a BVH). */
  visibleOnly?: boolean;
}

export function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Triangles whose centroid falls inside the lasso (deterministic). */
export function selectTrianglesInLasso(mesh: MeshData, spec: LassoSpec, spatial?: SpatialMesh | null): Uint8Array {
  const { positions: P, indices: I } = mesh;
  const T = I.length / 3;
  const sel = new Uint8Array(T);
  if (!spec.polygon || spec.polygon.length < 3) return sel;
  const m = spec.mvp;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of spec.polygon) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const [vx, vy, vz] = spec.viewDir;
  const ray = new THREE.Ray();
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    const w = m[3] * cx + m[7] * cy + m[11] * cz + m[15];
    if (!(Math.abs(w) > 1e-12)) continue;
    const x = (m[0] * cx + m[4] * cy + m[8] * cz + m[12]) / w;
    if (x < minX || x > maxX) continue;
    const y = (m[1] * cx + m[5] * cy + m[9] * cz + m[13]) / w;
    if (y < minY || y > maxY) continue;
    const z = (m[2] * cx + m[6] * cy + m[10] * cz + m[14]) / w;
    if (z < -1 || z > 1) continue;
    if (!pointInPolygon(x, y, spec.polygon)) continue;
    if (spec.frontOnly) {
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
      if (fx * vx + fy * vy + fz * vz >= 0) continue;
    }
    if (spec.visibleOnly && spatial) {
      // March towards the camera; anything hit first hides this triangle.
      ray.origin.set(cx - vx * 1e-4, cy - vy * 1e-4, cz - vz * 1e-4);
      ray.direction.set(-vx, -vy, -vz).normalize();
      const hit = spatial.bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance > 1e-3) continue;
    }
    sel[t] = 1;
  }
  return sel;
}

export interface LassoTrimParams {
  lasso: LassoSpec;
  /** delete the selected surface, or keep only the selected surface */
  mode: 'delete-inside' | 'keep-inside';
}

export function trimByLasso(mesh: MeshData, params: LassoTrimParams, spatial?: SpatialMesh | null): EditOutput {
  const sel = selectTrianglesInLasso(mesh, params.lasso, spatial);
  const T = sel.length;
  const keep = new Uint8Array(T);
  let selected = 0;
  for (let t = 0; t < T; t++) {
    if (sel[t]) selected++;
    keep[t] = params.mode === 'delete-inside' ? (sel[t] ? 0 : 1) : sel[t];
  }
  const out = compactMesh(mesh, keep);
  return { mesh: out, stats: { trianglesSelected: selected, trianglesRemoved: T - out.indices.length / 3, triangles: out.indices.length / 3 } };
}
