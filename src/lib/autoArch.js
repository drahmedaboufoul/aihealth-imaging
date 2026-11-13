/*
 * autoArch — automatic dental-arch detection for the CBCT panoramic (OPG).
 *
 * The manual arch trace is tedious ("the curve is pointless"), so this derives
 * the arch curve directly from the volume in ONE click:
 *
 *   1. Pick the axial slab around the dentition. Real head scans are NOT a
 *      centred phantom: the brightest / densest axial bands are usually the
 *      skull base or the cervical spine, NOT the teeth. So each axial slice is
 *      scored by its ENAMEL-bright voxels (top of the intensity range) that sit
 *      in the ANTERIOR band of that slice (within ~50 mm of the slice's own
 *      front-most bright structure), with posterior bright voxels (vertebrae,
 *      occiput, clivus) counted AGAINST it. The peak of that profile is the
 *      occlusal band.
 *   2. Threshold that slab to bone/enamel, collapse to a 2D occupancy map in
 *      the axial (i,j) plane, then HARD-REJECT everything more than
 *      ~60 mm posterior of the arch front — the cervical spine sits at the
 *      same axial level as the dentition and must never enter the fit.
 *   3. Fit a smooth arch through the remaining ridge: for angular sectors
 *      around a centre placed INSIDE the U of the arch, take the
 *      radially-outermost occupied voxel (the buccal/outer cortical edge),
 *      smooth, and resample into an ordered open curve.
 *   4. Validate the curve is a dental-arch-plausible U (wide enough, opening
 *      posteriorly, mid-point clearly anterior of the ends) and convert the
 *      (i,j) ridge points back to WORLD coordinates at the slab's centre slice
 *      — the same world control points the manual tracer produces, so they
 *      feed the existing generatePanoramic() unchanged.
 *
 * ORIENTATION: "anterior" is derived from the volume's direction matrix, NOT
 * assumed. DICOM axial volumes have jAxis ≈ +Y(LPS) (so anterior = decreasing
 * j); server-converted NIfTI volumes come through rasToLps with
 * jAxis ≈ −Y(LPS) (so anterior = INCREASING j). The previous implementation
 * hard-coded the DICOM convention, which pointed the whole angular sweep at
 * the posterior skull / cervical spine for NIfTI-loaded studies.
 *
 * Pure math / typed-array code: no DOM, no cornerstone imports. Operates on a
 * volume-like { dimensions, spacing, origin, direction, scalarData } and returns
 * world control points plus diagnostics. Downsamples in-plane so a ~500³ volume
 * stays well under a second on the main thread.
 *
 * Coordinate conventions match generatePanoramic()/cornerstone ImageVolume:
 *   dimensions [nx,ny,nz], spacing [sx,sy,sz], origin [x,y,z] (world),
 *   direction 9 numbers = world unit vectors of i,j,k voxel axes.
 */

const idxToWorld = (origin, iAxis, jAxis, kAxis, spacing, xi, yi, zi) => {
  const ix = xi * spacing[0];
  const iy = yi * spacing[1];
  const iz = zi * spacing[2];
  return [
    origin[0] + iAxis[0] * ix + jAxis[0] * iy + kAxis[0] * iz,
    origin[1] + iAxis[1] * ix + jAxis[1] * iy + kAxis[1] * iz,
    origin[2] + iAxis[2] * ix + jAxis[2] * iy + kAxis[2] * iz,
  ];
};

/**
 * Which way is the patient's ANTERIOR along the j (row) voxel axis?
 * World frame is LPS (cornerstone), so anterior = −Y. Returns +1 when
 * INCREASING j moves anterior (NIfTI rasToLps volumes), −1 when DECREASING j
 * moves anterior (classic DICOM axial). Falls back to the DICOM convention
 * when the j axis is too oblique to call.
 */
export function anteriorJSign(direction) {
  const jy = Array.isArray(direction) || ArrayBuffer.isView(direction) ? direction[4] : 1;
  if (!Number.isFinite(jy) || Math.abs(jy) < 0.5) return -1;
  return jy > 0 ? -1 : 1;
}

