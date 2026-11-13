/*
 * Iterative closest point refinement (point-to-plane, Chen & Medioni 1992)
 * with outlier rejection and a convergence report.
 *
 * - Correspondences: closest point on the fixed surface (BVH), with the
 *   interpolated outward normal there.
 * - Outliers: pairs farther than `maxCorrespondence`, farther than
 *   `outlierK` x median distance, or whose normals disagree by more than
 *   `normalAngleDeg` are ignored for that iteration.
 * - Step: linearised 6-DoF least squares; falls back to point-to-point
 *   (Horn) when the system is ill-conditioned (e.g. a flat patch).
 *
 * The result is a DRAFT transform: the UI must have a named person accept
 * it before it is used for anything other than display.
 */
import type { Mat4, MeshData } from './types';
import { fromRotationVector, multiply, orthonormalize, rotationAngleDeg, translationLength } from './mat4';
import { fitRigid } from './rigid';
import { sampleIndices } from './random';
import type { SpatialMesh } from './spatial';
import { computeVertexNormals } from './meshData';

export interface IcpOptions {
  maxIterations?: number;
  sampleCount?: number;
  seed?: number;
  /** Hard correspondence cap in mm. */
  maxCorrespondence?: number;
  /** Reject pairs whose distance exceeds k x median distance. */
  outlierK?: number;
  /** Reject pairs whose normals differ by more than this (degrees). */
  normalAngleDeg?: number;
  /** Converged when the RMS change and the step are below these. */
  tolerance?: number;
  method?: 'point-to-plane' | 'point-to-point';
}

export interface IcpIteration {
  iteration: number;
  rms: number;
  inliers: number;
  stepDeg: number;
  stepMm: number;
}

export interface IcpResult {
  matrix: Mat4;
  /** Final point-to-plane RMS over inliers (mm). */
  rms: number;
  /** Final point-to-point RMS over inliers (mm). */
  rmsPointToPoint: number;
  iterations: number;
  converged: boolean;
  inlierFraction: number;
  samples: number;
  method: 'point-to-plane' | 'point-to-point';
  reason: string;
  history: IcpIteration[];
  elapsedMs: number;
}

export const ICP_DEFAULTS: Required<IcpOptions> = {
  maxIterations: 60,
  sampleCount: 6000,
  seed: 1,
  maxCorrespondence: 2,
  outlierK: 3,
  normalAngleDeg: 60,
  tolerance: 1e-6,
  method: 'point-to-plane',
};

/** Solve a symmetric 6x6 system with partial pivoting. Returns null if singular. */
function solve6(A: Float64Array, b: Float64Array): Float64Array | null {
  const n = 6;
  const M = new Float64Array(n * 7);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) M[r * 7 + c] = A[r * 6 + c];
    M[r * 7 + 6] = b[r];
  }
  let maxDiag = 0;
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, Math.abs(A[i * 6 + i]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r * 7 + col]) > Math.abs(M[piv * 7 + col])) piv = r;
    if (Math.abs(M[piv * 7 + col]) < 1e-10 * Math.max(1, maxDiag)) return null;
    if (piv !== col) for (let c = 0; c < 7; c++) { const t = M[col * 7 + c]; M[col * 7 + c] = M[piv * 7 + c]; M[piv * 7 + c] = t; }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r * 7 + col] / M[col * 7 + col];
      if (f === 0) continue;
      for (let c = col; c < 7; c++) M[r * 7 + c] -= f * M[col * 7 + c];
    }
  }
  const x = new Float64Array(n);
  for (let r = 0; r < n; r++) x[r] = M[r * 7 + 6] / M[r * 7 + r];
  return x;
}

function median(values: Float64Array, count: number): number {
  const arr = values.slice(0, count).sort();
  if (count === 0) return 0;
  const mid = count >> 1;
  return count % 2 ? arr[mid] : 0.5 * (arr[mid - 1] + arr[mid]);
}

interface Pairs {
  count: number;
  p: Float64Array; // transformed moving points
  q: Float64Array; // closest fixed points
  n: Float64Array; // fixed normals
  d: Float64Array; // distances
}

