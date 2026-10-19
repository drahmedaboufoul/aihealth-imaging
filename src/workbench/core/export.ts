/*
 * Mesh writers. Headers carry no patient, study or file identifiers.
 */
import type { MeshData } from './types';

const STL_HEADER = 'aiHealth IOS workbench export (mm)';

/** Binary STL (little-endian), facet normals computed from the winding. */
export function writeBinaryStl(mesh: MeshData): ArrayBuffer {
  const { positions: P, indices: I } = mesh;
  const T = I.length / 3;
  const buf = new ArrayBuffer(84 + T * 50);
  const dv = new DataView(buf);
  const head = new TextEncoder().encode(STL_HEADER);
  new Uint8Array(buf, 0, 80).fill(0x20);
  new Uint8Array(buf, 0, 80).set(head.subarray(0, 80));
  dv.setUint32(80, T, true);
  let o = 84;
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) { nx /= l; ny /= l; nz /= l; }
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(o, P[v], true); dv.setFloat32(o + 4, P[v + 1], true); dv.setFloat32(o + 8, P[v + 2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}

function linearToSrgbByte(c: number): number {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

/** Binary little-endian PLY with optional per-vertex sRGB colour. */
export function writeBinaryPly(mesh: MeshData): ArrayBuffer {
  const { positions: P, indices: I, colors: C } = mesh;
  const V = P.length / 3, T = I.length / 3;
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    'comment aiHealth IOS workbench export (mm)',
    `element vertex ${V}`,
    'property float x',
    'property float y',
    'property float z',
    ...(C ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
    `element face ${T}`,
    'property list uchar int vertex_indices',
    'end_header',
    '',
  ].join('\n');
  const hb = new TextEncoder().encode(header);
  const vSize = 12 + (C ? 3 : 0);
  const buf = new ArrayBuffer(hb.length + V * vSize + T * 13);
  new Uint8Array(buf).set(hb, 0);
  const dv = new DataView(buf);
  let o = hb.length;
  for (let v = 0; v < V; v++) {
    dv.setFloat32(o, P[v * 3], true); dv.setFloat32(o + 4, P[v * 3 + 1], true); dv.setFloat32(o + 8, P[v * 3 + 2], true);
    o += 12;
    if (C) {
      dv.setUint8(o, linearToSrgbByte(C[v * 3])); dv.setUint8(o + 1, linearToSrgbByte(C[v * 3 + 1])); dv.setUint8(o + 2, linearToSrgbByte(C[v * 3 + 2]));
      o += 3;
    }
  }
  for (let t = 0; t < T; t++) {
    dv.setUint8(o, 3);
    dv.setInt32(o + 1, I[t * 3], true); dv.setInt32(o + 5, I[t * 3 + 1], true); dv.setInt32(o + 9, I[t * 3 + 2], true);
    o += 13;
  }
  return buf;
}
