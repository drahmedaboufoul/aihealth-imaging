/*
 * Neutral export file names (follows the M0 rule: no patient names, study
 * ids or file ids in anything the viewer writes). Only a date, the scan
 * slot letter, the version number and the kind of export appear.
 */

/** YYYY-MM-DD in local time. */
export function isoDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const SAFE = /^[a-z0-9-]+$/;

function safePart(s: string): string {
  const v = String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!SAFE.test(v)) throw new Error('unsafe file name part');
  return v;
}

/** scan-2026-10-19-a-v2.stl */
export function meshExportName(slot: string, versionIndex: number, ext: 'stl' | 'ply', date: Date = new Date()): string {
  return `scan-${isoDate(date)}-${safePart(slot)}-v${Math.max(0, Math.floor(versionIndex))}.${ext}`;
}

/** scan-2026-10-19-deviation.png */
export function imageExportName(kind: string, date: Date = new Date()): string {
  return `scan-${isoDate(date)}-${safePart(kind)}.png`;
}

/** measurements-2026-10-19.json (the brief's name) */
export function measurementsExportName(date: Date = new Date()): string {
  return `measurements-${isoDate(date)}.json`;
}

/** True when a name follows the neutral pattern (used by tests and as a guard before download). */
export function isNeutralExportName(name: string): boolean {
  return /^(scan|measurements)-\d{4}-\d{2}-\d{2}(-[a-z0-9]+)*(-v\d+)?\.(stl|ply|png|json)$/.test(name);
}
