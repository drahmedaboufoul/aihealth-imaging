/*
 * Synthetic meshes for the IOS workbench tests. No patient data: every
 * surface here is generated from a formula.
 */
import type { MeshData } from '../../src/workbench/core/types';

/** Flat grid in the XY plane at height z, normals +Z (or -Z when flipped). */
export function planeGrid(opts: { size?: number; n?: number; z?: number; flip?: boolean; cx?: number; cy?: number } = {}): MeshData {
  const size = opts.size ?? 10, n = opts.n ?? 20, z = opts.z ?? 0;
  const cx = opts.cx ?? 0, cy = opts.cy ?? 0;
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const v = j * (n + 1) + i;
    positions[v * 3] = cx - size / 2 + (size * i) / n;
    positions[v * 3 + 1] = cy - size / 2 + (size * j) / n;
    positions[v * 3 + 2] = z;
  }
  const idx: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    if (opts.flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
  }
  return { positions, indices: Uint32Array.from(idx), colors: null };
}

/** Icosphere (closed, outward normals). */
export function icosphere(radius = 10, subdivisions = 4, center: [number, number, number] = [0, 0, 0]): MeshData {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return v.map((c) => c / l); });
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const m = [(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2, (verts[a][2] + verts[b][2]) / 2];
      const l = Math.hypot(m[0], m[1], m[2]);
      verts.push(m.map((c) => c / l));
      cache.set(key, verts.length - 1);
      return verts.length - 1;
    };
    const next: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  verts = verts.map((v) => [v[0] * radius + center[0], v[1] * radius + center[1], v[2] * radius + center[2]]);
  return { positions: Float32Array.from(verts.flat()), indices: Uint32Array.from(faces.flat()), colors: null };
}

/**
 * Dental-arch-like open surface: a horseshoe ridge with tooth-like bumps.
 * Roughly 50 x 40 x 10 mm, outward normals. Triangles = 2 * nu * nv.
 */
export function archMesh(opts: { nu?: number; nv?: number; bumpHeight?: number; teeth?: number; colors?: boolean } = {}): MeshData {
  const nu = opts.nu ?? 160, nv = opts.nv ?? 40;
  const bump = opts.bumpHeight ?? 2.2, teeth = opts.teeth ?? 14;
  const positions = new Float32Array((nu + 1) * (nv + 1) * 3);
  const colors = opts.colors ? new Float32Array((nu + 1) * (nv + 1) * 3) : null;
  for (let i = 0; i <= nu; i++) {
    const s = i / nu;
    const th = -1.25 + 2.5 * s;
    const ax = 24 * Math.sin(th), az = 20 * Math.cos(th) - 8;
    // outward radial direction of the arch curve (in XZ)
    const rx = Math.sin(th), rz = Math.cos(th);
    const tooth = Math.pow(Math.max(0, Math.sin(th * teeth * 0.5 + 0.3)), 2);
    for (let j = 0; j <= nv; j++) {
      const tt = (j / nv) * Math.PI;
      const radial = 5 * Math.cos(tt);
      const h = 7 * Math.sin(tt) + bump * tooth * Math.pow(Math.sin(tt), 3) + 0.4 * Math.sin(3 * th + 2 * tt);
      const v = i * (nv + 1) + j;
      positions[v * 3] = ax + rx * radial;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = az + rz * radial;
      if (colors) { colors[v * 3] = 0.9; colors[v * 3 + 1] = 0.75 + 0.2 * tooth; colors[v * 3 + 2] = 0.7; }
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = i * (nv + 1) + j, b = a + 1, c = a + nv + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const mesh: MeshData = { positions, indices: Uint32Array.from(idx), colors };
  // make the top of the ridge face +Y (outward)
  orientOutward(mesh, [0, 1, 0]);
  return mesh;
}

/** Flip the winding if the area-weighted mean normal points away from `dir`. */
export function orientOutward(mesh: MeshData, dir: [number, number, number]): void {
  const P = mesh.positions, I = mesh.indices;
  let s = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    s += n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
  }
  if (s < 0) for (let t = 0; t < I.length; t += 3) { const x = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = x; }
}

/** Apply a column-major 4x4 to a copy of the mesh. */
export function transformed(mesh: MeshData, m: number[]): MeshData {
  const P = mesh.positions;
  const out = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return { positions: out, indices: mesh.indices.slice(), colors: mesh.colors ? mesh.colors.slice() : null };
}

/** Rotation about a unit axis by deg, then translation. Column-major. */
export function rigid(axis: [number, number, number], deg: number, t: [number, number, number]): number[] {
  const l = Math.hypot(...axis);
  const [x, y, z] = axis.map((v) => v / l);
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  return [
    x * x * C + c, y * x * C + z * s, z * x * C - y * s, 0,
    x * y * C - z * s, y * y * C + c, z * y * C + x * s, 0,
    x * z * C + y * s, y * z * C - x * s, z * z * C + c, 0,
    t[0], t[1], t[2], 1,
  ];
}

/** Add a smooth bump of `height` mm along the vertex normals inside `radius` of `center` (XZ). */
export function withBump(mesh: MeshData, center: [number, number], radius: number, height: number): MeshData {
  const out: MeshData = { positions: mesh.positions.slice(), indices: mesh.indices.slice(), colors: mesh.colors ? mesh.colors.slice() : null };
  const P = out.positions;
  for (let v = 0; v < P.length / 3; v++) {
    const d = Math.hypot(P[v * 3] - center[0], P[v * 3 + 2] - center[1]);
    if (d < radius) P[v * 3 + 1] += height * 0.5 * (1 + Math.cos((Math.PI * d) / radius));
  }
  return out;
}

/** ASCII PLY text (positions + faces, optional 0-255 colours). */
export function toAsciiPly(mesh: MeshData): string {
  const V = mesh.positions.length / 3, T = mesh.indices.length / 3;
  const lines = ['ply', 'format ascii 1.0', `element vertex ${V}`, 'property float x', 'property float y', 'property float z'];
  if (mesh.colors) lines.push('property uchar red', 'property uchar green', 'property uchar blue');
  lines.push(`element face ${T}`, 'property list uchar int vertex_indices', 'end_header');
  for (let v = 0; v < V; v++) {
    const p = [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]].map((n) => n.toFixed(5));
    if (mesh.colors) p.push(...[0, 1, 2].map((k) => String(Math.round((mesh.colors as Float32Array)[v * 3 + k] * 255))));
    lines.push(p.join(' '));
  }
  for (let t = 0; t < T; t++) lines.push(`3 ${mesh.indices[t * 3]} ${mesh.indices[t * 3 + 1]} ${mesh.indices[t * 3 + 2]}`);
  return `${lines.join('\n')}\n`;
}
