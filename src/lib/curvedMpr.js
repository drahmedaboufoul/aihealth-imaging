/*
 * curvedMpr — client-side curved-MPR panoramic (OPG) reconstruction for CBCT.
 *
 * Given the dental arch traced on the axial pane (>= 3 control points in
 * volume WORLD coordinates), reconstructs a panoramic strip by:
 *   1. fitting an OPEN Catmull-Rom spline through the control points,
 *   2. arc-length resampling it into uniform columns,
 *   3. for each column, projecting a slab PERPENDICULAR to the curve
 *      (in the axial plane) through the full vertical extent of the volume,
 *      collapsed with MIP (or average) — i.e. a classic curved MPR.
 *
 * Pure math/typed-array code: no DOM, no WebGL, no cornerstone imports —
 * unit-testable in jsdom and fast enough off the main thread (the viewer's
 * full-quality path asks for ~1600 columns via cbctComputeTasks and runs in
 * the compute worker; the library defaults cap at 1024x768 cols/rows with an
 * adaptive ~4-8mm slab, nearest-neighbour sampling).
 *
 * Coordinate conventions match @cornerstonejs/core ImageVolume:
 *   dimensions [nx,ny,nz], spacing [sx,sy,sz], origin [x,y,z] (world),
 *   direction: 9 numbers = world unit vectors of the i, j, k voxel axes
 *   in order [ix,iy,iz, jx,jy,jz, kx,ky,kz].
 */

// ── small vec3 helpers (plain arrays, no deps) ──────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a) => Math.sqrt(dot(a, a));
const normalize = (a) => {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
};

/**
 * Sanitize a manually traced arch into an OPEN polyline:
 *   - drop consecutive (near-)duplicate points — a double-click finish can
 *     stamp the last point twice;
 *   - drop trailing points that coincide with the FIRST point — a "closed"
 *     trace (loop) wrecks the panoramic, the spline must never be a loop.
 * Returns a new array; never mutates the input.
 *
 * @param {number[][]} points  world control points [x,y,z]
 * @param {Object} [options]
 * @param {number} [options.minGapMm]  consecutive points closer than this merge (default 0.75)
 * @returns {number[][]} open, deduplicated control points
 */
export function sanitizeArchPoints(points, options = {}) {
  if (!Array.isArray(points)) return [];
  const { minGapMm = 0.75 } = options;
  const out = [];
  for (const p of points) {
    if (!Array.isArray(p) && !ArrayBuffer.isView(p)) continue;
    const q = [p[0], p[1], p[2] ?? 0];
    if (!q.every(Number.isFinite)) continue;
    const prev = out[out.length - 1];
    if (prev && len(sub(q, prev)) < minGapMm) continue; // consecutive duplicate
    out.push(q);
  }
  // Un-close the loop: trailing points that return to the start are the
  // "connect last dot to first dot" artifact, not anatomy.
  while (out.length > 2 && len(sub(out[out.length - 1], out[0])) < minGapMm) out.pop();
  return out;
}

/**
 * Robust display window from an image's own finite, NON-BACKGROUND samples
 * (percentiles). A MIP panoramic is dominated by bone/enamel values, so
 * windowing it with the full-volume range (mostly air/soft tissue) washes it
 * out — window it to its own distribution instead. CBCT voxel values are NOT
 * calibrated HU (any fixed window is wrong), so everything is derived from the
 * data:
 *   1. sample the image's finite pixels (NaN = outside the volume is skipped);
 *   2. reject the BACKGROUND (air) peak — everything below a small fraction of
 *      the robust value range. Air pockets above the sinus / outside the ramus
 *      drag the low percentile down and flatten the strip to gray mush;
 *   3. take robust percentiles (default p2 / p99.5) of what remains — a
 *      data-derived bone window for the strip.
 * The returned window also carries a gentle display gamma (<1 brightens the
 * mid-tones so dentition pops out of the dark soft-tissue floor); callers that
 * only read lower/upper are unaffected.
 *
 * @param {{ data: Float32Array|number[] }} img
 * @param {number} [lowQ]  lower percentile (default 0.02)
 * @param {number} [highQ] upper percentile (default 0.995)
 * @param {Object} [options]
 * @param {number} [options.gamma] display gamma to report (default 0.88)
 * @param {number} [options.backgroundFraction] pixels below
 *        lo + backgroundFraction*(hi-lo) count as background (default 0.06)
 * @returns {{ lower:number, upper:number, gamma:number }|null} null when not computable
 */
