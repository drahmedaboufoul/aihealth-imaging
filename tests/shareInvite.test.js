import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateToken,
  shareUrlForToken,
  computeExpiry,
  isValidEmail,
  VALIDITY_UNITS,
  PERMISSIONS,
} from '../src/lib/shareInvite';

describe('generateToken', () => {
  beforeEach(() => {
    // jsdom-free: provide crypto + btoa in the node test env.
    vi.stubGlobal('crypto', {
      getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11) & 0xff; return arr; },
    });
    if (typeof globalThis.btoa !== 'function') {
      vi.stubGlobal('btoa', (s) => Buffer.from(s, 'binary').toString('base64'));
    }
  });
  afterEach(() => vi.unstubAllGlobals());

  it('produces a url-safe token with no +, / or = padding', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t).not.toMatch(/[+/=]/);
  });

  it('encodes 32 bytes → ~43 url-safe chars', () => {
    const t = generateToken();
    expect(t.length).toBeGreaterThanOrEqual(42);
    expect(t.length).toBeLessThanOrEqual(44);
  });
});

describe('shareUrlForToken', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('builds an absolute /viewer/share/<token> url from window.location.origin', () => {
    vi.stubGlobal('window', { location: { origin: 'https://imaging.example.com' } });
    expect(shareUrlForToken('abc123')).toBe('https://imaging.example.com/viewer/share/abc123');
  });
});

describe('computeExpiry', () => {
  const NOW = Date.UTC(2026, 6, 13, 12, 0, 0); // fixed base

  it('adds hours/days/months from a fixed now', () => {
    expect(computeExpiry(6, 'hours', NOW)).toBe(new Date(NOW + 6 * 3600 * 1000).toISOString());
    expect(computeExpiry(7, 'days', NOW)).toBe(new Date(NOW + 7 * 86400 * 1000).toISOString());
    expect(computeExpiry(1, 'months', NOW)).toBe(new Date(NOW + 30 * 86400 * 1000).toISOString());
  });

  it('clamps amounts below 1 up to 1', () => {
    expect(computeExpiry(0, 'days', NOW)).toBe(new Date(NOW + 86400 * 1000).toISOString());
    expect(computeExpiry(-5, 'days', NOW)).toBe(new Date(NOW + 86400 * 1000).toISOString());
  });

  it('floors fractional amounts', () => {
    expect(computeExpiry(2.9, 'days', NOW)).toBe(new Date(NOW + 2 * 86400 * 1000).toISOString());
  });

  it('defaults to days for an unknown unit', () => {
    expect(computeExpiry(3, 'weeks', NOW)).toBe(new Date(NOW + 3 * 86400 * 1000).toISOString());
  });
});

describe('isValidEmail', () => {
  it('accepts well-formed addresses', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('dr.jane+ref@clinic.example.com')).toBe(true);
  });
  it('rejects malformed / empty', () => {
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a @b.co')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });
});

describe('option tables', () => {
  it('exposes view + export permissions and hour/day/month units', () => {
    expect(PERMISSIONS.map((p) => p.value)).toEqual(['view', 'export']);
    expect(VALIDITY_UNITS.map((u) => u.value)).toEqual(['hours', 'days', 'months']);
  });
});
