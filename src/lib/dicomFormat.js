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
  // Cornerstone metadata providers may hand back a parsed PN object
  // ({ Alphabetic: 'Family^Given' }) instead of the raw string.
  if (typeof name === 'object') name = name.Alphabetic || name.alphabetic || '';
  if (typeof name !== 'string' || !name) return null;
  return name.split('^').filter(Boolean).join(' ');
}

/**
 * Format a DICOM DA (date) value as ISO-ish "YYYY-MM-DD".
 * Accepts the raw "YYYYMMDD" string OR the parsed object shape that
 * Cornerstone's wadouri metadata provider returns (dicomParser.parseDA →
 * { year, month, day }). Values that are too short to be a DA are
 * returned unchanged.
 * @param {string|{year:number,month:number,day:number}|null|undefined} yyyymmdd
 * @returns {string|null|undefined}
 */
export function formatDate(yyyymmdd) {
  if (!yyyymmdd) return yyyymmdd;
  if (typeof yyyymmdd === 'object') {
    const { year, month, day } = yyyymmdd;
    if (year == null || month == null || day == null) return null;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (typeof yyyymmdd !== 'string' || yyyymmdd.length < 8) return yyyymmdd;
  return `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`;
}
