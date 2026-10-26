/*
 * meshRegistration — rigid registration of an intraoral-scan mesh (STL/PLY/OBJ
 * point cloud, scanner-local millimetres) onto a CBCT volume (patient/world
 * LPS millimetres), plus the persistence shape for the resulting transform.
 *
 * Pipeline (all pure math, no DOM / three.js / cornerstone imports):
 *   1. downsamplePoints        — cap both clouds for speed
 *   2. initialAlignment        — centroid + principal-axes (PCA) coarse init;
 *                                the PCA rotation has 4 proper sign/flip
 *                                candidates, scored by nearest-neighbour RMS
 *   3. createIcpSession / runIcp — trimmed point-to-point ICP: per iteration
 *                                match every source point to its nearest
 *                                destination point through a uniform spatial
 *                                hash grid, drop the worst matches (median
 *                                trimming, partial-overlap tolerance), then
 *                                re-fit the FULL transform from the original
 *                                source points with Horn's closed-form
 *                                quaternion solution.
 *
 * Matrices are 16-number ROW-MAJOR 4x4 arrays (m[row*4+col]); this is exactly
 * the argument order of three.js `Matrix4.set(...)`. Quaternions follow the
 * three.js component order [x, y, z, w]. Transforms map MESH-LOCAL points into
 * PATIENT/WORLD (LPS) coordinates.
 *
 * Persistence: the per-study `viewer_annotations` jsonb on imaging_studies
 * (already used for the OPG arch) gains a `mesh_registrations` key:
 *   viewer_annotations.mesh_registrations[<mesh_study_id>] =
 *     { matrix: number[16], updated_at, method, rms_mm, source }
 * No schema change required.
 */

// ── vec3 helpers ─────────────────────────────────────────────────────────────
const v3sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const v3len = (a) => Math.hypot(a[0], a[1], a[2]);

export function centroid(points) {
  let x = 0;
  let y = 0;
  let z = 0;
  const n = points.length;
  if (!n) return [0, 0, 0];
  for (let i = 0; i < n; i++) { x += points[i][0]; y += points[i][1]; z += points[i][2]; }
  return [x / n, y / n, z / n];
}

/** Uniform-stride downsample to at most maxPoints (keeps spatial coverage). */
export function downsamplePoints(points, maxPoints) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const stride = points.length / maxPoints;
  const out = [];
  for (let f = 0; f < points.length && out.length < maxPoints; f += stride) {
    out.push(points[Math.floor(f)]);
  }
  return out;
}

// ── symmetric eigen-decomposition (cyclic Jacobi, n = 3 or 4) ───────────────
/**
 * Eigen-decomposition of a symmetric n×n matrix (flat row-major).
 * @returns {{ values:number[], vectors:number[] }} vectors flat row-major,
 *          COLUMN j = unit eigenvector of values[j]. Sorted descending.
 */
export function jacobiEigenSymmetric(A, n) {
  const a = A.slice();
  const v = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;

  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    if (off < 1e-22) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-18) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j * n + j] - a[i * n + i]);
  const values = order.map((i) => a[i * n + i]);
  const vectors = new Array(n * n);
  for (let col = 0; col < n; col++) {
    const src = order[col];
    for (let row = 0; row < n; row++) vectors[row * n + col] = v[row * n + src];
  }
  return { values, vectors };
}

/**
 * Principal axes of a point cloud (PCA of the covariance matrix).
 * @returns {{ center:number[], axes:number[][], values:number[] }}
 *          axes[k] = unit eigenvector of the k-th largest eigenvalue.
 */
export function principalAxes(points) {
  const c = centroid(points);
  const cov = new Array(9).fill(0);
  for (const p of points) {
    const d = v3sub(p, c);
    cov[0] += d[0] * d[0]; cov[1] += d[0] * d[1]; cov[2] += d[0] * d[2];
    cov[4] += d[1] * d[1]; cov[5] += d[1] * d[2]; cov[8] += d[2] * d[2];
  }
  cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];
  const n = Math.max(1, points.length);
  for (let i = 0; i < 9; i++) cov[i] /= n;
  const { values, vectors } = jacobiEigenSymmetric(cov, 3);
  const axes = [0, 1, 2].map((col) => [vectors[col], vectors[3 + col], vectors[6 + col]]);
  return { center: c, axes, values };
}

