/*
 * Spatial index over a MeshData using three-mesh-bvh (MIT).
 *
 * `indirect: true` keeps the index buffer in its canonical order, so the
 * BVH never changes the bytes a version hash was computed over.
 */
import * as THREE from 'three';
import { MeshBVH, type SerializedBVH } from 'three-mesh-bvh';
import type { MeshData } from './types';
import { computeVertexNormals } from './meshData';

export interface ClosestHit {
  distance: number;
  /** Signed distance using the interpolated outward normal at the hit. */
  signed: number;
  face: number;
  point: [number, number, number];
  normal: [number, number, number];
}

export class SpatialMesh {
  readonly geometry: THREE.BufferGeometry;
  readonly bvh: MeshBVH;
  readonly normals: Float32Array;
  readonly buildMs: number;
  private target: { point?: THREE.Vector3; distance?: number; faceIndex?: number } = {};
  private q = new THREE.Vector3();
  private tri = new THREE.Triangle();
  private bary = new THREE.Vector3();
  private va = new THREE.Vector3();
  private vb = new THREE.Vector3();
  private vc = new THREE.Vector3();

  constructor(readonly mesh: MeshData, normals?: Float32Array, serialized?: SerializedBVH) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    this.geometry = g;
    this.normals = normals ?? computeVertexNormals(mesh.positions, mesh.indices);
    const t0 = now();
    this.bvh = serialized ? MeshBVH.deserialize(serialized, g, { setIndex: false }) : new MeshBVH(g, { indirect: true });
    this.buildMs = now() - t0;
  }

  serialize(): SerializedBVH {
    return MeshBVH.serialize(this.bvh, { cloneBuffers: true });
  }

  /**
   * Closest point on the surface to (x, y, z) within maxDistance.
   * Returns null when nothing is that close.
   */
  closest(x: number, y: number, z: number, maxDistance = Infinity, out?: ClosestHit): ClosestHit | null {
    this.q.set(x, y, z);
    const hit = this.bvh.closestPointToPoint(this.q, this.target as never, 0, maxDistance) as
      | { point: THREE.Vector3; distance: number; faceIndex: number }
      | null;
    if (!hit) return null;
    const f = hit.faceIndex;
    const idx = this.mesh.indices;
    const p = this.mesh.positions;
    const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
    this.va.set(p[a * 3], p[a * 3 + 1], p[a * 3 + 2]);
    this.vb.set(p[b * 3], p[b * 3 + 1], p[b * 3 + 2]);
    this.vc.set(p[c * 3], p[c * 3 + 1], p[c * 3 + 2]);
    this.tri.set(this.va, this.vb, this.vc);
    this.tri.getBarycoord(hit.point, this.bary);
    const n = this.normals;
    let nx = this.bary.x * n[a * 3] + this.bary.y * n[b * 3] + this.bary.z * n[c * 3];
    let ny = this.bary.x * n[a * 3 + 1] + this.bary.y * n[b * 3 + 1] + this.bary.z * n[c * 3 + 1];
    let nz = this.bary.x * n[a * 3 + 2] + this.bary.y * n[b * 3 + 2] + this.bary.z * n[c * 3 + 2];
    let nl = Math.hypot(nx, ny, nz);
    if (!(nl > 1e-12)) {
      // degenerate interpolation: fall back to the face normal
      this.tri.getNormal(this.bary);
      nx = this.bary.x; ny = this.bary.y; nz = this.bary.z; nl = 1;
    }
    nx /= nl; ny /= nl; nz /= nl;
    const dx = x - hit.point.x, dy = y - hit.point.y, dz = z - hit.point.z;
    const dot = dx * nx + dy * ny + dz * nz;
    const res = out ?? ({ point: [0, 0, 0], normal: [0, 0, 0] } as unknown as ClosestHit);
    res.distance = hit.distance;
    res.signed = dot < 0 ? -hit.distance : hit.distance;
    res.face = f;
    res.point[0] = hit.point.x; res.point[1] = hit.point.y; res.point[2] = hit.point.z;
    res.normal[0] = nx; res.normal[1] = ny; res.normal[2] = nz;
    return res;
  }
}

export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
