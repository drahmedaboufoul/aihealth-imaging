import { describe, it, expect } from 'vitest';
import { formatPatientName, formatDate } from '../src/lib/dicomFormat';

describe('formatPatientName', () => {
  it('joins DICOM PN caret components with spaces', () => {
    expect(formatPatientName('Doe^Jane')).toBe('Doe Jane');
    expect(formatPatientName('Doe^Jane^Marie')).toBe('Doe Jane Marie');
  });

  it('drops empty components (trailing carets are common in scanner output)', () => {
    expect(formatPatientName('Doe^Jane^^^')).toBe('Doe Jane');
    expect(formatPatientName('Doe^^Jane')).toBe('Doe Jane');
    expect(formatPatientName('^Doe^Jane')).toBe('Doe Jane');
  });

  it('passes through names without carets', () => {
    expect(formatPatientName('Jane Doe')).toBe('Jane Doe');
  });

  it('returns null for null/undefined/empty input', () => {
    expect(formatPatientName(null)).toBeNull();
    expect(formatPatientName(undefined)).toBeNull();
    expect(formatPatientName('')).toBeNull();
  });

  it('collapses a caret-only value to an empty string', () => {
    expect(formatPatientName('^^')).toBe('');
  });
});

describe('formatDate', () => {
  it('formats DICOM DA YYYYMMDD as YYYY-MM-DD', () => {
    expect(formatDate('20240131')).toBe('2024-01-31');
    expect(formatDate('19991231')).toBe('1999-12-31');
  });

  it('truncates datetime-style values to the date part', () => {
    expect(formatDate('20240131120000')).toBe('2024-01-31');
  });

  it('returns short values unchanged', () => {
    expect(formatDate('2024')).toBe('2024');
    expect(formatDate('')).toBe('');
  });

  it('passes through null/undefined', () => {
    expect(formatDate(null)).toBeNull();
    expect(formatDate(undefined)).toBeUndefined();
  });
});