// ── mat4 (row-major) ─────────────────────────────────────────────────────────
export function mat4Identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function mat4Translation(t) {
  return [1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2], 0, 0, 0, 1];
}

/** R: 9-number row-major 3x3; t: vec3. Optional uniform scale s on R. */
export function mat4FromRotation(R, t = [0, 0, 0], s = 1) {
  return [
    R[0] * s, R[1] * s, R[2] * s, t[0],
    R[3] * s, R[4] * s, R[5] * s, t[1],
    R[6] * s, R[7] * s, R[8] * s, t[2],
    0, 0, 0, 1,
  ];
}

export function mat4Multiply(a, b) {
  const out = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] =
        a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  return out;
}

export function applyMat4(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

/** Inverse of a rigid (+ uniform scale) transform: M = T R S. */
export function invertRigidMat4(m) {
  // Column norms of the 3x3 block give the uniform scale.
  const s = (Math.hypot(m[0], m[4], m[8]) + Math.hypot(m[1], m[5], m[9]) + Math.hypot(m[2], m[6], m[10])) / 3 || 1;
  const inv2 = 1 / (s * s);
  // (R S)^-1 = R^T / s^2  (since R S has columns of length s)
  const r = [
    m[0] * inv2, m[4] * inv2, m[8] * inv2,
    m[1] * inv2, m[5] * inv2, m[9] * inv2,
    m[2] * inv2, m[6] * inv2, m[10] * inv2,
  ];
  const t = [m[3], m[7], m[11]];
  const it = [
    -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]),
    -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]),
    -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2]),
  ];
  return [r[0], r[1], r[2], it[0], r[3], r[4], r[5], it[1], r[6], r[7], r[8], it[2], 0, 0, 0, 1];
}

// ── quaternion helpers (three.js order [x, y, z, w]) ─────────────────────────
export function quatToMat3(q) {
  const [x, y, z, w] = q;
  const xx = x * x; const yy = y * y; const zz = z * z;
  const xy = x * y; const xz = x * z; const yz = y * z;
  const wx = w * x; const wy = w * y; const wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ];
}

export function mat3ToQuat(R) {
  // Shepperd's method (numerically safe branch selection).
  const m00 = R[0]; const m01 = R[1]; const m02 = R[2];
  const m10 = R[3]; const m11 = R[4]; const m12 = R[5];
  const m20 = R[6]; const m21 = R[7]; const m22 = R[8];
  const tr = m00 + m11 + m22;
  let x; let y; let z; let w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  return [x, y, z, w];
}

