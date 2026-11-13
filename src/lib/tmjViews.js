/*
 * tmjViews — client-side TMJ (temporomandibular joint) reconstruction geometry
 * for the dual-condyle CBCT display.
 *
 * Pure math / typed-array code: no DOM, no WebGL, no cornerstone imports, so the
 * condyle localization, FOV honesty check, and oblique-plane sampling are all
 * unit-testable in jsdom and fast on the main thread.
 *
 * Coordinate conventions match @cornerstonejs/core ImageVolume and the existing
 * curvedMpr/autoArch modules:
 *   dimensions [nx,ny,nz], spacing [sx,sy,sz], origin [x,y,z] (world),
 *   direction 9 numbers = world unit vectors of the i,j,k voxel axes
 *   [ix,iy,iz, jx,jy,jz, kx,ky,kz].
 *
 * WORLD FRAME is LPS (cornerstone): +X = patient LEFT, +Y = posterior,
 * +Z = superior. The condyles, "superior", "anterior" and the patient's
 * LEFT/RIGHT are ALWAYS derived from the volume's direction matrix here — never
 * hard-coded — because this codebase already shipped two orientation-sign bugs
 * (see autoArch.js header). The synthetic NIfTI/DICOM phantoms exercise both
 * direction conventions in the unit tests.
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

const iAxisOf = (d) => normalize([d[0], d[1], d[2]]);
const jAxisOf = (d) => normalize([d[3], d[4], d[5]]);
const kAxisOf = (d) => normalize([d[6], d[7], d[8]]);

/**
 * Patient-axis basis derived ENTIRELY from the volume's direction matrix.
 * Returns world unit vectors pointing toward patient LEFT (+X LPS), POSTERIOR
 * (+Y LPS) and SUPERIOR (+Z LPS), plus the convenience anterior/right vectors.
 *
 * The voxel axes (i,j,k) are an orthonormal world basis; the world LPS axes are
 * recovered by reading the matching ROW of the direction matrix. We pick, for
 * each world axis, the basis vector itself (+X is simply [1,0,0] in world
 * space) — the volume's direction only tells us how voxel indices map to world,
 * not a different world frame. So "left/superior" are constant world vectors;
 * what the direction matrix changes is which VOXEL axis those correspond to,
 * which the sampler handles via world→index projection. This function returns
 * the world axes plus the signed voxel-axis correspondence used for labelling.
 *
 * @param {number[]} direction 9-element direction matrix
 * @returns {{ left:number[], right:number[], superior:number[], inferior:number[],
 *             anterior:number[], posterior:number[],
 *             iAxis:number[], jAxis:number[], kAxis:number[] }}
 */
export function patientAxes(direction) {
  const d = direction;
  return {
    left: [1, 0, 0],
    right: [-1, 0, 0],
    posterior: [0, 1, 0],
    anterior: [0, -1, 0],
    superior: [0, 0, 1],
    inferior: [0, 0, -1],
    iAxis: iAxisOf(d),
    jAxis: jAxisOf(d),
    kAxis: kAxisOf(d),
  };
}

// world -> nearest voxel index, orthonormal direction basis. Returns null when
// outside the volume.
function worldToIndex(vol, w) {
  const { dimensions, spacing, origin, direction } = vol;
  const [nx, ny, nz] = dimensions;
  const iA = iAxisOf(direction);
  const jA = jAxisOf(direction);
  const kA = kAxisOf(direction);
  const dx = w[0] - origin[0];
  const dy = w[1] - origin[1];
  const dz = w[2] - origin[2];
  const xi = Math.round((dx * iA[0] + dy * iA[1] + dz * iA[2]) / spacing[0]);
  if (xi < 0 || xi >= nx) return null;
  const yi = Math.round((dx * jA[0] + dy * jA[1] + dz * jA[2]) / spacing[1]);
  if (yi < 0 || yi >= ny) return null;
  const zi = Math.round((dx * kA[0] + dy * kA[1] + dz * kA[2]) / spacing[2]);
  if (zi < 0 || zi >= nz) return null;
  return [xi, yi, zi];
}

