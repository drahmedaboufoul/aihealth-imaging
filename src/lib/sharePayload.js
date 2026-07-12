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
  return (payload?.files || []).filter(
    (f) => ['stl', 'ply', 'obj'].includes(f.fileKind) && f.url
  );
}