export function quatMultiply(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatFromAxisAngle(axis, angleRad) {
  const l = v3len(axis) || 1;
  const s = Math.sin(angleRad / 2);
  return [axis[0] / l * s, axis[1] / l * s, axis[2] / l * s, Math.cos(angleRad / 2)];
}

/** Compose a row-major mat4 from {position, quaternion [x,y,z,w], uniform scale}. */
export function mat4Compose(position, quaternion, scale = 1) {
  return mat4FromRotation(quatToMat3(quaternion), position, scale);
}

/** Decompose a rigid (+ uniform scale) row-major mat4. */
export function mat4Decompose(m) {
  const s = (Math.hypot(m[0], m[4], m[8]) + Math.hypot(m[1], m[5], m[9]) + Math.hypot(m[2], m[6], m[10])) / 3 || 1;
  const R = [m[0] / s, m[1] / s, m[2] / s, m[4] / s, m[5] / s, m[6] / s, m[8] / s, m[9] / s, m[10] / s];
  return { position: [m[3], m[7], m[11]], quaternion: mat3ToQuat(R), scale: s };
}

// ── paired-point rigid fit (Horn's closed-form quaternion method) ────────────
/**
 * Best rigid (optionally + uniform scale) transform mapping src[i] → dst[i].
 * @param {number[][]} src  matched source points
 * @param {number[][]} dst  matched destination points (same length)
 * @param {{ withScale?:boolean }} [options]
 * @returns {number[]} row-major mat4
 */
export function estimateRigidTransform(src, dst, options = {}) {
  const n = Math.min(src.length, dst.length);
  if (n < 3) throw new Error('estimateRigidTransform needs at least 3 point pairs');
  const cs = centroid(src);
  const cd = centroid(dst);

  // Cross-covariance H = Σ (s-cs)(d-cd)^T
  let Sxx = 0; let Sxy = 0; let Sxz = 0;
  let Syx = 0; let Syy = 0; let Syz = 0;
  let Szx = 0; let Szy = 0; let Szz = 0;
  let srcVar = 0;
  let dotSum = 0;
  for (let i = 0; i < n; i++) {
    const s = v3sub(src[i], cs);
    const d = v3sub(dst[i], cd);
    Sxx += s[0] * d[0]; Sxy += s[0] * d[1]; Sxz += s[0] * d[2];
    Syx += s[1] * d[0]; Syy += s[1] * d[1]; Syz += s[1] * d[2];
    Szx += s[2] * d[0]; Szy += s[2] * d[1]; Szz += s[2] * d[2];
    srcVar += v3dot(s, s);
  }

  // Horn's symmetric 4x4 N matrix; its max-eigenvalue eigenvector is the
  // optimal rotation quaternion (w, x, y, z).
  const N = [
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ];
  const { vectors } = jacobiEigenSymmetric(N, 4);
  const w = vectors[0]; const x = vectors[4]; const y = vectors[8]; const z = vectors[12];
  const norm = Math.hypot(w, x, y, z) || 1;
  const R = quatToMat3([x / norm, y / norm, z / norm, w / norm]);

  let scale = 1;
  if (options.withScale && srcVar > 1e-12) {
    // Σ d'·(R s')  /  Σ |s'|²
    for (let i = 0; i < n; i++) {
      const s = v3sub(src[i], cs);
      const d = v3sub(dst[i], cd);
      const rs = [
        R[0] * s[0] + R[1] * s[1] + R[2] * s[2],
        R[3] * s[0] + R[4] * s[1] + R[5] * s[2],
        R[6] * s[0] + R[7] * s[1] + R[8] * s[2],
      ];
      dotSum += v3dot(d, rs);
    }
    scale = dotSum / srcVar;
    if (!(scale > 0.2 && scale < 5)) scale = 1; // refuse degenerate fits
  }

  const t = [
    cd[0] - scale * (R[0] * cs[0] + R[1] * cs[1] + R[2] * cs[2]),
    cd[1] - scale * (R[3] * cs[0] + R[4] * cs[1] + R[5] * cs[2]),
    cd[2] - scale * (R[6] * cs[0] + R[7] * cs[1] + R[8] * cs[2]),
  ];
  return mat4FromRotation(R, t, scale);
}

// ── nearest neighbour via uniform spatial hash grid ──────────────────────────
export function buildNNGrid(points, cellSize = null) {
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
  }
  if (!cellSize) {
    const volume = Math.max(1e-9, (maxX - minX) * (maxY - minY) * (maxZ - minZ));
    cellSize = Math.max(0.5, Math.cbrt(volume / Math.max(1, points.length)) * 2);
  }
  const cells = new Map();
  const key = (cx, cy, cz) => `${cx},${cy},${cz}`;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const k = key(Math.floor(p[0] / cellSize), Math.floor(p[1] / cellSize), Math.floor(p[2] / cellSize));
    let arr = cells.get(k);
    if (!arr) { arr = []; cells.set(k, arr); }
    arr.push(i);
  }
  return { points, cells, cellSize, key };
}

/**
 * Nearest neighbour of p in the grid, searching expanding cell shells.
 * @returns {{ index:number, dist:number }|null} null when nothing within maxShells.
 */
export function nearestNeighbor(grid, p, maxShells = 2) {
  const { points, cells, cellSize, key } = grid;
  const cx = Math.floor(p[0] / cellSize);
  const cy = Math.floor(p[1] / cellSize);
  const cz = Math.floor(p[2] / cellSize);
  let bestIdx = -1;
  let bestD2 = Infinity;
  for (let shell = 0; shell <= maxShells; shell++) {
    for (let dx = -shell; dx <= shell; dx++) {
      for (let dy = -shell; dy <= shell; dy++) {
        for (let dz = -shell; dz <= shell; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== shell) continue;
          const arr = cells.get(key(cx + dx, cy + dy, cz + dz));
          if (!arr) continue;
          for (const i of arr) {
            const q = points[i];
            const d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
            if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
          }
        }
      }
    }
    // Anything already found within this shell's guaranteed radius is final.
    if (bestIdx >= 0 && Math.sqrt(bestD2) <= shell * cellSize) break;
  }
  return bestIdx >= 0 ? { index: bestIdx, dist: Math.sqrt(bestD2) } : null;
}