// voxel index -> world.
function indexToWorld(vol, xi, yi, zi) {
  const { spacing, origin, direction } = vol;
  const iA = iAxisOf(direction);
  const jA = jAxisOf(direction);
  const kA = kAxisOf(direction);
  const ix = xi * spacing[0];
  const iy = yi * spacing[1];
  const iz = zi * spacing[2];
  return [
    origin[0] + iA[0] * ix + jA[0] * iy + kA[0] * iz,
    origin[1] + iA[1] * ix + jA[1] * iy + kA[1] * iz,
    origin[2] + iA[2] * ix + jA[2] * iy + kA[2] * iz,
  ];
}

/** Sample the volume at a world point (nearest-neighbour). NaN if outside. */
export function sampleWorld(vol, w) {
  const idx = worldToIndex(vol, w);
  if (!idx) return NaN;
  const [nx, ny] = vol.dimensions;
  return vol.scalarData[idx[0] + idx[1] * nx + idx[2] * nx * ny];
}

// Robust intensity stats from a strided sample.
function robustRange(scalarData, total) {
  const stride = Math.max(1, Math.floor(total / 200000));
  const sample = [];
  for (let i = 0; i < total; i += stride) sample.push(scalarData[i]);
  if (!sample.length) return { lo: 0, hi: 1 };
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.5)];
  const hi = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.997))];
  return { lo, hi };
}

/**
 * Locate the left & right condyle centres from the volume's bone mask.
 *
 * The condyles are the posterior-superior-most dense bone masses sitting
 * LATERAL of the midline near the TOP of a dentition-bearing volume. The
 * heuristic (coarse, by design — the user refines by clicking):
 *
 *   1. Threshold to dense bone (high percentile).
 *   2. Restrict to the SUPERIOR portion of the volume (top ~40% in patient-
 *      superior, derived from the direction matrix) and the POSTERIOR half
 *      (condyles never sit anteriorly).
 *   3. Split into patient-LEFT and patient-RIGHT halves about the bone-mass
 *      midline (mean LEFT-coordinate). On each side, the condyle is the
 *      bone-mass centroid weighted toward the postero-superior corner.
 *   4. FOV HONESTY: if a side has almost no dense bone in the superior-
 *      posterior region, OR the detected centre sits within a margin of the
 *      volume's superior/posterior face (i.e. the joint is cut off), report
 *      that side as out-of-FOV rather than returning a garbage point.
 *
 * @param {Object} vol  { dimensions, spacing, origin, direction, scalarData }
 * @param {Object} [options]
 * @returns {{ left:{centerWorld:number[]|null, inFov:boolean, support:number},
 *             right:{centerWorld:number[]|null, inFov:boolean, support:number},
 *             threshold:number, axes:Object }}
 */
