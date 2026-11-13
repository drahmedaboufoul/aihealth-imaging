/*
 * cephProjection — synthetic lateral cephalogram from a CBCT volume.
 *
 * A lateral ceph is a parallel projection of the head along the patient's
 * LEFT-RIGHT axis onto the sagittal plane. We build it directly from the
 * loaded volume's voxels:
 *
 *   • find the world LEFT-RIGHT axis from the volume DIRECTION matrix (never
 *     hard-coded — this codebase had two orientation-sign bugs; the L-R axis
 *     is whichever of i/j/k is most aligned with world ±X / LPS-L),
 *   • the two in-plane axes become image COLUMNS (antero-posterior, A-P) and
 *     image ROWS (supero-inferior, S-I),
 *   • for every (col,row) cast a ray along the L-R axis through the volume and
 *     collapse it with MIP (crisp bone edges) or MEAN (film-like),
 *   • present in STANDARD orientation: patient faces RIGHT, maxilla UP. The
 *     column axis is oriented anterior→right; the row axis superior→top. The
 *     anterior/superior senses are derived from the direction matrix, so the
 *     ceph is never mirrored regardless of DICOM-vs-NIfTI load orientation.
 *
 * Pure math / typed arrays: no DOM, no cornerstone. Volume shape matches the
 * rest of the imaging stack:
 *   { dimensions [nx,ny,nz], spacing [sx,sy,sz], origin [x,y,z],
 *     direction (9 = world unit vectors of i,j,k), scalarData }.
 */

// ── vec3 helpers ────────────────────────────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a) => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

// The three voxel axes (unit world vectors) and their physical lengths.
function volAxes(vol) {
  const d = vol.direction;
  return {
    i: { unit: normalize([d[0], d[1], d[2]]), n: vol.dimensions[0], s: vol.spacing[0] },
    j: { unit: normalize([d[3], d[4], d[5]]), n: vol.dimensions[1], s: vol.spacing[1] },
    k: { unit: normalize([d[6], d[7], d[8]]), n: vol.dimensions[2], s: vol.spacing[2] },
  };
}

/**
 * Pick which voxel axis (i/j/k) is the patient LEFT-RIGHT direction, plus the
 * remaining two as antero-posterior (AP) and supero-inferior (SI).
 *
 * World frame is LPS (cornerstone): +X = patient LEFT, +Y = posterior,
 * +Z = superior. The L-R voxel axis is the one most aligned with world X; AP
 * is the one most aligned with world Y; SI the one most aligned with world Z.
 * Senses are recorded so the projection can be laid out un-mirrored:
 *   apSign  = +1 when increasing that axis moves POSTERIOR (so anterior is the
 *             low end); columns are written anterior→right by walking it down.
 *   siSign  = +1 when increasing that axis moves SUPERIOR; rows are written
 *             superior→top.
 *
 * @returns {{ lr, ap, si }} each { axis:'i'|'j'|'k', unit, n, s, sign }
 */
export function resolveCephAxes(vol) {
  const ax = volAxes(vol);
  const entries = [['i', ax.i], ['j', ax.j], ['k', ax.k]];
  const pick = (worldIdx, used) => {
    let best = null;
    let bestAbs = -1;
    for (const [key, a] of entries) {
      if (used.includes(key)) continue;
      const c = a.unit[worldIdx];
      if (Math.abs(c) > bestAbs) { bestAbs = Math.abs(c); best = { key, a, comp: c }; }
    }
    return best;
  };
  // L-R aligns with world X, AP with Y, SI with Z — assign greediest first by
  // absolute alignment so an oblique scan still partitions cleanly.
  const order = [0, 1, 2]
    .map((w) => ({ w, strength: Math.max(...entries.map(([, a]) => Math.abs(a.unit[w]))) }))
    .sort((p, q) => q.strength - p.strength)
    .map((o) => o.w);
  const used = [];
  const assigned = {};
  for (const w of order) {
    const p = pick(w, used);
    used.push(p.key);
    assigned[w] = p;
  }
  const lrP = assigned[0];
  const apP = assigned[1];
  const siP = assigned[2];
  return {
    lr: { axis: lrP.key, unit: lrP.a.unit, n: lrP.a.n, s: lrP.a.s },
    // apSign: +1 when increasing the axis moves POSTERIOR (world +Y).
    ap: { axis: apP.key, unit: apP.a.unit, n: apP.a.n, s: apP.a.s, sign: apP.comp >= 0 ? 1 : -1 },
    // siSign: +1 when increasing the axis moves SUPERIOR (world +Z).
    si: { axis: siP.key, unit: siP.a.unit, n: siP.a.n, s: siP.a.s, sign: siP.comp >= 0 ? 1 : -1 },
  };
}

