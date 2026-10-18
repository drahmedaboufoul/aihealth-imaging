/* global process */
/*
 * CORS for the imaging api/* routes. Never "*": only origins on the
 * ALLOWED_ORIGINS allowlist (comma-separated, exact origins) get an
 * Access-Control-Allow-Origin echo. Unset → the production viewer and the
 * staff EMR. The viewer itself calls these routes same-origin, so it needs
 * no CORS grant at all.
 */

export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'https://aihealth-imaging.vercel.app',
  'https://staff.aihealthmc.ae',
]);

/** Parse the allowlist; entries are normalized to their URL origin. */
export function allowedOrigins(raw = process.env.ALLOWED_ORIGINS) {
  const list = String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try { return new URL(entry).origin; } catch { return null; }
    })
    .filter((origin) => origin && origin !== 'null');
  return list.length ? list : [...DEFAULT_ALLOWED_ORIGINS];
}

/**
 * Apply CORS headers for this request. Returns false for a preflight from a
 * disallowed origin (the caller answers 403); true otherwise.
 */
export function applyCors(req, res, { methods = 'POST, OPTIONS', headers = 'Content-Type' } = {}) {
  const origin = req.headers?.origin;
  res.setHeader('Vary', 'Origin');
  const allowed = typeof origin === 'string' && allowedOrigins().includes(origin);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', headers);
    res.setHeader('Access-Control-Max-Age', '600');
  }
  return allowed || req.method !== 'OPTIONS';
}