function gatherPairs(
  fixed: SpatialMesh, moving: MeshData, movingNormals: Float32Array, samples: Uint32Array, T: Mat4,
  maxCorr: number, cosLimit: number, out: Pairs,
): void {
  const P = moving.positions;
  let k = 0;
  const hit = { point: [0, 0, 0], normal: [0, 0, 0] } as unknown as Parameters<SpatialMesh['closest']>[4];
  for (let s = 0; s < samples.length; s++) {
    const i = samples[s];
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const px = T[0] * x + T[4] * y + T[8] * z + T[12];
    const py = T[1] * x + T[5] * y + T[9] * z + T[13];
    const pz = T[2] * x + T[6] * y + T[10] * z + T[14];
    const h = fixed.closest(px, py, pz, maxCorr, hit);
    if (!h) continue;
    const mnx = movingNormals[i * 3], mny = movingNormals[i * 3 + 1], mnz = movingNormals[i * 3 + 2];
    const tnx = T[0] * mnx + T[4] * mny + T[8] * mnz;
    const tny = T[1] * mnx + T[5] * mny + T[9] * mnz;
    const tnz = T[2] * mnx + T[6] * mny + T[10] * mnz;
    if (tnx * h.normal[0] + tny * h.normal[1] + tnz * h.normal[2] < cosLimit) continue;
    out.p[k * 3] = px; out.p[k * 3 + 1] = py; out.p[k * 3 + 2] = pz;
    out.q[k * 3] = h.point[0]; out.q[k * 3 + 1] = h.point[1]; out.q[k * 3 + 2] = h.point[2];
    out.n[k * 3] = h.normal[0]; out.n[k * 3 + 1] = h.normal[1]; out.n[k * 3 + 2] = h.normal[2];
    out.d[k] = h.distance;
    k++;
  }
  out.count = k;
}

function residualStats(pairs: Pairs, threshold: number): { rmsPlane: number; rmsPoint: number; inliers: number } {
  let sPlane = 0, sPoint = 0, m = 0;
  for (let k = 0; k < pairs.count; k++) {
    if (pairs.d[k] > threshold) continue;
    const dx = pairs.p[k * 3] - pairs.q[k * 3], dy = pairs.p[k * 3 + 1] - pairs.q[k * 3 + 1], dz = pairs.p[k * 3 + 2] - pairs.q[k * 3 + 2];
    const r = dx * pairs.n[k * 3] + dy * pairs.n[k * 3 + 1] + dz * pairs.n[k * 3 + 2];
    sPlane += r * r; sPoint += dx * dx + dy * dy + dz * dz; m++;
  }
  return { rmsPlane: m ? Math.sqrt(sPlane / m) : NaN, rmsPoint: m ? Math.sqrt(sPoint / m) : NaN, inliers: m };
}

/**
 * Refine `initial` (moving-local -> fixed-local) so the moving surface lies
 * on the fixed surface.
 */
