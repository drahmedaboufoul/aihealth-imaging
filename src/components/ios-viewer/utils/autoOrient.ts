/*
 * autoOrient — compute a single rotation matrix that aligns a set of dental
 * scan meshes to a sensible viewing orientation.
 *
 * Why we need this: real intraoral STLs come out of the scanner in whatever
 * coordinate system the device or export tool used (Trios, iTero, exocad,
 * 3Shape are all different). A fresh-loaded case is usually lying on its
 * side, sometimes inverted, sometimes rolled 30°. The user's first reaction
 * is "where is my arch" — they have to orbit around just to find it.
 *
 * Approach: PCA (Principal Component Analysis) on a subsampled point cloud
 * across ALL meshes in the case. The three eigenvectors of the covariance
 * matrix give the three principal axes of the geometry:
 *
 *   axis0 (largest eigenvalue)   ≈ mesial-distal     (length of the arch)
 *   axis1 (middle eigenvalue)    ≈ buccal-lingual    (width)
 *   axis2 (smallest eigenvalue)  ≈ occlusal-gingival (height — normal to
 *                                   the occlusal plane)
 *
 * We build a rotation that maps:
 *   axis0 -> world X (left-right across the screen)
 *   axis2 -> world Y (up — out of the occlusal plane)
 *   axis1 -> world Z (depth — toward the viewer)
 *
 * That gives the standard "looking at the arch from above" view, which is
 * what dental workflows expect. The user can still orbit freely after; this
 * is just the *initial* orientation.
 *
 * Same transform is applied to every mesh in the case so upper + lower stay
 * registered to each other. We do NOT try to auto-flip based on role
 * (maxilla vs mandible) because the eigenvector direction is ambiguous and
 * a wrong flip is more annoying than a 180° rotate-with-the-mouse.
 *
 * Confidence guard: if the smallest two eigenvalues are very close, the
 * geometry has no clear "thinnest" axis (e.g. a sphere of points) and PCA
 * is unstable. In that case we return identity — better to leave the mesh
 * alone than rotate it to a random orientation.
 */

import * as THREE from 'three';

const MAX_SAMPLES = 8000;          // total samples across all meshes
const MIN_EIG_RATIO = 1.15;        // smallest eigenvalue must be < middle / 1.15

interface PCAResult {
  transform: THREE.Matrix4;        // rotation + translation that orients the case
  confident: boolean;              // false if eigenvalues are too close to be meaningful
  centroid: THREE.Vector3;
}

/**
 * Compute auto-orient transform from a list of geometries. Returns a single
 * Matrix4 to be applied uniformly to all of them so the case stays
 * registered.
 */
export function computeAutoOrient(geometries: THREE.BufferGeometry[]): PCAResult {
  if (!geometries || geometries.length === 0) {
    return { transform: new THREE.Matrix4(), confident: false, centroid: new THREE.Vector3() };
  }

  // Total vertex count across all geometries
  let totalVerts = 0;
  for (const g of geometries) {
    totalVerts += (g.attributes.position?.count) || 0;
  }
  if (totalVerts < 100) {
    return { transform: new THREE.Matrix4(), confident: false, centroid: new THREE.Vector3() };
  }

  const stride = Math.max(1, Math.floor(totalVerts / MAX_SAMPLES));

  // First pass: centroid
  let cx = 0, cy = 0, cz = 0, n = 0;
  for (const g of geometries) {
    const pos = g.attributes.position.array as ArrayLike<number>;
    const count = g.attributes.position.count;
    for (let i = 0; i < count; i += stride) {
      cx += pos[i * 3];
      cy += pos[i * 3 + 1];
      cz += pos[i * 3 + 2];
      n++;
    }
  }
  if (n < 50) {
    return { transform: new THREE.Matrix4(), confident: false, centroid: new THREE.Vector3() };
  }
  cx /= n; cy /= n; cz /= n;
  const centroid = new THREE.Vector3(cx, cy, cz);

  // Second pass: covariance matrix (symmetric, so 6 unique entries)
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
  for (const g of geometries) {
    const pos = g.attributes.position.array as ArrayLike<number>;
    const count = g.attributes.position.count;
    for (let i = 0; i < count; i += stride) {
      const x = pos[i * 3] - cx;
      const y = pos[i * 3 + 1] - cy;
      const z = pos[i * 3 + 2] - cz;
      cxx += x * x;
      cxy += x * y;
      cxz += x * z;
      cyy += y * y;
      cyz += y * z;
      czz += z * z;
    }
  }
  cxx /= n; cxy /= n; cxz /= n; cyy /= n; cyz /= n; czz /= n;

  // Solve eigendecomposition via Jacobi rotation (3x3 symmetric)
  const eig = jacobiEigen3([
    cxx, cxy, cxz,
    cxy, cyy, cyz,
    cxz, cyz, czz,
  ]);

  // eig.values sorted descending; eig.vectors[i] corresponds to eig.values[i].
  const e0 = eig.values[0];   // largest
  const e1 = eig.values[1];   // middle
  const e2 = eig.values[2];   // smallest
  const v0 = eig.vectors[0];  // mesial-distal axis (length)
  const v1 = eig.vectors[1];  // buccal-lingual axis (width)
  const v2 = eig.vectors[2];  // occlusal-gingival axis (height — out of plane)

  // Confidence: the smallest axis must be meaningfully smaller than the
  // middle axis. A sphere-like point cloud would have e0≈e1≈e2 and PCA
  // would orient randomly.
  const confident = e1 > 0 && e1 / Math.max(e2, 1e-6) >= MIN_EIG_RATIO;

  // Build a right-handed orthonormal basis: x=v0, y=v2, z=v1.
  // (We swap the middle and smallest so axis2 -> Y, the "up" axis we want.)
  const xAxis = v0.clone().normalize();
  const yAxis = v2.clone().normalize();
  let zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis); // ensures right-handed
  if (zAxis.lengthSq() < 1e-8) {
    return { transform: new THREE.Matrix4(), confident: false, centroid };
  }
  zAxis.normalize();
  // Recompute yAxis from cross to guarantee orthogonality (numerical hygiene)
  const yFinal = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();

  // We want: applying transform to a vertex p sends p.local = R^T * (p - centroid)
  // where the columns of R are (xAxis, yFinal, zAxis) in world coords.
  // Build R, then take its transpose for the inverse rotation.
  const R = new THREE.Matrix4().makeBasis(xAxis, yFinal, zAxis);
  const Rinv = new THREE.Matrix4().copy(R).transpose();

  // Compose: T_origin then R_inverse (right-to-left in matrix * matrix order)
  const Tneg = new THREE.Matrix4().makeTranslation(-cx, -cy, -cz);
  const transform = new THREE.Matrix4().multiplyMatrices(Rinv, Tneg);

  return { transform, confident, centroid };
}

