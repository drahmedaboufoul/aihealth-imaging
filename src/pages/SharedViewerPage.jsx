/*
 * SharedViewerPage — public viewer route for tokenized share invites.
 * URL: /viewer/share/:token
 *
 * Flow:
 *   1. Resolve the token via the imaging project's own /api/imaging-share-resolve.
 *      Server validates expiry / revoke / view-count limits and
 *      returns study metadata + signed file URLs.
 *   2. Render the appropriate viewer (CBCT / IOS / DICOM) in
 *      read-only mode based on study_type.
 *   3. DICOM export button is shown only if permission === 'export'.
 *
 * Anonymous: no Supabase auth required. The token IS the auth.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, Lock, Download } from 'lucide-react';

export default function SharedViewerPage() {
  const { token } = useParams();
  const [state, setState] = useState({ stage: 'loading', payload: null, error: null });

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const key = `share-${crypto.randomUUID()}`;
    setState({ stage: 'loading', payload: null, error: null });
    if (!token) return;
    (async () => {
      try {
        // Same-origin: this API route now lives on the imaging
        // Vercel project, not the EMR (the EMR is SSO-walled).
        const resp = await fetch(`/api/imaging-share-resolve`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const body = await resp.json();
        if (!active) return;
        if (!resp.ok) {
          setState({ stage: 'error', payload: null, error: body?.error || `Status ${resp.status}` });
          return;
        }
        if (!(Date.parse(body.signed_urls_expires_at) > Date.now())) throw new Error('Shared access has expired. Reopen the link.');
        sessionStorage.setItem(key, JSON.stringify(body));
        setState({ stage: 'ready', token, shareKey: key, payload: body, error: null });
      } catch (e) {
        if (!active) return;
        setState({ stage: 'error', payload: null, error: e?.message || String(e) });
      }
    })();
    return () => { active = false; controller.abort(); sessionStorage.removeItem(key); };
  }, [token]);

  if (state.stage === 'loading' || (state.stage === 'ready' && state.token !== token)) {
    return (
      <div className="h-screen w-screen bg-bg flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted">
          <Loader2 size={28} className="animate-spin" />
          <p className="text-xs">Verifying share link…</p>
        </div>
      </div>
    );
  }

  if (state.stage === 'error') {
    return (
      <div className="h-screen w-screen bg-bg flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center flex flex-col items-center gap-4">
          <Lock size={32} className="text-destructive" />
          <div>
            <p className="text-sm font-medium text-text">Link can't be opened</p>
            <p className="text-xs text-muted mt-1">{state.error || 'The link may be expired, revoked, or used too many times.'}</p>
          </div>
          <p className="text-xs text-muted">
            If you believe this is in error, contact the clinic that sent you the link.
          </p>
        </div>
      </div>
    );
  }

  const { study, niftiUrl, permission, expires_at } = state.payload;
  const studyType = study?.study_type;

  // Forward to the actual viewer route in read-only mode, passing the
  // resolved data via sessionStorage so we don't bake PHI in URL params.
  // Each viewer reads `?share=<key>` and pulls payload from session.
  const shareKey = state.shareKey;

  // Pick viewer route by modality
  let viewerRoute = null;
  if (studyType === 'cbct') viewerRoute = `/viewer/cbct?share=${shareKey}&readonly=1`;
  else if (studyType === 'intraoral_scan') viewerRoute = `/viewer/ios?share=${shareKey}&readonly=1`;
  else viewerRoute = `/viewer/dicom?share=${shareKey}&readonly=1`;

  // Header strip showing this is a shared session + countdown to expiry
  const expiresIn = expires_at ? Math.max(0, Math.floor((new Date(expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : null;

  return (
    <div className="h-screen w-screen flex flex-col bg-bg">
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b border-separator-s1 bg-background-secondary text-labels-primary text-xs"
      >
        <div className="flex items-center gap-3">
          <span className="font-semibold text-accent text-xs">Kyour.ai <span className="hidden sm:inline">· Imaging Interpreter</span></span>
          <span className="text-labels-secondary">
            {study?.patient_name && <span>{study.patient_name} · </span>}
            {studyType?.replace(/_/g, ' ')} · {study?.study_date && new Date(study.study_date).toLocaleDateString('en-GB')}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {expiresIn != null && (
            <span className="text-labels-tertiary">Expires in {expiresIn} day{expiresIn === 1 ? '' : 's'}</span>
          )}
          {permission === 'export' && studyType === 'cbct' && niftiUrl && (
            <a
              href={niftiUrl}
              download={`${study.id}.nii.gz`}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-accent text-white text-xs font-semibold hover:bg-accent-hover"
            >
              <Download size={10} /> Export NIfTI
            </a>
          )}
        </div>
      </div>
      {/* Embed the appropriate viewer via iframe (cheapest path; the
          viewer pages have their own auth gating logic which we bypass
          with ?share= + sessionStorage). */}
      <iframe
        src={viewerRoute}
        className="flex-1 w-full border-0"
        title="Shared imaging viewer"
      />
    </div>
  );
}
