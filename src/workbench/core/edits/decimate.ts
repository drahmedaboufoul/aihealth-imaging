/*
 * Quadric error metric decimation (Garland & Heckbert 1997) to a target
 * triangle count.
 *
 * - Area-weighted face quadrics plus strong boundary-plane quadrics so the
 *   open rim of a scan keeps its shape.
 * - Collapses are refused when they would break the link condition (create
 *   non-manifold edges) or flip/collapse a neighbouring triangle.
 * - Fully deterministic: no randomness, ties broken by vertex ids.
 */
import type { MeshData } from '../types';
import { compactMesh, EdgeTable } from '../meshData';
import type { EditOutput } from './trim';

export interface DecimateParams {
  targetTriangles: number;
}

const BOUNDARY_WEIGHT = 100;

class EdgeHeap {
  // entry storage (by entry id)
  u = new Int32Array(1024);
  v = new Int32Array(1024);
  su = new Uint32Array(1024);
  sv = new Uint32Array(1024);
  x = new Float64Array(1024 * 3);
  cost = new Float64Array(1024);
  // heap arrays (by heap slot): cost inline so comparisons rarely indirect
  hc = new Float64Array(1024);
  hid = new Int32Array(1024);
  size = 0;
  entries = 0;
  private free = new Int32Array(1024);
  private freeTop = 0;

  private static grown<T extends Float64Array | Int32Array | Uint32Array>(a: T, len: number): T {
    const b = new (a.constructor as new (n: number) => T)(len);
    b.set(a);
    return b;
  }

  private growEntries(): void {
    const n = this.u.length * 2;
    this.u = EdgeHeap.grown(this.u, n); this.v = EdgeHeap.grown(this.v, n);
    this.su = EdgeHeap.grown(this.su, n); this.sv = EdgeHeap.grown(this.sv, n);
    this.x = EdgeHeap.grown(this.x, n * 3); this.cost = EdgeHeap.grown(this.cost, n);
  }

  private less(ca: number, ia: number, cb: number, ib: number): boolean {
    if (ca !== cb) return ca < cb;
    if (this.u[ia] !== this.u[ib]) return this.u[ia] < this.u[ib];
    return this.v[ia] < this.v[ib];
  }

  push(cost: number, u: number, v: number, su: number, sv: number, x: number, y: number, z: number): void {
    let id: number;
    if (this.freeTop > 0) id = this.free[--this.freeTop];
    else {
      if (this.entries >= this.u.length) this.growEntries();
      id = this.entries++;
    }
    this.u[id] = u; this.v[id] = v; this.su[id] = su; this.sv[id] = sv; this.cost[id] = cost;
    this.x[id * 3] = x; this.x[id * 3 + 1] = y; this.x[id * 3 + 2] = z;
    if (this.size >= this.hc.length) {
      this.hc = EdgeHeap.grown(this.hc, this.hc.length * 2);
      this.hid = EdgeHeap.grown(this.hid, this.hid.length * 2);
    }
    const hc = this.hc, hid = this.hid;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(cost, id, hc[p], hid[p])) break;
      hc[i] = hc[p]; hid[i] = hid[p];
      i = p;
    }
    hc[i] = cost; hid[i] = id;
  }

  pop(): number {
    const hc = this.hc, hid = this.hid;
    const top = hid[0];
    const n = --this.size;
    if (n > 0) {
      const c = hc[n], id = hid[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        let m = l;
        if (r < n && this.less(hc[r], hid[r], hc[l], hid[l])) m = r;
        if (!this.less(hc[m], hid[m], c, id)) break;
        hc[i] = hc[m]; hid[i] = hid[m];
        i = m;
      }
      hc[i] = c; hid[i] = id;
    }
    return top;
  }

  release(id: number): void {
    if (this.freeTop >= this.free.length) this.free = EdgeHeap.grown(this.free, this.free.length * 2);
    this.free[this.freeTop++] = id;
  }
}

function addPlane(Q: Float64Array, v: number, a: number, b: number, c: number, d: number, w: number): void {
  const o = v * 10;
  Q[o] += w * a * a; Q[o + 1] += w * a * b; Q[o + 2] += w * a * c; Q[o + 3] += w * a * d;
  Q[o + 4] += w * b * b; Q[o + 5] += w * b * c; Q[o + 6] += w * b * d;
  Q[o + 7] += w * c * c; Q[o + 8] += w * c * d; Q[o + 9] += w * d * d;
}