export function locateCondyles(vol, options = {}) {
  const { dimensions, spacing, scalarData } = vol || {};
  if (!dimensions || !spacing || !scalarData) {
    throw new Error('Volume geometry/voxel data unavailable for condyle localization');
  }
  const [nx, ny, nz] = dimensions;
  const {
    // top fraction of the patient-superior range searched for condyles
    superiorFraction = 0.42,
    // require the condyle to sit in the posterior portion (fraction of the
    // posterior-coordinate range, measured from the anterior-most bone)
    posteriorFraction = 0.55,
    downsample = Math.max(1, Math.round(Math.max(nx, ny, nz) / 160)),
    // a side is out-of-FOV if its detected centre lands within this many mm of
    // the relevant volume face (joint cut off) or has too little bone support
    fovMarginMm = 4,
    minSupport = 20,
  } = options;

  const total = nx * ny * nz;
  const { lo, hi } = robustRange(scalarData, total);
  if (!(hi > lo)) throw new Error('Volume has no intensity contrast for condyle localization');
  const threshold = lo + (hi - lo) * 0.78; // dense cortical/condylar bone

  const axes = patientAxes(vol.direction);
  const ds = downsample;

  // Pass 1: collect dense-bone voxels with their patient-frame coordinates
  // (left = projection on +X, post = projection on +Y, sup = projection on +Z).
  // Track ranges so "superior portion" / "posterior portion" are relative to
  // the actual bone extent, not the raw FOV (robust to padding).
  let supMin = Infinity; let supMax = -Infinity;
  let postMin = Infinity; let postMax = -Infinity;
  let leftAcc = 0; let leftN = 0;
  const sxy = nx * ny;
  // first sweep — bone extent + mean-left (midline)
  for (let z = 0; z < nz; z += ds) {
    const base = z * sxy;
    for (let y = 0; y < ny; y += ds) {
      const row = base + y * nx;
      for (let x = 0; x < nx; x += ds) {
        if (scalarData[row + x] < threshold) continue;
        const w = indexToWorld(vol, x, y, z);
        const sup = dot(w, axes.superior);
        const post = dot(w, axes.posterior);
        if (sup < supMin) supMin = sup;
        if (sup > supMax) supMax = sup;
        if (post < postMin) postMin = post;
        if (post > postMax) postMax = post;
        leftAcc += dot(w, axes.left); leftN++;
      }
    }
  }
  if (!leftN) {
    return {
      left: { centerWorld: null, inFov: false, support: 0 },
      right: { centerWorld: null, inFov: false, support: 0 },
      threshold, axes,
    };
  }
  const midLeft = leftAcc / leftN;
  const supCut = supMax - (supMax - supMin) * superiorFraction; // keep sup >= supCut
  const postCut = postMin + (postMax - postMin) * posteriorFraction; // keep post >= postCut

  // Pass 2: per side, accumulate a postero-superior-weighted centroid of the
  // superior+posterior dense bone. side key: 'left' (LEFT of midline) / 'right'.
  const acc = {
    left: { x: 0, y: 0, z: 0, w: 0, n: 0 },
    right: { x: 0, y: 0, z: 0, w: 0, n: 0 },
  };
  for (let z = 0; z < nz; z += ds) {
    const base = z * sxy;
    for (let y = 0; y < ny; y += ds) {
      const row = base + y * nx;
      for (let x = 0; x < nx; x += ds) {
        if (scalarData[row + x] < threshold) continue;
        const w = indexToWorld(vol, x, y, z);
        const sup = dot(w, axes.superior);
        const post = dot(w, axes.posterior);
        if (sup < supCut || post < postCut) continue;
        const leftCoord = dot(w, axes.left);
        const side = leftCoord >= midLeft ? 'left' : 'right';
        // weight toward postero-superior corner so the centroid lands ON the
        // condylar head, not the broad ramus below/in front of it.
        const wSup = (sup - supCut) / Math.max(1e-3, supMax - supCut);
        const wPost = (post - postCut) / Math.max(1e-3, postMax - postCut);
        const weight = 0.25 + wSup + wPost;
        const a = acc[side];
        a.x += w[0] * weight; a.y += w[1] * weight; a.z += w[2] * weight;
        a.w += weight; a.n += 1;
      }
    }
  }

  // Volume faces (in patient sup/post coordinates) for the FOV cut-off test —
  // and the FULL sup/post range of the FOV so we can demand a condyle actually
  // sits HIGH and BACK in the scan (not just the relative top of whatever bone
  // is present — a dento-alveolar scan's only bone is the teeth, mid-volume).
  let faceSupMax = -Infinity; let faceSupMin = Infinity;
  let facePostMax = -Infinity; let facePostMin = Infinity;
  for (let cz = 0; cz < 2; cz++)
    for (let cy = 0; cy < 2; cy++)
      for (let cx = 0; cx < 2; cx++) {
        const w = indexToWorld(vol, cx * (nx - 1), cy * (ny - 1), cz * (nz - 1));
        const sup = dot(w, axes.superior);
        const post = dot(w, axes.posterior);
        if (sup > faceSupMax) faceSupMax = sup;
        if (sup < faceSupMin) faceSupMin = sup;
        if (post > facePostMax) facePostMax = post;
        if (post < facePostMin) facePostMin = post;
      }
  const supRange = faceSupMax - faceSupMin;
  const postRange = facePostMax - facePostMin;

  const finishSide = (a) => {
    if (a.n < minSupport || a.w <= 0) {
      return { centerWorld: null, inFov: false, support: a.n };
    }
    const c = [a.x / a.w, a.y / a.w, a.z / a.w];
    const sup = dot(c, axes.superior);
    const post = dot(c, axes.posterior);
    // (1) Cut-off check: the condyle should NOT be jammed against the superior
    // or posterior FOV face (the joint is sliced off the top/back of a tight
    // scan). The healthy condyle sits a few mm inside the ceiling/back wall.
    const supGap = faceSupMax - sup;
    const postGap = facePostMax - post;
    const cutOff = supGap < fovMarginMm || postGap < fovMarginMm;
    // (2) Presence check: a real condyle sits in the UPPER and POSTERIOR part
    // of the FOV. A dento-alveolar (teeth-only) scan's densest bone is the
    // arch, mid/low and anterior — it fails this and is honestly reported as
    // "condyles outside this scan's field of view" instead of a garbage point.
    const supFrac = supRange > 0 ? (sup - faceSupMin) / supRange : 0;
    const postFrac = postRange > 0 ? (post - facePostMin) / postRange : 0;
    const inRegion = supFrac >= 0.5 && postFrac >= 0.45;
    return { centerWorld: c, inFov: !cutOff && inRegion, support: a.n };
  };

  return {
    left: finishSide(acc.left),
    right: finishSide(acc.right),
    threshold,
    axes,
  };
}