// Robust intensity stats from a strided sample of the volume.
function robustRange(scalarData, total) {
  const sample = [];
  const stride = Math.max(1, Math.floor(total / 200000));
  for (let i = 0; i < total; i += stride) sample.push(scalarData[i]);
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.5)];
  // 99.95th percentile: must reach ENAMEL (the brightest tissue, but a tiny
  // voxel fraction) — at 99.8 the reference topped out in dense cortical
  // bone/vertebra range and the enamel threshold lost its meaning.
  const hi = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.9995))];
  return { lo, hi };
}

/**
 * Find the axial slice band richest in DENTITION (enamel-bright, anterior)
 * voxels. Anterior-band weighting keeps the peak off the skull base and the
 * cervical spine on real (off-centre, neck-included) head scans.
 *
 * @returns {{ peakZ:number, z0:number, z1:number, threshold:number,
 *             enamelThreshold:number, lo:number, hi:number, antSign:number }}
 */
export function findDentitionSlab(vol, options = {}) {
  const { dimensions, spacing, direction, scalarData } = vol;
  const [nx, ny, nz] = dimensions;
  const {
    slabHalfSlices = 6,
    sampleStride = 2,
    // Dentition lives within ~50 mm of the slice's front-most bright structure.
    anteriorBandMm = 50,
    // Bright voxels further back than this are vertebra / posterior skull.
    posteriorRejectMm = 75,
  } = options;

  const total = nx * ny * nz;
  const { lo, hi } = robustRange(scalarData, total);
  // No intensity contrast (uniform volume) => no dentition to find.
  if (!(hi > lo)) throw new Error('Volume has no intensity contrast for arch detection');
  // Bone/cortical threshold (used for the arch occupancy fit) and a stricter
  // enamel-grade threshold (used to FIND the occlusal band — enamel is the
  // brightest tissue in the head, so it cannot be confused with skull base).
  const threshold = lo + (hi - lo) * 0.55;
  const enamelThreshold = lo + (hi - lo) * 0.72;

  const antSign = anteriorJSign(direction);
  const sy = (spacing && spacing[1]) || 1;
  const bandRows = anteriorBandMm / (sy * sampleStride);
  const rejectRows = posteriorRejectMm / (sy * sampleStride);

  const sxy = nx * ny;
  const histLen = Math.ceil(ny / sampleStride);
  const hist = new Int32Array(histLen);

  // Score one threshold pass; per slice: count bright voxels per row, anchor
  // the slice at its anterior-most bright row, reward the anterior band and
  // penalise far-posterior brightness.
  const scoreSlices = (thr) => {
    const scores = new Float64Array(nz);
    for (let z = 0; z < nz; z++) {
      hist.fill(0);
      const base = z * sxy;
      let any = false;
      for (let y = 0, h = 0; y < ny; y += sampleStride, h++) {
        const row = base + y * nx;
        let count = 0;
        for (let x = 0; x < nx; x += sampleStride) {
          if (scalarData[row + x] >= thr) count++;
        }
        if (count > 0) { hist[h] = count; any = true; }
      }
      if (!any) { scores[z] = 0; continue; }
      // Anterior-most bright row (in "anterior coordinate" a = antSign * h).
      let aFront = -Infinity;
      for (let h = 0; h < histLen; h++) {
        if (hist[h] > 0) {
          const a = antSign * h;
          if (a > aFront) aFront = a;
        }
      }
      let score = 0;
      for (let h = 0; h < histLen; h++) {
        if (!hist[h]) continue;
        const depth = aFront - antSign * h; // rows behind the front, >= 0
        if (depth <= bandRows) score += hist[h];
        else if (depth > rejectRows) score -= hist[h];
      }
      scores[z] = score;
    }
    return scores;
  };

  let scores = scoreSlices(enamelThreshold);
  let best = 0;
  for (let z = 0; z < nz; z++) if (scores[z] > best) best = scores[z];
  // Some scans (low-dose, no enamel in FOV) have nothing that bright — fall
  // back to the bone threshold, still anterior-weighted.
  if (best < 8) scores = scoreSlices(threshold);

  // Smooth the score profile and take the peak as the occlusal band.
  let peakZ = 0;
  let peakVal = -Infinity;
  const win = 3;
  for (let z = 0; z < nz; z++) {
    let acc = 0;
    let n = 0;
    for (let d = -win; d <= win; d++) {
      const zz = z + d;
      if (zz >= 0 && zz < nz) { acc += scores[zz]; n++; }
    }
    const v = acc / n;
    if (v > peakVal) { peakVal = v; peakZ = z; }
  }
  if (!(peakVal > 0)) throw new Error('No dentition-like axial band found (nothing bright and anterior)');

  const z0 = Math.max(0, peakZ - slabHalfSlices);
  const z1 = Math.min(nz - 1, peakZ + slabHalfSlices);
  return { peakZ, z0, z1, threshold, enamelThreshold, lo, hi, antSign };
}

