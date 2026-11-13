/*
 * Mesh topology helpers: welding a triangle soup into an indexed mesh,
 * normals, areas, adjacency, edge tables and compaction.
 *
 * All functions are pure and deterministic: the same input always yields
 * the same output arrays, which is what makes version hashes reproducible.
 */
import type { MeshData } from './types';

export interface WeldResult {
  positions: Float32Array;
  indices: Uint32Array;
  /** source vertex -> welded vertex */
  remap: Uint32Array;
  /** welded vertex -> first source vertex that produced it */
  firstSource: Uint32Array;
  /** triangles dropped because two corners welded together */
  degenerateDropped: number;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Bit patterns of the floats with -0 folded into +0 so they hash equal. */
function canonicalBits(src: Float32Array): Uint32Array {
  const f = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    f[i] = v === 0 ? 0 : v;
  }
  return new Uint32Array(f.buffer);
}

/**
 * Weld vertices that are bit-identical (after -0 -> +0). Optional `extra`
 * attribute (e.g. UVs) participates in the key so texture seams survive.
 * Triangles that collapse (two equal corners) are dropped.
 */
export function weldVertices(
  positions: Float32Array,
  indices: Uint32Array | null,
  extra?: Float32Array | null,
  extraStride = 0,
): WeldResult {
  const n = positions.length / 3;
  const pb = canonicalBits(positions);
  const eb = extra && extraStride > 0 ? canonicalBits(extra) : null;
  const size = nextPow2(Math.max(16, n * 2));
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1); // welded id
  const remap = new Uint32Array(n);
  const firstSourceTmp = new Uint32Array(n);
  let welded = 0;
  for (let v = 0; v < n; v++) {
    const x = pb[v * 3], y = pb[v * 3 + 1], z = pb[v * 3 + 2];
    let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d);
    if (eb) for (let k = 0; k < extraStride; k++) h ^= Math.imul(eb[v * extraStride + k], 0x27d4eb2f + k * 2);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
    let slot = h & mask;
    for (;;) {
      const id = table[slot];
      if (id === -1) {
        table[slot] = welded;
        firstSourceTmp[welded] = v;
        remap[v] = welded++;
        break;
      }
      const s = firstSourceTmp[id];
      let same = pb[s * 3] === x && pb[s * 3 + 1] === y && pb[s * 3 + 2] === z;
      if (same && eb) {
        for (let k = 0; k < extraStride; k++) {
          if (eb[s * extraStride + k] !== eb[v * extraStride + k]) { same = false; break; }
        }
      }
      if (same) { remap[v] = id; break; }
      slot = (slot + 1) & mask;
    }
  }
  const outPos = new Float32Array(welded * 3);
  const firstSource = firstSourceTmp.slice(0, welded);
  for (let w = 0; w < welded; w++) {
    const s = firstSource[w];
    outPos[w * 3] = positions[s * 3]; outPos[w * 3 + 1] = positions[s * 3 + 1]; outPos[w * 3 + 2] = positions[s * 3 + 2];
  }
  const triSrc = indices ? indices.length / 3 : n / 3;
  const outIdx = new Uint32Array(triSrc * 3);
  let t = 0;
  let dropped = 0;
  for (let i = 0; i < triSrc; i++) {
    const a = remap[indices ? indices[i * 3] : i * 3];
    const b = remap[indices ? indices[i * 3 + 1] : i * 3 + 1];
    const c = remap[indices ? indices[i * 3 + 2] : i * 3 + 2];
    if (a === b || b === c || a === c) { dropped++; continue; }
    outIdx[t * 3] = a; outIdx[t * 3 + 1] = b; outIdx[t * 3 + 2] = c;
    t++;
  }
  return { positions: outPos, indices: outIdx.slice(0, t * 3), remap, firstSource, degenerateDropped: dropped };
}

/** Gather a per-source-vertex attribute onto welded vertices (first source wins). */
export function gatherAttribute(src: Float32Array, stride: number, firstSource: Uint32Array): Float32Array {
  const out = new Float32Array(firstSource.length * stride);
  for (let w = 0; w < firstSource.length; w++) {
    const s = firstSource[w];
    for (let k = 0; k < stride; k++) out[w * stride + k] = src[s * stride + k];
  }
  return out;
}

/** Area-weighted vertex normals (unit length; zero for isolated vertices). */
export function computeVertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (l > 0) { normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l; }
  }
  return normals;
}