function rmsOfMatches(srcPts, grid, matrix, maxShells = 2) {
  let acc = 0;
  let n = 0;
  for (const p of srcPts) {
    const nn = nearestNeighbor(grid, applyMat4(matrix, p), maxShells);
    if (nn) { acc += nn.dist * nn.dist; n++; }
  }
  return n ? Math.sqrt(acc / n) : Infinity;
}

// ── coarse init: centroid + principal axes (4 proper flip candidates) ────────
/**
 * Coarse alignment of src onto dst: translate centroids together, rotate the
 * principal axes of src onto those of dst. The PCA basis has a sign ambiguity;
 * all 4 proper (det = +1) sign combinations are scored by NN RMS and the best
 * wins. Returns { matrix, rms }.
 */
export function initialAlignment(srcPts, dstPts, options = {}) {
  const sN = downsamplePoints(srcPts, options.sampleSize || 600);
  const dN = downsamplePoints(dstPts, options.sampleSize || 1200);
  const sp = principalAxes(sN);
  const dp = principalAxes(dN);
  const grid = buildNNGrid(dN);

  // Candidate rotations R = Vd * F * Vs^T with F = diag(f1,f2,f3), fi = ±1,
  // det F = +1 (proper rotations only).
  const flips = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
  let best = null;
  for (const f of flips) {
    // Vd: columns = dst axes; Vs: columns = src axes.
    const R = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let k = 0; k < 3; k++) acc += dp.axes[k][r] * f[k] * sp.axes[k][c];
        R[r * 3 + c] = acc;
      }
    }
    const t = [
      dp.center[0] - (R[0] * sp.center[0] + R[1] * sp.center[1] + R[2] * sp.center[2]),
      dp.center[1] - (R[3] * sp.center[0] + R[4] * sp.center[1] + R[5] * sp.center[2]),
      dp.center[2] - (R[6] * sp.center[0] + R[7] * sp.center[1] + R[8] * sp.center[2]),
    ];
    const m = mat4FromRotation(R, t);
    const rms = rmsOfMatches(sN, grid, m, 3);
    if (!best || rms < best.rms) best = { matrix: m, rms };
  }
  // Plain centroid translation (no rotation) is sometimes better than a bad
  // PCA fit (e.g. near-spherical clouds) — keep it as a candidate too.
  const mT = mat4Translation(v3sub(dp.center, sp.center));
  const rmsT = rmsOfMatches(sN, grid, mT, 3);
  if (rmsT < best.rms) best = { matrix: mT, rms: rmsT };
  return best;
}

// ── trimmed point-to-point ICP ───────────────────────────────────────────────
/**
 * Create an incremental ICP session so the caller can yield between
 * iterations (keeps the UI responsive without a worker round-trip).
 *
 * @param {number[][]} srcPts mesh-local points
 * @param {number[][]} dstPts patient-world points (CBCT surface samples)
 * @param {Object} [options]
 *   maxIterations (default 30), tolerance (ΔRMS mm, default 1e-3),
 *   sampleSize (src cap, default 2500), dstSampleSize (default 6000),
 *   trimFraction (worst matches dropped, default 0.2),
 *   initMatrix (row-major mat4; default = initialAlignment)
 * @returns {{ step:()=>{done:boolean,iteration:number,rms:number}, result:()=>Object }}
 */