/**
 * Auto-detect the dental arch control points (world coords) from the volume.
 *
 * @param {Object} vol  { dimensions, spacing, origin, direction, scalarData }
 * @param {Object} [options]
 * @param {number} [options.sectors]       angular ridge samples (default 64)
 * @param {number} [options.controlPoints] output control points (default 14)
 * @param {number} [options.downsample]    in-plane voxel stride (default auto)
 * @param {number} [options.archDepthMm]   max arch depth behind the front (default 60)
 * @returns {{ pointsWorld:number[][], pointsIndex:number[][], slab:Object,
 *             centroid:number[], antSign:number }}
 */
export function detectDentalArch(vol, options = {}) {
  const { dimensions, spacing, origin, direction, scalarData } = vol || {};
  if (!dimensions || !spacing || !origin || !direction || !scalarData) {
    throw new Error('Volume geometry/voxel data unavailable for auto-arch');
  }
  const [nx, ny] = dimensions;
  const iAxis = [direction[0], direction[1], direction[2]];
  const jAxis = [direction[3], direction[4], direction[5]];
  const kAxis = [direction[6], direction[7], direction[8]];

  const {
    sectors = 64,
    controlPoints = 14,
    archDepthMm = 60,
    // Posterior extension: a clinical OPG runs molar-to-ramus, but the anterior
    // fit is depth-capped (archDepthMm) to keep the cervical spine out. After
    // the anterior U is fitted we chase each end POSTERO-LATERALLY along the
    // bone mask up to this much extra depth behind the cap.
    posteriorExtendMm = 45,
    // Deep + within this distance of the arch midline ⇒ the cervical spine /
    // posterior midline; stop the extension rather than diving into it.
    spineGuardMm = 18,
    // Mask-snap search window for the tangential extension march.
    extendSearchMm = 4,
  } = options;
  // Downsample the in-plane grid so the occupancy pass is cheap on big volumes.
  const ds = options.downsample || Math.max(1, Math.round(Math.max(nx, ny) / 256));

  const slab = findDentitionSlab(vol, options);
  const { z0, z1, threshold, antSign } = slab;
  const sxy = nx * ny;
  const rowMm = spacing[1] * ds; // mm per occupancy-grid row
  const colMm = spacing[0] * ds; // mm per occupancy-grid column

  // Binary occupancy map over the slab (collapsed across z) on the downsampled
  // grid.
  const gw = Math.ceil(nx / ds);
  const gh = Math.ceil(ny / ds);
  const occ = new Uint8Array(gw * gh);
  const rowCount = new Int32Array(gh);
  for (let z = z0; z <= z1; z++) {
    const base = z * sxy;
    for (let y = 0; y < ny; y += ds) {
      const row = base + y * nx;
      const gy = (y / ds) | 0;
      for (let x = 0; x < nx; x += ds) {
        if (scalarData[row + x] >= threshold) {
          const gx = (x / ds) | 0;
          const o = gy * gw + gx;
          if (!occ[o]) { occ[o] = 1; rowCount[gy]++; }
        }
      }
    }
  }

  // Anterior anchor: the front-most occupied row (>= 2 cells to skip noise).
  let gyFront = NaN;
  let aFront = -Infinity;
  for (let pass = 0; pass < 2 && !Number.isFinite(gyFront); pass++) {
    const minCells = pass === 0 ? 2 : 1;
    for (let gy = 0; gy < gh; gy++) {
      if (rowCount[gy] >= minCells) {
        const a = antSign * gy;
        if (a > aFront) { aFront = a; gyFront = gy; }
      }
    }
  }
  if (!Number.isFinite(gyFront)) throw new Error('No dentition detected (threshold found no bright voxels)');

  // Keep the FULL (pre-reject) bone occupancy: the posterior-extension pass
  // below chases the arch into the molar/ramus region, which lives DEEPER than
  // the anterior-fit depth cap.
  const occFull = Uint8Array.from(occ);

  // HARD-REJECT posterior anatomy: anything deeper than archDepthMm behind the
  // arch front (cervical spine, posterior skull) must not enter the fit.
  const maxDepthRows = archDepthMm / rowMm;
  let cxAcc = 0;
  let cyAcc = 0;
  let cN = 0;
  let maxDepthSeen = 0;
  const keptGx = [];
  const keptGy = [];
  for (let gy = 0; gy < gh; gy++) {
    const depth = aFront - antSign * gy;
    const keep = depth >= 0 && depth <= maxDepthRows;
    for (let gx = 0; gx < gw; gx++) {
      const o = gy * gw + gx;
      if (!occ[o]) continue;
      if (!keep) { occ[o] = 0; continue; }
      keptGx.push(gx); keptGy.push(gy);
      cxAcc += gx; cyAcc += gy; cN++;
      if (depth > maxDepthSeen) maxDepthSeen = depth;
    }
  }
  if (cN < 8) throw new Error('No dentition detected (anterior arch band is empty)');

  const cx = cxAcc / cN;
  const cy = cyAcc / cN;

  // Sweep centre INSIDE the U of the arch: on the arch midline (mean x of the
  // anterior band), ~60% of the arch depth behind the front. Sweeping from the
  // bright-voxel centroid was wrong on real scans — with the spine/skull in
  // the map the centroid lands posteriorly and the sectors hit the vertebrae.
  const centerGx = cx;
  const centerGy = gyFront - antSign * Math.max(2, 0.6 * maxDepthSeen);

  // For each angular sector the OUTERMOST occupied grid cell is the buccal
  // edge of the arch. Angle 0 points ANTERIOR (orientation-aware); the sweep
  // covers the U, which opens posteriorly.
  const ridge = []; // { gx, gy }
  const maxR = Math.hypot(gw, gh);
  const halfSweepDeg = 115;
  for (let s = 0; s < sectors; s++) {
    const ang = (-halfSweepDeg + (2 * halfSweepDeg * s) / (sectors - 1)) * (Math.PI / 180);
    const dx = Math.sin(ang);
    const dy = antSign * Math.cos(ang); // +cos toward anterior, sign-corrected
    let bestR = -1;
    let bx = -1;
    let by = -1;
    for (let r = 2; r < maxR; r += 1) {
      const gx = Math.round(centerGx + dx * r);
      const gy = Math.round(centerGy + dy * r);
      if (gx < 0 || gx >= gw || gy < 0 || gy >= gh) break;
      if (occ[gy * gw + gx]) { bestR = r; bx = gx; by = gy; }
    }
    if (bestR > 0) ridge.push({ gx: bx, gy: by });
  }
  if (ridge.length < 4) throw new Error('Arch ridge too sparse to fit a curve');

  // Smooth the ridge (moving average) to suppress single-voxel jitter.
  const sm = ridge.map((p, i) => {
    let ax = 0;
    let ay = 0;
    let n = 0;
    for (let d = -2; d <= 2; d++) {
      const q = ridge[i + d];
      if (q) { ax += q.gx; ay += q.gy; n++; }
    }
    return { gx: ax / n, gy: ay / n };
  });

  // ── Posterior extension ─────────────────────────────────────────────────
  // The anterior sweep above is capped at archDepthMm so the cervical spine
  // can never enter the fit — but that also clips the molars and ramus, the
  // exact posterior anatomy a real OPG must span. Extend each end of the
  // ridge POSTERO-LATERALLY by tangential marching that snaps to the full
  // (pre-reject) bone mask, until the mask runs out, a depth/length cap is
  // reached, or the path would dive toward the midline at depth (the spine).
  const extMaxDepthMm = Math.min(archDepthMm + posteriorExtendMm, gh * rowMm * 0.85);
  const extMaxLenMm = posteriorExtendMm * 1.8; // per-end arc-length cap
  const searchMm = extendSearchMm;
  const searchRad = Math.max(1, Math.round(searchMm / colMm));
  const stepCols = Math.max(1, searchMm / colMm);
  const spineGuardCols = spineGuardMm / colMm;
  const minMaskSupport = 2;
  const maxMisses = 2;

  const extendArchEnd = (poly, fromEnd) => {
    const ext = [];
    const n = poly.length;
    if (n < 2) return ext;
    const endP = fromEnd ? poly[n - 1] : poly[0];
    const backP = fromEnd ? poly[Math.max(0, n - 4)] : poly[Math.min(n - 1, 3)];
    let dirx = endP.gx - backP.gx;
    let diry = endP.gy - backP.gy;
    const dl = Math.hypot(dirx, diry);
    if (dl < 1e-3) return ext;
    dirx /= dl; diry /= dl;
    let cur = { gx: endP.gx, gy: endP.gy };
    let appendedMm = 0;
    let misses = 0;
    for (let step = 0; step < 400; step++) {
      const candx = cur.gx + dirx * stepCols;
      const candy = cur.gy + diry * stepCols;
      if (candx < 0 || candx >= gw || candy < 0 || candy >= gh) break;
      const depthRows = aFront - antSign * candy;
      if (depthRows * rowMm > extMaxDepthMm) break;
      // Spine guard: deep AND near the arch midline ⇒ posterior midline
      // anatomy (the cervical spine). Stop instead of chasing it.
      if (depthRows > maxDepthRows && Math.abs(candx - cx) < spineGuardCols) break;
      // Snap to the bone-mask centroid in a small window around the candidate.
      let sxA = 0; let syA = 0; let nMask = 0;
      const cgx = Math.round(candx);
      const cgy = Math.round(candy);
      for (let dy = -searchRad; dy <= searchRad; dy++) {
        for (let dx = -searchRad; dx <= searchRad; dx++) {
          const gx = cgx + dx;
          const gy = cgy + dy;
          if (gx < 0 || gx >= gw || gy < 0 || gy >= gh) continue;
          if (occFull[gy * gw + gx]) { sxA += gx; syA += gy; nMask++; }
        }
      }
      if (nMask < minMaskSupport) {
        // No mask support — bridge a tiny gap, but bail if the void persists
        // (don't extend into noise / empty space).
        if (++misses > maxMisses) break;
        cur = { gx: candx, gy: candy };
        continue;
      }
      misses = 0;
      const mgx = sxA / nMask;
      const mgy = syA / nMask;
      // Blend the marching tangent with the pull toward the local mask centroid
      // so the extension follows the arch's curvature into the ramus.
      let ndx = mgx - cur.gx;
      let ndy = mgy - cur.gy;
      const ndl = Math.hypot(ndx, ndy);
      if (ndl > 1e-3) { ndx /= ndl; ndy /= ndl; }
      dirx = 0.6 * dirx + 0.4 * ndx;
      diry = 0.6 * diry + 0.4 * ndy;
      const bl = Math.hypot(dirx, diry);
      if (bl > 1e-3) { dirx /= bl; diry /= bl; }
      appendedMm += Math.hypot((mgx - cur.gx) * colMm, (mgy - cur.gy) * rowMm);
      cur = { gx: mgx, gy: mgy };
      ext.push({ gx: cur.gx, gy: cur.gy });
      if (appendedMm > extMaxLenMm) break;
    }
    return ext;
  };

  // frontExt marches outward from sm[0]; reverse it so the farthest point comes
  // first and it connects cleanly into the anterior ridge.
  const frontExt = extendArchEnd(sm, false).reverse();
  const backExt = extendArchEnd(sm, true);
  const poly = [...frontExt, ...sm, ...backExt];

  // Resample the (extended) ridge to the requested control points by ARC
  // LENGTH so the points stay evenly spaced after extension.
  const cum = new Float64Array(poly.length);
  for (let i = 1; i < poly.length; i++) {
    const dpx = (poly[i].gx - poly[i - 1].gx) * colMm;
    const dpy = (poly[i].gy - poly[i - 1].gy) * rowMm;
    cum[i] = cum[i - 1] + Math.hypot(dpx, dpy);
  }
  const totalLen = cum[poly.length - 1] || 1;
  const out = [];
  const zc = Math.round((z0 + z1) / 2);
  let ki = 0;
  for (let c = 0; c < controlPoints; c++) {
    const target = (c / (controlPoints - 1)) * totalLen;
    while (ki < poly.length - 2 && cum[ki + 1] < target) ki++;
    const seg = cum[ki + 1] - cum[ki];
    const t = seg > 0 ? (target - cum[ki]) / seg : 0;
    const gx = poly[ki].gx + (poly[ki + 1].gx - poly[ki].gx) * t;
    const gy = poly[ki].gy + (poly[ki + 1].gy - poly[ki].gy) * t;
    out.push([gx, gy]);
  }

  // ── Plausibility checks: the curve must look like a dental arch ──────────
  // Wide enough across x (left-right molar span)…
  let minGx = Infinity;
  let maxGx = -Infinity;
  for (const [gx] of out) { if (gx < minGx) minGx = gx; if (gx > maxGx) maxGx = gx; }
  const widthMm = (maxGx - minGx) * colMm;
  if (widthMm < 16) {
    throw new Error(`Auto-arch rejected: curve too narrow (${widthMm.toFixed(1)} mm) — not a dental arch`);
  }
  // …and a U opening posteriorly: the most-anterior control point sits in the
  // middle third, clearly in front of both endpoints.
  let aMax = -Infinity;
  let aMaxIdx = 0;
  for (let c = 0; c < out.length; c++) {
    const a = antSign * out[c][1];
    if (a > aMax) { aMax = a; aMaxIdx = c; }
  }
  const aEnd = Math.max(antSign * out[0][1], antSign * out[out.length - 1][1]);
  const uDepthMm = (aMax - aEnd) * rowMm;
  if (aMaxIdx < out.length / 4 || aMaxIdx > (3 * out.length) / 4 || uDepthMm < 5) {
    throw new Error('Auto-arch rejected: curve is not an anterior-opening U (posterior anatomy?)');
  }
  // …and a THIN ridge, not the rim of a filled mass: a dental arch's bright
  // voxels hug the curve, whereas e.g. a dense skull-base plate (a toothless
  // FOV's brightest band) is solid — most of its voxels sit far inside the
  // outer-edge curve the sweep traces.
  const nearMm = 5;
  let nearCurve = 0;
  for (let i = 0; i < keptGx.length; i++) {
    const px = keptGx[i];
    const py = keptGy[i];
    let best = Infinity;
    for (const q of sm) {
      const dxMm = (px - q.gx) * colMm;
      const dyMm = (py - q.gy) * rowMm;
      const d2 = dxMm * dxMm + dyMm * dyMm;
      if (d2 < best) best = d2;
    }
    if (best <= nearMm * nearMm) nearCurve++;
  }
  if (nearCurve / keptGx.length < 0.35) {
    throw new Error('Auto-arch rejected: bright mass is solid, not an arch ridge (no dentition?)');
  }

  const pointsIndex = out.map(([gx, gy]) => [gx * ds, gy * ds, zc]);
  const pointsWorld = pointsIndex.map(([xi, yi, zi]) =>
    idxToWorld(origin, iAxis, jAxis, kAxis, spacing, xi, yi, zi)
  );

  return {
    pointsWorld,
    pointsIndex,
    slab,
    centroid: [cx * ds, cy * ds, zc],
    antSign,
  };
}