export function triangleArea(p: Float32Array, a: number, b: number, c: number): number {
  const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
  const e1x = p[b * 3] - ax, e1y = p[b * 3 + 1] - ay, e1z = p[b * 3 + 2] - az;
  const e2x = p[c * 3] - ax, e2y = p[c * 3 + 1] - ay, e2z = p[c * 3 + 2] - az;
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  return 0.5 * Math.hypot(nx, ny, nz);
}

export function surfaceArea(mesh: MeshData): number {
  let s = 0;
  const { positions, indices } = mesh;
  for (let t = 0; t < indices.length; t += 3) s += triangleArea(positions, indices[t], indices[t + 1], indices[t + 2]);
  return s;
}

/** Barycentric vertex areas: one third of each incident triangle's area. */
export function vertexAreas(mesh: MeshData): Float64Array {
  const { positions, indices } = mesh;
  const out = new Float64Array(positions.length / 3);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const third = triangleArea(positions, a, b, c) / 3;
    out[a] += third; out[b] += third; out[c] += third;
  }
  return out;
}

export interface Bounds { min: [number, number, number]; max: [number, number, number] }

export function computeBounds(positions: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/** CSR vertex adjacency (unique neighbours, ascending). */
export interface Adjacency { offsets: Uint32Array; neighbors: Uint32Array }

export function buildAdjacency(vertexCountN: number, indices: Uint32Array): Adjacency {
  const deg = new Uint32Array(vertexCountN + 1);
  for (let t = 0; t < indices.length; t += 3) {
    deg[indices[t]] += 2; deg[indices[t + 1]] += 2; deg[indices[t + 2]] += 2;
  }
  const off = new Uint32Array(vertexCountN + 1);
  for (let v = 0; v < vertexCountN; v++) off[v + 1] = off[v] + deg[v];
  const raw = new Uint32Array(off[vertexCountN]);
  const fill = off.slice(0, vertexCountN);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    raw[fill[a]++] = b; raw[fill[a]++] = c;
    raw[fill[b]++] = a; raw[fill[b]++] = c;
    raw[fill[c]++] = a; raw[fill[c]++] = b;
  }
  // de-duplicate each list
  const outOff = new Uint32Array(vertexCountN + 1);
  const out = new Uint32Array(raw.length);
  let w = 0;
  for (let v = 0; v < vertexCountN; v++) {
    outOff[v] = w;
    const s = off[v], e = off[v + 1];
    const seg = raw.subarray(s, e);
    seg.sort();
    let last = -1;
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] !== last) { out[w++] = seg[i]; last = seg[i]; }
    }
  }
  outOff[vertexCountN] = w;
  return { offsets: outOff, neighbors: out.slice(0, w) };
}

/**
 * Open-addressing table of undirected edges. For each edge it stores how
 * many triangles use it and the first directed half-edge (3*tri + corner,
 * where the half-edge runs corner -> corner+1).
 */
export class EdgeTable {
  readonly a: Int32Array;
  readonly b: Int32Array;
  readonly count: Uint8Array;
  readonly firstHalfEdge: Int32Array;
  readonly mask: number;
  size = 0;

  constructor(expectedEdges: number) {
    const cap = nextPow2(Math.max(16, expectedEdges * 2));
    this.a = new Int32Array(cap).fill(-1);
    this.b = new Int32Array(cap);
    this.count = new Uint8Array(cap);
    this.firstHalfEdge = new Int32Array(cap);
    this.mask = cap - 1;
  }

  private slotOf(lo: number, hi: number): number {
    let h = Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca77);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
    let s = h & this.mask;
    while (this.a[s] !== -1 && (this.a[s] !== lo || this.b[s] !== hi)) s = (s + 1) & this.mask;
    return s;
  }

  add(u: number, v: number, halfEdge: number): number {
    const lo = u < v ? u : v, hi = u < v ? v : u;
    const s = this.slotOf(lo, hi);
    if (this.a[s] === -1) {
      this.a[s] = lo; this.b[s] = hi; this.firstHalfEdge[s] = halfEdge; this.size++;
    }
    if (this.count[s] < 255) this.count[s]++;
    return s;
  }

  find(u: number, v: number): number {
    const lo = u < v ? u : v, hi = u < v ? v : u;
    const s = this.slotOf(lo, hi);
    return this.a[s] === -1 ? -1 : s;
  }

  static fromIndices(indices: Uint32Array): EdgeTable {
    const table = new EdgeTable(indices.length);
    for (let t = 0; t < indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const u = indices[t + k], v = indices[t + ((k + 1) % 3)];
        table.add(u, v, t + k);
      }
    }
    return table;
  }
}

