/*
 * volumeMeshSampling — CBCT-volume sampling utilities for the Compare/Overlay
 * (CBCT ↔ intraoral-mesh) views:
 *
 *   - sampleDentitionSurfacePoints: bone/enamel ISOSURFACE points around the
 *     dental arch (the ICP target cloud). Reuses autoArch's dentition-slab
 *     detector so the cloud hugs the teeth/alveolus instead of the whole head,
 *     keeps only "surface" voxels (bright voxel with a dim in-plane neighbour)
 *     and hard-rejects far-posterior anatomy (spine / occiput).
 *
 *   - extractAxialMipPlane / extractMidSlicePlane: world-space textured-plane
 *     data (Float32 image + 4 world corners) so the three.js overlay scene can
 *     show the CBCT as patient-space backdrops behind the mesh. Rendering the
 *     mesh inside cornerstone's vtk.js 3D viewport has no supported API in
 *     cornerstone3D v4, so the overlay goes the other way: CBCT → three.js.
 *
 * Pure math / typed-array code (no DOM, no cornerstone). Volume shape matches
 * the rest of the imaging stack: { dimensions [nx,ny,nz], spacing, origin,
 * direction (9 world unit vectors of i,j,k), scalarData }.
 */
import { findDentitionSlab } from '@/lib/autoArch';

const idxToWorld = (vol, xi, yi, zi) => {
  const { origin, direction: d, spacing } = vol;
  const ix = xi * spacing[0];
  const iy = yi * spacing[1];
  const iz = zi * spacing[2];
  return [
    origin[0] + d[0] * ix + d[3] * iy + d[6] * iz,
    origin[1] + d[1] * ix + d[4] * iy + d[7] * iz,
    origin[2] + d[2] * ix + d[5] * iy + d[8] * iz,
  ];
};

/** 1st–99th percentile window of a raw scalar array (NIfTI has no DICOM VOI). */
export function computeScalarRangeFromData(data) {
  if (!data || !data.length) return null;
  const stride = Math.max(1, Math.floor(data.length / 250000));
  const sample = [];
  for (let i = 0; i < data.length; i += stride) sample.push(data[i]);
  sample.sort((a, b) => a - b);
  const n = sample.length;
  let lower = sample[Math.floor(n * 0.01)];
  let upper = sample[Math.floor(n * 0.99)];
  if (!(upper > lower)) { lower = sample[0]; upper = sample[n - 1]; }
  return upper > lower ? { lower, upper } : null;
}

/** Pull a cornerstone volume's scalar data across the v4 API variants. */
export function getVolumeScalarData(volume) {
  let data = null;
  try { if (typeof volume?.getScalarData === 'function') data = volume.getScalarData(); } catch (_) { /* try next */ }
  if (!data) { try { data = volume?.voxelManager?.getCompleteScalarDataArray?.(); } catch (_) { /* try next */ } }
  if (!data) { try { data = volume?.scalarData; } catch (_) { /* none */ } }
  return data && data.length ? data : null;
}

/**
 * Sample bone/enamel surface points around the dental arch, in WORLD (LPS) mm.
 *
 * @param {Object} vol { dimensions, spacing, origin, direction, scalarData }
 * @param {Object} [options]
 *   maxPoints (default 6000), zPadMm slab expansion (default 14),
 *   posteriorRejectMm depth behind the arch front to drop (default 70)
 * @returns {{ points:number[][], slab:Object, threshold:number, center:number[] }}
 */
