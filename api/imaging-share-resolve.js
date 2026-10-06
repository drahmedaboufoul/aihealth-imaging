/* global process */
/**
 * /api/imaging-share-resolve
 *
 * Public (no auth header required) endpoint that resolves a share
 * token into study metadata + signed file URLs so the imaging viewer
 * can render the case in read-only mode for an external collaborator.
 *
 * Validates:
 *   - Token exists
 *   - Not expired
 *   - Not revoked
 *   - view_count < max_views (then increments view_count)
 *
 * Returns:
 *   {
 *     study: { id, study_type, study_date, description, patient_name? },
 *     files: [{ url, fileName, fileKind, sopInstanceUid? }],
 *     niftiUrl?: string,
 *     viewer_annotations?: object,
 *     permission: 'view' | 'export',
 *     expires_at, max_views, view_count,
 *   }
 *
 * Body: { token: string }
 *
 * Uses the service-role key to bypass RLS (the token IS the auth
 * mechanism here). We DO NOT expose the patient's full record — only
 * the bare minimum needed to render the study.
 */

import { createClient } from '@supabase/supabase-js';
import {
  CLINICAL_MEDIA_SIGNED_URL_EXPIRY_SECONDS,
  imagingInviteMatchesStudy,
  isLiveImagingStudy,
  patientReleaseAllowsInvite,
  sourceArtifactsMatchFiles,
} from './_clinicalMediaShare.js';

export const config = { runtime: 'nodejs', maxDuration: 15 };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const NIFTI_BUCKET   = 'imaging-derived';
const IMAGING_BUCKET = 'imaging';