/**
 * Estimate the condylar long axis (medio-lateral) and the ramus (supero-
 * inferior) direction near a condyle centre, from the local dense-bone cloud.
 * Used to orient the default parasagittal cut perpendicular to the condylar
 * long axis. Falls back to the patient axes when the local cloud is too sparse.
 *
 * @returns {{ longAxis:number[], ramusAxis:number[] }}  world unit vectors
 */
export function condyleAxes(vol, centerWorld, options = {}) {
  const axes = patientAxes(vol.direction);
  if (!centerWorld) return { longAxis: axes.left, ramusAxis: axes.superior };
  const { radiusMm = 14, threshold = null, downsample = 1 } = options;
  const [nx, ny, nz] = vol.dimensions;
  const { scalarData } = vol;
  let thr = threshold;
  if (thr == null) {
    const { lo, hi } = robustRange(scalarData, nx * ny * nz);
    thr = lo + (hi - lo) * 0.78;
  }
  // gather dense voxels within radius, compute principal direction in the
  // axial (left/posterior) plane → that's the condylar long axis projection.
  const pts = [];
  const ic = worldToIndex(vol, centerWorld);
  if (!ic) return { longAxis: axes.left, ramusAxis: axes.superior };
  const rx = Math.ceil(radiusMm / vol.spacing[0]);
  const ry = Math.ceil(radiusMm / vol.spacing[1]);
  const rz = Math.ceil(radiusMm / vol.spacing[2]);
  const sxy = nx * ny;
  for (let z = Math.max(0, ic[2] - rz); z <= Math.min(nz - 1, ic[2] + rz); z += downsample) {
    for (let y = Math.max(0, ic[1] - ry); y <= Math.min(ny - 1, ic[1] + ry); y += downsample) {
      const row = z * sxy + y * nx;
      for (let x = Math.max(0, ic[0] - rx); x <= Math.min(nx - 1, ic[0] + rx); x += downsample) {
        if (scalarData[row + x] < thr) continue;
        const w = indexToWorld(vol, x, y, z);
        pts.push([dot(w, axes.left), dot(w, axes.posterior)]);
      }
    }
  }
  if (pts.length < 6) return { longAxis: axes.left, ramusAxis: axes.superior };
  // 2x2 covariance in (left, posterior); principal eigenvector = long axis dir
  let ml = 0; let mp = 0;
  for (const p of pts) { ml += p[0]; mp += p[1]; }
  ml /= pts.length; mp /= pts.length;
  let cll = 0; let clp = 0; let cpp = 0;
  for (const p of pts) {
    const dl = p[0] - ml; const dp = p[1] - mp;
    cll += dl * dl; clp += dl * dp; cpp += dp * dp;
  }
  cll /= pts.length; clp /= pts.length; cpp /= pts.length;
  // larger eigenvalue's eigenvector (closed form for symmetric 2x2)
  const tr = cll + cpp;
  const det = cll * cpp - clp * clp;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc;
  let ev = clp !== 0 ? [l1 - cpp, clp] : [1, 0];
  const evl = Math.hypot(ev[0], ev[1]);
  if (evl > 0) ev = [ev[0] / evl, ev[1] / evl];
  // map (left, posterior) components back into world
  const longAxis = normalize(add(scale(axes.left, ev[0]), scale(axes.posterior, ev[1])));
  // ramus axis: superior, orthogonalized against the long axis
  let ramus = sub(axes.superior, scale(longAxis, dot(axes.superior, longAxis)));
  ramus = normalize(ramus);
  if (len(ramus) === 0) ramus = axes.superior;
  return { longAxis, ramusAxis: ramus };
}

