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
import { useSearchParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { Loader2, AlertCircle, ArrowLeft, ExternalLink, GitCompare, X, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import ShareInviteDialog from '../components/ShareInviteDialog';
import { resolveSignedUrl, resolveStudyFiles } from '../lib/signedUrl';
import { readSharePayload, shareMeshFiles, SHARE_EXPIRED_MESSAGE } from '../lib/sharePayload';
import { ModelViewer } from '../components/ios-viewer/ModelViewer';
import { supabase } from '../lib/supabase';

export default function IOSViewerPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [fileUrl, setFileUrl] = useState(null);
  const [fileName, setFileName] = useState('3D Scan');
  // Multi-file mode (study mode): array of { url, fileName, fileType }.
  // null until resolved; empty array means "we tried but found nothing".
  const [files, setFiles] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Patient HUD info pulled from the study (when in study mode) so the
  // viewer can label whose scan this is. Falls back to URL ?name= param.
  const [hud, setHud] = useState(null); // { patientName, studyDate, studyType }

  // Phase 5.2 — two-scan comparison state.
  // comparisonFiles is the same shape as files (array of {url, fileName, fileType}).
  // null when no comparison active.
  const [comparisonFiles, setComparisonFiles] = useState(null);
  const [comparisonStudyInfo, setComparisonStudyInfo] = useState(null);
  const [comparisonOpacity, setComparisonOpacity] = useState(0.55);
  const [comparisonColor, setComparisonColor] = useState('#22d3ee'); // cyan
  const [showCompareDialog, setShowCompareDialog] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [availableStudies, setAvailableStudies] = useState([]);
  const [loadingCompare, setLoadingCompare] = useState(false);

  // Viewer settings — same shape as EMR.
  // meshLayers is populated by MultiMeshModel after files load and supersedes
  // the per-role flags for the right panel.
  const [viewerSettings, setViewerSettings] = useState({
    maxillaVisible: true,
    maxillaOpacity: 100,
    mandibleVisible: true,
    mandibleOpacity: 100,
    occlusionVisible: true,
    occlusionOpacity: 100,
    showGrid: true,
    meshLayers: undefined, // [{ key, label, role, visible, opacity }] when multi-file
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
  // Tokenized share flow: SharedViewerPage validated the token server-side
  // and stashed the resolved payload (signed URLs) in sessionStorage.
  const shareKey = searchParams.get('share');
  const sharePayload = useMemo(() => readSharePayload(shareKey), [shareKey]);
  // Read-only mode for patient portal embeds + shared sessions: hides
  // clinical tools (measurement, occlusal contact, analysis, mouse
  // settings) while keeping orbit, zoom, pan, layer toggles, view presets.
  const readOnly = searchParams.get('readonly') === '1' || searchParams.get('mode') === 'patient' || !!shareKey;

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
        // Shared session: the token was already validated server-side and
        // the payload carries pre-signed URLs — no Supabase auth needed.
        if (shareKey) {
          if (!sharePayload) throw new Error(SHARE_EXPIRED_MESSAGE);
          const meshes = shareMeshFiles(sharePayload);
          if (meshes.length === 0) throw new Error('This shared study has no 3D scan files.');
          if (cancelled) return;
          setFiles(meshes.map((f) => ({
            url: f.url,
            fileName: f.fileName,
            fileType: f.fileKind,
          })));
          setFileUrl(null);
          setFileName(`Case · ${meshes.length} scan${meshes.length !== 1 ? 's' : ''}`);
          setHud({
            patientName: sharePayload.study?.patient_name || null,
            studyDate:   sharePayload.study?.study_date || null,
            studyType:   sharePayload.study?.study_type || null,
          });
          return;
        }
        // Auth gate — non-demo paths read RLS-protected tables. If there's
        // no session, bounce to /login with a return path so the user lands
        // back here after signing in.
        if (!isDemo) {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) {
            const back = encodeURIComponent(location.pathname + location.search);
            navigate(`/login?next=${back}`, { replace: true });
            return;
          }
        }

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
          // Fetch the study + patient name for the HUD. Best-effort —
          // failures here don't block rendering.
          try {
            const { data: study } = await supabase
              .from('imaging_studies')
              .select('study_type, study_date, customers(name)')
              .eq('id', studyId)
              .maybeSingle();
            if (study && !cancelled) {
              setHud({
                patientName: study.customers?.name || queryName || null,
                studyDate:   study.study_date,
                studyType:   study.study_type,
              });
            }
          } catch (_) {}
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
  }, [fileId, filePath, queryName, isDemo, studyId, shareKey, sharePayload]);

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

  // Open the comparison-study picker. Pulls all OTHER IOS studies for
  // this patient (or all clinic IOS studies if no patient context).
  const openComparePicker = async () => {
    if (!hud?.patientName && !studyId) return; // need a study context
    setShowCompareDialog(true);
    setLoadingCompare(true);
    try {
      // Get patient_id of the current study
      let patientId = null;
      if (studyId) {
        const { data } = await supabase
          .from('imaging_studies').select('patient_id').eq('id', studyId).maybeSingle();
        patientId = data?.patient_id;
      }
      if (!patientId) { setAvailableStudies([]); setLoadingCompare(false); return; }
      const { data: rows } = await supabase
        .from('imaging_studies')
        .select('id, study_type, study_date, description')
        .eq('patient_id', patientId)
        .in('study_type', ['intraoral_scan'])
        .neq('id', studyId)
        .order('study_date', { ascending: false });
      setAvailableStudies(rows || []);
    } catch (e) {
      console.warn('[compare] picker load failed:', e?.message);
      setAvailableStudies([]);
    } finally {
      setLoadingCompare(false);
    }
  };

  const selectComparisonStudy = async (chosenStudyId, label) => {
    try {
      const arr = await resolveStudyFiles(chosenStudyId);
      setComparisonFiles(arr.map((f) => ({
        url: f.url, fileName: f.fileName, fileType: f.fileKind,
      })));
      setComparisonStudyInfo({ id: chosenStudyId, label });
      setShowCompareDialog(false);
    } catch (e) {
      toast.error('Could not load study: ' + (e?.message || e));
    }
  };

  const clearComparison = () => {
    setComparisonFiles(null);
    setComparisonStudyInfo(null);
  };

  return (
    <div className="h-screen w-screen overflow-hidden">
      {/* Compare picker dialog */}
      {showCompareDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setShowCompareDialog(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-lg shadow-2xl max-w-md w-full mx-4 p-5"
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <GitCompare size={16} className="text-cyan-600" />
                Compare with another scan
              </h2>
              <button onClick={() => setShowCompareDialog(false)} className="text-gray-400 hover:text-gray-700">
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Pick another IOS scan from this patient to overlay on top of the current one.
              The overlay renders in cyan with adjustable opacity for direct comparison.
            </p>
            {loadingCompare ? (
              <div className="text-sm text-gray-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>
            ) : availableStudies.length === 0 ? (
              <div className="text-sm text-gray-500 italic">No other IOS scans for this patient.</div>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-auto">
                {availableStudies.map((s) => {
                  const label = s.description || `Scan · ${new Date(s.study_date).toLocaleDateString('en-GB')}`;
                  return (
                    <button
                      key={s.id}
                      onClick={() => selectComparisonStudy(s.id, label)}
                      className="w-full text-left text-sm px-3 py-2 rounded border border-gray-200 hover:border-cyan-400 hover:bg-cyan-50/50 transition-colors"
                    >
                      <div className="font-medium text-gray-900">{label}</div>
                      <div className="text-xs text-gray-500">{new Date(s.study_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {isDemo && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
          <div className="bg-accent text-bg text-[11px] font-medium px-3 py-1 rounded-full shadow-lg">
            DEMO MODE — built-in mock mesh (visibility toggles + tools wired)
          </div>
        </div>
      )}
      {/* Patient HUD — top-right corner. Shows whose scan this is +
          modality + date so clinicians always know what they're viewing. */}
      {(hud?.patientName || queryName) && !isDemo && (
        <div className="absolute top-3 right-3 z-40 pointer-events-none">
          <div
            className="text-[11px] font-mono rounded shadow-lg px-3 py-1.5 backdrop-blur-sm"
            style={{ backgroundColor: 'rgba(11,13,16,0.78)', color: '#cdd2d8', border: '1px solid #1d2128' }}
          >
            <div className="font-semibold tracking-wide text-amber-300">
              {hud?.patientName || queryName}
            </div>
            <div className="text-[9px] uppercase tracking-wider text-gray-400 mt-0.5 flex items-center gap-1.5">
              {hud?.studyType && <span>{hud.studyType.replace(/_/g, ' ')}</span>}
              {hud?.studyDate && (
                <>
                  <span className="text-gray-600">·</span>
                  <span>{new Date(hud.studyDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                </>
              )}
              {fileName && !hud?.studyType && (
                <span>{fileName}</span>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Share button — top-right, below ModelViewer's h-14 topbar so it
          doesn't collide with the patient HUD. Same invite flow as the
          DICOM/CBCT viewers; hidden in read-only / demo sessions. */}
      {!readOnly && !isDemo && studyId && (
        <div className="absolute top-16 right-3 z-30">
          <button
            onClick={() => setShowShareDialog(true)}
            className="bg-white text-gray-800 text-[11px] font-semibold px-3 py-1.5 rounded-lg shadow-md border border-gray-200 hover:bg-amber-50 hover:border-amber-300 flex items-center gap-1.5"
            title="Create a share link for this study"
          >
            <Share2 size={12} className="text-amber-600" />
            Share
          </button>
        </div>
      )}
      {showShareDialog && studyId && (
        <ShareInviteDialog
          studyId={studyId}
          patientName={hud?.patientName}
          onClose={() => setShowShareDialog(false)}
        />
      )}

      {/* Compare button + active overlay panel — hidden in read-only patient embed */}
      {!readOnly && !isDemo && studyId && (
        <div className="absolute bottom-3 left-3 z-30">
          {!comparisonFiles ? (
            <button
              onClick={openComparePicker}
              className="bg-white text-gray-800 text-[11px] font-semibold px-3 py-1.5 rounded-lg shadow-md border border-gray-200 hover:bg-cyan-50 hover:border-cyan-300 flex items-center gap-1.5"
            >
              <GitCompare size={12} className="text-cyan-600" />
              Compare with another scan
            </button>
          ) : (
            <div className="bg-white rounded-lg shadow-md border border-gray-200 p-2.5 min-w-64">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-cyan-700 flex items-center gap-1">
                  <GitCompare size={10} /> Comparing
                </div>
                <button
                  onClick={clearComparison}
                  className="text-gray-400 hover:text-red-600 text-[10px]"
                  title="Stop comparing"
                >
                  <X size={12} />
                </button>
              </div>
              <div className="text-xs text-gray-700 font-medium mb-1.5 truncate">
                {comparisonStudyInfo?.label || 'Second scan'}
              </div>
              <div className="flex items-center gap-2 text-[10px] text-gray-600">
                <span>Opacity</span>
                <input
                  type="range" min={0.1} max={1} step={0.05}
                  value={comparisonOpacity}
                  onChange={(e) => setComparisonOpacity(Number(e.target.value))}
                  className="flex-1 accent-cyan-600"
                />
                <span className="font-mono w-8 text-right">{Math.round(comparisonOpacity * 100)}%</span>
              </div>
              <div className="flex items-center gap-1 mt-1.5">
                {[
                  { c: '#22d3ee', name: 'cyan' },
                  { c: '#a855f7', name: 'purple' },
                  { c: '#ef4444', name: 'red' },
                  { c: '#fbbf24', name: 'amber' },
                ].map((opt) => (
                  <button
                    key={opt.c}
                    onClick={() => setComparisonColor(opt.c)}
                    title={opt.name}
                    style={{
                      width: 18, height: 18, borderRadius: 4, backgroundColor: opt.c,
                      border: comparisonColor === opt.c ? '2px solid #1f2937' : '1px solid #d4d4d8',
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <ModelViewer
        scan={scan}
        patient={patient}
        viewerSettings={viewerSettings}
        onUpdateSettings={(updates) => setViewerSettings((s) => ({ ...s, ...updates }))}
        activeTool={activeTool}
        onSetTool={setActiveTool}
        mouseSettings={mouseSettings}
        onUpdateMouseSettings={setMouseSettings}
        onClose={() => window.close()}
        fileUrl={fileUrl}
        fileType={fileType}
        files={files}
        readOnly={readOnly}
        onMeshesReady={(layers) =>
          setViewerSettings((s) => ({ ...s, meshLayers: layers }))
        }
        comparisonFiles={comparisonFiles}
        comparisonOpacity={comparisonOpacity}
        comparisonColor={comparisonColor}
      />
    </div>
  );
}
