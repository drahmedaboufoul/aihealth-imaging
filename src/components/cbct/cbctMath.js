/*
 * cbctMath — 3D geometry helpers for the CBCT viewer (implant ↔ nerve
 * distance checks). Extracted from CBCTViewerPage.jsx during the A0
 * monolith split — pure move, no behavior change.
 */

/**
 * Compute the minimum distance from a 3D line segment (a..b) to a
 * polyline (the nerve canal). Returns the smallest perpendicular
 * distance from any point on a..b to any segment of the polyline.
 * Used for implant-vs-nerve safety check.
 */
export function segmentToPolylineDistance(a, b, polyline) {
  if (!Array.isArray(polyline) || polyline.length < 2) return Infinity;
  let min = Infinity;
  // For each segment in the polyline, compute the closest distance
  // between the implant axis and that segment.
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = segmentToSegmentDistance(a, b, polyline[i], polyline[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

/**
 * 3D segment-to-segment minimum distance — based on the standard
 * "Real-Time Collision Detection" algorithm by Christer Ericson.
 */
export function segmentToSegmentDistance(p1, q1, p2, q2) {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r  = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s, t;
  const EPS = 1e-9;
  if (a <= EPS && e <= EPS) return len(sub(p1, p2));
  if (a <= EPS) { s = 0; t = clamp01(f / e); }
  else {
    const c = dot(d1, r);
    if (e <= EPS) { t = 0; s = clamp01(-c / a); }
    else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const c1 = add(p1, scale(d1, s));
  const c2 = add(p2, scale(d2, t));
  return len(sub(c1, c2));
}

const sub   = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add   = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot   = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const len   = (a) => Math.sqrt(dot(a, a));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
