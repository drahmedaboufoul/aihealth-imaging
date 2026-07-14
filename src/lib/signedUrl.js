/*
 * Resolve a viewer query-string into a signed Supabase storage URL.
 *
 * Mirrors the URL contract documented in EMR repo handoff/IMAGING_SPLIT.md:
 *   ?id=<patient_files.id>     (preferred — looks up file_path + bucket)
 *   ?path=<bucket/key>         (fallback — direct path)
 *   ?study=<imaging_studies.id> (multi-file — load all 3D scans for the study)
 *   resolveStudyDicomFiles      (multi-instance — DICOM stack for a study)
 */

import { supabase } from './supabase';

const DEFAULT_BUCKET = 'patient-files';
const IMAGING_BUCKET = 'imaging';
const NIFTI_BUCKET = 'imaging-derived';
const SCAN_KINDS = ['stl', 'ply', 'obj'];

export async function resolveSignedUrl({ id, path }) {
  if (!id && !path) {
    throw new Error('Either id (patient_files.id) or path (bucket/key) is required');
  }

  let bucket = DEFAULT_BUCKET;
  let key = path;
  let fileName = null;

  if (id) {
    const { data, error } = await supabase
      .from('patient_files')
      .select('id, file_name, file_path, bucket_id, file_type')
      .eq('id', id)
      .single();
    if (error) throw new Error(`patient_files lookup failed: ${error.message}`);
    if (!data) throw new Error(`patient_files row not found for id=${id}`);
    bucket = data.bucket_id || DEFAULT_BUCKET;
    key = data.file_path;
    fileName = data.file_name;
  }

  const { data: signed, error: signErr } = await supabase
    .storage
    .from(bucket)
    .createSignedUrl(key, 60 * 60); // 1 hour
  if (signErr) throw new Error(`createSignedUrl failed: ${signErr.message}`);

  return { url: signed.signedUrl, fileName, bucket, key };
}

/**
 * Resolve every 3D scan file (STL/PLY/OBJ) belonging to an imaging_studies row
 * into signed URLs. Used by /viewer/ios?study=<id> to render upper + lower +
 * occlusion together as one case.
 *
 * Returns: Array<{ url, fileName, fileKind, fileId }>
 *
 * Files come back in upload order; the viewer is responsible for role
 * detection (filename heuristics) and rendering.
 */
export async function resolveStudyFiles(studyId) {
  if (!studyId) throw new Error('studyId is required');

  const { data: rows, error } = await supabase
    .from('imaging_files')
    .select('id, storage_path, original_filename, file_kind, content_type, file_size')
    .eq('study_id', studyId)
    .in('file_kind', SCAN_KINDS)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`imaging_files lookup failed: ${error.message}`);
  if (!rows || rows.length === 0) {
    throw new Error(`No 3D scan files (STL/PLY/OBJ) found for study ${studyId}`);
  }

  // Sign every storage_path in parallel. Partial failure is allowed —
  // the viewer should render whatever loaded successfully.
  const signed = await Promise.all(rows.map(async (row) => {
    const { data, error: sErr } = await supabase
      .storage
      .from(IMAGING_BUCKET)
      .createSignedUrl(row.storage_path, 60 * 60);
    if (sErr) {
      console.warn(`[resolveStudyFiles] sign failed for ${row.storage_path}: ${sErr.message}`);
      return null;
    }
    return {
      url: data.signedUrl,
      fileName: row.original_filename || row.storage_path.split('/').pop(),
      fileKind: row.file_kind,
      fileId: row.id,
      fileSize: row.file_size,
    };
  }));

  const ok = signed.filter(Boolean);
  if (ok.length === 0) throw new Error(`Could not sign any files for study ${studyId}`);
  return ok;
}

/**
 * Resolve every DICOM instance belonging to an imaging_studies row into
 * signed URLs, ordered by SOP Instance UID (which mirrors slice order for
 * a CT/CBCT series in most modern scanners). Used by
 * /viewer/dicom?study=<id> to render a stack-scrollable series.
 *
 * Returns the same shape as resolveStudyFiles plus the original_filename
 * which the viewer uses to label slices on the slider hover.
 *
 * For very large series (CBCT can be 200-500 instances) the URL signing
 * itself stays cheap (a single batched SQL query + parallel sign calls)
 * — the viewer is responsible for fetching pixel data lazily per frame.
 */
export async function resolveStudyDicomFiles(studyId) {
  if (!studyId) throw new Error('studyId is required');

  const { data: rows, error } = await supabase
    .from('imaging_files')
    .select('id, storage_path, original_filename, sop_instance_uid, file_size')
    .eq('study_id', studyId)
    .eq('file_kind', 'dicom')
    .order('sop_instance_uid', { ascending: true, nullsFirst: false });

  if (error) throw new Error(`imaging_files lookup failed: ${error.message}`);
  if (!rows || rows.length === 0) {
    throw new Error(`No DICOM files found for study ${studyId}`);
  }

  // Sign in parallel. CBCT series of 400 instances signs in ~1-2s thanks to
  // Promise.all + Supabase's batched API.
  const signed = await Promise.all(rows.map(async (row) => {
    const { data, error: sErr } = await supabase
      .storage
      .from(IMAGING_BUCKET)
      .createSignedUrl(row.storage_path, 60 * 60);
    if (sErr) {
      console.warn(`[resolveStudyDicomFiles] sign failed for ${row.storage_path}: ${sErr.message}`);
      return null;
    }
    return {
      url: data.signedUrl,
      fileName: row.original_filename || row.storage_path.split('/').pop(),
      sopInstanceUid: row.sop_instance_uid,
      fileId: row.id,
      fileSize: row.file_size,
    };
  }));

  const ok = signed.filter(Boolean);
  if (ok.length === 0) throw new Error(`Could not sign any DICOM files for study ${studyId}`);
  return ok;
}

/**
 * Look up the server-converted NIfTI volume for a study, if one exists.
 * The conversion service writes nifti_storage_path to imaging_studies
 * once it succeeds; until then this returns null and the viewer falls
 * back to streaming the DICOM stack.
 *
 * Returns null if:
 *   - The study has not been converted yet (nifti_status null/queued/converting)
 *   - The conversion failed (nifti_status='failed') — caller can read
 *     nifti_status separately to render an error state
 *   - No row found (caller error — should be checked upstream)
 *
 * Returns { url, status, dimensions, spacing, error } when conversion is ready.
 */
export async function resolveStudyNiftiVolume(studyId) {
  if (!studyId) throw new Error('studyId is required');

  const { data: row, error } = await supabase
    .from('imaging_studies')
    .select('id, nifti_storage_path, nifti_status, nifti_error')
    .eq('id', studyId)
    .maybeSingle();

  if (error) throw new Error(`imaging_studies lookup failed: ${error.message}`);
  if (!row) return { url: null, status: null, error: 'study not found' };

  // Status surface so the viewer can render different UI for queued vs
  // converting vs failed without making another query.
  const status = row.nifti_status || null;
  if (!row.nifti_storage_path || status !== 'ready') {
    return { url: null, status, error: row.nifti_error || null };
  }

  const { data: signed, error: sErr } = await supabase
    .storage
    .from(NIFTI_BUCKET)
    .createSignedUrl(row.nifti_storage_path, 60 * 60);
  if (sErr) {
    return { url: null, status, error: `sign failed: ${sErr.message}` };
  }

  return { url: signed.signedUrl, status: 'ready', error: null };
}
