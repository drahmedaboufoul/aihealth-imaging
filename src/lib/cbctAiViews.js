/*
 * cbctAiViews — deterministic AI-input view capture for the CBCT reader.
 *
 * Given the loaded volume (the same { dimensions, spacing, origin, direction,
 * scalarData } shape the viewer/curvedMpr/autoArch already use), produces the
 * fixed set of 2D views the ai-read-cbct edge function expects:
 *
 *   - "panoramic"      auto-arch curved-MPR OPG (reuses detectDentalArch +
 *                      generatePanoramic — no math duplicated here)
 *   - "axial_1..N"     3–5 thin axial MIP slabs spread through the dentition
 *                      band found by findDentitionSlab (crowns → roots)
 *   - "coronal_mid"    thin coronal slab through the dental centroid
 *   - "sagittal_mid"   thin sagittal slab through the dental centroid
 *   - "mip_frontal"    full-depth frontal (coronal) MIP — a cheap scout
 *
 * Split in two layers so the geometry is unit-testable in jsdom:
 *   buildAiViews(vol)            — pure typed-array math, no DOM
 *   viewsToAiPayload(views, ...) — browser-only PNG encoding via <canvas>
 *
 * Output images are 8-bit windowed grayscale, capped at ~1024 px on the long
 * edge. View labels are STABLE — the AI references them in findings.view_refs
 * and the findings panel resolves them back to the rendered images.
 */
import { detectDentalArch, findDentitionSlab } from '@/lib/autoArch';
import { generatePanoramic } from '@/lib/curvedMpr';

export const MAX_EDGE_DEFAULT = 1024;

/** Robust display window (1st–99th percentile) from raw scalar data. */
export function robustRange(scalarData) {
  if (!scalarData || !scalarData.length) return null;
  const stride = Math.max(1, Math.floor(scalarData.length / 250000));
  const sample = [];
  for (let i = 0; i < scalarData.length; i += stride) sample.push(scalarData[i]);
  sample.sort((a, b) => a - b);
  const n = sample.length;
  let lower = sample[Math.floor(n * 0.01)];
  let upper = sample[Math.floor(n * 0.99)];
  if (!(upper > lower)) { lower = sample[0]; upper = sample[n - 1]; }
  return upper > lower ? { lower, upper } : null;
}

/** Window a Float32 image to 8-bit grayscale (NaN / out-of-volume → 0). */
export function toUint8Gray(img, lower, upper) {
  const { width, height, data } = img;
  const span = upper > lower ? upper - lower : 1;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    out[i] = Number.isFinite(v)
      ? Math.max(0, Math.min(255, Math.round(((v - lower) / span) * 255)))
      : 0;
  }
  return out;
}

/** Nearest-neighbour downsample so max(width, height) <= maxEdge. */
export function downsampleToMaxEdge(img, maxEdge = MAX_EDGE_DEFAULT) {
  const { width, height, data } = img;
  const edge = Math.max(width, height);
  if (edge <= maxEdge) return img;
  const f = maxEdge / edge;
  const w = Math.max(1, Math.round(width * f));
  const h = Math.max(1, Math.round(height * f));
  const out = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    const sr = Math.min(height - 1, Math.round(r / f));
    for (let c = 0; c < w; c++) {
      const sc = Math.min(width - 1, Math.round(c / f));
      out[r * w + c] = data[sr * width + sc];
    }
  }
  return { ...img, width: w, height: h, data: out };
}

// ── slab extractors (pure typed-array MIPs) ─────────────────────────────────

/** Thin axial MIP slab centred on z index `zc`. Image rows = j, cols = i. */
export function extractAxialSlab(vol, zc, halfSlices = 2) {
  const [nx, ny, nz] = vol.dimensions;
  const { scalarData } = vol;
  const z0 = Math.max(0, zc - halfSlices);
  const z1 = Math.min(nz - 1, zc + halfSlices);
  const data = new Float32Array(nx * ny).fill(-Infinity);
  const sxy = nx * ny;
  for (let z = z0; z <= z1; z++) {
    const base = z * sxy;
    for (let i = 0; i < sxy; i++) {
      const v = scalarData[base + i];
      if (v > data[i]) data[i] = v;
    }
  }
  return { width: nx, height: ny, data };
}

