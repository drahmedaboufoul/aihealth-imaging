/*
 * IOS workbench core types.
 *
 * Everything under src/workbench/core is plain TypeScript with no DOM access,
 * so it runs unchanged in the geometry Web Worker, on the main thread and in
 * the Node unit tests. Units are the scanner's native millimetres throughout.
 */

/** Indexed triangle mesh in a scan's native frame (millimetres). */
export interface MeshData {
  /** xyz per vertex. */
  positions: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  indices: Uint32Array;
  /** Optional linear-RGB colour per vertex (0..1), as three.js stores it. */
  colors?: Float32Array | null;
}

/** 4x4 matrix, column-major (the same layout as THREE.Matrix4.elements). */
export type Mat4 = number[];

export type Vec3 = [number, number, number];

export interface Plane {
  /** A point on the plane. */
  origin: Vec3;
  /** Unit normal. "positive" side is the side the normal points to. */
  normal: Vec3;
}

export const IDENTITY: Readonly<Mat4> = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function triangleCount(mesh: MeshData): number {
  return mesh.indices.length / 3;
}

export function vertexCount(mesh: MeshData): number {
  return mesh.positions.length / 3;
}