/**
 * Sample an oblique plane through a world centre. The plane is spanned by two
 * world unit vectors (uAxis across columns, vAxis down rows), centred on
 * `centerWorld`, optionally slab-averaged/MIP'd along the plane normal.
 *
 * Row 0 is the most-positive along vAxis (so pass vAxis = SUPERIOR to get a
 * maxilla-up image). Column 0 is the most-negative along uAxis.
 *
 * @param {Object} vol  { dimensions, spacing, origin, direction, scalarData }
 * @param {number[]} centerWorld
 * @param {number[]} uAxis  world unit vector for columns (left→right of image)
 * @param {number[]} vAxis  world unit vector for rows (image bottom→top)
 * @param {Object} [options]
 * @param {number} [options.widthMm=50]
 * @param {number} [options.heightMm=50]
 * @param {number} [options.pixelMm]  in-plane sample spacing (default min spacing)
 * @param {number} [options.slabThicknessMm=0] slab depth along the plane normal
 * @param {'mip'|'mean'} [options.projection='mean']
 * @param {number} [options.maxDim=512]
 * @returns {{ width, height, data:Float32Array, pixelMm,
 *             centerWorld, uAxis, vAxis, normal }}
 *          data row-major, NaN outside the volume.
 */
export function sampleObliquePlane(vol, centerWorld, uAxis, vAxis, options = {}) {
  if (!centerWorld) throw new Error('sampleObliquePlane needs a centre');
  const {
    widthMm = 50,
    heightMm = 50,
    slabThicknessMm = 0,
    projection = 'mean',
    maxDim = 512,
  } = options;
  const minSpacing = Math.min(vol.spacing[0], vol.spacing[1], vol.spacing[2]);
  let pixelMm = options.pixelMm || minSpacing;

  const u = normalize(uAxis);
  let v = normalize(vAxis);
  // orthogonalize v against u so the grid is square
  v = normalize(sub(v, scale(u, dot(v, u))));
  const normal = normalize(cross(u, v));

  let width = Math.floor(widthMm / pixelMm) + 1;
  let height = Math.floor(heightMm / pixelMm) + 1;
  if (Math.max(width, height) > maxDim) {
    const f = maxDim / Math.max(width, height);
    pixelMm = pixelMm / f;
    width = Math.floor(widthMm / pixelMm) + 1;
    height = Math.floor(heightMm / pixelMm) + 1;
  }
  if (width < 2) width = 2;
  if (height < 2) height = 2;

  let slabN = 1;
  let slabStep = 0;
  if (slabThicknessMm > 0) {
    slabN = Math.floor(slabThicknessMm / minSpacing) + 1;
    if (slabN > 21) slabN = 21;
    if (slabN % 2 === 0) slabN += 1;
    slabStep = slabN > 1 ? slabThicknessMm / (slabN - 1) : 0;
  }
  const isMip = projection === 'mip';
  const data = new Float32Array(width * height);
  const halfW = (width - 1) / 2;
  const halfH = (height - 1) / 2;

  for (let r = 0; r < height; r++) {
    // row 0 = top = most-positive along v
    const vOff = (halfH - r) * pixelMm;
    for (let c = 0; c < width; c++) {
      const uOff = (c - halfW) * pixelMm;
      const bx = centerWorld[0] + u[0] * uOff + v[0] * vOff;
      const by = centerWorld[1] + u[1] * uOff + v[1] * vOff;
      const bz = centerWorld[2] + u[2] * uOff + v[2] * vOff;
      let accv = isMip ? -Infinity : 0;
      let count = 0;
      for (let s = 0; s < slabN; s++) {
        const off = slabN > 1 ? s * slabStep - slabThicknessMm / 2 : 0;
        const w = [bx + normal[0] * off, by + normal[1] * off, bz + normal[2] * off];
        const val = sampleWorld(vol, w);
        if (!Number.isFinite(val)) continue;
        if (isMip) { if (val > accv) accv = val; } else { accv += val; }
        count++;
      }
      data[r * width + c] = count === 0 ? NaN : (isMip ? accv : accv / count);
    }
  }
  return { width, height, data, pixelMm, centerWorld, uAxis: u, vAxis: v, normal };
}