export function computeImageWindow(img, lowQ = 0.02, highQ = 0.995, options = {}) {
  const { gamma = 0.88, backgroundFraction = 0.06 } = options;
  const data = img?.data;
  if (!data || !data.length) return null;
  const stride = Math.max(1, Math.floor(data.length / 200000));
  let sample = [];
  for (let i = 0; i < data.length; i += stride) {
    const v = data[i];
    if (Number.isFinite(v)) sample.push(v);
  }
  if (sample.length < 16) return null;
  sample.sort((a, b) => a - b);
  // Background (air) rejection: drop everything below a small fraction of the
  // robust value range — but only when enough foreground survives, so flat or
  // background-free images keep their full distribution.
  const lo0 = sample[0];
  const hi0 = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.999))];
  if (hi0 > lo0) {
    const bgCut = lo0 + (hi0 - lo0) * backgroundFraction;
    let first = 0;
    while (first < sample.length && sample[first] <= bgCut) first++;
    if (first > 0 && sample.length - first >= 64) sample = sample.slice(first);
  }
  const lower = sample[Math.floor(sample.length * lowQ)];
  const upper = sample[Math.min(sample.length - 1, Math.floor(sample.length * highQ))];
  if (!(upper > lower)) return null;
  return { lower, upper, gamma };
}

/**
 * Force a candidate vertical (row) axis to point SUPERIOR.
 *
 * The panoramic puts row 0 at the most-positive end of the vertical axis, so
 * that axis MUST point superior for the standard OPG presentation (maxilla on
 * top, mandible at bottom). Neither candidate the callers have is guaranteed
 * to do so: cornerstone's stock AXIAL camera viewPlaneNormal is [0,0,-1]
 * (pointing INFERIOR), and server-converted NIfTI volumes can carry a k axis
 * pointing either way — the previous code hard-coded the "k points superior"
 * DICOM assumption, which rendered those panoramics upside down (same class
 * of bug as the anterior/posterior flip fixed in autoArch.anteriorJSign).
 *
 * The world frame is LPS (cornerstone), so superior = +Z: derive the sign
 * from the axis' world Z component instead of assuming it. Axes with no
 * meaningful Z component (not a vertical axis at all) are returned unchanged.
 *
 * @param {number[]} axis  candidate vertical world axis
 * @returns {number[]} unit axis flipped (if needed) to point superior (+Z LPS)
 */
export function superiorVerticalAxis(axis) {
  const a = normalize(axis || []);
  if (len(a) === 0) return [0, 0, 1];
  return a[2] < 0 ? scale(a, -1) : a;
}

// Catmull-Rom interpolation between p1 and p2 (p0/p3 are neighbours).
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = 0.5 * (
      2 * p1[i] +
      (-p0[i] + p2[i]) * t +
      (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
      (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3
    );
  }
  return out;
}

/**
 * Open Catmull-Rom spline through ALL control points (endpoints clamped by
 * duplication), densely sampled then arc-length resampled to uniform spacing.
 *
 * @param {number[][]} controlPoints  >= 2 world points [x,y,z]
 * @param {number} sampleSpacing      desired distance between samples (mm)
 * @param {number} [maxSamples]      cap on returned samples (spacing grows to fit)
 * @param {Object} [options]
 * @param {number} [options.exactSamples] when >= 2, return EXACTLY this many
 *        uniform arc-length samples (spacing = length/(n-1)), ignoring
 *        sampleSpacing/maxSamples. Used to map the arch to a fixed strip width.
 * @returns {{ positions: number[][], tangents: number[][], length: number, spacing: number }}
 */