/**
 * Thin coronal MIP slab centred on j index `yc` (or full-depth MIP when
 * halfSlices is Infinity). Rows = k flipped so row 0 is the volume's last
 * slice (superior for a standard inferior→superior k axis), cols = i.
 */
export function extractCoronalSlab(vol, yc, halfSlices = 3) {
  const [nx, ny, nz] = vol.dimensions;
  const { scalarData } = vol;
  const full = !Number.isFinite(halfSlices);
  const y0 = full ? 0 : Math.max(0, yc - halfSlices);
  const y1 = full ? ny - 1 : Math.min(ny - 1, yc + halfSlices);
  const data = new Float32Array(nx * nz).fill(-Infinity);
  const sxy = nx * ny;
  for (let z = 0; z < nz; z++) {
    const r = nz - 1 - z;
    const rowOut = r * nx;
    const zBase = z * sxy;
    for (let y = y0; y <= y1; y++) {
      const rowIn = zBase + y * nx;
      for (let x = 0; x < nx; x++) {
        const v = scalarData[rowIn + x];
        if (v > data[rowOut + x]) data[rowOut + x] = v;
      }
    }
  }
  return { width: nx, height: nz, data };
}

/** Thin sagittal MIP slab centred on i index `xc`. Rows = k flipped, cols = j. */
export function extractSagittalSlab(vol, xc, halfSlices = 3) {
  const [nx, ny, nz] = vol.dimensions;
  const { scalarData } = vol;
  const x0 = Math.max(0, xc - halfSlices);
  const x1 = Math.min(nx - 1, xc + halfSlices);
  const data = new Float32Array(ny * nz).fill(-Infinity);
  const sxy = nx * ny;
  for (let z = 0; z < nz; z++) {
    const r = nz - 1 - z;
    const rowOut = r * ny;
    const zBase = z * sxy;
    for (let y = 0; y < ny; y++) {
      const rowIn = zBase + y * nx;
      let best = -Infinity;
      for (let x = x0; x <= x1; x++) {
        const v = scalarData[rowIn + x];
        if (v > best) best = v;
      }
      data[rowOut + y] = best;
    }
  }
  return { width: ny, height: nz, data };
}

// ── main pure builder ───────────────────────────────────────────────────────

/**
 * Build the deterministic AI view set as Float32 images (pure, no DOM).
 *
 * @param {Object} vol  { dimensions, spacing, origin, direction, scalarData }
 * @param {Object} [options]
 * @param {number[][]} [options.archPointsWorld] traced/saved arch — skips auto-detect
 * @param {number[]}   [options.verticalAxis]    axial viewPlaneNormal for the OPG
 * @param {{lower:number,upper:number}} [options.range] display window override
 * @param {number} [options.axialCount]  axial slab levels (default 4, clamped 3–5)
 * @param {number} [options.maxEdge]     long-edge cap (default 1024)
 * @returns {{ views: Array<{label:string,width:number,height:number,data:Float32Array}>,
 *             range: {lower:number,upper:number},
 *             meta: { archSource: 'provided'|'auto'|null, zLevels:number[], slab:Object|null } }}
 */
