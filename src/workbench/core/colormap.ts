/*
 * Colour ramps for the deviation and contact maps (sRGB 0..1 triples).
 * The renderer converts to linear; legends use the same functions so the
 * legend always matches the mesh.
 */
import { contactBand, type ContactThresholds } from './contact';

export type RGB = [number, number, number];

export const NO_DATA: RGB = [0.62, 0.64, 0.67];

const DEV_STOPS: Array<[number, RGB]> = [
  [-1, [0.11, 0.25, 0.85]], // blue: below the reference
  [-0.5, [0.1, 0.72, 0.95]], // cyan
  [0, [0.2, 0.78, 0.35]], // green: on the reference
  [0.5, [0.98, 0.84, 0.12]], // yellow
  [1, [0.9, 0.12, 0.12]], // red: above the reference
];

function lerp(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Deviation colour. Values within +/-tolerance are flat green; outside, the
 * ramp runs from green at the tolerance edge to blue/red at +/-range.
 */
export function deviationColor(value: number, range: number, tolerance: number): RGB {
  if (!Number.isFinite(value)) return NO_DATA;
  if (Math.abs(value) <= tolerance) return DEV_STOPS[2][1];
  const span = Math.max(1e-9, range - tolerance);
  const s = Math.sign(value) * Math.min(1, (Math.abs(value) - tolerance) / span);
  for (let i = 0; i < DEV_STOPS.length - 1; i++) {
    const [x0, c0] = DEV_STOPS[i];
    const [x1, c1] = DEV_STOPS[i + 1];
    if (s >= x0 && s <= x1) return lerp(c0, c1, (s - x0) / (x1 - x0));
  }
  return s < 0 ? DEV_STOPS[0][1] : DEV_STOPS[DEV_STOPS.length - 1][1];
}

export const CONTACT_COLORS: Record<'contact' | 'near' | 'close', RGB> = {
  contact: [0.86, 0.1, 0.16],
  near: [0.98, 0.55, 0.1],
  close: [0.98, 0.86, 0.2],
};

/** Contact colour or null when the vertex is clear (keep the base colour). */
export function contactColor(d: number, t: ContactThresholds): RGB | null {
  const band = contactBand(d, t);
  return band === 'clear' ? null : CONTACT_COLORS[band];
}

export function hex(c: RGB): string {
  return `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Fill a linear-RGB colour buffer (three.js vertex colours) for a mapped
 * overlay. `values` is per topology vertex; `displayToTopo` (optional) maps
 * display vertices onto topology vertices.
 */
export function paintDeviation(
  out: Float32Array, values: Float32Array, range: number, tolerance: number, displayToTopo?: Uint32Array | null,
): void {
  const n = out.length / 3;
  for (let i = 0; i < n; i++) {
    const v = values[displayToTopo ? displayToTopo[i] : i];
    const c = deviationColor(v, range, tolerance);
    out[i * 3] = srgbToLinear(c[0]); out[i * 3 + 1] = srgbToLinear(c[1]); out[i * 3 + 2] = srgbToLinear(c[2]);
  }
}

export function paintContacts(
  out: Float32Array, values: Float32Array, t: ContactThresholds, base: RGB, displayToTopo?: Uint32Array | null,
): void {
  const n = out.length / 3;
  const bl: RGB = [srgbToLinear(base[0]), srgbToLinear(base[1]), srgbToLinear(base[2])];
  for (let i = 0; i < n; i++) {
    const c = contactColor(values[displayToTopo ? displayToTopo[i] : i], t);
    if (!c) { out[i * 3] = bl[0]; out[i * 3 + 1] = bl[1]; out[i * 3 + 2] = bl[2]; continue; }
    out[i * 3] = srgbToLinear(c[0]); out[i * 3 + 1] = srgbToLinear(c[1]); out[i * 3 + 2] = srgbToLinear(c[2]);
  }
}