/**
 * Build the standard TMJ planes for one condyle.
 *
 *   parasagittal — perpendicular to the condylar long axis, rotated by
 *                  `angleDeg` around the SUPERIOR axis (default ~perpendicular
 *                  to the mean ramus direction). Rows = superior (maxilla up),
 *                  cols = the in-plane anterior↔posterior direction.
 *   coronal      — oblique coronal through the centre: cols along the condylar
 *                  long axis (medio-lateral), rows = superior.
 *
 * @param {Object} vol
 * @param {number[]} centerWorld
 * @param {Object} [options]
 * @param {number} [options.angleDeg=0] extra rotation of the parasagittal cut
 *        about the superior axis (0 = perpendicular to the condylar long axis)
 * @param {number} [options.offsetMm=0] scroll offset along the parasagittal
 *        normal (medio-lateral through the condyle, ±15mm typical)
 * @param {number} [options.slabThicknessMm=1]
 * @param {'mip'|'mean'} [options.projection='mean']
 * @param {number} [options.sizeMm=46]
 * @returns {{ parasagittal:Object, coronal:Object, longAxis:number[],
 *             ramusAxis:number[], axes:Object }}
 */
export function buildCondylePlanes(vol, centerWorld, options = {}) {
  const {
    angleDeg = 0,
    offsetMm = 0,
    slabThicknessMm = 1,
    projection = 'mean',
    sizeMm = 46,
  } = options;
  const axes = patientAxes(vol.direction);
  const { longAxis } = condyleAxes(vol, centerWorld, options);

  // Parasagittal: the cut PLANE is perpendicular to the condylar long axis, so
  // its NORMAL is the long axis. The in-plane horizontal (uAxis) is the
  // anterior↔posterior direction within that plane; vAxis is superior.
  // Rotating by angleDeg spins the plane about the superior axis.
  const rot = (vec, axis, deg) => {
    const th = (deg * Math.PI) / 180;
    const k = normalize(axis);
    const cosA = Math.cos(th);
    const sinA = Math.sin(th);
    // Rodrigues
    return add(
      add(scale(vec, cosA), scale(cross(k, vec), sinA)),
      scale(k, dot(k, vec) * (1 - cosA))
    );
  };
  let paraNormal = rot(longAxis, axes.superior, angleDeg);
  paraNormal = normalize(paraNormal);
  // uAxis = anterior↔posterior in-plane: project anterior onto the plane
  let paraU = sub(axes.anterior, scale(paraNormal, dot(axes.anterior, paraNormal)));
  paraU = normalize(paraU);
  if (len(paraU) === 0) paraU = axes.anterior;
  const paraV = axes.superior;
  // scroll medio-laterally along the plane normal
  const paraCenter = add(centerWorld, scale(paraNormal, offsetMm));
  const parasagittal = sampleObliquePlane(vol, paraCenter, paraU, paraV, {
    widthMm: sizeMm, heightMm: sizeMm, slabThicknessMm, projection,
  });
  parasagittal.normal = paraNormal;
  parasagittal.scrollMm = offsetMm;

  // Coronal oblique: cols along the condylar long axis (medio-lateral), rows
  // superior, normal ~ anterior↔posterior.
  const coronal = sampleObliquePlane(vol, centerWorld, longAxis, axes.superior, {
    widthMm: sizeMm, heightMm: sizeMm, slabThicknessMm, projection,
  });

  return { parasagittal, coronal, longAxis, ramusAxis: axes.superior, axes };
}

