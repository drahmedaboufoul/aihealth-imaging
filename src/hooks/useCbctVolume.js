/*
 * useCbctVolume — owns the CBCT viewer's volume-load lifecycle:
 *   resolve study → NIfTI fast path (if converted) → DICOM streaming
 *   fallback → engine/viewport/tool-group setup → ready.
 *
 * Extracted from CBCTViewerPage.jsx during the A0 monolith split.
 *
 * W2 (audit findings #1 + #16):
 *   - fetches imaging_studies → customers so the top bar can render the
 *     patient identity banner (name · MRN · DOB · study date)
 *   - "converting" is a first-class stage with auto-poll + retry instead
 *     of a dead-end error
 *   - failures surface as TYPED errors ({ kind, message }) — missing
 *     study / share-expired / not-found / generic — not raw strings.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { resolveStudyDicomFiles, resolveStudyNiftiVolume } from '../lib/signedUrl';
import { initCornerstone } from '../lib/cornerstoneInit';
import { shareDicomFiles, SHARE_EXPIRED_MESSAGE } from '../lib/sharePayload';
import { renderFromNifti, renderFromDicomStack } from '../components/cbct/cbctEngine';
import { VOLUME_PRESETS_HU } from '../components/cbct/cbctViewModes';

// How long to wait between automatic re-checks while the server-side
// NIfTI conversion is still running.
const CONVERTING_POLL_MS = 20000;

/** Classify an init failure into a typed error the UI can recover from. */
function toCbctError(err) {
  const message = err?.message || String(err);
  if (err?.kind) return { kind: err.kind, message };
  if (message === SHARE_EXPIRED_MESSAGE) return { kind: 'share-expired', message };
  if (/^Missing \?study=/.test(message)) return { kind: 'missing-study', message };
  if (/No DICOM files found|study not found|Could not sign any/.test(message)) {
    return { kind: 'not-found', message };
  }
  return { kind: 'generic', message };
}

