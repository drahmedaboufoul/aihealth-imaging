/*
 * Signed surface deviation (mm) of a test scan against a reference scan.
 *
 * For every test vertex we take the closest point on the reference surface
 * (BVH) and sign the distance with the reference's outward normal there:
 * positive = test lies outside the reference (material added / swelling),
 * negative = inside (material lost / recession). Vertices farther than
 * `maxDistance` have no counterpart (NaN) and are drawn grey.
 */
import type { Mat4, MeshData } from './types';
import type { SpatialMesh } from './spatial';
import { vertexAreas } from './meshData';

export interface DeviationOptions {
  /** Search radius in mm; beyond it a vertex has no counterpart. */
  maxDistance?: number;
  /** Flip the sign convention (if the reference normals point inwards). */
  invertSign?: boolean;
}

export interface ToleranceBand {
  /** Half-width of the band in mm (e.g. 0.1 means +/-0.1 mm). */
  tolerance: number;
  /** Fraction (0..1) of the matched surface area inside the band. */
  areaFraction: number;
  /** Fraction (0..1) of matched vertices inside the band. */
  vertexFraction: number;
}

export interface DeviationStats {
  vertices: number;
  matched: number;
  noData: number;
  min: number;
  max: number;
  mean: number;
  meanAbs: number;
  rms: number;
  std: number;
  p05: number;
  p50: number;
  p95: number;
  bands: ToleranceBand[];
}

export interface DeviationResult {
  values: Float32Array;
  stats: DeviationStats;
  elapsedMs: number;
}

export const DEFAULT_BANDS = [0.05, 0.1, 0.2];

function quantile(sorted: Float32Array, q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function deviationStats(values: Float32Array, areas?: Float64Array | null, bands: number[] = DEFAULT_BANDS): DeviationStats {
  let matched = 0, sum = 0, sumAbs = 0, sumSq = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    matched++; sum += v; sumAbs += Math.abs(v); sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const finite = new Float32Array(matched);
  let k = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) finite[k++] = values[i];
  finite.sort();
  const mean = matched ? sum / matched : NaN;
  const bandOut: ToleranceBand[] = bands.map((tolerance) => {
    let inV = 0, inA = 0, totA = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      const a = areas ? areas[i] : 1;
      totA += a;
      if (Math.abs(v) <= tolerance + 1e-12) { inV++; inA += a; }
    }
    return { tolerance, areaFraction: totA ? inA / totA : 0, vertexFraction: matched ? inV / matched : 0 };
  });
  return {
    vertices: values.length,
    matched,
    noData: values.length - matched,
    min: matched ? min : NaN,
    max: matched ? max : NaN,
    mean,
    meanAbs: matched ? sumAbs / matched : NaN,
    rms: matched ? Math.sqrt(sumSq / matched) : NaN,
    std: matched ? Math.sqrt(Math.max(0, sumSq / matched - mean * mean)) : NaN,
    p05: quantile(finite, 0.05),
    p50: quantile(finite, 0.5),
    p95: quantile(finite, 0.95),
    bands: bandOut,
  };
}

/**
 * @param ref       reference surface (spatial index in its local frame)
 * @param test      test mesh in its local frame
 * @param testToRef rigid transform taking test-local points into ref-local
 */
export function computeDeviation(ref: SpatialMesh, test: MeshData, testToRef: Mat4, options: DeviationOptions = {}, bands = DEFAULT_BANDS): DeviationResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const maxDistance = options.maxDistance ?? 1;
  const sign = options.invertSign ? -1 : 1;
  const P = test.positions;
  const n = P.length / 3;
  const values = new Float32Array(n);
  const M = testToRef;
  const hit = { point: [0, 0, 0], normal: [0, 0, 0] } as unknown as Parameters<SpatialMesh['closest']>[4];
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const h = ref.closest(
      M[0] * x + M[4] * y + M[8] * z + M[12],
      M[1] * x + M[5] * y + M[9] * z + M[13],
      M[2] * x + M[6] * y + M[10] * z + M[14],
      maxDistance, hit,
    );
    values[i] = h ? sign * h.signed : NaN;
  }
  const stats = deviationStats(values, vertexAreas(test), bands);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { values, stats, elapsedMs: t1 - t0 };
}

export interface Histogram {
  min: number;
  max: number;
  binWidth: number;
  counts: Uint32Array;
  below: number;
  above: number;
  noData: number;
}

export function histogram(values: Float32Array, min: number, max: number, bins: number): Histogram {
  const counts = new Uint32Array(bins);
  const w = (max - min) / bins;
  let below = 0, above = 0, noData = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { noData++; continue; }
    if (v < min) { below++; continue; }
    if (v > max) { above++; continue; }
    let b = Math.floor((v - min) / w);
    if (b >= bins) b = bins - 1;
    counts[b]++;
  }
  return { min, max, binWidth: w, counts, below, above, noData };
}
