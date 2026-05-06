/*
 * Resolve a viewer query-string into a signed Supabase storage URL.
 *
 * Mirrors the URL contract documented in EMR repo handoff/IMAGING_SPLIT.md:
 *   ?id=<patient_files.id>   (preferred — looks up file_path + bucket)
 *   ?path=<bucket/key>       (fallback — direct path)
 */

import { supabase } from './supabase';

const DEFAULT_BUCKET = 'patient-files';

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
