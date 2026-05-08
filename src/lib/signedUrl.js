/*
 * Resolve a viewer query-string into a signed Supabase storage URL.
 *
 * Mirrors the URL contract documented in EMR repo handoff/IMAGING_SPLIT.md:
 *   ?id=<patient_files.id>     (preferred — looks up file_path + bucket)
 *   ?path=<bucket/key>         (fallback — direct path)
 *   ?study=<imaging_studies.id> (multi-file — load all 3D scans for the study)
 */

import { supabase } from './supabase';

const DEFAULT_BUCKET = 'patient-files';
const IMAGING_BUCKET = 'imaging';
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
