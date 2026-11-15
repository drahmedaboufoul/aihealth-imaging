import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateToken,
  shareUrlForToken,
  resolveViewerBase,
  computeExpiry,
  clampMaxViews,
  isValidEmail,
  VALIDITY_UNITS,
  PERMISSIONS,
  SHARE_MAX_VALIDITY_MS,
  SHARE_MAX_VIEWS,
  SHARE_DEFAULT_VIEWS,
} from '../src/lib/shareInvite';
import * as serverShare from '../api/_clinicalMediaShare.js';

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
  it('falls back to window.location.origin outside production builds (dev/test only)', () => {
    vi.stubGlobal('window', { location: { origin: 'https://imaging.example.com' } });
    expect(shareUrlForToken('abc123')).toBe('https://imaging.example.com/viewer/share/abc123');
  });
  it('honors an explicit base (canonical public domain override)', () => {
    expect(shareUrlForToken('abc123', 'https://imaging.aihealthmc.ae'))
      .toBe('https://imaging.aihealthmc.ae/viewer/share/abc123');
  });
  it('strips a trailing slash on the base', () => {
    expect(shareUrlForToken('t', 'https://x.ae/')).toBe('https://x.ae/viewer/share/t');
  });
});

describe('computeExpiry', () => {
  const NOW = Date.UTC(2026, 6, 13, 12, 0, 0); // fixed base

  it('adds hours/days from a fixed now', () => {
    expect(computeExpiry(6, 'hours', NOW)).toBe(new Date(NOW + 6 * 3600 * 1000).toISOString());
    expect(computeExpiry(7, 'days', NOW)).toBe(new Date(NOW + 7 * 86400 * 1000).toISOString());
  });

  it('caps validity at 7 days whatever the amount or unit', () => {
    const cap = new Date(NOW + 7 * 86400 * 1000).toISOString();
    expect(computeExpiry(8, 'days', NOW)).toBe(cap);
    expect(computeExpiry(365, 'days', NOW)).toBe(cap);
    expect(computeExpiry(200, 'hours', NOW)).toBe(cap);
    expect(computeExpiry(1, 'months', NOW)).toBe(new Date(NOW + 86400 * 1000).toISOString()); // unknown unit -> days
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
  it('exposes view + export permissions and hour/day units (no months)', () => {
    expect(PERMISSIONS.map((p) => p.value)).toEqual(['view', 'export']);
    expect(VALIDITY_UNITS.map((u) => u.value)).toEqual(['hours', 'days']);
    for (const u of VALIDITY_UNITS) expect(u.max * u.ms).toBe(SHARE_MAX_VALIDITY_MS);
  });
});

describe('view cap', () => {
  it('defaults to and caps at 20 views', () => {
    expect(SHARE_DEFAULT_VIEWS).toBe(20);
    expect(SHARE_MAX_VIEWS).toBe(20);
    expect(clampMaxViews(undefined)).toBe(20);
    expect(clampMaxViews(50)).toBe(20);
    expect(clampMaxViews(5)).toBe(5);
    expect(clampMaxViews(-3)).toBe(1);
    expect(clampMaxViews('7.9')).toBe(7);
  });
  it('matches the limits the resolver enforces', () => {
    expect(serverShare.SHARE_MAX_VALIDITY_MS).toBe(SHARE_MAX_VALIDITY_MS);
    expect(serverShare.SHARE_MAX_VIEWS).toBe(SHARE_MAX_VIEWS);
  });
});

describe('resolveViewerBase', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses VITE_PUBLIC_VIEWER_URL without a trailing slash', () => {
    expect(resolveViewerBase({ VITE_PUBLIC_VIEWER_URL: 'https://imaging.aihealthmc.ae/', PROD: true }))
      .toBe('https://imaging.aihealthmc.ae');
  });
  it('has no window.location fallback in production builds', () => {
    vi.stubGlobal('window', { location: { origin: 'https://preview-123.vercel.app' } });
    expect(resolveViewerBase({ PROD: true })).toBe('');
    expect(resolveViewerBase({ PROD: true, VITE_PUBLIC_VIEWER_URL: '  ' })).toBe('');
  });
  it('falls back to the current origin in dev', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5174' } });
    expect(resolveViewerBase({ PROD: false })).toBe('http://localhost:5174');
  });
});
