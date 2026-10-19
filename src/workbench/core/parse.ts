/*
 * Mesh file parsing for the workbench (runs inside the geometry worker).
 *
 * Output is two views of the same surface:
 *   - topology: vertices welded by position only. Analyses, edits, hashes
 *     and exports all use this one.
 *   - display:  only for textured files, where vertices are welded by
 *     position AND texture coordinate so the texture seams survive. Each
 *     display vertex maps to its topology vertex (displayToTopo).
 *
 * Binary STL has a direct reader (no intermediate three.js geometry) so a
 * 2M-triangle scan does not allocate per-vertex normals it never needs.
 * PLY, OBJ and ASCII STL reuse the three.js loaders, including the Fussen
 * byte-RGB OBJ colour normalisation used by the main viewer.
 */
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { normalizeObjVertexColors } from '../../lib/objVertexColors';
import type { MeshData } from './types';
import { gatherAttribute, weldVertices } from './meshData';

export type MeshFormat = 'stl' | 'ply' | 'obj';

export interface DisplayMesh {
  positions: Float32Array;
  indices: Uint32Array;
  colors: Float32Array | null;
  uvs: Float32Array | null;
}

export interface ParsedMesh {
  format: MeshFormat;
  topo: MeshData;
  /** null when the display mesh is the topology mesh itself */
  display: DisplayMesh | null;
  displayToTopo: Uint32Array | null;
  stats: {
    sourceTriangles: number;
    degenerateDropped: number;
    parseMs: number;
    weldMs: number;
  };
}

export function detectFormat(fileName: string, hint?: string): MeshFormat {
  const ext = (hint || fileName.split('.').pop() || '').toLowerCase();
  if (ext === 'stl' || ext === 'ply' || ext === 'obj') return ext;
  throw new Error(`Unsupported 3D scan format: .${ext || '?'}`);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isBinaryStl(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const count = new DataView(buffer).getUint32(80, true);
  return 84 + count * 50 === buffer.byteLength;
}

function readBinaryStlSoup(buffer: ArrayBuffer): Float32Array {
  const dv = new DataView(buffer);
  const T = dv.getUint32(80, true);
  const soup = new Float32Array(T * 9);
  let o = 84;
  for (let t = 0; t < T; t++) {
    o += 12; // skip facet normal
    for (let k = 0; k < 9; k++) { soup[t * 9 + k] = dv.getFloat32(o, true); o += 4; }
    o += 2;
  }
  return soup;
}

function objGeometry(buffer: ArrayBuffer): THREE.BufferGeometry {
  const text = new TextDecoder().decode(buffer);
  const obj = new OBJLoader().parse(normalizeObjVertexColors(text));
  obj.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const g = mesh.isMesh ? (mesh.geometry as THREE.BufferGeometry) : null;
    if (!g || !g.attributes.position) return;
    const c = g.clone();
    if (!mesh.matrixWorld.equals(new THREE.Matrix4())) c.applyMatrix4(mesh.matrixWorld);
    parts.push(c);
  });
  if (parts.length === 0) throw new Error('No mesh found in the OBJ file.');
  if (parts.length === 1) return parts[0];
  const common = Object.keys(parts[0].attributes).filter((n) => parts.every((g) => g.hasAttribute(n)));
  for (const g of parts) for (const n of Object.keys(g.attributes)) if (!common.includes(n)) g.deleteAttribute(n);
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  if (!merged) throw new Error('Could not merge the OBJ groups.');
  return merged;
}

function attr(g: THREE.BufferGeometry, name: string): Float32Array | null {
  const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
  if (!a) return null;
  if (a.array instanceof Float32Array && a.itemSize === (name === 'uv' ? 2 : 3) && !(a as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) return a.array;
  const size = name === 'uv' ? 2 : 3;
  const out = new Float32Array(a.count * size);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < size; k++) out[i * size + k] = a.getComponent(i, k);
  return out;
}

export function parseMeshBuffer(buffer: ArrayBuffer, fileName: string, formatHint?: string): ParsedMesh {
  const format = detectFormat(fileName, formatHint);
  const t0 = now();
  let soup: Float32Array;
  let index: Uint32Array | null = null;
  let colors: Float32Array | null = null;
  let uvs: Float32Array | null = null;
  if (format === 'stl' && isBinaryStl(buffer)) {
    soup = readBinaryStlSoup(buffer);
  } else {
    let g: THREE.BufferGeometry;
    if (format === 'stl' && !/facet/.test(new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096))))) {
      throw new Error('The STL file contains no triangles.');
    }
    try {
      if (format === 'stl') g = new STLLoader().parse(buffer);
      else if (format === 'ply') g = new PLYLoader().parse(buffer);
      else g = objGeometry(buffer);
    } catch (err) {
      throw new Error(`Could not read the ${format.toUpperCase()} file (${err instanceof Error ? err.message : 'unknown error'}).`, { cause: err });
    }
    const pos = attr(g, 'position');
    if (!pos || pos.length < 9) throw new Error('The file contains no triangles.');
    soup = pos;
    const idx = g.getIndex();
    index = idx ? Uint32Array.from(idx.array as ArrayLike<number>) : null;
    colors = attr(g, 'color');
    uvs = attr(g, 'uv');
    g.dispose();
  }
  const sourceTriangles = index ? index.length / 3 : soup.length / 9;
  const t1 = now();

  let topo: MeshData;
  let display: DisplayMesh | null = null;
  let displayToTopo: Uint32Array | null = null;
  let degenerateDropped: number;
  if (uvs) {
    // seam-preserving display weld, then position-only topology weld
    const dw = weldVertices(soup, index, uvs, 2);
    const dColors = colors ? gatherAttribute(colors, 3, dw.firstSource) : null;
    const dUvs = gatherAttribute(uvs, 2, dw.firstSource);
    const tw = weldVertices(dw.positions, dw.indices);
    displayToTopo = tw.remap;
    // keep display triangles in lock-step with topology triangles
    const keep: number[] = [];
    for (let t = 0; t < dw.indices.length; t += 3) {
      const a = tw.remap[dw.indices[t]], b = tw.remap[dw.indices[t + 1]], c = tw.remap[dw.indices[t + 2]];
      if (a !== b && b !== c && a !== c) keep.push(dw.indices[t], dw.indices[t + 1], dw.indices[t + 2]);
    }
    display = { positions: dw.positions, indices: Uint32Array.from(keep), colors: dColors, uvs: dUvs };
    topo = { positions: tw.positions, indices: tw.indices, colors: dColors ? gatherAttribute(dColors, 3, tw.firstSource) : null };
    degenerateDropped = dw.degenerateDropped + tw.degenerateDropped;
  } else {
    const w = weldVertices(soup, index);
    topo = { positions: w.positions, indices: w.indices, colors: colors ? gatherAttribute(colors, 3, w.firstSource) : null };
    degenerateDropped = w.degenerateDropped;
  }
  const t2 = now();
  if (topo.indices.length === 0) throw new Error('The file contains no usable triangles.');
  return {
    format,
    topo,
    display,
    displayToTopo,
    stats: { sourceTriangles, degenerateDropped, parseMs: t1 - t0, weldMs: t2 - t1 },
  };
}