/**
 * Which side label (R / L) belongs on the LEFT of the screen for a maxilla-up
 * presentation, derived from the direction matrix — never by mirroring the
 * patient. In radiological convention the patient's RIGHT is shown on the
 * viewer's LEFT. We compute, for a given image uAxis, whether increasing column
 * index moves toward patient LEFT or RIGHT, so callers can place L/R markers
 * correctly regardless of the direction convention.
 *
 * @param {number[]} uAxis  world unit vector mapped to increasing image column
 * @returns {{ leftEdge:'L'|'R', rightEdge:'L'|'R' }}
 */
export function lrLabelsForUaxis(uAxis) {
  // +X world is patient LEFT (LPS). If uAxis points toward +X, the right edge
  // of the image (max column) is patient LEFT and the left edge is patient
  // RIGHT (radiological). If uAxis points toward -X, it's flipped.
  const towardLeft = uAxis[0]; // dot with patient-left [1,0,0]
  if (towardLeft >= 0) {
    return { leftEdge: 'R', rightEdge: 'L' };
  }
  return { leftEdge: 'L', rightEdge: 'R' };
}

/**
 * Linear measurement in mm between two image pixels on a sampled plane.
 * pixel = { c, r } column/row. Uses the plane's pixelMm.
 */
export function measurePixels(plane, a, b) {
  const dc = (a.c - b.c) * plane.pixelMm;
  const dr = (a.r - b.r) * plane.pixelMm;
  return Math.hypot(dc, dr);
}

/** Convert an image pixel on a plane back to a WORLD coordinate. */
export function planePixelToWorld(plane, c, r) {
  const halfW = (plane.width - 1) / 2;
  const halfH = (plane.height - 1) / 2;
  const uOff = (c - halfW) * plane.pixelMm;
  const vOff = (halfH - r) * plane.pixelMm;
  return [
    plane.centerWorld[0] + plane.uAxis[0] * uOff + plane.vAxis[0] * vOff,
    plane.centerWorld[1] + plane.uAxis[1] * uOff + plane.vAxis[1] * vOff,
    plane.centerWorld[2] + plane.uAxis[2] * uOff + plane.vAxis[2] * vOff,
  ];
}

/** Robust display window for a sampled plane (percentiles of finite samples). */
export function planeWindow(plane, lowQ = 0.02, highQ = 0.99) {
  const { data } = plane;
  const sample = [];
  for (let i = 0; i < data.length; i++) {
    if (Number.isFinite(data[i])) sample.push(data[i]);
  }
  if (sample.length < 8) return null;
  sample.sort((a, b) => a - b);
  const lower = sample[Math.floor(sample.length * lowQ)];
  const upper = sample[Math.min(sample.length - 1, Math.floor(sample.length * highQ))];
  if (!(upper > lower)) return null;
  return { lower, upper };
}
