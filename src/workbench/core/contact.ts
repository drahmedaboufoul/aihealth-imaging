/*
 * Occlusal contact / clearance map between two arbitrary meshes.
 *
 * Works for any two meshes (Fussen exports carry no upper/lower role in
 * their names): the user says which is upper and which is lower. For every
 * vertex of each arch we measure the signed distance to the opposing
 * surface using the opposing arch's outward normal:
 *   d < 0  the vertex is inside the opposing arch (interpenetration = contact)
 *   d >= 0 clearance to the opposing arch
 * Bands (defaults from the brief): contact d < 0, near 0..0.1, close 0..0.3 mm.
 *
 * The map is a DRAFT until a named person accepts it.
 */
import type { Mat4, MeshData } from './types';
import type { SpatialMesh } from './spatial';
import { invertRigid, multiply } from './mat4';
import { buildAdjacency, vertexAreas, vertexComponents } from './meshData';

export interface ContactThresholds {
  /** Upper bound of the "contact" band (mm). Default 0. */
  contact: number;
  /** Upper bound of the "near" band (mm). Default 0.1. */
  near: number;
  /** Upper bound of the "close" band (mm). Default 0.3. */
  close: number;
}

export const DEFAULT_CONTACT_THRESHOLDS: ContactThresholds = { contact: 0, near: 0.1, close: 0.3 };

export type ContactBand = 'contact' | 'near' | 'close' | 'clear';

export function contactBand(d: number, t: ContactThresholds = DEFAULT_CONTACT_THRESHOLDS): ContactBand {
  if (!Number.isFinite(d)) return 'clear';
  if (d < t.contact) return 'contact';
  if (d < t.near) return 'near';
  if (d < t.close) return 'close';
  return 'clear';
}

export interface ContactSide {
  /** Signed distance per vertex to the opposing arch (NaN beyond search radius). */
  values: Float32Array;
  /** mm^2 of surface in each band (barycentric vertex areas). */
  areaContact: number;
  areaNear: number;
  areaClose: number;
  /** Number of separate contact patches (connected contact vertices). */
  contactPatches: number;
  /** Deepest interpenetration (most negative distance, mm), NaN if none. */
  deepest: number;
  vertices: { contact: number; near: number; close: number };
}

export interface ContactResult {
  upper: ContactSide;
  lower: ContactSide;
  thresholds: ContactThresholds;
  searchRadius: number;
  warnings: string[];
  elapsedMs: number;
}

export interface ContactInput {
  mesh: MeshData;
  spatial: SpatialMesh;
  /** Display/world pose of this scan (local -> world). */
  matrix: Mat4;
}

function side(from: ContactInput, to: ContactInput, t: ContactThresholds, radius: number, invertSign: boolean): ContactSide {
  const M = multiply(invertRigid(to.matrix), from.matrix);
  const P = from.mesh.positions;
  const n = P.length / 3;
  const values = new Float32Array(n);
  const hit = { point: [0, 0, 0], normal: [0, 0, 0] } as unknown as Parameters<SpatialMesh['closest']>[4];
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const h = to.spatial.closest(
      M[0] * x + M[4] * y + M[8] * z + M[12],
      M[1] * x + M[5] * y + M[9] * z + M[13],
      M[2] * x + M[6] * y + M[10] * z + M[14],
      radius, hit,
    );
    values[i] = h ? (invertSign ? -h.signed : h.signed) : NaN;
  }
  const areas = vertexAreas(from.mesh);
  let aC = 0, aN = 0, aL = 0, vC = 0, vN = 0, vL = 0, deepest = Infinity;
  const contactMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const band = contactBand(values[i], t);
    if (band === 'contact') { aC += areas[i]; vC++; contactMask[i] = 1; if (values[i] < deepest) deepest = values[i]; }
    else if (band === 'near') { aN += areas[i]; vN++; }
    else if (band === 'close') { aL += areas[i]; vL++; }
  }
  const patches = vC ? vertexComponents(buildAdjacency(n, from.mesh.indices), contactMask).count : 0;
  return {
    values, areaContact: aC, areaNear: aN, areaClose: aL, contactPatches: patches,
    deepest: Number.isFinite(deepest) ? deepest : NaN,
    vertices: { contact: vC, near: vN, close: vL },
  };
}

export function computeContacts(
  upper: ContactInput, lower: ContactInput,
  thresholds: ContactThresholds = DEFAULT_CONTACT_THRESHOLDS,
  options: { searchRadius?: number; invertSign?: boolean } = {},
): ContactResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const radius = options.searchRadius ?? Math.max(1, thresholds.close * 3);
  const up = side(upper, lower, thresholds, radius, !!options.invertSign);
  const low = side(lower, upper, thresholds, radius, !!options.invertSign);
  const warnings: string[] = [];
  const deepLimit = -0.5;
  if ((Number.isFinite(up.deepest) && up.deepest < deepLimit) || (Number.isFinite(low.deepest) && low.deepest < deepLimit)) {
    warnings.push('Interpenetration deeper than 0.5 mm: check the bite registration or the alignment before reading contacts.');
  }
  const near = up.vertices.near + up.vertices.close + low.vertices.near + low.vertices.close;
  const inside = up.vertices.contact + low.vertices.contact;
  if (inside > 0 && inside > 3 * Math.max(1, near)) {
    warnings.push('Most nearby surface reads as inside the other arch: the scans may overlap or a mesh may have inverted normals.');
  }
  if (up.vertices.contact + up.vertices.near + up.vertices.close === 0) {
    warnings.push(`No surfaces within ${thresholds.close} mm: the arches may not be in occlusion.`);
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { upper: up, lower: low, thresholds, searchRadius: radius, warnings, elapsedMs: t1 - t0 };
}
