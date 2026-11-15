/*
 * shareInvite — create tokenized share links from inside a viewer.
 *
 * This is the DentalX "Invite" flow, built on our existing
 * imaging_share_invites table. A signed-in clinic member inserts a row
 * directly under RLS (insert policy: clinic_id ∈ my clinic assignments AND
 * created_by = auth.uid()); the token becomes a public /viewer/share/<token>
 * link that the SharedViewerPage resolves server-side.
 *
 * No RPC needed for the clinic path — the RLS policy is the guard. (The
 * patient-portal path uses a SECURITY DEFINER RPC because the patient has no
 * Supabase auth session; a clinician does.)
 */

import { supabase } from './supabase';

// 32 random bytes → url-safe base64 (matches the strength the patient-portal
// RPC expects for caller-supplied tokens).
export function generateToken() {
  const bytes = new Uint8Array(32);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The canonical public base URL that share links are minted on:
 * VITE_PUBLIC_VIEWER_URL (e.g. https://imaging.aihealthmc.ae) so links never
 * point at a Vercel preview host or localhost. Production builds have no
 * fallback — an unset value returns '' and minting is refused. Local dev
 * (`vite`, tests) may fall back to the current origin.
 */
export function resolveViewerBase(env = viteEnv()) {
  const configured = String(env.VITE_PUBLIC_VIEWER_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (env.PROD) return '';
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return '';
}

function viteEnv() {
  try {
    return (import.meta && import.meta.env) || {};
  } catch { return {}; /* import.meta unavailable (non-ESM test env) */ }
}

export function shareUrlForToken(token, base = resolveViewerBase()) {
  return `${String(base).replace(/\/+$/, '')}/viewer/share/${token}`;
}

export const PERMISSIONS = [
  { value: 'view', label: 'View only' },
  { value: 'export', label: 'View + export' },
];

// M0 share caps. The resolver (api/_clinicalMediaShare.js) enforces the same
// limits server-side and refuses any invite minted outside them.
export const SHARE_MAX_VALIDITY_MS = 7 * 86400 * 1000; // 7 days
export const SHARE_MAX_VIEWS = 20;
export const SHARE_DEFAULT_VIEWS = 20;

export const VALIDITY_UNITS = [
  { value: 'hours', label: 'hours', ms: 3600 * 1000, max: 168 },
  { value: 'days', label: 'days', ms: 86400 * 1000, max: 7 },
];

/** Expiry ISO timestamp, clamped to at least 1 unit and at most 7 days. */
export function computeExpiry(amount, unit, nowMs = Date.now()) {
  const u = VALIDITY_UNITS.find((x) => x.value === unit) || VALIDITY_UNITS[1];
  const n = Math.max(1, Math.floor(Number(amount) || 1));
  return new Date(nowMs + Math.min(n * u.ms, SHARE_MAX_VALIDITY_MS)).toISOString();
}

/** View limit, clamped to 1..SHARE_MAX_VIEWS. */
export function clampMaxViews(value) {
  const n = Math.floor(Number(value) || SHARE_DEFAULT_VIEWS);
  return Math.min(SHARE_MAX_VIEWS, Math.max(1, n));
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

/**
 * Create a share invite for a study. Resolves the study's clinic + the
 * current user, inserts the invite under RLS, and returns the link.
 *
 * @returns {Promise<{ token, url, expiresAt }>}
 * @throws Error with a user-facing message on failure.
 */
export async function createShareInvite({
  studyId,
  invitedEmail,
  invitedName = null,
  validityAmount = 7,
  validityUnit = 'days',
  maxViews = SHARE_DEFAULT_VIEWS,
  permission = 'view',
  note = null,
}) {
  if (!studyId) throw new Error('A study is required to create a share link.');
  if (!isValidEmail(invitedEmail)) throw new Error('Enter a valid recipient email.');
  // Resolve the public link base first so no invite row is created when the
  // deployment cannot mint a correct link.
  const base = resolveViewerBase();
  if (!base) throw new Error('Share links are not configured on this deployment.');

  const { data: { session } } = await supabase.auth.getSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error('You must be signed in to create a share link.');

  // The study's clinic must be one of the caller's assignments for the RLS
  // insert check to pass; set it explicitly rather than relying on the
  // app_current_clinic() default (which may be unset in the viewer app).
  const { data: study, error: studyErr } = await supabase
    .from('imaging_studies')
    .select('id, clinic_id')
    .eq('id', studyId)
    .maybeSingle();
  if (studyErr) throw new Error('Could not load the study. Please try again.');
  if (!study) throw new Error('Study not found or not accessible.');

  const token = generateToken();
  const expiresAt = computeExpiry(validityAmount, validityUnit);

  const { error: insErr } = await supabase.from('imaging_share_invites').insert({
    study_id: studyId,
    clinic_id: study.clinic_id,
    invited_email: invitedEmail.trim().toLowerCase(),
    invited_name: invitedName?.trim() || null,
    token,
    source: 'clinic',
    expires_at: expiresAt,
    created_by: userId,
    max_views: clampMaxViews(maxViews),
    permission: permission === 'export' ? 'export' : 'view',
    note: note?.trim() || null,
  });
  if (insErr) {
    // RLS denial surfaces as a permission error — translate it.
    if (/row-level security|permission|policy/i.test(insErr.message)) {
      throw new Error('You do not have permission to share this study.');
    }
    throw new Error('Could not create the share link. Please try again.');
  }

  return { token, url: shareUrlForToken(token, base), expiresAt };
}