export function sampleArchCurve(controlPoints, sampleSpacing, maxSamples = 4096, options = {}) {
  if (!Array.isArray(controlPoints) || controlPoints.length < 2) {
    throw new Error('Arch curve needs at least 2 control points');
  }
  const cps = controlPoints.map((p) => [p[0], p[1], p[2]]);
  // Clamp the open ends: duplicate first/last so the spline passes through them.
  const ext = [cps[0], ...cps, cps[cps.length - 1]];

  // Dense pass — enough subdivisions that arc-length resampling is accurate.
  const DENSE_PER_SEG = 32;
  const dense = [];
  for (let s = 0; s < ext.length - 3; s++) {
    for (let d = 0; d < DENSE_PER_SEG; d++) {
      dense.push(catmullRom(ext[s], ext[s + 1], ext[s + 2], ext[s + 3], d / DENSE_PER_SEG));
    }
  }
  dense.push(cps[cps.length - 1]);

  // Cumulative arc length.
  const cum = new Float64Array(dense.length);
  for (let i = 1; i < dense.length; i++) {
    cum[i] = cum[i - 1] + len(sub(dense[i], dense[i - 1]));
  }
  const total = cum[dense.length - 1];
  if (!(total > 0)) throw new Error('Arch curve has zero length');

  const { exactSamples = 0 } = options;
  let spacing;
  let n;
  if (exactSamples && exactSamples >= 2) {
    // Stretch/resample the curve to an EXACT column count regardless of its
    // arc length — guarantees the panoramic strip spans the full output width.
    n = Math.floor(exactSamples);
    spacing = total / (n - 1);
  } else {
    spacing = Math.max(sampleSpacing, 1e-6);
    n = Math.floor(total / spacing) + 1;
    if (n > maxSamples) { n = maxSamples; spacing = total / (n - 1); }
    if (n < 2) { n = 2; spacing = total; }
  }

  const positions = [];
  const tangents = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const target = Math.min(i * spacing, total);
    while (k < dense.length - 2 && cum[k + 1] < target) k++;
    const segLen = cum[k + 1] - cum[k];
    const f = segLen > 0 ? (target - cum[k]) / segLen : 0;
    positions.push(add(dense[k], scale(sub(dense[k + 1], dense[k]), f)));
    tangents.push(normalize(sub(dense[k + 1], dense[k])));
  }
  return { positions, tangents, length: total, spacing };
}

/**
 * Curved-MPR panoramic reconstruction along a traced arch.
 *
 * @param {Object} vol  volume-like: { dimensions, spacing, origin, direction, scalarData }
 * @param {number[][]} archPointsWorld  >= 3 control points (world, on the axial slice)
 * @param {Object} [options]
 * @param {number[]} [options.verticalAxis]   world unit vector for image rows
 *                                            (default: the volume k axis, i.e. axial normal).
 *                                            The SIGN is derived, not trusted: the axis is
 *                                            forced superior (+Z LPS) so row 0 = maxilla.
 * @param {number}  [options.slabThicknessMm] perpendicular slab depth (mm).
 *        Default: ADAPTIVE to voxel spacing — clamp(16·minSpacing, 4…8) mm. A
 *        fixed thick slab (the old 20mm) MIPs spine/ghost anatomy into the
 *        strip and flattens contrast; ~4–8mm stays a tooth-thick slab.
 * @param {'mip'|'mean'} [options.projection] slab collapse (default 'mip')
 * @param {number}  [options.maxColumns]      default 1024
 * @param {number}  [options.maxRows]         default 768
 * @param {number}  [options.maxSlabSamples]  default 21
 * @param {number}  [options.columns]         EXACT strip width (default maxColumns).
 *        The arch arc length is resampled to this many columns so the strip
 *        always spans edge-to-edge — there are never unpainted columns.
 * @param {number}  [options.vertAboveMm]     vertical window above the occlusal
 *        plane (superior), default 50 — maxillary roots up through the sinus
 *        floor. Tightens the strip to the dentition/jaw region instead of the
 *        full volume height.
 * @param {number}  [options.vertBelowMm]     vertical window below the occlusal
 *        plane (inferior), default 55 — mandibular roots down past the
 *        inferior border.
 * @returns {{ width, height, data: Float32Array, colSpacing, rowSpacing }}
 *          data is row-major, row 0 = most-superior; misses are NaN. Pixels
 *          are SQUARE (rowSpacing == colSpacing) unless maxRows forces a
 *          coarser row pitch, so the strip's aspect matches the anatomy.
 */
