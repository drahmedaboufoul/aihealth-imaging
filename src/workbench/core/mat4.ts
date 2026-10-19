/*
 * Small column-major 4x4 matrix helpers (same element order as three.js) so
 * the core stays free of three.js object allocation in hot loops.
 */
import type { Mat4, Vec3 } from './types';

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** a * b (apply b first, then a). */
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Mat4 {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** Inverse of a rigid transform (rotation + translation). */
export function invertRigid(m: ArrayLike<number>): Mat4 {
  // R^T and -R^T t
  const out = identity();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[c * 4 + r] = m[r * 4 + c];
  const tx = m[12], ty = m[13], tz = m[14];
  out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
  out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
  out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
  return out;
}

/** General 4x4 inverse (for projection matrices). Returns null if singular. */
export function invertGeneral(m: ArrayLike<number>): Mat4 | null {
  const a = Array.from(m);
  const inv = new Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
  for (let i = 0; i < 16; i++) inv[i] /= det;
  return inv;
}

export function transformPoint(m: ArrayLike<number>, p: ArrayLike<number>): Vec3 {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

export function transformDirection(m: ArrayLike<number>, d: ArrayLike<number>): Vec3 {
  const x = d[0], y = d[1], z = d[2];
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}

/** Rotation (axis-angle vector, radians = |v|) + translation -> Mat4. */
export function fromRotationVector(rv: ArrayLike<number>, t: ArrayLike<number> = [0, 0, 0]): Mat4 {
  const ax = rv[0], ay = rv[1], az = rv[2];
  const angle = Math.hypot(ax, ay, az);
  const m = identity();
  if (angle > 1e-15) {
    const x = ax / angle, y = ay / angle, z = az / angle;
    const c = Math.cos(angle), s = Math.sin(angle), C = 1 - c;
    m[0] = x * x * C + c; m[4] = x * y * C - z * s; m[8] = x * z * C + y * s;
    m[1] = y * x * C + z * s; m[5] = y * y * C + c; m[9] = y * z * C - x * s;
    m[2] = z * x * C - y * s; m[6] = z * y * C + x * s; m[10] = z * z * C + c;
  }
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}

/** Rotation angle (degrees) of the rotation part of a rigid matrix. */
export function rotationAngleDeg(m: ArrayLike<number>): number {
  const tr = m[0] + m[5] + m[10];
  const c = Math.max(-1, Math.min(1, (tr - 1) / 2));
  return (Math.acos(c) * 180) / Math.PI;
}

export function translationLength(m: ArrayLike<number>): number {
  return Math.hypot(m[12], m[13], m[14]);
}

/** True when m is finite, orthonormal (det +1) with a [0,0,0,1] last row. */
export function isRigid(m: ArrayLike<number>, tol = 1e-4): boolean {
  if (!m || m.length !== 16) return false;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) return false;
  if (Math.abs(m[3]) > tol || Math.abs(m[7]) > tol || Math.abs(m[11]) > tol || Math.abs(m[15] - 1) > tol) return false;
  const cols = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const d = cols[i][0] * cols[j][0] + cols[i][1] * cols[j][1] + cols[i][2] * cols[j][2];
      if (Math.abs(d - (i === j ? 1 : 0)) > tol) return false;
    }
  }
  const det = cols[0][0] * (cols[1][1] * cols[2][2] - cols[1][2] * cols[2][1])
    - cols[1][0] * (cols[0][1] * cols[2][2] - cols[0][2] * cols[2][1])
    + cols[2][0] * (cols[0][1] * cols[1][2] - cols[0][2] * cols[1][1]);
  return Math.abs(det - 1) < tol;
}

/** Re-orthonormalise the rotation part (Gram-Schmidt) to stop drift. */
export function orthonormalize(m: Mat4): Mat4 {
  const out = m.slice();
  let x = [m[0], m[1], m[2]];
  let y = [m[4], m[5], m[6]];
  const nx = Math.hypot(x[0], x[1], x[2]);
  x = x.map((v) => v / nx);
  const d = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  y = [y[0] - d * x[0], y[1] - d * x[1], y[2] - d * x[2]];
  const ny = Math.hypot(y[0], y[1], y[2]);
  y = y.map((v) => v / ny);
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  out[0] = x[0]; out[1] = x[1]; out[2] = x[2]; out[3] = 0;
  out[4] = y[0]; out[5] = y[1]; out[6] = y[2]; out[7] = 0;
  out[8] = z[0]; out[9] = z[1]; out[10] = z[2]; out[11] = 0;
  out[15] = 1;
  return out;
}