export function useCbctVolume({
  studyId,
  shareKey,
  sharePayload,
  effectiveStudyId,
  navigate,
  location,
}) {
  const [stage, setStage] = useState('init'); // init | resolving | loading-volume | converting | ready | error
  const [error, setError] = useState(null);   // { kind, message } | null
  const [progress, setProgress] = useState(0);
  const [presetTable, setPresetTable] = useState(VOLUME_PRESETS_HU);

  // Patient/study identity for the top-bar banner (W2). Shape:
  // { patientName, mrn, dob, studyDate, studyType, description }
  const [studyMeta, setStudyMeta] = useState(null);

  // Bumped by retry() / the converting auto-poll to re-run the load.
  const [reloadToken, setReloadToken] = useState(0);
  const retry = useCallback(() => {
    setError(null);
    setProgress(0);
    setReloadToken((n) => n + 1);
  }, []);

  // Cached volume + last loaded volumeId, for fast view-mode rebuilds
  // without reloading the volume.
  const cachedVolumeRef = useRef(null);
  const cachedVolumeIdRef = useRef(null);

  const axialRef    = useRef(null);
  const coronalRef  = useRef(null);
  const sagittalRef = useRef(null);
  const vrRef       = useRef(null);
  const enginRef    = useRef(null);

  useEffect(() => {
    document.title = 'CBCT Viewer · aiHealth Imaging';
    let cancelled = false;

    // ── Patient identity banner (W2) — best-effort, never blocks load ──
    // Share mode: the resolve API already returned the patient name.
    // Authed mode: one joined select; RLS scopes it to the caller's clinic.
    if (sharePayload?.study) {
      setStudyMeta({
        patientName: sharePayload.study.patient_name || null,
        mrn: null,
        dob: null,
        studyDate: sharePayload.study.study_date || null,
        studyType: sharePayload.study.study_type || null,
        description: sharePayload.study.description || null,
      });
    } else if (studyId) {
      supabase
        .from('imaging_studies')
        .select('id, study_date, study_type, description, patient_id, customers(name, medical_record_number, date_of_birth)')
        .eq('id', studyId)
        .maybeSingle()
        .then(({ data, error: metaErr }) => {
          if (cancelled || metaErr || !data) return;
          setStudyMeta({
            patientName: data.customers?.name || null,
            mrn: data.customers?.medical_record_number || null,
            dob: data.customers?.date_of_birth || null,
            studyDate: data.study_date || null,
            studyType: data.study_type || null,
            description: data.description || null,
          });
        });
    }

    (async () => {
      try {
        if (shareKey && !sharePayload) {
          throw new Error(SHARE_EXPIRED_MESSAGE);
        }
        if (!effectiveStudyId) {
          throw new Error('Missing ?study=<imaging_studies.id> URL parameter.');
        }
        if (!sharePayload) {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) {
            const back = encodeURIComponent(location.pathname + location.search);
            navigate(`/login?next=${back}`, { replace: true });
            return;
          }
        }
        if (cancelled) return;

        setStage('resolving');

        // ── Architecture A fast path ──────────────────────────────────
        // If the EMR converted this study to NIfTI server-side, take the
        // single-file path. Geometry is baked into the header — no IPP
        // guesswork, no scanner-quirk landmines. Falls through to the
        // DICOM streaming path if no NIfTI is available yet.
        // Share mode: the resolve API already signed the NIfTI URL.
        let niftiInfo = { url: null, status: null, error: null };
        if (sharePayload) {
          niftiInfo = { url: sharePayload.niftiUrl || null, status: sharePayload.niftiUrl ? 'ready' : null, error: null };
        } else {
          try {
            niftiInfo = await resolveStudyNiftiVolume(studyId);
          } catch (e) {
            console.warn('[cbct] resolveStudyNiftiVolume failed (will fall back to DICOM):', e?.message);
          }
        }
        if (cancelled) return;

        // Conversion still running → first-class stage (W2): the page
        // shows an auto-polling panel instead of a dead-end error.
        if (niftiInfo.status === 'converting' || niftiInfo.status === 'queued') {
          setStage('converting');
          return;
        }
        // The study row itself is gone — typed not-found, no point
        // falling through to the DICOM path to fail again.
        if (niftiInfo.error === 'study not found') {
          throw { kind: 'not-found', message: `No imaging study found for id ${effectiveStudyId}.` };
        }

        if (niftiInfo.url) {
          // NIfTI ready — load + render and we're done. The browser
          // sees one file with explicit geometry and avoids the entire
          // DICOM-stack reconstruction path.
          setStage('loading-volume');
          await initCornerstone();
          if (cancelled) return;

          const volumeId = `cornerstoneVolume:nifti-${effectiveStudyId}`;
          await renderFromNifti({
            niftiUrl: niftiInfo.url,
            volumeId,
            elements: {
              CBCT_AXIAL:    axialRef.current,
              CBCT_CORONAL:  coronalRef.current,
              CBCT_SAGITTAL: sagittalRef.current,
              CBCT_3D:       vrRef.current,
            },
            setProgress,
            setPresetTable,
            cancelledRef: () => cancelled,
            engineRef: enginRef,
            cachedVolumeRef,
            cachedVolumeIdRef,
          });
          if (cancelled) return;
          setStage('ready');
          return;
        }

        // ── Fallback: DICOM streaming path ────────────────────────────
        // Used when the converter hasn't run yet (status null) or failed.
        if (niftiInfo.status === 'failed') {
          console.warn('[cbct] NIfTI conversion failed for this study, falling back to DICOM:', niftiInfo.error);
        }

        const list = sharePayload
          ? shareDicomFiles(sharePayload)
          : await resolveStudyDicomFiles(studyId);
        if (cancelled) return;
        if (list.length < 3) {
          throw new Error(
            `Volume rendering needs at least 3 DICOM instances; got ${list.length}.`
          );
        }

        await initCornerstone();
        if (cancelled) return;

        setStage('loading-volume');
        await renderFromDicomStack({
          dicomFiles: list,
          volumeId: `cornerstoneStreamingImageVolume:study-${effectiveStudyId}`,
          elements: {
            CBCT_AXIAL:    axialRef.current,
            CBCT_CORONAL:  coronalRef.current,
            CBCT_SAGITTAL: sagittalRef.current,
            CBCT_3D:       vrRef.current,
          },
          setProgress,
          setPresetTable,
          cancelledRef: () => cancelled,
          engineRef: enginRef,
          cachedVolumeRef,
          cachedVolumeIdRef,
        });
        if (cancelled) return;
        setStage('ready');
      } catch (err) {
        if (cancelled) return;
        console.error('[CBCT viewer] init failed:', err);
        setError(toCbctError(err));
        setStage('error');
      }
    })();

    return () => { cancelled = true; };
  }, [studyId, shareKey, sharePayload, effectiveStudyId, navigate, location.pathname, location.search, reloadToken]);

  // Auto-poll while the server-side conversion is running (W2): re-run
  // the load every CONVERTING_POLL_MS until the NIfTI is ready. The timer
  // restarts after each attempt, and is cleaned up on unmount / stage
  // change, so it can never double-fire.
  useEffect(() => {
    if (stage !== 'converting') return;
    const t = setTimeout(() => setReloadToken((n) => n + 1), CONVERTING_POLL_MS);
    return () => clearTimeout(t);
  }, [stage, reloadToken]);

  return {
    stage,
    error,
    progress,
    presetTable,
    setPresetTable,
    studyMeta,
    retry,
    enginRef,
    cachedVolumeRef,
    cachedVolumeIdRef,
    axialRef,
    coronalRef,
    sagittalRef,
    vrRef,
  };
}