export function decimate(mesh: MeshData, params: DecimateParams, onProgress?: (fraction: number) => void): EditOutput {
  const T0 = mesh.indices.length / 3;
  const target = Math.max(4, Math.floor(params.targetTriangles));
  if (target >= T0) {
    return { mesh: { positions: mesh.positions.slice(), indices: mesh.indices.slice(), colors: mesh.colors ? mesh.colors.slice() : null }, stats: { trianglesBefore: T0, triangles: T0, collapses: 0, maxQuadricCost: 0 } };
  }
  const nV = mesh.positions.length / 3;
  const P = Float64Array.from(mesh.positions);
  const C = mesh.colors ? Float64Array.from(mesh.colors) : null;
  const I = Int32Array.from(mesh.indices);
  const triAlive = new Uint8Array(T0).fill(1);
  const vAlive = new Uint8Array(nV);
  const stamp = new Uint32Array(nV);
  const Q = new Float64Array(nV * 10);
  // corner lists
  const head = new Int32Array(nV).fill(-1);
  const tail = new Int32Array(nV).fill(-1);
  const cNext = new Int32Array(T0 * 3).fill(-1);
  for (let c = 0; c < T0 * 3; c++) {
    const v = I[c];
    vAlive[v] = 1;
    if (head[v] === -1) head[v] = c; else cNext[tail[v]] = c;
    tail[v] = c;
  }

  const faceNormal = (t: number, out: Float64Array) => {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    out[0] = e1y * e2z - e1z * e2y; out[1] = e1z * e2x - e1x * e2z; out[2] = e1x * e2y - e1y * e2x;
  };
  const fn = new Float64Array(3);
  for (let t = 0; t < T0; t++) {
    faceNormal(t, fn);
    const len = Math.hypot(fn[0], fn[1], fn[2]);
    if (!(len > 0)) continue;
    const a = fn[0] / len, b = fn[1] / len, c = fn[2] / len;
    const p0 = I[t * 3] * 3;
    const d = -(a * P[p0] + b * P[p0 + 1] + c * P[p0 + 2]);
    const area = len / 2;
    for (let k = 0; k < 3; k++) addPlane(Q, I[t * 3 + k], a, b, c, d, area);
  }
  const edges = EdgeTable.fromIndices(mesh.indices);
  const isBoundaryVertex = new Uint8Array(nV);
  for (let s = 0; s < edges.a.length; s++) {
    if (edges.a[s] === -1 || edges.count[s] !== 1) continue;
    const he = edges.firstHalfEdge[s];
    const t = (he - (he % 3)) / 3;
    const u = I[he], w = I[t * 3 + (((he % 3) + 1) % 3)];
    isBoundaryVertex[u] = 1; isBoundaryVertex[w] = 1;
    faceNormal(t, fn);
    const ex = P[w * 3] - P[u * 3], ey = P[w * 3 + 1] - P[u * 3 + 1], ez = P[w * 3 + 2] - P[u * 3 + 2];
    let mx = ey * fn[2] - ez * fn[1], my = ez * fn[0] - ex * fn[2], mz = ex * fn[1] - ey * fn[0];
    const ml = Math.hypot(mx, my, mz);
    if (!(ml > 0)) continue;
    mx /= ml; my /= ml; mz /= ml;
    const d = -(mx * P[u * 3] + my * P[u * 3 + 1] + mz * P[u * 3 + 2]);
    const w2 = BOUNDARY_WEIGHT * (ex * ex + ey * ey + ez * ez);
    addPlane(Q, u, mx, my, mz, d, w2);
    addPlane(Q, w, mx, my, mz, d, w2);
  }

  const best = new Float64Array(4); // x, y, z, cost
  const evalCost = (q: Float64Array, x: number, y: number, z: number) =>
    q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];
  const qs = new Float64Array(10);
  const computeCollapse = (u: number, v: number) => {
    for (let k = 0; k < 10; k++) qs[k] = Q[u * 10 + k] + Q[v * 10 + k];
    const ux = P[u * 3], uy = P[u * 3 + 1], uz = P[u * 3 + 2];
    const vx = P[v * 3], vy = P[v * 3 + 1], vz = P[v * 3 + 2];
    const elen = Math.hypot(vx - ux, vy - uy, vz - uz);
    const a00 = qs[0], a01 = qs[1], a02 = qs[2], a11 = qs[4], a12 = qs[5], a22 = qs[7];
    const det = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
    const scale = Math.abs(a00) + Math.abs(a11) + Math.abs(a22);
    let found = false;
    if (Math.abs(det) > 1e-12 * scale * scale * scale && scale > 0) {
      const b0 = -qs[3], b1 = -qs[6], b2 = -qs[8];
      const x = (b0 * (a11 * a22 - a12 * a12) - a01 * (b1 * a22 - a12 * b2) + a02 * (b1 * a12 - a11 * b2)) / det;
      const y = (a00 * (b1 * a22 - a12 * b2) - b0 * (a01 * a22 - a12 * a02) + a02 * (a01 * b2 - b1 * a02)) / det;
      const z = (a00 * (a11 * b2 - b1 * a12) - a01 * (a01 * b2 - b1 * a02) + b0 * (a01 * a12 - a11 * a02)) / det;
      const mx = (ux + vx) / 2, my = (uy + vy) / 2, mz = (uz + vz) / 2;
      if (Math.hypot(x - mx, y - my, z - mz) <= elen) {
        best[0] = x; best[1] = y; best[2] = z; best[3] = evalCost(qs, x, y, z);
        found = true;
      }
    }
    if (!found) {
      const cand = [[ux, uy, uz], [vx, vy, vz], [(ux + vx) / 2, (uy + vy) / 2, (uz + vz) / 2]];
      best[3] = Infinity;
      for (const [x, y, z] of cand) {
        const c = evalCost(qs, x, y, z);
        if (c < best[3]) { best[0] = x; best[1] = y; best[2] = z; best[3] = c; }
      }
    }
    if (best[3] < 0) best[3] = 0;
  };

  const heap = new EdgeHeap();
  const pushEdge = (a: number, b: number) => {
    const u = a < b ? a : b, v = a < b ? b : a;
    computeCollapse(u, v);
    heap.push(best[3], u, v, stamp[u], stamp[v], best[0], best[1], best[2]);
  };
  // initial edges in triangle order (deterministic)
  const pushed = new Uint8Array(edges.a.length);
  for (let t = 0; t < T0; t++) {
    for (let k = 0; k < 3; k++) {
      const u = I[t * 3 + k], w = I[t * 3 + ((k + 1) % 3)];
      const s = edges.find(u, w);
      if (pushed[s]) continue;
      pushed[s] = 1;
      pushEdge(u, w);
    }
  }

  // neighbourhood helpers
  const mark = new Int32Array(nV).fill(-1);
  let markGen = 0;
  const trisOf = (v: number, out: number[]) => {
    out.length = 0;
    let prev = -1;
    let c = head[v];
    while (c !== -1) {
      const t = (c - (c % 3)) / 3;
      const nextC = cNext[c];
      if (!triAlive[t] || I[c] !== v) {
        // prune dead corners
        if (prev === -1) head[v] = nextC; else cNext[prev] = nextC;
        if (tail[v] === c) tail[v] = prev;
      } else {
        out.push(t);
        prev = c;
      }
      c = nextC;
    }
  };
  const tu: number[] = [], tv: number[] = [], nbr: number[] = [], sharedList: number[] = [];
  const n0 = new Float64Array(3);
  /** true when replacing u/v by (x, y, z) flips or collapses triangle t */
  const flipsAt = (t: number, u: number, v: number, x: number, y: number, z: number): boolean => {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    faceNormal(t, n0);
    const ax = a === u || a === v ? x : P[a * 3], ay = a === u || a === v ? y : P[a * 3 + 1], az = a === u || a === v ? z : P[a * 3 + 2];
    const bx = b === u || b === v ? x : P[b * 3], by = b === u || b === v ? y : P[b * 3 + 1], bz = b === u || b === v ? z : P[b * 3 + 2];
    const cx = c === u || c === v ? x : P[c * 3], cy = c === u || c === v ? y : P[c * 3 + 1], cz = c === u || c === v ? z : P[c * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const m0 = e1y * e2z - e1z * e2y, m1 = e1z * e2x - e1x * e2z, m2 = e1x * e2y - e1y * e2x;
    const l0 = Math.hypot(n0[0], n0[1], n0[2]), l1 = Math.hypot(m0, m1, m2);
    return !(l1 > 1e-14) || n0[0] * m0 + n0[1] * m1 + n0[2] * m2 < 0.2 * l0 * l1;
  };

  let triCount = T0;
  let collapses = 0;
  let maxCost = 0;
  while (triCount > target && heap.size > 0) {
    const id = heap.pop();
    const u = heap.u[id], v = heap.v[id];
    const ok = vAlive[u] && vAlive[v] && heap.su[id] === stamp[u] && heap.sv[id] === stamp[v];
    const x = heap.x[id * 3], y = heap.x[id * 3 + 1], z = heap.x[id * 3 + 2];
    const cost = heap.cost[id];
    heap.release(id);
    if (!ok) continue;
    trisOf(u, tu);
    trisOf(v, tv);
    // shared triangles (contain both u and v)
    let shared = 0;
    sharedList.length = 0;
    for (const t of tu) {
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      if (a === v || b === v || c === v) { sharedList.push(t); shared++; }
    }
    if (shared === 0) continue;
    // link condition: common neighbours == shared triangles
    markGen++;
    const gen = markGen;
    for (const t of tu) for (let k = 0; k < 3; k++) { const w = I[t * 3 + k]; if (w !== u) mark[w] = gen; }
    let common = 0;
    markGen++;
    const gen2 = markGen;
    for (const t of tv) for (let k = 0; k < 3; k++) {
      const w = I[t * 3 + k];
      if (w !== v && w !== u && mark[w] === gen) { mark[w] = gen2; common++; }
    }
    if (common !== shared) continue;
    if (isBoundaryVertex[u] && isBoundaryVertex[v] && shared !== 1) continue; // would pinch the rim
    // flip check
    let flips = false;
    for (let i = 0; i < tu.length && !flips; i++) {
      const t = tu[i];
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      if (a === v || b === v || c === v) continue; // shared: removed
      flips = flipsAt(t, u, v, x, y, z);
    }
    for (let i = 0; i < tv.length && !flips; i++) {
      const t = tv[i];
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      if (a === u || b === u || c === u) continue;
      flips = flipsAt(t, u, v, x, y, z);
    }
    if (flips) continue;

    // perform u -> v at (x, y, z)
    for (const t of sharedList) { triAlive[t] = 0; triCount--; }
    for (const t of tu) {
      if (!triAlive[t]) continue;
      for (let k = 0; k < 3; k++) if (I[t * 3 + k] === u) I[t * 3 + k] = v;
    }
    // append u's corner list to v's
    if (head[u] !== -1) {
      if (head[v] === -1) head[v] = head[u]; else cNext[tail[v]] = head[u];
      tail[v] = tail[u];
    }
    head[u] = -1; tail[u] = -1;
    vAlive[u] = 0;
    P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z;
    for (let k = 0; k < 10; k++) Q[v * 10 + k] += Q[u * 10 + k];
    if (C) for (let k = 0; k < 3; k++) C[v * 3 + k] = 0.5 * (C[v * 3 + k] + C[u * 3 + k]);
    if (isBoundaryVertex[u]) isBoundaryVertex[v] = 1;
    stamp[v]++;
    collapses++;
    if (cost > maxCost) maxCost = cost;
    // re-push edges around v
    trisOf(v, tv);
    nbr.length = 0;
    markGen++;
    for (const t of tv) for (let k = 0; k < 3; k++) {
      const w = I[t * 3 + k];
      if (w !== v && mark[w] !== markGen) { mark[w] = markGen; nbr.push(w); }
    }
    // insertion sort (tiny lists) keeps push order deterministic without a comparator call per element
    for (let i = 1; i < nbr.length; i++) {
      const w = nbr[i];
      let j = i - 1;
      while (j >= 0 && nbr[j] > w) { nbr[j + 1] = nbr[j]; j--; }
      nbr[j + 1] = w;
    }
    for (const w of nbr) pushEdge(v, w);
    if (onProgress && (collapses & 0xffff) === 0) onProgress(Math.min(1, (T0 - triCount) / Math.max(1, T0 - target)));
  }

  const keep = triAlive;
  const outPositions = new Float32Array(P);
  const out = compactMesh({ positions: outPositions, indices: Uint32Array.from(I), colors: C ? new Float32Array(C) : null }, keep);
  return {
    mesh: out,
    stats: { trianglesBefore: T0, triangles: out.indices.length / 3, collapses, maxQuadricCost: maxCost },
  };
}