export function generatePanoramic(vol, archPointsWorld, options = {}) {
  const { dimensions, spacing, origin, direction, scalarData } = vol || {};
  if (!dimensions || !spacing || !origin || !direction || !scalarData) {
    throw new Error('Volume geometry/voxel data unavailable');
  }
  if (!Array.isArray(archPointsWorld) || archPointsWorld.length < 3) {
    throw new Error('Trace at least 3 arch points first');
  }
  // Defensive: the arch must be an OPEN curve — strip duplicate / loop-closing
  // points a finished manual trace may carry.
  const archPoints = sanitizeArchPoints(archPointsWorld);
  if (archPoints.length < 3) throw new Error('Trace at least 3 distinct arch points first');
  const {
    verticalAxis = null,
    slabThicknessMm = null,
    projection = 'mip',
    maxColumns = 1024,
    maxRows = 768,
    maxSlabSamples = 21,
    columns = null,
    vertAboveMm = 50,
    vertBelowMm = 55,
  } = options;
  // Exact strip width: map the arch arc length onto this many columns so the
  // panoramic always fills the canvas (no black band where a short curve would
  // otherwise leave columns unpainted).
  const outputColumns = Math.max(2, Math.round(columns || maxColumns));

  const [nx, ny, nz] = dimensions;
  const iAxis = normalize([direction[0], direction[1], direction[2]]);
  const jAxis = normalize([direction[3], direction[4], direction[5]]);
  const kAxis = normalize([direction[6], direction[7], direction[8]]);

  // Vertical (row) direction: caller may pass the axial viewPlaneNormal;
  // fall back to the volume's k axis. Either way it's the slice-stack axis —
  // but its SIGN is not trustworthy (camera normals point inferior, NIfTI k
  // axes point either way), so derive it from the world frame: force the axis
  // superior (+Z in LPS) so row 0 is always the maxilla (standard OPG).
  let vAxis = normalize(verticalAxis || kAxis);
  if (len(vAxis) === 0) vAxis = kAxis;
  vAxis = superiorVerticalAxis(vAxis);

  const minSpacing = Math.min(spacing[0], spacing[1], spacing[2]);
  // Slab thickness: adaptive to voxel spacing unless the caller fixed it —
  // ~16 voxels deep, clamped to a tooth-scale 4–8mm window.
  const slabMm = Number.isFinite(slabThicknessMm) && slabThicknessMm > 0
    ? slabThicknessMm
    : Math.min(8, Math.max(4, minSpacing * 16));

  // Columns: resample the arch to EXACTLY outputColumns uniform arc-length
  // samples — the strip spans the full output width whatever the curve length.
  const curve = sampleArchCurve(archPoints, minSpacing, outputColumns, {
    exactSamples: outputColumns,
  });
  const { positions, tangents } = curve;
  const width = positions.length;

  // Vertical window. Start from the full volume extent projected onto vAxis…
  const ref = positions[Math.floor(width / 2)];
  let volTMin = Infinity;
  let volTMax = -Infinity;
  for (let cz = 0; cz < 2; cz++) {
    for (let cy = 0; cy < 2; cy++) {
      for (let cx = 0; cx < 2; cx++) {
        const corner = add(
          add(origin, scale(iAxis, cx * (nx - 1) * spacing[0])),
          add(scale(jAxis, cy * (ny - 1) * spacing[1]), scale(kAxis, cz * (nz - 1) * spacing[2]))
        );
        const t = dot(sub(corner, ref), vAxis);
        if (t < volTMin) volTMin = t;
        if (t > volTMax) volTMax = t;
      }
    }
  }
  // …then tighten to the dentition/jaw region: the occlusal plane (the mean
  // height of the arch control points, which lie on the traced slab) ± a jaw
  // window. This drops the empty space above the maxilla so the teeth fill more
  // of the strip. Clamp to the volume so we never sample outside it.
  let accT = 0;
  for (const p of archPoints) accT += dot(sub(p, ref), vAxis);
  const occlusalT = archPoints.length ? accT / archPoints.length : 0;
  let tMax = Math.min(volTMax, occlusalT + vertAboveMm);
  let tMin = Math.max(volTMin, occlusalT - vertBelowMm);
  if (!(tMax - tMin > 1e-3)) { tMax = volTMax; tMin = volTMin; }
  // Rows: SQUARE pixels — the row pitch matches the column (arc) pitch so the
  // strip's pixel aspect equals its physical mm aspect. The old fixed
  // rowSpacing=minSpacing squashed the anatomy: 1024 columns over a ~130mm
  // arch is ~0.13mm/px horizontally vs 0.3–0.5mm/px vertically, a 3–4×
  // vertical squish once drawn with square screen pixels. maxRows stays as a
  // safety valve only (a degenerate ultra-short arch would explode the rows).
  let rowSpacing = curve.spacing > 0 ? curve.spacing : minSpacing;
  let height = Math.floor((tMax - tMin) / rowSpacing) + 1;
  if (height > maxRows) { height = maxRows; rowSpacing = (tMax - tMin) / (height - 1); }
  if (height < 2) height = 2;

  // Slab: samples perpendicular to the curve, centred on it.
  let slabN = Math.floor(slabMm / minSpacing) + 1;
  if (slabN > maxSlabSamples) slabN = maxSlabSamples;
  if (slabN < 1) slabN = 1;
  if (slabN % 2 === 0) slabN += 1; // keep it centred
  const slabStep = slabN > 1 ? slabMm / (slabN - 1) : 0;

  // Precompute index-space conversion (orthonormal direction => dot products).
  const sx = spacing[0];
  const sy = spacing[1];
  const sz = spacing[2];
  const out = new Float32Array(width * height);
  const isMip = projection !== 'mean';

  for (let c = 0; c < width; c++) {
    const p = positions[c];
    const tan = tangents[c];
    // In-plane normal: perpendicular to both the vertical axis and the curve.
    let nrm = normalize(cross(vAxis, tan));
    if (len(nrm) === 0) nrm = normalize(cross(kAxis, tan));

    for (let r = 0; r < height; r++) {
      // Row 0 = top of the image = most-positive along vAxis. vAxis is forced
      // superior above, so the top row is ALWAYS the most-superior anatomy
      // (maxilla on top, mandible at bottom) for both DICOM and NIfTI volumes.
      const tOff = tMax - r * rowSpacing;
      const bx = p[0] + vAxis[0] * tOff;
      const by = p[1] + vAxis[1] * tOff;
      const bz = p[2] + vAxis[2] * tOff;

      let acc = isMip ? -Infinity : 0;
      let count = 0;
      for (let s = 0; s < slabN; s++) {
        const off = slabN > 1 ? s * slabStep - slabMm / 2 : 0;
        const wx = bx + nrm[0] * off;
        const wy = by + nrm[1] * off;
        const wz = bz + nrm[2] * off;
        // world -> index (orthonormal axes)
        const dx = wx - origin[0];
        const dy = wy - origin[1];
        const dz = wz - origin[2];
        const xi = Math.round((dx * iAxis[0] + dy * iAxis[1] + dz * iAxis[2]) / sx);
        if (xi < 0 || xi >= nx) continue;
        const yi = Math.round((dx * jAxis[0] + dy * jAxis[1] + dz * jAxis[2]) / sy);
        if (yi < 0 || yi >= ny) continue;
        const zi = Math.round((dx * kAxis[0] + dy * kAxis[1] + dz * kAxis[2]) / sz);
        if (zi < 0 || zi >= nz) continue;
        const v = scalarData[xi + yi * nx + zi * nx * ny];
        if (isMip) { if (v > acc) acc = v; } else { acc += v; }
        count++;
      }
      out[r * width + c] = count === 0 ? NaN : (isMip ? acc : acc / count);
    }
  }

  return { width, height, data: out, colSpacing: curve.spacing, rowSpacing };
}