export function sampleDentitionSurfacePoints(vol, options = {}) {
  const { dimensions, spacing, scalarData } = vol || {};
  if (!dimensions || !spacing || !vol.origin || !vol.direction || !scalarData) {
    throw new Error('Volume geometry/voxel data unavailable for surface sampling');
  }
  const { maxPoints = 6000, zPadMm = 14, posteriorRejectMm = 70 } = options;
  const [nx, ny, nz] = dimensions;
  const sxy = nx * ny;

  const slab = findDentitionSlab(vol, options); // throws when no dentition band
  const { threshold, antSign } = slab;
  const zPad = Math.round(zPadMm / (spacing[2] || 1));
  const z0 = Math.max(0, slab.z0 - zPad);
  const z1 = Math.min(nz - 1, slab.z1 + zPad);

  // In-plane stride keeps the pass cheap on large volumes.
  const ds = options.downsample || Math.max(1, Math.round(Math.max(nx, ny) / 320));

  // Anterior anchor within the expanded slab (front-most bright row).
  let aFront = -Infinity;
  for (let z = z0; z <= z1; z += Math.max(1, (z1 - z0) >> 3) || 1) {
    const base = z * sxy;
    for (let y = 0; y < ny; y += ds) {
      const row = base + y * nx;
      for (let x = 0; x < nx; x += ds) {
        if (scalarData[row + x] >= threshold) {
          const a = antSign * y;
          if (a > aFront) aFront = a;
          break;
        }
      }
    }
  }
  if (!Number.isFinite(aFront)) throw new Error('No bright dentition voxels found in the slab');
  const maxDepth = posteriorRejectMm / (spacing[1] || 1);

  const candidates = [];
  for (let z = z0; z <= z1; z++) {
    const base = z * sxy;
    for (let y = ds; y < ny - ds; y += ds) {
      const depth = aFront - antSign * y;
      if (depth < -ds || depth > maxDepth) continue; // posterior anatomy out
      const row = base + y * nx;
      for (let x = ds; x < nx - ds; x += ds) {
        const o = row + x;
        if (scalarData[o] < threshold) continue;
        // Surface test: a bright voxel with at least one dim in-plane
        // neighbour is on the bone/enamel boundary (cheap isosurface).
        if (
          scalarData[o - ds] < threshold || scalarData[o + ds] < threshold ||
          scalarData[o - ds * nx] < threshold || scalarData[o + ds * nx] < threshold
        ) {
          candidates.push([x, y, z]);
        }
      }
    }
  }
  if (candidates.length < 50) throw new Error('Too few dentition surface voxels for registration');

  // Uniform cap, then convert to world.
  const stride = Math.max(1, candidates.length / maxPoints);
  const points = [];
  let cx = 0; let cy = 0; let cz = 0;
  for (let f = 0; f < candidates.length && points.length < maxPoints; f += stride) {
    const [xi, yi, zi] = candidates[Math.floor(f)];
    const w = idxToWorld(vol, xi, yi, zi);
    points.push(w);
    cx += w[0]; cy += w[1]; cz += w[2];
  }
  const n = points.length;
  return { points, slab, threshold, center: [cx / n, cy / n, cz / n] };
}

// ── world-space textured planes for the three.js overlay backdrop ────────────

/**
 * Axial maximum-intensity projection over [z0..z1] as a textured world plane.
 * Defaults to the dentition slab (±pad) so the backdrop shows the arch.
 *
 * @returns {{ width, height, data:Float32Array,
 *             corners:number[][] }} corners = world positions of image
 *           (u,v) = (0,0), (1,0), (1,1), (0,1) — i.e. (i=0,j=0) … (i=0,j=max).
 */