export function icp(fixed: SpatialMesh, moving: MeshData, initial: Mat4, options: IcpOptions = {}, movingNormals?: Float32Array): IcpResult {
  const o = { ...ICP_DEFAULTS, ...options };
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const normals = movingNormals ?? computeVertexNormals(moving.positions, moving.indices);
  const nV = moving.positions.length / 3;
  const samples = sampleIndices(nV, Math.min(o.sampleCount, nV), o.seed);
  const pairs: Pairs = {
    count: 0,
    p: new Float64Array(samples.length * 3), q: new Float64Array(samples.length * 3),
    n: new Float64Array(samples.length * 3), d: new Float64Array(samples.length),
  };
  const cosLimit = Math.cos((o.normalAngleDeg * Math.PI) / 180);
  let T = initial.slice();
  const history: IcpIteration[] = [];
  let prevRms = Infinity;
  let converged = false;
  let reason = 'maximum iterations reached';
  let usedMethod: 'point-to-plane' | 'point-to-point' = o.method;
  const A = new Float64Array(36), b = new Float64Array(6);

  for (let it = 1; it <= o.maxIterations; it++) {
    gatherPairs(fixed, moving, normals, samples, T, o.maxCorrespondence, cosLimit, pairs);
    if (pairs.count < 6) { reason = 'too few overlapping points — pre-align with landmarks first'; break; }
    const med = median(pairs.d, pairs.count);
    const threshold = Math.min(o.maxCorrespondence, Math.max(o.outlierK * med, 0.02));
    const stats = residualStats(pairs, threshold);
    if (stats.inliers < 6) { reason = 'too few inliers'; break; }

    let step: Mat4 | null = null;
    if (o.method === 'point-to-plane') {
      // Linearise about the inlier centroid for good conditioning.
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < pairs.count; k++) {
        if (pairs.d[k] > threshold) continue;
        cx += pairs.p[k * 3]; cy += pairs.p[k * 3 + 1]; cz += pairs.p[k * 3 + 2];
      }
      cx /= stats.inliers; cy /= stats.inliers; cz /= stats.inliers;
      A.fill(0); b.fill(0);
      for (let k = 0; k < pairs.count; k++) {
        if (pairs.d[k] > threshold) continue;
        const px = pairs.p[k * 3] - cx, py = pairs.p[k * 3 + 1] - cy, pz = pairs.p[k * 3 + 2] - cz;
        const nx = pairs.n[k * 3], ny = pairs.n[k * 3 + 1], nz = pairs.n[k * 3 + 2];
        const r = (pairs.p[k * 3] - pairs.q[k * 3]) * nx + (pairs.p[k * 3 + 1] - pairs.q[k * 3 + 1]) * ny + (pairs.p[k * 3 + 2] - pairs.q[k * 3 + 2]) * nz;
        const J = [py * nz - pz * ny, pz * nx - px * nz, px * ny - py * nx, nx, ny, nz];
        for (let i = 0; i < 6; i++) {
          b[i] -= J[i] * r;
          for (let j = 0; j < 6; j++) A[i * 6 + j] += J[i] * J[j];
        }
      }
      const x = solve6(A, b);
      if (x) {
        // S(p) = R (p - c) + c + t
        step = fromRotationVector([x[0], x[1], x[2]]);
        step[12] = cx + x[3] - (step[0] * cx + step[4] * cy + step[8] * cz);
        step[13] = cy + x[4] - (step[1] * cx + step[5] * cy + step[9] * cz);
        step[14] = cz + x[5] - (step[2] * cx + step[6] * cy + step[10] * cz);
      } else usedMethod = 'point-to-point';
    }
    if (!step) {
      const mv: [number, number, number][] = [], fx: [number, number, number][] = [];
      for (let k = 0; k < pairs.count; k++) {
        if (pairs.d[k] > threshold) continue;
        mv.push([pairs.p[k * 3], pairs.p[k * 3 + 1], pairs.p[k * 3 + 2]]);
        fx.push([pairs.q[k * 3], pairs.q[k * 3 + 1], pairs.q[k * 3 + 2]]);
      }
      step = fitRigid(mv, fx).matrix;
      if (o.method === 'point-to-point') usedMethod = 'point-to-point';
    }
    T = orthonormalize(multiply(step, T));
    const stepDeg = rotationAngleDeg(step), stepMm = translationLength(step);
    const rms = usedMethod === 'point-to-plane' ? stats.rmsPlane : stats.rmsPoint;
    history.push({ iteration: it, rms, inliers: stats.inliers, stepDeg, stepMm });
    if (Math.abs(prevRms - rms) < o.tolerance && stepDeg < 1e-5 && stepMm < 1e-6) {
      converged = true;
      reason = 'converged';
      break;
    }
    prevRms = rms;
  }

  // Final evaluation with the returned transform.
  gatherPairs(fixed, moving, normals, samples, T, o.maxCorrespondence, cosLimit, pairs);
  const med = median(pairs.d, pairs.count);
  const threshold = Math.min(o.maxCorrespondence, Math.max(o.outlierK * med, 0.02));
  const fin = residualStats(pairs, threshold);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    matrix: T,
    rms: fin.rmsPlane,
    rmsPointToPoint: fin.rmsPoint,
    iterations: history.length,
    converged,
    inlierFraction: samples.length ? fin.inliers / samples.length : 0,
    samples: samples.length,
    method: usedMethod,
    reason,
    history,
    elapsedMs: t1 - t0,
  };
}
