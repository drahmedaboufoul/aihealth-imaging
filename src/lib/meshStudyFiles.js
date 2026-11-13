/*
 * meshStudyFiles — locate and sign the mesh files (STL/PLY/OBJ) of an
 * intraoral-scan imaging study so the Compare/Overlay views can load them.
 *
 * Studies exported by intraoral scanners often carry the SAME component in
 * several formats (upperjaw.stl + upperjaw.ply + upperjaw.obj). pickMeshFiles
 * dedupes by component base name and prefers STL > PLY > OBJ (STL is the most
 * robust to parse and what the rest of the platform standardises on).
 */

export const MESH_FILE_KINDS = ['stl', 'ply', 'obj'];
const KIND_PRIORITY = { stl: 0, ply: 1, obj: 2 };

/** Strip mesh extensions (possibly doubled: "x.stl.stl") to the component base name. */
export function meshBaseName(fileName) {
  let base = String(fileName || '').toLowerCase().trim();
  base = base.replace(/^.*\//, '');
  // Uploads may prefix a timestamp ("1780584874761_lowerjaw.stl").
  base = base.replace(/^\d{10,}_/, '');
  for (let i = 0; i < 3; i++) base = base.replace(/\.(stl|ply|obj)$/i, '');
  return base || 'model';
}

/** Human label for a scan component file ("upperjaw" → "Upper jaw"). */
export function meshComponentLabel(fileName) {
  const base = meshBaseName(fileName);
  if (/upper/.test(base)) return 'Upper jaw';
  if (/lower|mandib/.test(base)) return 'Lower jaw';
  const occ = base.match(/occlusion\s*(\d*)/);
  if (occ) return `Bite ${occ[1] || ''}`.trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Dedupe a study's mesh file rows by component, preferring STL > PLY > OBJ.
 * @param {Array<{file_kind:string, original_filename?:string, storage_path:string}>} rows
 * @returns {Array} one row per component, sorted by name, each annotated with
 *          { baseName, label }.
 */
export function pickMeshFiles(rows) {
  const byBase = new Map();
  for (const row of rows || []) {
    const kind = String(row?.file_kind || '').toLowerCase();
    if (!MESH_FILE_KINDS.includes(kind)) continue;
    const name = row.original_filename || row.storage_path || '';
    const base = meshBaseName(name);
    const prev = byBase.get(base);
    if (!prev || KIND_PRIORITY[kind] < KIND_PRIORITY[String(prev.file_kind).toLowerCase()]) {
      byBase.set(base, { ...row, file_kind: kind, baseName: base, label: meshComponentLabel(name) });
    }
  }
  return [...byBase.values()].sort((a, b) => a.baseName.localeCompare(b.baseName));
}

/**
 * Fetch + sign the mesh files of a study (bucket `imaging`).
 * @returns {Promise<Array<{id, file_kind, baseName, label, storage_path, url}>>}
 */
export async function fetchMeshStudyFiles(supabase, studyId, expiresIn = 3600) {
  const { data: rows, error } = await supabase
    .from('imaging_files')
    .select('id, file_kind, original_filename, storage_path')
    .eq('study_id', studyId)
    .in('file_kind', MESH_FILE_KINDS);
  if (error) throw error;
  const picked = pickMeshFiles(rows || []);
  if (!picked.length) return [];
  const { data: signed, error: signErr } = await supabase.storage
    .from('imaging')
    .createSignedUrls(picked.map((p) => p.storage_path), expiresIn);
  if (signErr) throw signErr;
  return picked
    .map((p, i) => ({ ...p, url: signed?.[i]?.signedUrl || null }))
    .filter((f) => f.url);
}