export function extractAxialMipPlane(vol, options = {}) {
  const { dimensions, scalarData } = vol;
  const [nx, ny, nz] = dimensions;
  const sxy = nx * ny;
  let { z0 = null, z1 = null } = options;
  if (z0 == null || z1 == null) {
    try {
      const slab = findDentitionSlab(vol);
      const pad = Math.round((options.zPadMm ?? 10) / (vol.spacing[2] || 1));
      z0 = Math.max(0, slab.z0 - pad);
      z1 = Math.min(nz - 1, slab.z1 + pad);
    } catch (_) {
      z0 = Math.max(0, Math.floor(nz / 2) - 8);
      z1 = Math.min(nz - 1, Math.floor(nz / 2) + 8);
    }
  }
  const ds = options.downsample || Math.max(1, Math.round(Math.max(nx, ny) / 512));
  const width = Math.ceil(nx / ds);
  const height = Math.ceil(ny / ds);
  const data = new Float32Array(width * height).fill(-Infinity);
  for (let z = z0; z <= z1; z++) {
    const base = z * sxy;
    for (let y = 0, gy = 0; y < ny; y += ds, gy++) {
      const row = base + y * nx;
      const orow = gy * width;
      for (let x = 0, gx = 0; x < nx; x += ds, gx++) {
        const v = scalarData[row + x];
        if (v > data[orow + gx]) data[orow + gx] = v;
      }
    }
  }
  const zc = Math.round((z0 + z1) / 2);
  const corners = [
    idxToWorld(vol, 0, 0, zc),
    idxToWorld(vol, nx - 1, 0, zc),
    idxToWorld(vol, nx - 1, ny - 1, zc),
    idxToWorld(vol, 0, ny - 1, zc),
  ];
  return { width, height, data, corners, z0, z1 };
}

/**
 * A single coronal/sagittal slice as a textured world plane (mid-volume by
 * default). axis: 'coronal' fixes j, 'sagittal' fixes i.
 */
export function extractMidSlicePlane(vol, axis, sliceIndex = null) {
  const { dimensions, scalarData } = vol;
  const [nx, ny, nz] = dimensions;
  const sxy = nx * ny;
  const ds = Math.max(1, Math.round(Math.max(nx, ny, nz) / 512));

  if (axis === 'coronal') {
    const j = sliceIndex == null ? Math.floor(ny / 2) : Math.max(0, Math.min(ny - 1, sliceIndex));
    const width = Math.ceil(nx / ds);
    const height = Math.ceil(nz / ds);
    const data = new Float32Array(width * height);
    for (let z = 0, gy = 0; z < nz; z += ds, gy++) {
      const base = z * sxy + j * nx;
      const orow = gy * width;
      for (let x = 0, gx = 0; x < nx; x += ds, gx++) data[orow + gx] = scalarData[base + x];
    }
    const corners = [
      idxToWorld(vol, 0, j, 0),
      idxToWorld(vol, nx - 1, j, 0),
      idxToWorld(vol, nx - 1, j, nz - 1),
      idxToWorld(vol, 0, j, nz - 1),
    ];
    return { width, height, data, corners, slice: j };
  }
  if (axis === 'sagittal') {
    const i = sliceIndex == null ? Math.floor(nx / 2) : Math.max(0, Math.min(nx - 1, sliceIndex));
    const width = Math.ceil(ny / ds);
    const height = Math.ceil(nz / ds);
    const data = new Float32Array(width * height);
    for (let z = 0, gy = 0; z < nz; z += ds, gy++) {
      const base = z * sxy + i;
      const orow = gy * width;
      for (let y = 0, gx = 0; y < ny; y += ds, gx++) data[orow + gx] = scalarData[base + y * nx];
    }
    const corners = [
      idxToWorld(vol, i, 0, 0),
      idxToWorld(vol, i, ny - 1, 0),
      idxToWorld(vol, i, ny - 1, nz - 1),
      idxToWorld(vol, i, 0, nz - 1),
    ];
    return { width, height, data, corners, slice: i };
  }
  throw new Error(`Unknown slice axis: ${axis}`);
}

/**
 * Window a Float32 plane image to RGBA bytes (texture-ready, no canvas).
 * -Infinity / NaN map to black.
 */
export function windowImageToRgba(image, lower, upper) {
  const { width, height, data } = image;
  const span = upper > lower ? upper - lower : 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    let g = 0;
    if (Number.isFinite(v)) g = Math.max(0, Math.min(255, Math.round(((v - lower) / span) * 255)));
    const o = i * 4;
    rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
  }
  return rgba;
}