export function createIcpSession(srcPts, dstPts, options = {}) {
  const {
    maxIterations = 30,
    tolerance = 1e-3,
    sampleSize = 2500,
    dstSampleSize = 6000,
    trimFraction = 0.2,
  } = options;
  if (!Array.isArray(srcPts) || srcPts.length < 10) throw new Error('ICP needs at least 10 source points');
  if (!Array.isArray(dstPts) || dstPts.length < 10) throw new Error('ICP needs at least 10 destination points');

  const src = downsamplePoints(srcPts, sampleSize);
  const dst = downsamplePoints(dstPts, dstSampleSize);
  const grid = buildNNGrid(dst);

  let initRms = null;
  let matrix = options.initMatrix || null;
  if (!matrix) {
    const init = initialAlignment(src, dst);
    matrix = init.matrix;
    initRms = init.rms;
  }

  let iteration = 0;
  let rms = Infinity;
  let prevRms = Infinity;
  let done = false;

  const step = () => {
    if (done) return { done, iteration, rms };
    // Match through the current transform.
    const pairs = []; // [srcOriginal, dstPoint, dist]
    for (const p of src) {
      const nn = nearestNeighbor(grid, applyMat4(matrix, p), 2);
      if (nn) pairs.push([p, dst[nn.index], nn.dist]);
    }
    if (pairs.length < 10) { done = true; return { done, iteration, rms }; }
    // Trim: drop the worst matches (partial overlap, outliers).
    pairs.sort((a, b) => a[2] - b[2]);
    const keep = Math.max(10, Math.floor(pairs.length * (1 - trimFraction)));
    const kept = pairs.slice(0, keep);
    // Re-fit the FULL transform from the original source points.
    matrix = estimateRigidTransform(kept.map((p) => p[0]), kept.map((p) => p[1]));
    let acc = 0;
    for (const [p, q] of kept) {
      const tp = applyMat4(matrix, p);
      acc += (tp[0] - q[0]) ** 2 + (tp[1] - q[1]) ** 2 + (tp[2] - q[2]) ** 2;
    }
    rms = Math.sqrt(acc / kept.length);
    iteration++;
    if (iteration >= maxIterations || Math.abs(prevRms - rms) < tolerance) done = true;
    prevRms = rms;
    return { done, iteration, rms };
  };

  const result = () => ({
    matrix: matrix.slice(),
    rms,
    initRms,
    iterations: iteration,
    converged: done && iteration < maxIterations,
    srcCount: src.length,
    dstCount: dst.length,
  });

  return { step, result };
}

/** Synchronous convenience wrapper (used by tests and small clouds). */
export function runIcp(srcPts, dstPts, options = {}) {
  const session = createIcpSession(srcPts, dstPts, options);
  let s = session.step();
  while (!s.done) s = session.step();
  return session.result();
}

// ── persistence shape (viewer_annotations.mesh_registrations) ────────────────
export const MESH_REGISTRATIONS_KEY = 'mesh_registrations';

/** Build a normalized registration entry for persistence. */
export function makeRegistrationEntry({ matrix, method = 'manual', rmsMm = null, source = null, now = null }) {
  if (!Array.isArray(matrix) || matrix.length !== 16 || matrix.some((v) => !Number.isFinite(v))) {
    throw new Error('Registration matrix must be 16 finite numbers (row-major 4x4)');
  }
  return {
    matrix: matrix.map((v) => Number(v)),
    method,
    rms_mm: Number.isFinite(rmsMm) ? Number(rmsMm.toFixed(3)) : null,
    source: source || null,
    updated_at: now || new Date().toISOString(),
  };
}

export function isValidRegistrationEntry(entry) {
  return Boolean(
    entry &&
    Array.isArray(entry.matrix) &&
    entry.matrix.length === 16 &&
    entry.matrix.every((v) => Number.isFinite(v))
  );
}

/**
 * Merge a mesh registration into a study's viewer_annotations WITHOUT
 * clobbering unrelated keys (e.g. the OPG `arch`). Returns a NEW object.
 */
export function upsertMeshRegistration(viewerAnnotations, meshStudyId, entry) {
  if (!meshStudyId) throw new Error('meshStudyId required');
  if (!isValidRegistrationEntry(entry)) throw new Error('Invalid registration entry');
  const prev = viewerAnnotations && typeof viewerAnnotations === 'object' ? viewerAnnotations : {};
  return {
    ...prev,
    [MESH_REGISTRATIONS_KEY]: {
      ...(prev[MESH_REGISTRATIONS_KEY] || {}),
      [meshStudyId]: entry,
    },
  };
}

export function getMeshRegistration(viewerAnnotations, meshStudyId) {
  const entry = viewerAnnotations?.[MESH_REGISTRATIONS_KEY]?.[meshStudyId];
  return isValidRegistrationEntry(entry) ? entry : null;
}
