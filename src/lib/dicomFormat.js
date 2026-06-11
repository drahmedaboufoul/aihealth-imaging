/*
 * dicomFormat — pure display formatters for DICOM header values.
 *
 * Extracted from DicomViewerPage so the logic is reusable and unit-testable
 * without importing the Cornerstone-backed page component.
 */

/**
 * Format a DICOM Person Name (PN) value for display.
 * PN components are caret-separated: "Family^Given^Middle^Prefix^Suffix".
 * Empty components are dropped.
 * @param {string|null|undefined} name
 * @returns {string|null}
 */
export function formatPatientName(name) {
  if (!name) return null;
  return name.split('^').filter(Boolean).join(' ');
}

/**
 * Format a DICOM DA (date) value "YYYYMMDD" as ISO-ish "YYYY-MM-DD".
 * Values that are too short to be a DA are returned unchanged.
 * @param {string|null|undefined} yyyymmdd
 * @returns {string|null|undefined}
 */
export function formatDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length < 8) return yyyymmdd;
  return `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`;
}