/**
 * Jacobi rotation method for the eigenvalues / eigenvectors of a real
 * symmetric 3x3 matrix. Stable, no library dependency.
 *
 * Input: 9-element row-major flat array (m[0..8]) representing a 3x3
 *        matrix. Must be symmetric (m[1]==m[3], m[2]==m[6], m[5]==m[7]).
 * Returns: { values: [e0,e1,e2] descending, vectors: [Vector3,Vector3,Vector3] }
 */
function jacobiEigen3(m: number[]): { values: number[]; vectors: THREE.Vector3[] } {
  // Working symmetric matrix (mutated)
  const A = [
    [m[0], m[1], m[2]],
    [m[3], m[4], m[5]],
    [m[6], m[7], m[8]],
  ];
  // Eigenvector matrix V starts as identity
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < 50; sweep++) {
    // Sum of off-diagonal absolute values
    const off = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]);
    if (off < 1e-12) break;

    // Iterate the three off-diagonal pairs (0,1), (0,2), (1,2)
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as [number, number][]) {
      const apq = A[p][q];
      if (Math.abs(apq) < 1e-14) continue;

      const app = A[p][p];
      const aqq = A[q][q];
      const theta = (aqq - app) / (2 * apq);
      const t = theta >= 0
        ? 1 / (theta + Math.sqrt(1 + theta * theta))
        : 1 / (theta - Math.sqrt(1 + theta * theta));
      const c = 1 / Math.sqrt(1 + t * t);
      const s = t * c;

      A[p][p] = app - t * apq;
      A[q][q] = aqq + t * apq;
      A[p][q] = 0;
      A[q][p] = 0;

      // Rotate the other elements
      for (let i = 0; i < 3; i++) {
        if (i !== p && i !== q) {
          const aip = A[i][p];
          const aiq = A[i][q];
          A[i][p] = c * aip - s * aiq;
          A[i][q] = s * aip + c * aiq;
          A[p][i] = A[i][p];
          A[q][i] = A[i][q];
        }
        // Rotate V columns p, q
        const vip = V[i][p];
        const viq = V[i][q];
        V[i][p] = c * vip - s * viq;
        V[i][q] = s * vip + c * viq;
      }
    }
  }

  const eigs = [
    { value: A[0][0], vec: new THREE.Vector3(V[0][0], V[1][0], V[2][0]) },
    { value: A[1][1], vec: new THREE.Vector3(V[0][1], V[1][1], V[2][1]) },
    { value: A[2][2], vec: new THREE.Vector3(V[0][2], V[1][2], V[2][2]) },
  ];
  eigs.sort((a, b) => b.value - a.value); // descending

  return {
    values: eigs.map((e) => e.value),
    vectors: eigs.map((e) => e.vec),
  };
}
