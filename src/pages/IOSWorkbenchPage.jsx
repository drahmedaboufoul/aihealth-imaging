/*
 * /viewer/ios/workbench — IOS workbench v1.
 *
 *   (no params)                 open local STL/PLY/OBJ files (read in the browser, never uploaded)
 *   ?study=<id>                 load a study's scans (same signed-URL path and sign-in gate as /viewer/ios)
 *   ?study=<id>&compare=<id>    two visits: up to two scans from each study
 *
 * Share / read-only sessions are not offered the workbench.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';
import * as THREE from 'three';
import Workbench from '../workbench/ui/Workbench';
import { safeErrorMessage } from '../lib/safeError';

function toIncoming(files, prefix) {
  return files.map((f) => ({
    name: f.fileName,
    read: async () => {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`The ${prefix} scan could not be downloaded (HTTP ${res.status}).`);
      return res.arrayBuffer();
    },
    textureUrl: f.textureUrl,
    // saved bite registration (row-major in the study record) -> column-major pose
    matrix: Array.isArray(f.matrix) ? new THREE.Matrix4().set(...f.matrix).elements.slice() : undefined,
  }));
}

export default function IOSWorkbenchPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const studyId = params.get('study');
  const compareId = params.get('compare');
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!!studyId);

  useEffect(() => {
    document.title = 'IOS workbench · aiHealth Imaging';
    if (!studyId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const [{ supabase }, { resolveStudyFiles }] = await Promise.all([import('../lib/supabase'), import('../lib/signedUrl')]);
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
          return;
        }
        const primary = await resolveStudyFiles(studyId);
        let incoming = toIncoming(primary.slice(0, compareId ? 2 : 4), 'study');
        if (compareId) {
          const other = await resolveStudyFiles(compareId);
          incoming = incoming.concat(toIncoming(other.slice(0, 2), 'comparison'));
        }
        if (!cancelled) setFiles(incoming);
      } catch (err) {
        if (!cancelled) setError(safeErrorMessage(err, 'The study scans could not be loaded.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [studyId, compareId, navigate, location.pathname, location.search]);

  const backTo = useMemo(() => (studyId ? `/viewer/ios?study=${encodeURIComponent(studyId)}` : '/'), [studyId]);

  if (loading) {
    return (
      <div className="h-screen w-screen bg-gray-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-gray-500"><Loader2 size={28} className="animate-spin" /><p className="text-[12px]">Loading study scans…</p></div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="h-screen w-screen bg-gray-100 flex items-center justify-center p-6">
        <div className="max-w-md text-center flex flex-col items-center gap-3">
          <AlertCircle size={28} className="text-red-600" />
          <p className="text-[14px] font-medium text-gray-800">Could not open the workbench</p>
          <p className="text-[12px] text-gray-500">{error}</p>
        </div>
      </div>
    );
  }
  return <Workbench initialFiles={files} backTo={backTo} title={studyId ? (compareId ? 'Two visits' : 'Study scans') : 'Local files'} />;
}