// Read a voxel by per-axis index keyed to i/j/k.
function voxelAt(vol, idx) {
  const [nx, ny] = vol.dimensions;
  return vol.scalarData[idx.i + idx.j * nx + idx.k * nx * ny];
}

/**
 * Build a synthetic lateral cephalogram.
 *
 * @param {Object} vol  { dimensions, spacing, origin, direction, scalarData }
 * @param {Object} [options]
 *   projection : 'mip' | 'mean'   (default 'mip')
 *   longEdgePx : longest output edge target (default 1024)
 * @returns {{
 *   width, height, data: Float32Array,   // row-major; row 0 = superior
 *   colSpacingMm, rowSpacingMm,           // mm per pixel (true aspect ratio)
 *   axes,                                  // resolveCephAxes result
 *   // pixelToWorld(col,row) and worldToPixel([x,y,z]) — for landmark mapping.
 *   pixelToWorld, worldToPixel,
 * }}
 */
export function generateLateralCeph(vol, options = {}) {
  const { dimensions, spacing, origin, direction, scalarData } = vol || {};
  if (!dimensions || !spacing || !origin || !direction || !scalarData) {
    throw new Error('Volume geometry/voxel data unavailable');
  }
  const { projection = 'mip', longEdgePx = 1024 } = options;
  const isMip = projection !== 'mean';
  const axes = resolveCephAxes(vol);
  const { lr, ap, si } = axes;

  // Physical extents (mm) of the two in-plane axes.
  const apMm = (ap.n - 1) * ap.s;
  const siMm = (si.n - 1) * si.s;
  const longMm = Math.max(apMm, siMm);
  // Pixels-per-mm so the LONG physical edge maps to longEdgePx — keeps the true
  // mm aspect ratio (no patient distortion).
  const pxPerMm = longMm > 0 ? longEdgePx / longMm : 1;
  const colSpacingMm = 1 / pxPerMm;
  const rowSpacingMm = 1 / pxPerMm;
  const width = Math.max(2, Math.round(apMm * pxPerMm) + 1);
  const height = Math.max(2, Math.round(siMm * pxPerMm) + 1);

  // Standard ceph layout: patient faces RIGHT (anterior at the HIGH columns)
  // and maxilla UP (superior at row 0). So columns run POSTERIOR → ANTERIOR
  // and rows run SUPERIOR → INFERIOR.
  //
  // AP axis: apSign = +1 means increasing index → POSTERIOR, so the posterior
  // (left, col 0) end is the HIGH index and columns walk the index DOWN toward
  // anterior. apSign = −1 means increasing index → anterior, so col 0 = index 0
  // and columns walk the index UP.
  const apOriginIndex = ap.sign > 0 ? (ap.n - 1) : 0;
  const apIndexStep = ap.sign > 0 ? -1 : 1;
  // Rows: row 0 = superior (top). siSign = +1 means increasing index → superior,
  // so the top row is the HIGH index and rows walk the index downward.
  const siOriginIndex = si.sign > 0 ? (si.n - 1) : 0;
  const siIndexStep = si.sign > 0 ? -1 : 1;

  // Continuous index along an axis for a given mm offset from its index-0 corner.
  const apMmPerIndex = ap.s;
  const siMmPerIndex = si.s;

  const out = new Float32Array(width * height);
  const lrN = lr.n;
  const idx = { i: 0, j: 0, k: 0 };

  for (let r = 0; r < height; r++) {
    const siMmFromTop = r * rowSpacingMm; // 0 at top (superior)
    // top corresponds to siOriginIndex; step toward the other end.
    const siIndexF = siOriginIndex + siIndexStep * (siMmFromTop / siMmPerIndex);
    const siIndex = Math.round(siIndexF);
    if (siIndex < 0 || siIndex >= si.n) { /* leave NaN row */ }
    for (let c = 0; c < width; c++) {
      const apMmFromAnt = c * colSpacingMm;
      const apIndexF = apOriginIndex + apIndexStep * (apMmFromAnt / apMmPerIndex);
      const apIndex = Math.round(apIndexF);
      let acc = isMip ? -Infinity : 0;
      let count = 0;
      if (siIndex >= 0 && siIndex < si.n && apIndex >= 0 && apIndex < ap.n) {
        idx[si.axis] = siIndex;
        idx[ap.axis] = apIndex;
        for (let l = 0; l < lrN; l++) {
          idx[lr.axis] = l;
          const v = voxelAt(vol, idx);
          if (isMip) { if (v > acc) acc = v; } else { acc += v; }
          count++;
        }
      }
      out[r * width + c] = count === 0 ? NaN : (isMip ? acc : acc / count);
    }
  }

  // ── coordinate mapping (pixel ↔ world) ────────────────────────────────────
  // World of an [i,j,k] voxel index. Reused by both directions.
  const idxToWorld = (ii, jj, kk) => {
    const ix = ii * spacing[0];
    const iy = jj * spacing[1];
    const iz = kk * spacing[2];
    const d = direction;
    return [
      origin[0] + d[0] * ix + d[3] * iy + d[6] * iz,
      origin[1] + d[1] * ix + d[4] * iy + d[7] * iz,
      origin[2] + d[2] * ix + d[5] * iy + d[8] * iz,
    ];
  };

  // pixel → world: place the ray base at the L-R MID-plane (the lateral ceph is
  // a projection; landmarks placed on it live on the mid-sagittal plane).
  const lrMid = (lr.n - 1) / 2;
  function pixelToWorld(col, row) {
    const apIndexF = apOriginIndex + apIndexStep * ((col * colSpacingMm) / apMmPerIndex);
    const siIndexF = siOriginIndex + siIndexStep * ((row * rowSpacingMm) / siMmPerIndex);
    const idxv = { i: 0, j: 0, k: 0 };
    idxv[ap.axis] = apIndexF;
    idxv[si.axis] = siIndexF;
    idxv[lr.axis] = lrMid;
    return idxToWorld(idxv.i, idxv.j, idxv.k);
  }

  // world → pixel: project onto the AP/SI plane via the (orthonormal) axis dots.
  function worldToPixel(world) {
    const rel = sub(world, origin);
    // Continuous voxel index along ap/si = (rel · unit) / spacing.
    const apIndexF = dot(rel, ap.unit) / ap.s;
    const siIndexF = dot(rel, si.unit) / si.s;
    const apMmFromAnt = (apIndexF - apOriginIndex) * apIndexStep * apMmPerIndex;
    const siMmFromTop = (siIndexF - siOriginIndex) * siIndexStep * siMmPerIndex;
    return { col: apMmFromAnt / colSpacingMm, row: siMmFromTop / rowSpacingMm };
  }

  return {
    width, height, data: out,
    colSpacingMm, rowSpacingMm,
    axes, projection: isMip ? 'mip' : 'mean',
    pixelToWorld, worldToPixel,
  };
}

