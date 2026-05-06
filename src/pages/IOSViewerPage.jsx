/*
 * IOS Viewer page — moved from EMR (src/pages/IOSViewerPage.jsx).
 *
 * Reads file via patient_files lookup (id) or direct storage path (path),
 * mints a 1-hour signed URL, and renders the Three.js ModelViewer.
 *
 * Auth: relies on the shared Supabase project's auth session — when the
 * user clicks View in the EMR, their session cookie is already set for
 * the *.aihealth.app domain (phase 1). For pure direct access, the
 * imaging app expects an active Supabase auth session.
 */

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';
import { resolveSignedUrl } from '../lib/signedUrl';
import { ModelViewer } from '../components/ios-viewer/ModelViewer';

export default function IOSViewerPage() {
  const [searchParams] = useSearchParams();
  const [fileUrl, setFileUrl] = useState(null);
  const [fileName, setFileName] = useState('3D Scan');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Viewer settings state — same shape as the EMR's IOSViewerPage
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
  const [mouseSettings, setMouseSettings] = useState({ leftRotation: true });

  const fileId = searchParams.get('id');
  const filePath = searchParams.get('path');
  const queryName = searchParams.get('name');
  const fileType = searchParams.get('type') || 'stl';

  // Synthetic patient + scan objects for the ModelViewer header.
  // Real patient context comes via the optional `?patient=` param later;
  // for now we keep the same shape as the EMR's IOSViewerPage.
  const patient = {
    id: fileId || 'P001',
    name: queryName || 'Patient',
    gender: 'male',
    age: 30,
  };
  const scan = {
    id: fileId || 'S001',
    patientId: patient.id,
    type: 'IOS',
    name: queryName || '3D Scan',
    createdAt: new Date().toISOString(),
    hasModel: true,
  };

  useEffect(() => {
    document.title = `${queryName || '3D Scan'} · aiHealth Imaging`;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await resolveSignedUrl({ id: fileId, path: filePath });
        if (cancelled) return;
        setFileUrl(r.url);
        setFileName(r.fileName || queryName || '3D Scan');
      } catch (err) {
        if (cancelled) return;
        setError(err.message);
        console.error('Error loading file:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fileId, filePath, queryName]);

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
      <div className="h-screen w-screen bg-bg flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 max-w-sm text-center">
          <AlertCircle size={28} className="text-destructive" />
          <p className="text-[13px] font-medium">Could not load 3D scan</p>
          <p className="text-[11px] text-muted font-mono break-all">{error}</p>
          <button
            type="button"
            onClick={() => window.close()}
            className="mt-2 px-3 py-1.5 text-[12px] rounded border border-border hover:border-foreground/40"
          >
            Close window
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden">
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
      />
    </div>
  );
}
