/**
 * /api/imaging-share-resolve — hosted on the imaging viewer project so
 * the public token route doesn't hit the EMR's Vercel SSO wall.
 *
 * Public endpoint (no auth). Uses the service-role key to bypass RLS —
 * the token IS the auth mechanism here. Validates expiry / revoke /
 * max_views, then returns the bare minimum needed to render the case.
 *
 * Required Vercel env vars on aihealth-imaging:
 *   - SUPABASE_URL (or VITE_SUPABASE_URL)
 *   - SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'nodejs', maxDuration: 15 };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const NIFTI_BUCKET   = 'imaging-derived';
const IMAGING_BUCKET = 'imaging';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(503).json({ error: 'Service not configured' });

  const { token } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Missing token' });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: invite, error: invErr } = await admin
    .from('imaging_share_invites')
    .select('id, study_id, expires_at, revoked_at, view_count, max_views, permission, invited_email, source')
    .eq('token', token)
    .maybeSingle();
  if (invErr || !invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.revoked_at)              return res.status(403).json({ error: 'Invite was revoked' });
  if (new Date(invite.expires_at).getTime() < Date.now()) return res.status(403).json({ error: 'Invite expired' });
  if (invite.view_count >= invite.max_views) return res.status(403).json({ error: 'View limit reached' });

  const { data: study, error: stErr } = await admin
    .from('imaging_studies')
    .select(`
      id, study_type, study_date, description, status,
      nifti_status, nifti_storage_path, viewer_annotations,
      patient_id, customers(name)
    `)
    .eq('id', invite.study_id)
    .maybeSingle();
  if (stErr || !study) return res.status(404).json({ error: 'Study not found' });

  const { data: files } = await admin
    .from('imaging_files')
    .select('id, storage_path, original_filename, sop_instance_uid, file_kind, file_size')
    .eq('study_id', study.id)
    .order('sop_instance_uid', { ascending: true, nullsFirst: false });

  const signedFiles = await Promise.all((files || []).map(async (f) => {
    const { data: signed } = await admin.storage.from(IMAGING_BUCKET).createSignedUrl(f.storage_path, 60 * 60);
    return {
      url: signed?.signedUrl || null,
      fileName: f.original_filename || f.storage_path.split('/').pop(),
      fileKind: f.file_kind,
      sopInstanceUid: f.sop_instance_uid,
      fileSize: f.file_size,
    };
  }));

  let niftiUrl = null;
  if (study.nifti_status === 'ready' && study.nifti_storage_path) {
    const { data: signed } = await admin.storage.from(NIFTI_BUCKET).createSignedUrl(study.nifti_storage_path, 60 * 60);
    niftiUrl = signed?.signedUrl || null;
  }

  admin.from('imaging_share_invites')
    .update({ view_count: invite.view_count + 1, accepted_at: invite.view_count === 0 ? new Date().toISOString() : undefined })
    .eq('id', invite.id)
    .then(() => {});

  return res.status(200).json({
    study: {
      id:           study.id,
      study_type:   study.study_type,
      study_date:   study.study_date,
      description:  study.description,
      patient_name: study.customers?.name || null,
    },
    files: signedFiles.filter((f) => f.url),
    niftiUrl,
    viewer_annotations: study.viewer_annotations || null,
    permission:  invite.permission,
    expires_at:  invite.expires_at,
    max_views:   invite.max_views,
    view_count:  invite.view_count + 1,
    invited_email: invite.invited_email,
    source: invite.source,
  });
}