/**
 * Cross-sections perpendicular to the arch — the dental "cross-sections" panel.
 * At `count` evenly arc-spaced positions along the arch, cut a slice in the
 * plane spanned by the in-plane normal (buccal-lingual) and the vertical axis
 * (superior-inferior). Each image is `widthMm` wide x the volume's vertical
 * extent tall, sampled nearest-neighbour. Returns an array of {data,width,height}.
 *
 * @param {Object} vol  { dimensions, spacing, origin, direction, scalarData }
 * @param {number[][]} archPointsWorld  >= 3 control points (world)
 * @param {Object} [options]
 * @param {number} [options.count]        number of cross-sections (default 12)
 * @param {number} [options.widthMm]      buccal-lingual width (default 30)
 * @param {number[]} [options.verticalAxis] superior-inferior world axis
 * @param {number} [options.maxDim]       cap per-section pixels (default 192)
 * @returns {{ sections: Array<{data:Float32Array,width:number,height:number,positionMm:number}>, spacing:number }}
 */
export function generateCrossSections(vol, archPointsWorld, options = {}) {
  const { dimensions, spacing, origin, direction, scalarData } = vol || {};
  if (!dimensions || !spacing || !origin || !direction || !scalarData) {
    throw new Error('Volume geometry/voxel data unavailable');
  }
  if (!Array.isArray(archPointsWorld) || archPointsWorld.length < 3) {
    throw new Error('Trace at least 3 arch points first');
  }
  const archPoints = sanitizeArchPoints(archPointsWorld);
  if (archPoints.length < 3) throw new Error('Trace at least 3 distinct arch points first');
  const { count = 12, widthMm = 30, verticalAxis = null, maxDim = 192 } = options;
  const [nx, ny, nz] = dimensions;
  const iAxis = normalize([direction[0], direction[1], direction[2]]);
  const jAxis = normalize([direction[3], direction[4], direction[5]]);
  const kAxis = normalize([direction[6], direction[7], direction[8]]);
  // Same superior-on-top convention as the panoramic (see superiorVerticalAxis).
  let vAxis = normalize(verticalAxis || kAxis);
  if (len(vAxis) === 0) vAxis = kAxis;
  vAxis = superiorVerticalAxis(vAxis);
  const minSpacing = Math.min(spacing[0], spacing[1], spacing[2]);

  const curve = sampleArchCurve(archPoints, minSpacing, 4096);
  const { positions, tangents } = curve;
  const N = positions.length;

  // Vertical extent of the volume projected on vAxis (same as the panoramic).
  const ref = positions[Math.floor(N / 2)];
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let cz = 0; cz < 2; cz++)
    for (let cy = 0; cy < 2; cy++)
      for (let cx = 0; cx < 2; cx++) {
        const corner = add(
          add(origin, scale(iAxis, cx * (nx - 1) * spacing[0])),
          add(scale(jAxis, cy * (ny - 1) * spacing[1]), scale(kAxis, cz * (nz - 1) * spacing[2]))
        );
        const t = dot(sub(corner, ref), vAxis);
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }

  let rowSpacing = minSpacing;
  let height = Math.floor((tMax - tMin) / rowSpacing) + 1;
  if (height > maxDim) { height = maxDim; rowSpacing = (tMax - tMin) / (height - 1); }
  if (height < 2) height = 2;

  let colSpacing = minSpacing;
  let width = Math.floor(widthMm / colSpacing) + 1;
  if (width > maxDim) { width = maxDim; colSpacing = widthMm / (width - 1); }
  if (width < 2) width = 2;

  const sx = spacing[0];
  const sy = spacing[1];
  const sz = spacing[2];
  const sections = [];
  for (let s = 0; s < count; s++) {
    const ci = Math.round(((s + 0.5) / count) * (N - 1));
    const p = positions[ci];
    const tan = tangents[ci];
    let nrm = normalize(cross(vAxis, tan));
    if (len(nrm) === 0) nrm = normalize(cross(kAxis, tan));

    const data = new Float32Array(width * height);
    for (let r = 0; r < height; r++) {
      const tOff = tMax - r * rowSpacing;
      const bx = p[0] + vAxis[0] * tOff;
      const by = p[1] + vAxis[1] * tOff;
      const bz = p[2] + vAxis[2] * tOff;
      for (let c = 0; c < width; c++) {
        const off = (c - (width - 1) / 2) * colSpacing;
        const wx = bx + nrm[0] * off;
        const wy = by + nrm[1] * off;
        const wz = bz + nrm[2] * off;
        const dx = wx - origin[0];
        const dy = wy - origin[1];
        const dz = wz - origin[2];
        const xi = Math.round((dx * iAxis[0] + dy * iAxis[1] + dz * iAxis[2]) / sx);
        const yi = Math.round((dx * jAxis[0] + dy * jAxis[1] + dz * jAxis[2]) / sy);
        const zi = Math.round((dx * kAxis[0] + dy * kAxis[1] + dz * kAxis[2]) / sz);
        let v = NaN;
        if (xi >= 0 && xi < nx && yi >= 0 && yi < ny && zi >= 0 && zi < nz) {
          v = scalarData[xi + yi * nx + zi * nx * ny];
        }
        data[r * width + c] = v;
      }
    }
    sections.push({ data, width, height, positionMm: ci * curve.spacing });
  }
  return { sections, spacing: curve.spacing };
}

