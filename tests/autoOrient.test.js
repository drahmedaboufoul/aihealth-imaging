import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeAutoOrient } from '../src/components/ios-viewer/utils/autoOrient';

/** Deterministic LCG so test geometry is reproducible. */
function makeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/**
 * Build a BufferGeometry of `count` points filling a box with the given
 * half-extents, rotated by `rotation` (Euler) and shifted by `offset`.
 */
function makePointCloud({ count = 3000, extents = [5, 2.5, 0.5], rotation = null, offset = [0, 0, 0], seed = 42 }) {
  const rng = makeRng(seed);
  const positions = new Float32Array(count * 3);
  const m = new THREE.Matrix4();
  if (rotation) m.makeRotationFromEuler(new THREE.Euler(...rotation));
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.set(
      (rng() * 2 - 1) * extents[0],
      (rng() * 2 - 1) * extents[1],
      (rng() * 2 - 1) * extents[2],
    );
    v.applyMatrix4(m);
    positions[i * 3] = v.x + offset[0];
    positions[i * 3 + 1] = v.y + offset[1];
    positions[i * 3 + 2] = v.z + offset[2];
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geom;
}

function transformedExtents(geometries, transform) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const v = new THREE.Vector3();
  for (const g of geometries) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(transform);
      min.min(v);
      max.max(v);
    }
  }
  return [max.x - min.x, max.y - min.y, max.z - min.z];
}

describe('computeAutoOrient — PCA initial orientation', () => {
  it('returns identity and low confidence for no geometry', () => {
    for (const input of [[], null, undefined]) {
      const { transform, confident } = computeAutoOrient(input);
      expect(confident).toBe(false);
      expect(transform.equals(new THREE.Matrix4())).toBe(true);
    }
  });

  it('returns identity and low confidence below the vertex threshold', () => {
    const tiny = makePointCloud({ count: 50 });
    const { transform, confident } = computeAutoOrient([tiny]);
    expect(confident).toBe(false);
    expect(transform.equals(new THREE.Matrix4())).toBe(true);
  });

  it('maps an arbitrarily rotated arch-like cloud to X=length, Y=height, Z=width', () => {
    // Half-extents 5 / 2.5 / 0.5: clearly distinct principal axes,
    // rotated to an awkward orientation and shifted away from the origin.
    const geom = makePointCloud({
      extents: [5, 2.5, 0.5],
      rotation: [0.7, -1.1, 0.4],
      offset: [120, -45, 30],
    });
    const { transform, confident, centroid } = computeAutoOrient([geom]);
    expect(confident).toBe(true);
    // Centroid reported in original (pre-transform) coordinates
    expect(centroid.x).toBeCloseTo(120, 0);
    expect(centroid.y).toBeCloseTo(-45, 0);
    expect(centroid.z).toBeCloseTo(30, 0);

    const [ex, ey, ez] = transformedExtents([geom], transform);
    // Longest axis -> X, thinnest -> Y (occlusal "up"), middle -> Z
    expect(ex).toBeGreaterThan(ez);
    expect(ez).toBeGreaterThan(ey);
    expect(ex).toBeCloseTo(10, 0);
    expect(ey).toBeCloseTo(1, 0);
    expect(ez).toBeCloseTo(5, 0);
  });

  it('moves the case centroid to the origin', () => {
    const geom = makePointCloud({
      extents: [5, 2.5, 0.5],
      rotation: [0.3, 0.9, -0.5],
      offset: [42, 17, -88],
    });
    const { transform } = computeAutoOrient([geom]);
    // Mean of transformed points should be ~origin
    const pos = geom.attributes.position;
    const v = new THREE.Vector3();
    const mean = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      mean.add(v.fromBufferAttribute(pos, i).applyMatrix4(transform));
    }
    mean.divideScalar(pos.count);
    expect(mean.length()).toBeLessThan(0.5);
  });

  it('keeps multiple meshes registered with one shared transform', () => {
    const upper = makePointCloud({
      extents: [5, 2.5, 0.5],
      rotation: [0.2, 0.4, 0.1],
      offset: [10, 5, 0],
      seed: 1,
    });
    const lower = makePointCloud({
      extents: [5, 2.5, 0.5],
      rotation: [0.2, 0.4, 0.1],
      offset: [10, 5, -2],
      seed: 2,
    });
    const { transform, confident } = computeAutoOrient([upper, lower]);
    expect(confident).toBe(true);
    const [ex, ey, ez] = transformedExtents([upper, lower], transform);
    expect(ex).toBeGreaterThan(ez);
    expect(ez).toBeGreaterThan(ey);
  });

  it('produces a proper rotation (orthonormal, det = +1)', () => {
    const geom = makePointCloud({ extents: [5, 2.5, 0.5], rotation: [1.2, 0.3, -0.7] });
    const { transform } = computeAutoOrient([geom]);
    // Determinant of an affine rigid transform equals the rotation det
    expect(transform.determinant()).toBeCloseTo(1, 6);
    // Rotation rows orthonormal
    const e = transform.elements; // column-major
    const rows = [
      new THREE.Vector3(e[0], e[4], e[8]),
      new THREE.Vector3(e[1], e[5], e[9]),
      new THREE.Vector3(e[2], e[6], e[10]),
    ];
    for (const r of rows) expect(r.length()).toBeCloseTo(1, 6);
    expect(rows[0].dot(rows[1])).toBeCloseTo(0, 6);
    expect(rows[0].dot(rows[2])).toBeCloseTo(0, 6);
    expect(rows[1].dot(rows[2])).toBeCloseTo(0, 6);
  });

  it('reports low confidence for direction-less (sphere-like) geometry', () => {
    // Equal extents in all directions -> eigenvalues nearly equal -> PCA
    // orientation is meaningless and must not be trusted.
    const blob = makePointCloud({ extents: [3, 3, 3] });
    const { confident } = computeAutoOrient([blob]);
    expect(confident).toBe(false);
  });
});