const canonicalFileFingerprint = (files) => JSON.stringify((files || []).map((file) => [
  file.file_id || file.id,
  file.artifact_id || null,
  file.series_instance_uid || null,
  file.sop_instance_uid || null,
  file.storage_bucket || IMAGING_BUCKET,
  file.storage_path,
]));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  // CORS for the imaging viewer (different origin)
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
  if (!token || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    return res.status(400).json({ error: 'Invalid token' });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Look up the invite
  const { data: invite, error: invErr } = await admin
    .from('imaging_share_invites')
    .select('id, study_id, clinic_id, expires_at, revoked_at, view_count, max_views, permission, invited_email, source')
    .eq('token', token)
    .maybeSingle();
  if (invErr || !invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.revoked_at)              return res.status(403).json({ error: 'Invite was revoked' });
  if (!(new Date(invite.expires_at).getTime() > Date.now())) return res.status(403).json({ error: 'Invite expired' });
  if (invite.view_count >= invite.max_views) return res.status(403).json({ error: 'View limit reached' });

  // Look up the study + patient name (limited fields — no PHI beyond
  // what's necessary to identify and render).
  const { data: study, error: stErr } = await admin
    .from('imaging_studies')
    .select(`
      id, clinic_id, study_type, study_date, description, status, archived_at, is_visible_to_patient, encounter_id, filing_scope,
      nifti_status, nifti_storage_path, viewer_annotations,
      patient_id, customers(name)
    `)
    .eq('id', invite.study_id)
    .maybeSingle();
  if (stErr || !study) return res.status(404).json({ error: 'Study not found' });
  if (!imagingInviteMatchesStudy(invite, study)) {
    return res.status(410).json({ error: 'Share is no longer available' });
  }
  const { data: clinic, error: clinicError } = await admin
    .from('clinics')
    .select('id,is_active,suspended_at')
    .eq('id', study.clinic_id)
    .maybeSingle();
  if (clinicError || !isLiveImagingStudy(study, clinic) || !patientReleaseAllowsInvite(invite, study)) {
    return res.status(410).json({ error: 'Study is no longer available' });
  }

  // Sign the file URLs
  const { data: files, error: filesError } = await admin
    .from('imaging_files')
    .select('id, clinic_id, storage_bucket, storage_path, original_filename, sop_instance_uid, series_instance_uid, series_number, series_description, image_type, instance_number, sort_order, file_kind, file_size, asset_role, sha256, dicom_acquisition')
    .eq('study_id', study.id)
    .eq('clinic_id', study.clinic_id)
    .eq('storage_bucket', IMAGING_BUCKET)
    .eq('asset_role', 'source');
  if (filesError) return res.status(500).json({ error: 'Could not authorize study files' });

  let filesToSign = files || [];
  let sourceArtifactIds = [];
  if (study.study_type === 'cbct') {
    // This is the exact row set selected inside the database for converter
    // provenance. Signing those rows (not a JS re-selection) prevents an
    // equal-count divergent series from being disclosed.
    const { data: diagnosticFiles, error: artifactError } = await admin.rpc(
      'clinical_media_cbct_diagnostic_files',
      { p_study_id: study.id },
    );
    if (artifactError || !Array.isArray(diagnosticFiles) || diagnosticFiles.length === 0) {
      return res.status(409).json({ error: 'The diagnostic series has not completed provenance review' });
    }
    filesToSign = diagnosticFiles.map((file) => ({ ...file, id: file.file_id }));
    sourceArtifactIds = diagnosticFiles.map((file) => file.artifact_id);
  } else {
    const { data: artifactIds, error: artifactError } = await admin.rpc(
      'clinical_media_study_input_artifacts',
      { p_study_id: study.id },
    );
    sourceArtifactIds = Array.isArray(artifactIds) ? artifactIds : [];
    if (artifactError || sourceArtifactIds.length !== filesToSign.length) {
      return res.status(409).json({ error: 'The imaging sources have not completed provenance review' });
    }
  }

  if (study.filing_scope === 'patient_external') {
    const { data: intakes, error: intakeError } = await admin.from('patient_external_imaging_intakes')
      .select('study_id,clinic_id,patient_id,session:clinical_media_upload_sessions(study_id,clinic_id,patient_id,encounter_id,filing_scope,status,finalized_count,item_count)')
      .eq('study_id', study.id).eq('clinic_id', study.clinic_id).eq('patient_id', study.patient_id);
    if (intakeError || study.encounter_id !== null || study.study_type !== 'other'
        || !intakes?.some(({ session }) => session?.study_id === study.id
          && session.clinic_id === study.clinic_id && session.patient_id === study.patient_id
          && session.encounter_id === null && session.filing_scope === 'patient_external'
          && session.status === 'completed' && session.item_count === filesToSign.length
          && session.finalized_count === session.item_count)) {
      return res.status(409).json({ error: 'The external study has not completed intake' });
    }
  }
  // Rebind the authorized artifact IDs to these exact immutable source rows.
  // Equal counts alone cannot authorize a substituted path or hash.
  if (study.study_type !== 'cbct') {
    // Bound PostgREST URL length: a typical MR acquisition has hundreds of IDs.
    const artifacts = [];
    let artifactsError = false;
    for (let offset = 0; offset < sourceArtifactIds.length; offset += 100) {
      const result = await admin.from('clinical_media_artifacts')
        .select('id,source_table,source_id,source_slot,artifact_kind,clinic_id,patient_id,encounter_id,filing_scope,storage_bucket,storage_path,sha256')
        .eq('clinic_id', study.clinic_id)
        .in('id', sourceArtifactIds.slice(offset, offset + 100));
      if (result.error || !Array.isArray(result.data)) { artifactsError = true; break; }
      artifacts.push(...result.data);
    }
    if (artifactsError || !sourceArtifactsMatchFiles(study, filesToSign, sourceArtifactIds, artifacts)) {
      return res.status(409).json({ error: 'The complete imaging source manifest could not be authorized' });
    }
  }

  // Atomically reserve this view before issuing any object grant. Concurrent
  // resolves for the final slot cannot both pass the stale count observed
  // above, and a concurrently revoked/expired invite fails the guarded update.
  const viewPatch = { view_count: invite.view_count + 1 };
  if (invite.view_count === 0) viewPatch.accepted_at = new Date().toISOString();
  const { data: claimedInvite, error: claimError } = await admin
    .from('imaging_share_invites')
    .update(viewPatch)
    .eq('id', invite.id)
    .eq('study_id', study.id)
    .eq('clinic_id', study.clinic_id)
    .eq('view_count', invite.view_count)
    .eq('max_views', invite.max_views)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id,study_id,clinic_id,view_count,revoked_at,expires_at')
    .maybeSingle();
  if (claimError || !claimedInvite) {
    return res.status(403).json({ error: 'Invite is no longer available' });
  }

  // Re-check source lifecycle after claiming and immediately before signing.
  // The trigger blocks new shares, while this service-role fence closes the
  // archive/suspension race for existing external tokens.
  const [{ data: currentStudy }, { data: currentClinic }] = await Promise.all([
    admin.from('imaging_studies')
      .select('id,clinic_id,status,archived_at,is_visible_to_patient')
      .eq('id', study.id)
      .maybeSingle(),
    admin.from('clinics')
      .select('id,is_active,suspended_at')
      .eq('id', study.clinic_id)
      .maybeSingle(),
  ]);
  if (!isLiveImagingStudy(currentStudy, currentClinic) || !imagingInviteMatchesStudy(invite, currentStudy) || !patientReleaseAllowsInvite(invite, currentStudy)) {
    return res.status(410).json({ error: 'Study is no longer available' });
  }
  if (study.study_type === 'cbct') {
    const { data: currentDiagnosticFiles, error: currentDiagnosticError } = await admin.rpc(
      'clinical_media_cbct_diagnostic_files',
      { p_study_id: study.id },
    );
    if (currentDiagnosticError
        || canonicalFileFingerprint(currentDiagnosticFiles) !== canonicalFileFingerprint(filesToSign)) {
      return res.status(410).json({ error: 'The diagnostic series changed; reopen the share' });
    }
  }

  const signedUrlsExpireAt = new Date(Date.now() + CLINICAL_MEDIA_SIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();
  const pathBatches = [];
  for (let offset = 0; offset < filesToSign.length; offset += 100) {
    pathBatches.push(filesToSign.slice(offset, offset + 100).map(file => file.storage_path));
  }
  const grants = await Promise.all(pathBatches.map(async paths => {
    const { data, error } = await admin.storage.from(IMAGING_BUCKET)
      .createSignedUrls(paths, CLINICAL_MEDIA_SIGNED_URL_EXPIRY_SECONDS);
    if (error || !Array.isArray(data) || data.length !== paths.length
        || new Set(data.map(item => item.path)).size !== paths.length
        || data.some(item => !paths.includes(item.path) || !item.signedUrl || item.error)) return null;
    return data;
  }));
  if (grants.some(batch => batch === null)) {
    return res.status(502).json({ error: 'The complete diagnostic series could not be authorized' });
  }
  const signedByPath = new Map(grants.flat().map(item => [item.path, item.signedUrl]));
  if (signedByPath.size !== filesToSign.length) {
    return res.status(502).json({ error: 'The complete diagnostic series could not be authorized' });
  }
  const signedFiles = filesToSign.map(f => ({
    fileId: f.id,
    seriesInstanceUid: f.series_instance_uid,
    seriesNumber: f.series_number,
    seriesDescription: f.series_description,
    instanceNumber: f.instance_number,
    dicomAcquisition: f.dicom_acquisition || null,
    url: signedByPath.get(f.storage_path),
    fileName: f.original_filename || f.storage_path.split('/').pop(),
    fileKind: f.file_kind,
    sopInstanceUid: f.sop_instance_uid,
    fileSize: f.file_size,
  }));

  // Sign the NIfTI if present
  let niftiUrl = null;
  if (study.nifti_status === 'ready' && study.nifti_storage_path) {
    const { data: derivedArtifactId, error: derivedError } = await admin.rpc(
      'clinical_media_current_cbct_nifti_artifact',
      {
        p_study_id: study.id,
        p_storage_bucket: NIFTI_BUCKET,
        p_storage_path: study.nifti_storage_path,
      },
    );
    if (!derivedError && derivedArtifactId) {
      const { data: signed, error: signError } = await admin.storage
        .from(NIFTI_BUCKET)
        .createSignedUrl(study.nifti_storage_path, CLINICAL_MEDIA_SIGNED_URL_EXPIRY_SECONDS);
      if (!signError) niftiUrl = signed?.signedUrl || null;
    }
  }

  if (signedFiles.length === 0 && !niftiUrl) {
    return res.status(409).json({ error: 'No live source or derived imaging object is available' });
  }

  // Never return a URL if the source or invite was revoked while Storage was
  // signing. Already-minted URLs remain server-local and expire after 10 min.
  const [
    { data: finalInvite },
    { data: finalStudy },
    { data: finalClinic },
    finalDiagnosticResult,
  ] = await Promise.all([
    admin.from('imaging_share_invites')
      .select('id,study_id,clinic_id,view_count,revoked_at,expires_at')
      .eq('id', invite.id)
      .maybeSingle(),
    admin.from('imaging_studies')
      .select('id,clinic_id,status,archived_at,is_visible_to_patient')
      .eq('id', study.id)
      .maybeSingle(),
    admin.from('clinics')
      .select('id,is_active,suspended_at')
      .eq('id', study.clinic_id)
      .maybeSingle(),
    study.study_type === 'cbct'
      ? admin.rpc('clinical_media_cbct_diagnostic_files', { p_study_id: study.id })
      : admin.rpc('clinical_media_study_input_artifacts', { p_study_id: study.id }),
  ]);
  if (!finalInvite
      || finalInvite.revoked_at
      || !imagingInviteMatchesStudy(finalInvite, study)
      || !(new Date(finalInvite.expires_at).getTime() > Date.now())
      || finalInvite.view_count !== claimedInvite.view_count
      || !isLiveImagingStudy(finalStudy, finalClinic)
      || !imagingInviteMatchesStudy(invite, finalStudy)
      || !patientReleaseAllowsInvite(invite, finalStudy)
      || (study.study_type !== 'cbct' && (finalDiagnosticResult.error
        || JSON.stringify([...(finalDiagnosticResult.data || [])].sort()) !== JSON.stringify([...sourceArtifactIds].sort())))
      || (study.study_type === 'cbct' && (
        finalDiagnosticResult.error
        || canonicalFileFingerprint(finalDiagnosticResult.data) !== canonicalFileFingerprint(filesToSign)
      ))) {
    return res.status(410).json({ error: 'Share is no longer available' });
  }

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
    signed_urls_expires_at: signedUrlsExpireAt,
    max_views:   invite.max_views,
    view_count:  claimedInvite.view_count,
    invited_email: invite.invited_email,
    source: invite.source,
  });
}