export interface TopologyReport {
  boundaryEdges: number;
  nonManifoldEdges: number;
  /** true when every edge has exactly two triangles */
  closed: boolean;
}

export function topologyReport(mesh: MeshData): TopologyReport {
  const table = EdgeTable.fromIndices(mesh.indices);
  let boundary = 0, nonManifold = 0;
  for (let s = 0; s < table.a.length; s++) {
    if (table.a[s] === -1) continue;
    if (table.count[s] === 1) boundary++;
    else if (table.count[s] > 2) nonManifold++;
  }
  return { boundaryEdges: boundary, nonManifoldEdges: nonManifold, closed: boundary === 0 && nonManifold === 0 };
}

/**
 * Keep only the triangles flagged in `keep`, drop vertices nobody uses any
 * more and carry colours along. Vertex order is preserved (stable).
 */
export function compactMesh(mesh: MeshData, keep: Uint8Array | null, extraTriangles?: Uint32Array): MeshData {
  const { positions, indices, colors } = mesh;
  const nV = positions.length / 3;
  const used = new Int32Array(nV).fill(-1);
  const triTotal = indices.length / 3;
  let keptTris = 0;
  for (let t = 0; t < triTotal; t++) {
    if (keep && !keep[t]) continue;
    keptTris++;
    used[indices[t * 3]] = 0; used[indices[t * 3 + 1]] = 0; used[indices[t * 3 + 2]] = 0;
  }
  if (extraTriangles) {
    for (let i = 0; i < extraTriangles.length; i++) used[extraTriangles[i]] = 0;
  }
  let nNew = 0;
  for (let v = 0; v < nV; v++) if (used[v] === 0) used[v] = nNew++;
  const outPos = new Float32Array(nNew * 3);
  const outCol = colors ? new Float32Array(nNew * 3) : null;
  for (let v = 0; v < nV; v++) {
    const w = used[v];
    if (w < 0) continue;
    outPos[w * 3] = positions[v * 3]; outPos[w * 3 + 1] = positions[v * 3 + 1]; outPos[w * 3 + 2] = positions[v * 3 + 2];
    if (outCol && colors) { outCol[w * 3] = colors[v * 3]; outCol[w * 3 + 1] = colors[v * 3 + 1]; outCol[w * 3 + 2] = colors[v * 3 + 2]; }
  }
  const extraCount = extraTriangles ? extraTriangles.length / 3 : 0;
  const outIdx = new Uint32Array((keptTris + extraCount) * 3);
  let w = 0;
  for (let t = 0; t < triTotal; t++) {
    if (keep && !keep[t]) continue;
    outIdx[w++] = used[indices[t * 3]]; outIdx[w++] = used[indices[t * 3 + 1]]; outIdx[w++] = used[indices[t * 3 + 2]];
  }
  if (extraTriangles) for (let i = 0; i < extraTriangles.length; i++) outIdx[w++] = used[extraTriangles[i]];
  return { positions: outPos, indices: outIdx, colors: outCol };
}

/** Deep copy (used so originals are never mutated). */
export function cloneMesh(mesh: MeshData): MeshData {
  return {
    positions: mesh.positions.slice(),
    indices: mesh.indices.slice(),
    colors: mesh.colors ? mesh.colors.slice() : null,
  };
}

/** Apply a rigid/affine column-major matrix to every vertex (new mesh). */
export function transformMesh(mesh: MeshData, m: ArrayLike<number>): MeshData {
  const p = mesh.positions;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return { positions: out, indices: mesh.indices.slice(), colors: mesh.colors ? mesh.colors.slice() : null };
}

/** Connected components over triangles sharing a vertex restricted to `mask` vertices. */
export function vertexComponents(adj: Adjacency, mask: Uint8Array): { labels: Int32Array; count: number } {
  const n = mask.length;
  const labels = new Int32Array(n).fill(-1);
  const stack = new Uint32Array(n);
  let count = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || labels[s] !== -1) continue;
    let top = 0;
    stack[top++] = s;
    labels[s] = count;
    while (top > 0) {
      const v = stack[--top];
      for (let i = adj.offsets[v]; i < adj.offsets[v + 1]; i++) {
        const u = adj.neighbors[i];
        if (mask[u] && labels[u] === -1) { labels[u] = count; stack[top++] = u; }
      }
    }
    count++;
  }
  return { labels, count };
}
