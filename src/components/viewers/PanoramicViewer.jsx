/*
 * PanoramicViewer — displays the server-rendered panoramic (OPG) reconstruction
 * for a CBCT study as a plain image. This is the mobile-safe path: the phone
 * never holds the volume, it just shows the PNG the Cloud Run renderer produced
 * (see /api/generate-panoramic + handoff/CBCT_PANORAMIC_CONTRACT.md).
 *
 * If the panoramic hasn't been rendered yet it offers to generate it and polls
 * imaging_studies.panoramic_status until ready. If the clean NIfTI volume isn't
 * converted yet, it first triggers conversion (/api/convert-cbct) and waits.
 *
 * Props:
 *   studyId  : string
 *   fileName : string
 *   onClose  : () => void      // back to the slice/volume viewer
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, X, AlertTriangle, RefreshCw, Maximize2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

async function authedPost(path, body) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* no body */ }
  return { ok: res.ok, status: res.status, json };
}

export default function PanoramicViewer({ studyId, fileName = 'Panoramic (OPG)', onClose }) {
  const [phase, setPhase] = useState('checking'); // checking | absent | working | ready | error
  const [message, setMessage] = useState('');
  const [imgUrl, setImgUrl] = useState(null);
  const [fit, setFit] = useState(true);
  const pollRef = useRef(null);
  const mountedRef = useRef(true);

  const clearPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  const signAndShow = useCallback(async (path) => {
    const { data, error } = await supabase.storage.from('imaging-derived').createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) throw error || new Error('Could not sign panoramic URL');
    if (!mountedRef.current) return;
    setImgUrl(data.signedUrl);
    setPhase('ready');
  }, []);

  const fetchStudy = useCallback(async () => {
    const { data, error } = await supabase
      .from('imaging_studies')
      .select('nifti_status, panoramic_status, panoramic_storage_path, panoramic_error')
      .eq('id', studyId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }, [studyId]);

  // Poll the study row until the panoramic is ready/failed (and convert the
  // volume first if needed). Returns nothing; updates state as it goes.
  const startPolling = useCallback(() => {
    clearPoll();
    let triggeredConvert = false;
    let triggeredPanoramic = false;
    const startedAt = Date.now();
    pollRef.current = setInterval(async () => {
      try {
        const s = await fetchStudy();
        if (!mountedRef.current || !s) return;

        // Don't spin forever. The panoramic image is produced by the external
        // Cloud Run renderer (POST /panoramic); if that isn't deployed yet the
        // row never reaches 'ready'. After a grace period, say so honestly
        // instead of an endless spinner.
        if (s.panoramic_status !== 'ready' && Date.now() - startedAt > 75000) {
          clearPoll();
          setPhase('error');
          setMessage(
            s.nifti_status !== 'ready'
              ? 'Still preparing the volume — this is taking longer than expected. Try again shortly, or use the slice view.'
              : 'Panoramic rendering isn’t available on the server yet. Use the slice / MPR view for now; the panoramic will appear here once the renderer is set up.'
          );
          return;
        }

        if (s.panoramic_status === 'ready' && s.panoramic_storage_path) {
          clearPoll();
          await signAndShow(s.panoramic_storage_path);
          return;
        }
        if (s.panoramic_status === 'failed') {
          clearPoll();
          setPhase('error');
          setMessage(s.panoramic_error || 'Panoramic rendering failed.');
          return;
        }

        // Still need the clean volume before the renderer can run.
        if (s.nifti_status !== 'ready') {
          setMessage(s.nifti_status === 'failed'
            ? 'Volume conversion failed — cannot build the panoramic.'
            : 'Preparing the volume the panoramic is built from…');
          if (!triggeredConvert && s.nifti_status !== 'queued' && s.nifti_status !== 'converting') {
            triggeredConvert = true;
            await authedPost('/api/convert-cbct', { study_id: studyId });
          }
          return;
        }

        // Volume is ready; kick the panoramic render once, then keep polling.
        if (s.panoramic_status === 'queued' || s.panoramic_status === 'rendering') {
          setMessage('Rendering the panoramic…');
          return;
        }
        if (!triggeredPanoramic) {
          triggeredPanoramic = true;
          setMessage('Rendering the panoramic…');
          const r = await authedPost('/api/generate-panoramic', { study_id: studyId });
          if (!r.ok && r.status !== 202 && r.status !== 409) {
            clearPoll();
            setPhase('error');
            setMessage(r.json?.error || `Could not start rendering (HTTP ${r.status}).`);
          }
        }
      } catch (e) {
        // Transient errors: keep polling; only surface if it persists is fine for v1.
        console.warn('[PanoramicViewer] poll error:', e?.message);
      }
    }, 4000);
  }, [fetchStudy, signAndShow, studyId]);

  const generate = useCallback(async () => {
    setPhase('working');
    setMessage('Starting…');
    startPolling();
  }, [startPolling]);

  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        const s = await fetchStudy();
        if (!mountedRef.current) return;
        if (!s) { setPhase('error'); setMessage('Study not found.'); return; }
        if (s.panoramic_status === 'ready' && s.panoramic_storage_path) {
          await signAndShow(s.panoramic_storage_path);
        } else if (s.panoramic_status === 'queued' || s.panoramic_status === 'rendering') {
          setPhase('working'); setMessage('Rendering the panoramic…'); startPolling();
        } else {
          setPhase('absent');
        }
      } catch (e) {
        if (mountedRef.current) { setPhase('error'); setMessage(e?.message || 'Failed to load.'); }
      }
    })();
    return () => { mountedRef.current = false; clearPoll(); };
  }, [fetchStudy, signAndShow, startPolling]);

  return (
    <div className="h-screen w-screen flex flex-col bg-neutral-950">
      <div className="flex items-center gap-2 px-3 py-2 bg-neutral-900 border-b border-neutral-800">
        <span className="text-sm font-semibold text-amber-400 mr-2 truncate max-w-[55%]">{fileName} · Panoramic (OPG)</span>
        <div className="flex-1" />
        {phase === 'ready' && (
          <button type="button" title="Fit / actual size" onClick={() => setFit((f) => !f)}
            className="p-2 rounded-md text-neutral-300 hover:bg-neutral-800"><Maximize2 className="h-4 w-4" /></button>
        )}
        {onClose && (
          <button type="button" title="Back to slices" onClick={onClose}
            className="p-2 rounded-md text-neutral-300 hover:bg-neutral-800"><X className="h-4 w-4" /></button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-black">
        {phase === 'ready' && imgUrl && (
          <img
            src={imgUrl}
            alt="Panoramic reconstruction"
            onClick={() => setFit((f) => !f)}
            className={fit ? 'max-h-full max-w-full object-contain' : 'max-w-none cursor-zoom-out'}
            style={fit ? {} : { width: 'auto', height: 'auto' }}
          />
        )}

        {(phase === 'checking' || phase === 'working') && (
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            <Loader2 className="h-10 w-10 animate-spin text-amber-500" />
            <p className="text-white">{message || 'Loading…'}</p>
            <p className="text-neutral-500 text-xs max-w-xs">Rendering happens on the server — this can take a minute. You can leave this open; it updates automatically.</p>
          </div>
        )}

        {phase === 'absent' && (
          <div className="flex flex-col items-center gap-4 px-6 text-center">
            <p className="text-white">No panoramic has been generated for this study yet.</p>
            <p className="text-neutral-500 text-xs max-w-sm">The panoramic (OPG) is reconstructed on the server from the CBCT volume, so it loads as an image on any device — including phones.</p>
            <button type="button" onClick={generate}
              className="px-4 py-2 rounded-md bg-amber-500 text-black text-sm font-medium">Generate panoramic</button>
          </div>
        )}

        {phase === 'error' && (
          <div className="flex flex-col items-center gap-3 px-6 text-center">
            <AlertTriangle className="h-10 w-10 text-red-400" />
            <p className="text-white">Couldn’t produce the panoramic</p>
            <p className="text-neutral-400 text-sm max-w-md">{message}</p>
            <button type="button" onClick={generate}
              className="px-4 py-2 rounded-md bg-amber-500 text-black text-sm font-medium inline-flex items-center gap-2">
              <RefreshCw className="h-4 w-4" /> Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
