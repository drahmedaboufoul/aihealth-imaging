/*
 * Measurement records and the JSON file format
 * (`measurements-YYYY-MM-DD.json`, schema "aihealth.ios-workbench.measurements/v1").
 *
 * Points are stored in the scan's NATIVE frame (millimetres, before any
 * display alignment), tied to the exact geometry by the version's output
 * SHA-256. No patient name, study id or file id is ever written.
 */
import type { Vec3 } from './types';

export const MEASUREMENTS_SCHEMA = 'aihealth.ios-workbench.measurements/v1';

export type MeasurementKind = 'distance' | 'angle' | 'surface-path' | 'area' | 'section-distance' | 'section-width' | 'section-height';

export interface MeasurementRecord {
  id: string;
  kind: MeasurementKind;
  /** Neutral scan slot letter, e.g. "A". */
  slot: string;
  /** Version the points were picked on. */
  versionId: string;
  /** outputSha256 of that version (ties the points to the exact geometry). */
  versionSha256: string;
  /** Picked points (native mm). Area: lasso polygon is in `meta`, not here. */
  points: Vec3[];
  value: number;
  unit: 'mm' | 'deg' | 'mm2';
  /** How the value was computed, e.g. "euclidean", "edge-path-dijkstra". */
  method: string;
  label?: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export interface MeasurementsFile {
  schema: typeof MEASUREMENTS_SCHEMA;
  exportedAt: string;
  frame: 'scan-native-mm';
  /** Free-text app identifier; never a patient or study identifier. */
  generator: string;
  measurements: MeasurementRecord[];
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Angle at vertex b of a-b-c, degrees. */
export function angleDeg(a: Vec3, b: Vec3, c: Vec3): number {
  const u = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const lu = Math.hypot(u[0], u[1], u[2]), lv = Math.hypot(v[0], v[1], v[2]);
  if (!(lu > 0 && lv > 0)) return NaN;
  const cos = Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

export function buildMeasurementsFile(measurements: MeasurementRecord[], now: Date = new Date()): MeasurementsFile {
  return {
    schema: MEASUREMENTS_SCHEMA,
    exportedAt: now.toISOString(),
    frame: 'scan-native-mm',
    generator: 'aihealth-imaging ios-workbench v1',
    measurements: measurements.map((m) => JSON.parse(JSON.stringify(m))),
  };
}

const KINDS: MeasurementKind[] = ['distance', 'angle', 'surface-path', 'area', 'section-distance', 'section-width', 'section-height'];
const UNITS = ['mm', 'deg', 'mm2'];

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Validate an imported file. Throws a readable error; never trusts unknown fields. */
export function parseMeasurementsFile(text: string): MeasurementsFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('Not a JSON file.'); }
  const f = raw as Partial<MeasurementsFile>;
  if (!f || f.schema !== MEASUREMENTS_SCHEMA) throw new Error('Not an IOS workbench measurements file (schema mismatch).');
  if (!Array.isArray(f.measurements)) throw new Error('The file has no measurements list.');
  const measurements: MeasurementRecord[] = f.measurements.map((m, i) => {
    const r = m as Partial<MeasurementRecord>;
    if (!r || typeof r !== 'object') throw new Error(`Measurement ${i + 1} is not an object.`);
    if (!KINDS.includes(r.kind as MeasurementKind)) throw new Error(`Measurement ${i + 1} has an unknown kind.`);
    if (!UNITS.includes(String(r.unit))) throw new Error(`Measurement ${i + 1} has an unknown unit.`);
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) throw new Error(`Measurement ${i + 1} has no numeric value.`);
    if (!Array.isArray(r.points) || !r.points.every(isVec3)) throw new Error(`Measurement ${i + 1} has invalid points.`);
    if (typeof r.slot !== 'string' || !/^[A-Z]$/.test(r.slot)) throw new Error(`Measurement ${i + 1} has an invalid scan slot.`);
    if (typeof r.versionSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.versionSha256)) throw new Error(`Measurement ${i + 1} has an invalid version hash.`);
    return {
      id: typeof r.id === 'string' ? r.id.slice(0, 64) : `m-${i + 1}`,
      kind: r.kind as MeasurementKind,
      slot: r.slot,
      versionId: typeof r.versionId === 'string' ? r.versionId.slice(0, 32) : '',
      versionSha256: r.versionSha256,
      points: r.points as Vec3[],
      value: r.value,
      unit: r.unit as MeasurementRecord['unit'],
      method: typeof r.method === 'string' ? r.method.slice(0, 64) : 'unknown',
      label: typeof r.label === 'string' ? r.label.slice(0, 120) : undefined,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
      meta: r.meta && typeof r.meta === 'object' ? JSON.parse(JSON.stringify(r.meta)) : undefined,
    };
  });
  return {
    schema: MEASUREMENTS_SCHEMA,
    exportedAt: typeof f.exportedAt === 'string' ? f.exportedAt : '',
    frame: 'scan-native-mm',
    generator: typeof f.generator === 'string' ? f.generator.slice(0, 80) : 'unknown',
    measurements,
  };
}

export function formatValue(m: Pick<MeasurementRecord, 'value' | 'unit'>): string {
  if (m.unit === 'deg') return `${m.value.toFixed(1)}°`;
  if (m.unit === 'mm2') return `${m.value.toFixed(2)} mm²`;
  return `${m.value.toFixed(2)} mm`;
}