/**
 * Small separable unsharp mask for Float32 grayscale images ({ width, height,
 * data }, NaN = outside). A 2-pass (horizontal then vertical) NaN-aware box
 * blur approximates the Gaussian low-pass; the result is
 *
 *   out = v + amount · (v − blur)
 *
 * NaN pixels stay NaN and never bleed into the blur (skipped, not treated as
 * 0). Pure typed-array math — no DOM, safe inside the compute worker. Applied
 * to the panoramic BEFORE windowing so the enamel/PDL edges pop; the robust
 * percentile window absorbs the overshoot.
 *
 * @param {{ width:number, height:number, data:Float32Array }} img
 * @param {Object} [options]
 * @param {number} [options.radiusPx=2]  blur half-width in pixels
 * @param {number} [options.amount=0.6]  overshoot strength (0 disables)
 * @returns same-shape image with a NEW data buffer (input untouched)
 */
export function unsharpMaskImage(img, options = {}) {
  const { radiusPx = 2, amount = 0.6 } = options;
  const { width, height, data } = img || {};
  const r = Math.round(radiusPx);
  if (!width || !height || !data || r < 1 || !(amount > 0)) return img;
  // Pass 1: horizontal box blur (NaN-aware).
  const tmp = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      let sum = 0;
      let cnt = 0;
      for (let i = x0; i <= x1; i++) {
        const v = data[row + i];
        if (Number.isFinite(v)) { sum += v; cnt++; }
      }
      tmp[row + x] = cnt ? sum / cnt : NaN;
    }
  }
  // Pass 2: vertical box blur of the horizontal pass + the unsharp add.
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height - 1, y + r);
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const v = data[idx];
      if (!Number.isFinite(v)) { out[idx] = NaN; continue; }
      let sum = 0;
      let cnt = 0;
      for (let j = y0; j <= y1; j++) {
        const b = tmp[j * width + x];
        if (Number.isFinite(b)) { sum += b; cnt++; }
      }
      const blur = cnt ? sum / cnt : v;
      out[idx] = v + amount * (v - blur);
    }
  }
  return { ...img, data: out };
}

/**
 * Window a panoramic (Float32, NaN = outside volume) to opaque grayscale RGBA
 * for a canvas ImageData. NaN/out-of-range clamp to black. Optional display
 * gamma (<1 brightens mid-tones — pair with computeImageWindow().gamma).
 */
export function panoramicToRGBA(pano, lower, upper, gamma = 1) {
  const { width, height, data } = pano;
  const span = upper > lower ? upper - lower : 1;
  const useGamma = Number.isFinite(gamma) && gamma > 0 && gamma !== 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    let g = 0;
    if (Number.isFinite(v)) {
      let t = (v - lower) / span;
      t = t <= 0 ? 0 : t >= 1 ? 1 : t;
      if (useGamma) t = Math.pow(t, gamma);
      g = Math.round(t * 255);
    }
    const o = i * 4;
    rgba[o] = g;
    rgba[o + 1] = g;
    rgba[o + 2] = g;
    rgba[o + 3] = 255;
  }
  return rgba;
}
