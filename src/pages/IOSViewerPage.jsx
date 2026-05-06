/*
 * IOS Viewer page — moved from EMR (src/pages/IOSViewerPage.jsx).
 *
 * Modes:
 *   ?id=<patient_files.id>     Resolve via patient_files lookup + Supabase signed URL
 *   ?path=<bucket/key>          Resolve via direct Supabase storage signed URL
 *   ?demo=1                     Load a public sample STL — no auth needed (validation)
 *
 * Reads a 1-hour signed URL from the shared Supabase project and renders
 * the Three.js ModelViewer. The demo mode lets anyone hit the viewer
 * without an auth session, so we can validate the renderer end-to-end.
 */

import React, { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Loader2, AlertCircle, ArrowLeft, ExternalLink } from 'lucide-react';
import { resolveSignedUrl } from '../lib/signedUrl';
import { ModelViewer } from '../components/ios-viewer/ModelViewer';

// Public sample mesh — Three.js examples bunny. Small (~80KB), binary STL,
// good for validating the loader pipeline. Lives at threejs.org's CDN.
const DEMO_FILE = {
  url: 'https://threejs.org/examples/models/stl/binary/pr2_head_pan.stl',
  name: 'Demo: PR2 head pan (Three.js sample)',
  type: 'stl',
};

export default function IOSViewerPage() {
  const [searchParams] = useSearchParams();
  const [fileUrl, setFileUrl] = useState(null);
  const [fileName, setFileName] = useState('3D Scan');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Viewer settings — same shape as the EMR's IOSViewerPage
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

  const isDemo = searchParams.get('demo') === '1';
  const fileId = searchParams.get('id');
  const filePath = searchParams.get('path');
  const queryName = searchParams.get('name');
  const fileType = searchParams.get('type') || (isDemo ? DEMO_FILE.type : 'stl');

  const patient = {
    id: fileId || 'P001',
    name: queryName || (isDemo ? 'Demo Patient' : 'Patient'),
    gender: 'male',
    age: 30,
  };
  const scan = {
    id: fileId || 'S001',
    patientId: patient.id,
    type: 'IOS',
    name: fileName,
    createdAt: new Date().toISOString(),
    hasModel: true,
  };

  useEffect(() => {
    document.title = `${queryName || (isDemo ? 'Demo' : '3D Scan')} · aiHealth Imaging`;

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (isDemo) {
          if (cancelled) return;
          setFileUrl(DEMO_FILE.url);
          setFileName(DEMO_FILE.name);
        } else {
          const r = await resolveSignedUrl({ id: fileId, path: filePath });
          if (cancelled) return;
          setFileUrl(r.url);
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
  }, [fileId, filePath, queryName, isDemo]);

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
            This page expects either{' '}
            <code className="text-accent font-mono">?id=&lt;file_id&gt;</code> or{' '}
            <code className="text-accent font-mono">?path=&lt;bucket/key&gt;</code>{' '}
            in the URL.
            <br />
            To validate the renderer with no auth, try the demo mode.
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
            DEMO MODE — sample mesh, not real patient data
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
      />
    </div>
  );
}
