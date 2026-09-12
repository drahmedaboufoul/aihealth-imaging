/*
 * sharePayload — client half of the tokenized share flow.
 *
 * SharedViewerPage (/viewer/share/:token) resolves the invite through
 * /api/imaging-share-resolve (expiry / revoke / view-count checks happen
 * server-side), stashes the response in sessionStorage under
 * `share-<token8>`, and iframes the real viewer with
 * `?share=<key>&readonly=1`. The iframe is same-origin, so it shares the
 * tab's sessionStorage.
 *
 * Viewer pages call readSharePayload() to pick the payload back up and
 * skip the Supabase auth gate — the token already WAS the auth, and the
 * payload carries pre-signed URLs so no RLS-protected reads are needed.
 *
 * Payload shape (see api/imaging-share-resolve.js):
 *   {
 *     study: { id, study_type, study_date, description, patient_name },
 *     files: [{ url, fileName, fileKind, sopInstanceUid, fileSize }],
 *     niftiUrl,               // signed URL or null
 *     viewer_annotations,     // saved viewer state (v1 array | v2 object)
 *     permission, expires_at, max_views, view_count,
 *   }
 */

export const SHARE_EXPIRED_MESSAGE =
  'Shared session not found — reopen the share link you were sent.';

export function readSharePayload(shareKey) {
  if (!shareKey || typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(shareKey);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || !payload.study) return null;
    return payload;
  } catch {
    return null;
  }
}

/** DICOM instances from a share payload, in SOP-instance order (the API
 *  already sorts); shape-compatible with resolveStudyDicomFiles(). */
export function shareDicomFiles(payload) {
  return (payload?.files || []).filter((f) => f.fileKind === 'dicom' && f.url);
}

/** Mesh files (STL/PLY/OBJ) from a share payload; shape-compatible with
 *  resolveStudyFiles() output consumed by the IOS viewer. */
export function shareMeshFiles(payload) {
  const files = payload?.files || [];
  const meshes = files.filter(
    (f) => ['stl', 'ply', 'obj'].includes(f.fileKind) && f.url
  );
  const stem = (name = '') => name.split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase();
  const images = files.filter((f) => f.url && /\.(jpe?g|png)$/i.test(f.fileName || ''));
  const decorated = meshes.map((f) => {
    const base = stem(f.fileName);
    const fussen = /^texturemesh(\d+_\d+)$/.exec(base);
    const matches = images.filter((image) => {
      const imageBase = stem(image.fileName);
      return imageBase === base || (fussen && imageBase === `fussentexture${fussen[1]}`);
    });
    // Ambiguous sidecars must never paint one arch with another arch's colour.
    return matches.length === 1 && f.fileKind === 'obj'
      ? { ...f, textureUrl: matches[0].url } : { ...f };
  });
  // Alternate formats of the same named component are one surface.
  const selected = new Map();
  const rank = (f) => f.textureUrl ? 3 : f.fileKind === 'ply' ? 2 : f.fileKind === 'obj' ? 1 : 0;
  for (const file of decorated) {
    const key = stem(file.fileName);
    const previous = selected.get(key);
    if (!previous || rank(file) > rank(previous)) selected.set(key, file);
  }
  const result = [...selected.values()];
  const alignment = payload?.viewer_annotations?.mesh_alignment;
  if (!alignment?.matrices) return result;
  return result.map((file) => {
    const matrix = alignment.matrices[file.fileId];
    if (!isRigidScanMatrix(matrix)) throw new Error('Saved scan alignment is incomplete. Ask the clinic to review this scan.');
    // Shared basis rotation only: Fussen Z-up / +Y anterior -> Y-up / +Z anterior.
    const displayMatrix = alignment.coordinate_frame === 'fussen_z_up'
      ? [...matrix.slice(0, 4).map((n) => -n), ...matrix.slice(8, 12), ...matrix.slice(4, 8), ...matrix.slice(12, 16)]
      : [...matrix];
    return { ...file, matrix: displayMatrix };
  });
}

/** Row-major rigid pose; reject scale, reflection and perspective transforms. */
export function isRigidScanMatrix(m) {
  if (!Array.isArray(m) || m.length !== 16 || !m.every(Number.isFinite)) return false;
  const near = (a, b) => Math.abs(a - b) < 0.001;
  if (![m[12], m[13], m[14]].every((n) => near(n, 0)) || !near(m[15], 1)) return false;
  const rows = [m.slice(0, 3), m.slice(4, 7), m.slice(8, 11)];
  const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
  if (!rows.every((r) => near(dot(r, r), 1))) return false;
  if (!near(dot(rows[0], rows[1]), 0) || !near(dot(rows[0], rows[2]), 0) || !near(dot(rows[1], rows[2]), 0)) return false;
  const determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  return near(determinant, 1);
}
