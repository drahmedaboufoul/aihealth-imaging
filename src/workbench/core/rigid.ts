/*
 * Closed-form rigid registration of paired points (Horn 1987, unit
 * quaternions) used for the 3-point landmark pre-alignment and as the
 * point-to-point fallback inside ICP.
 */
import type { Mat4, Vec3 } from './types';
import { identity, transformPoint } from './mat4';

/** Jacobi eigen-decomposition of a symmetric n x n matrix (row-major). */
export function jacobiEigen(a: number[][]): { values: number[]; vectors: number[][] } {
  const n = a.length;
  const m = a.map((r) => r.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += m[i][j] * m[i][j];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(m[p][q]) < 1e-300) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const mkp = m[k][p], mkq = m[k][q];
          m[k][p] = c * mkp - s * mkq;
          m[k][q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < n; k++) {
          const mpk = m[p][k], mqk = m[q][k];
          m[p][k] = c * mpk - s * mqk;
          m[q][k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: m.map((r, i) => r[i]), vectors: v };
}

export interface RigidFit {
  /** Maps `moving` points onto `fixed` points. Column-major. */
  matrix: Mat4;
  /** RMS of the paired residuals after the fit (mm). */
  rms: number;
  /** Per-pair residual distances (mm). */
  residuals: number[];
}

/**
 * Least-squares rigid transform taking moving[i] -> fixed[i] (N >= 3,
 * not collinear). Optional per-pair weights.
 */
export function fitRigid(moving: Vec3[], fixed: Vec3[], weights?: number[]): RigidFit {
  const n = moving.length;
  if (n < 3 || fixed.length !== n) throw new Error('Rigid fit needs at least three point pairs.');
  let wsum = 0;
  const cm = [0, 0, 0], cf = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    wsum += w;
    for (let k = 0; k < 3; k++) { cm[k] += w * moving[i][k]; cf[k] += w * fixed[i][k]; }
  }
  for (let k = 0; k < 3; k++) { cm[k] /= wsum; cf[k] /= wsum; }
  // cross-covariance S = sum w (m - cm)(f - cf)^T
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    const a = [moving[i][0] - cm[0], moving[i][1] - cm[1], moving[i][2] - cm[2]];
    const b = [fixed[i][0] - cf[0], fixed[i][1] - cf[1], fixed[i][2] - cf[2]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += w * a[r] * b[c];
  }
  const [[Sxx, Sxy, Sxz], [Syx, Syy, Syz], [Szx, Szy, Szz]] = S;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const { values, vectors } = jacobiEigen(N);
  let best = 0;
  for (let i = 1; i < 4; i++) if (values[i] > values[best]) best = i;
  let q0 = vectors[0][best], qx = vectors[1][best], qy = vectors[2][best], qz = vectors[3][best];
  const ql = Math.hypot(q0, qx, qy, qz);
  q0 /= ql; qx /= ql; qy /= ql; qz /= ql;
  const R = [
    [q0 * q0 + qx * qx - qy * qy - qz * qz, 2 * (qx * qy - q0 * qz), 2 * (qx * qz + q0 * qy)],
    [2 * (qy * qx + q0 * qz), q0 * q0 - qx * qx + qy * qy - qz * qz, 2 * (qy * qz - q0 * qx)],
    [2 * (qz * qx - q0 * qy), 2 * (qz * qy + q0 * qx), q0 * q0 - qx * qx - qy * qy + qz * qz],
  ];
  const m = identity();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[c * 4 + r] = R[r][c];
  m[12] = cf[0] - (R[0][0] * cm[0] + R[0][1] * cm[1] + R[0][2] * cm[2]);
  m[13] = cf[1] - (R[1][0] * cm[0] + R[1][1] * cm[1] + R[1][2] * cm[2]);
  m[14] = cf[2] - (R[2][0] * cm[0] + R[2][1] * cm[1] + R[2][2] * cm[2]);
  const residuals = moving.map((p, i) => {
    const t = transformPoint(m, p);
    return Math.hypot(t[0] - fixed[i][0], t[1] - fixed[i][1], t[2] - fixed[i][2]);
  });
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n);
  return { matrix: m, rms, residuals };
}

/** True when three points are too close to collinear to define a frame. */
export function nearlyCollinear(p: Vec3[], minAreaMm2 = 1): boolean {
  if (p.length < 3) return true;
  const [a, b, c] = p;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
  return 0.5 * Math.hypot(cx, cy, cz) < minAreaMm2;
}