export function buildAiViews(vol, options = {}) {
  const { dimensions, spacing, origin, direction, scalarData } = vol || {};
  if (!dimensions || !spacing || !origin || !direction || !scalarData) {
    throw new Error('Volume geometry/voxel data unavailable for AI view capture');
  }
  const [nx, ny, nz] = dimensions;
  const maxEdge = options.maxEdge || MAX_EDGE_DEFAULT;
  const axialCount = Math.max(3, Math.min(5, options.axialCount || 4));
  const range = options.range || robustRange(scalarData);
  if (!range) throw new Error('Volume has no intensity contrast for AI view capture');

  const views = [];
  const push = (label, img) => views.push({ label, ...downsampleToMaxEdge(img, maxEdge) });

  // Dentition slab — drives the axial levels; mid-volume band as fallback.
  let slab = null;
  try { slab = findDentitionSlab(vol); } catch (_) { /* uniform / unusual volume */ }
  const zMid = Math.floor(nz / 2);
  const zLo = slab ? Math.max(0, slab.z0 - (slab.peakZ - slab.z0)) : Math.max(0, zMid - Math.floor(nz / 6));
  const zHi = slab ? Math.min(nz - 1, slab.z1 + (slab.z1 - slab.peakZ)) : Math.min(nz - 1, zMid + Math.floor(nz / 6));

  // Arch: prefer the clinician's traced/saved points; else auto-detect.
  let archPoints = null;
  let archSource = null;
  let centroid = null;
  if (Array.isArray(options.archPointsWorld) && options.archPointsWorld.length >= 3) {
    archPoints = options.archPointsWorld;
    archSource = 'provided';
  } else {
    try {
      const det = detectDentalArch(vol);
      archPoints = det.pointsWorld;
      centroid = det.centroid; // [ix, iy, iz] index coords
      archSource = 'auto';
    } catch (_) { /* panoramic skipped; planar views still produced */ }
  }

  // (a) Panoramic via the existing curved-MPR generator.
  if (archPoints) {
    try {
      const pano = generatePanoramic(vol, archPoints, {
        verticalAxis: options.verticalAxis || null,
        maxColumns: maxEdge,
        maxRows: 768,
      });
      push('panoramic', pano);
    } catch (_) { archSource = null; }
  } else {
    archSource = null;
  }

  // (b) Axial slabs spread through the dentition (crowns → roots).
  const zLevels = [];
  for (let i = 0; i < axialCount; i++) {
    const z = Math.round(zLo + ((zHi - zLo) * i) / (axialCount - 1));
    zLevels.push(z);
    push(`axial_${i + 1}`, extractAxialSlab(vol, z, 2));
  }

  // (c) Coronal + sagittal mid-dentition slabs (through the dental centroid
  //     when auto-arch found one, else the volume centre).
  const yc = centroid ? Math.round(centroid[1]) : Math.floor(ny / 2);
  const xc = centroid ? Math.round(centroid[0]) : Math.floor(nx / 2);
  push('coronal_mid', extractCoronalSlab(vol, Math.max(0, Math.min(ny - 1, yc)), 3));
  push('sagittal_mid', extractSagittalSlab(vol, Math.max(0, Math.min(nx - 1, xc)), 3));

  // (d) Cheap frontal MIP scout (full depth across j).
  push('mip_frontal', extractCoronalSlab(vol, 0, Infinity));

  return { views, range, meta: { archSource, zLevels, slab } };
}

// ── browser-only PNG encoding ───────────────────────────────────────────────

/** Render one Float32 view to a PNG data URL via <canvas>. Null when no 2D ctx. */
export function viewToPngDataUrl(view, lower, upper) {
  const { width, height } = view;
  if (!width || !height || typeof document === 'undefined') return null;
  const gray = toUint8Gray(view, lower, upper);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gray.length; i++) {
    const g = gray[i];
    const o = i * 4;
    rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imgData = ctx.createImageData(width, height);
  imgData.data.set(rgba);
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Encode built views into the ai-read-cbct payload:
 *   [{ label, data: <base64 PNG, no data-URL prefix>, mediaType: 'image/png' }]
 * Views that fail to encode (no canvas) are skipped.
 */
export function viewsToAiPayload(views, range) {
  const images = [];
  for (const view of views) {
    const url = viewToPngDataUrl(view, range.lower, range.upper);
    if (!url) continue;
    images.push({ label: view.label, data: url.split(',')[1], mediaType: 'image/png' });
  }
  return images;
}

/**
 * Convenience for the viewer: build views AND encode them.
 * @returns {{ images: Array, viewUrls: Record<string,string>, meta: Object }}
 */
export function generateCbctAiViews(vol, options = {}) {
  const { views, range, meta } = buildAiViews(vol, options);
  const images = [];
  const viewUrls = {};
  for (const view of views) {
    const url = viewToPngDataUrl(view, range.lower, range.upper);
    if (!url) continue;
    viewUrls[view.label] = url;
    images.push({ label: view.label, data: url.split(',')[1], mediaType: 'image/png' });
  }
  return { images, viewUrls, meta };
}