/**
 * FOV honesty: a small dento-alveolar CBCT often lacks the superior cranial
 * anatomy (Sella, Nasion, Porion/Orbitale) a classic ceph needs. Detect this
 * from the volume's SUPERO-INFERIOR physical extent — full cephalometric
 * landmarks require roughly the nasion-to-menton span (~110-130 mm); typical
 * 5x5 / 8x8 dental scans are far shorter.
 *
 * @returns {{ heightMm, isSmallFov, missingSuperior, note }}
 */
export function assessCephFov(vol) {
  const axes = resolveCephAxes(vol);
  const heightMm = (axes.si.n - 1) * axes.si.s;
  const apMm = (axes.ap.n - 1) * axes.ap.s;
  // Nasion sits ~95-110 mm above Menton; Sella higher still. Under ~95 mm of
  // vertical FOV the superior landmarks are almost certainly out of frame.
  const missingSuperior = heightMm < 95;
  const isSmallFov = heightMm < 95 || apMm < 90;
  let note = null;
  if (missingSuperior) {
    note = `Limited FOV: vertical extent ~${Math.round(heightMm)} mm. This dento-alveolar `
      + 'scan likely does NOT include the superior cranial landmarks (Sella, Nasion, '
      + 'Porion, Orbitale) required for a classic lateral ceph. Place only the landmarks '
      + 'visible in frame — Frankfort/SN-based measures may be unavailable.';
  } else if (isSmallFov) {
    note = `Limited antero-posterior FOV (~${Math.round(apMm)} mm) — some posterior or `
      + 'anterior landmarks may fall outside the image.';
  }
  return { heightMm, apMm, isSmallFov, missingSuperior, note };
}
