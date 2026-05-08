/*
 * IOS Viewer page — mounts the ModelViewer ported from EMR.
 *
 * Modes:
 *   ?id=<patient_files.id>     Resolve via patient_files lookup + signed URL
 *   ?path=<bucket/key>          Direct Supabase storage path → signed URL
 *   ?demo=1                     No fileUrl — renders the built-in DentalModel mock
 *                               so the visibility toggles + tools all wire up
 *                               correctly without scale issues. Use this to
 *                               validate the viewer end-to-end.
 *
 * Two important fixes vs. the EMR's IOSViewerPage:
 *   - scan/patient are useMemo'd. The EMR version recreated them on every
 *     render (including a `createdAt: new Date().toISOString()` field that
 *     changed on every paint). ModelViewer's loading-overlay effect has
 *     `[scan]` as a dep, so a fresh object reference each render triggered
 *     the loading overlay every time a tool was clicked — the "viewer
 *     reloads on every click" symptom.
 *   - mouseSettings.leftRotation defaults to FALSE so right-click rotates,
 *     matching exocad / dental-CAD convention (left = pick, right = rotate,
 *     middle = pan, scroll = zoom). Phase 2.5 refactor will lock this in
 *     properly with a full exocad-aligned interaction model.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Loader2, AlertCircle, ArrowLeft, ExternalLink } from 'lucide-react';
import { resolveSignedUrl, resolveStudyFiles } from '../lib/signedUrl';
import { ModelViewer } from '../components/ios-viewer/ModelViewer';

export default function IOSViewerPage() {
  const [searchParams] = useSearchParams();
  const [fileUrl, setFileUrl] = useState(null);
  const [fileName, setFileName] = useState('3D Scan');
  // Multi-file mode (study mode): array of { url, fileName, fileType }.
  // null until resolved; empty array means "we tried but found nothing".
  const [files, setFiles] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Viewer settings — same shape as EMR
  const [viewerSettings, setViewerSettings] = useState({
    maxillaVisible: true,
    maxillaOpacity: 100,
    mandibleVisible: true,
    mandibleOpacity: 100,
    occlusionVisible: true,
    occlusionOpacity: 100,
    showGrid: true,
  });
  const [activeTool, setActiveTool] = useState('none');
  // Right-click drag rotates (exocad / dental-CAD standard).
  // Left-click is reserved for picking / measurement points.
  const [mouseSettings, setMouseSettings] = useState({ leftRotation: false });

  const isDemo = searchParams.get('demo') === '1';
  const fileId = searchParams.get('id');
  const filePath = searchParams.get('path');
  const queryName = searchParams.get('name');
  const fileType = searchParams.get('type') || 'stl';
  const studyId = searchParams.get('study');

  // Memoize patient + scan so their object references stay stable across
  // renders. Without this, ModelViewer's `useEffect(..., [scan])` re-runs
  // on every keystroke / tool click and re-shows the loading overlay.
  const patient = useMemo(() => ({
    id: fileId || 'P001',
    name: queryName || (isDemo ? 'Demo Patient' : 'Patient'),
    gender: 'male',
    age: 30,
  }), [fileId, queryName, isDemo]);

  const scan = useMemo(() => ({
    id: fileId || 'S001',
    patientId: patient.id,
    type: 'IOS',
    name: fileName,
    // NOTE: no createdAt — that field was recreating on every render in the
    // EMR copy and forcing ModelViewer to re-mount its loading overlay.
    hasModel: true,
  }), [fileId, patient.id, fileName]);

  useEffect(() => {
    document.title = `${queryName || (isDemo ? 'Demo' : (studyId ? 'Study' : '3D Scan'))} · aiHealth Imaging`;

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (isDemo) {
          // Demo intentionally leaves fileUrl null. ModelViewer's branch
          // logic falls through to DentalModel (built-in mock maxilla +
          // mandible + occlusion meshes) which is what the visibility
          // toggles + tools are designed for.
          if (cancelled) return;
          setFileUrl(null);
          setFiles(null);
          setFileName('Demo Mesh');
        } else if (studyId) {
          // Multi-file study mode — load every STL/PLY/OBJ for the study.
          const arr = await resolveStudyFiles(studyId);
          if (cancelled) return;
          setFiles(arr.map((f) => ({
            url: f.url,
            fileName: f.fileName,
            fileType: f.fileKind,
          })));
          setFileUrl(null);
          setFileName(`Case · ${arr.length} scan${arr.length !== 1 ? 's' : ''}`);
        } else {
          // Legacy single-file mode
          const r = await resolveSignedUrl({ id: fileId, path: filePath });
          if (cancelled) return;
          setFileUrl(r.url);
          setFiles(null);
          setFileName(r.fileName || queryName || '3D Scan');
        }
      } catch (err) {
        if (cancelled) return;
        setError(err.message || String(err));
        console.error('Error loading file:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fileId, filePath, queryName, isDemo, studyId]);

  if (loading) {
    return (
      <div className="h-screen w-screen bg-bg flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted">
          <Loader2 size={28} className="animate-spin" />
          <p className="text-[12px]">Loading 3D scan…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen w-screen bg-bg flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center flex flex-col items-center gap-4">
          <AlertCircle size={28} className="text-destructive" />
          <div>
            <p className="text-[14px] font-medium text-text">Could not load 3D scan</p>
            <p className="text-[11px] text-muted font-mono break-all mt-1">{error}</p>
          </div>
          <div className="text-[11.5px] text-muted leading-relaxed mt-2">
            This page expects one of:{' '}
            <code className="text-accent font-mono">?study=&lt;study_id&gt;</code>{' '}
            (loads upper + lower + occlusion together),{' '}
            <code className="text-accent font-mono">?id=&lt;file_id&gt;</code>, or{' '}
            <code className="text-accent font-mono">?path=&lt;bucket/key&gt;</code>.
          </div>
          <div className="flex items-center gap-2 mt-2">
            <Link
              to="/viewer/ios?demo=1"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium bg-accent text-bg hover:bg-accent/90"
              style={{ backgroundImage: 'none' }}
            >
              <ExternalLink size={12} /> Open demo
            </Link>
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] border border-border hover:border-accent/40"
            >
              <ArrowLeft size={12} /> Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden">
      {isDemo && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
          <div className="bg-accent text-bg text-[11px] font-medium px-3 py-1 rounded-full shadow-lg">
            DEMO MODE — built-in mock mesh (visibility toggles + tools wired)
          </div>
        </div>
      )}
      <ModelViewer
        scan={scan}
        patient={patient}
        viewerSettings={viewerSettings}
        onUpdateSettings={setViewerSettings}
        activeTool={activeTool}
        onSetTool={setActiveTool}
        mouseSettings={mouseSettings}
        onUpdateMouseSettings={setMouseSettings}
        onClose={() => window.close()}
        fileUrl={fileUrl}
        fileType={fileType}
        files={files}
      />
    </div>
  );
}
