/*
 * CBCTViewerPage — true 3D CBCT viewer with MPR + volume rendering.
 *
 * Cornerstone3D 4.x rewrite. The 1.x streaming-image-volume-loader had a
 * fatal incompatibility with JPEG-2000 encapsulated DICOM (would re-parse
 * compressed bytes for slice positions and crash). The 4.x core ships a
 * fixed streaming volume loader that handles all transfer syntaxes plus
 * synchronized crosshairs + reference lines out of the box.
 *
 * URL contract:
 *   /viewer/cbct?study=<imaging_studies.id>   load all DICOM instances as a volume
 *
 * Layout: 4-panel grid
 *   ┌─────────────┬─────────────┐
 *   │ AXIAL       │ CORONAL     │
 *   ├─────────────┼─────────────┤
 *   │ SAGITTAL    │ 3D VOLUME   │
 *   └─────────────┴─────────────┘
 *
 * Crosshairs tool: clicking on any MPR panel snaps the cross-hairs to that
 * point and updates the other two panels to show the corresponding slice
 * through the 3D volume — exactly the radiology-workstation behaviour the
 * user asked for.
 *
 * ── Structure (A0 monolith split) ──────────────────────────────────────
 * This page is the composition root: it owns state + cross-cutting
 * actions (AI, promote-to-plan, live co-viewing) and delegates rendering
 * and effects to:
 *   components/cbct/cbctViewModes.js   view-mode config + constants
 *   components/cbct/cbctEngine.js      Cornerstone engine/tool-group setup
 *   components/cbct/cbctMath.js        implant↔nerve distance math
 *   components/cbct/ViewerTopBar.jsx   header + patient banner + mode tabs
 *   components/cbct/ToolRail.jsx       48px tool strip + tabbed context panel
 *   components/cbct/ViewportGrid.jsx   per-mode viewport layouts + states
 *   components/cbct/overlays/*         Arch / Nerve / Implant SVG overlays
 *   components/cbct/modals/*           Promote-to-Plan + AI dialogs (Radix)
 *   components/viewer/*                shared tokens/controls/tool config
 *   hooks/useCbctVolume.js             volume-load lifecycle + typed errors
 *   hooks/useCbctTools.js              tool/display/annotation effects
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import ShareInviteDialog from '../components/ShareInviteDialog';
import ViewerTopBar from '../components/cbct/ViewerTopBar';
import ToolRail from '../components/cbct/ToolRail';
import ViewportGrid from '../components/cbct/ViewportGrid';
import MinWidthGuard from '../components/viewer/MinWidthGuard';
import PromotePlanModal from '../components/cbct/modals/PromotePlan';
import AiPanel from '../components/cbct/modals/AiPanel';
import { useCbctVolume } from '../hooks/useCbctVolume';
import { useCbctTools } from '../hooks/useCbctTools';
import { VIEW_MODES, AI_VIEW_LABELS } from '../components/cbct/cbctViewModes';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/supabase';
import { readSharePayload } from '../lib/sharePayload';
import { useViewerRoom } from '../hooks/useViewerRoom';
import { serializeCbctState, applyCbctState, cbctRoomId } from '../lib/viewerRoom';
import { isSimulatedAiResult } from '../lib/featureFlags';

export default function CBCTViewerPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const studyId = searchParams.get('study');
  // Tokenized share flow: SharedViewerPage validated the token server-side
  // and stashed the resolved payload (signed URLs + saved annotations) in
  // sessionStorage. In share mode we skip the Supabase auth gate and all
  // DB reads/writes — everything renders from the payload, read-only.
  const shareKey = searchParams.get('share');
  const sharePayload = useMemo(() => readSharePayload(shareKey), [shareKey]);
  const readOnly = searchParams.get('readonly') === '1' || !!shareKey;
  const effectiveStudyId = studyId || sharePayload?.study?.id || null;

  // ── Volume lifecycle (stage / error / progress / presets / refs) ────
  const {
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
  } = useCbctVolume({
    studyId,
    shareKey,
    sharePayload,
    effectiveStudyId,
    navigate,
    location,
  });

  // ── Viewer state ─────────────────────────────────────────────────────
  const [activePreset, setActivePreset] = useState('Bone');

  // Phase 1: active measurement / interaction tool. 'crosshair' is default.
  const [activeTool, setActiveTool] = useState('crosshair');

  // Per-panel slice HUD: { CBCT_AXIAL: { current, total }, ... }
  const [sliceHud, setSliceHud] = useState({});

  // View mode — 'mpr-3d' (default), 'ceph', 'pano', 'crosssec', 'tmj'.
  // (Legacy 'implant' mode keys are aliased to 'mpr-3d' in switchViewMode.)
  const [viewMode, setViewMode] = useState('mpr-3d');

  // Display toggles
  const [invert, setInvert]               = useState(false);
  const [showRefLines, setShowRefLines]   = useState(true);
  const [slabThickness, setSlabThickness] = useState(0); // in mm; 0 = single slice

  // Annotation list (refreshed periodically while the user is drawing).
  // Each entry: { uid, toolName, displayText, viewportId }
  const [annotations, setAnnotations] = useState([]);

  // AI panel — live vision read + (flag-gated) placeholder segmentation.
  // aiLastRun entries: { ts, result, simulated, canApply }
  const [showAiModal, setShowAiModal] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [aiRunning, setAiRunning] = useState({}); // { 'nerve-canal': true }
  const [aiLastRun, setAiLastRun] = useState({}); // { 'nerve-canal': { ts, result, simulated, canApply } }

  // Claude-vision CBCT reading — unlike the Phase-4 segmentation stubs, this
  // path is live: it captures the panes on screen and POSTs them to the
  // ai-read-cbct edge function, which returns ranked findings.
  const [aiReadStage, setAiReadStage]   = useState('idle'); // idle | running | done | error
  const [aiReadError, setAiReadError]   = useState(null);
  const [aiReadResult, setAiReadResult] = useState(null); // cbct_reader payload

  // Live co-viewing (same room pattern as DicomViewerPage). Operator = authed
  // clinician who flips "Go live"; follower = shared/read-only session that
  // mirrors the operator's view mode / preset / invert / slab. The room is
  // namespaced ':cbct' so it never collides with a live 2D session on the
  // same study id.
  const [goLive, setGoLive] = useState(false);
  const applyingRemoteRef = useRef(false); // guard so applied frames don't echo
  const roomRole = readOnly ? 'follower' : (goLive ? 'operator' : null);
  // Latest local packed frame + latest setter closures — refreshed every
  // render (below switchViewMode's declaration) so the follower always calls
  // the current closures, not stale ones captured at subscribe time.
  const cbctStateRef = useRef(null);
  const remoteSettersRef = useRef({});

  const onRemoteState = useCallback((frame) => {
    applyingRemoteRef.current = true;
    applyCbctState(cbctStateRef.current, frame, remoteSettersRef.current);
    setTimeout(() => { applyingRemoteRef.current = false; }, 0);
  }, []);

  const { participants, operatorPresent, operatorName, publish: roomPublish } = useViewerRoom({
    roomId: effectiveStudyId ? cbctRoomId(effectiveStudyId) : null,
    role: roomRole,
    onRemoteState,
  });

  // Phase 3.6.2 — "Promote to Treatment Plan" dialog state.
  // When the user has placed implants, they can promote the planning
  // session into a formal treatment_plans row that flows into the EMR's
  // billing + plan-acceptance pipeline.
  const [showPromoteModal, setShowPromoteModal] = useState(false);
  const [promoteTitle,     setPromoteTitle]     = useState('Implant treatment plan');
  const [promoteFeePerImplant, setPromoteFeePerImplant] = useState(4500);
  const [promotingPlan,    setPromotingPlan]    = useState(false);
  const [promoteResult,    setPromoteResult]    = useState(null); // { planId } on success
  const [promoteError,     setPromoteError]     = useState(null); // inline dialog error (W1)

  // Phase 3.2 arch-curve Pano state. archPoints is an array of [worldX, worldY]
  // captured from user clicks on the axial viewport. The pano canvas
  // re-renders whenever the points or VOI change.
  const [archPoints, setArchPoints]   = useState([]);
  const [archSlabMM, setArchSlabMM]   = useState(8); // perp slab thickness mm
  // Surface render-side failures (null scalarData, missing geometry, etc.)
  // in the pano panel so the user sees *why* the right-hand image stays
  // empty instead of staring at a black canvas with no feedback.
  const [panoRenderError, setPanoRenderError] = useState(null);
  // Explicit "Trace Arch" tool — when true, ANY left-click on the axial
  // adds an arch point. When false, only Shift+Click adds points (legacy
  // shortcut). This makes the workflow discoverable instead of hidden
  // behind a keyboard modifier.
  const [tracingArch, setTracingArch] = useState(false);
  const panoCanvasRef                 = useRef(null);

  // Phase 3.3 cross-sections — N thin slices perpendicular to the arch
  // curve at uniform arc-length spacing. Each is rendered into its own
  // <canvas>; the refs are collected lazily.
  const [xsWidthMM, setXsWidthMM] = useState(25);
  const xsCanvasRefs = useRef([]);

  // Phase 3.5 nerve canal trace. nervePoints is an array of 3D world
  // points [x, y, z]. tracingNerve enables Shift+Click capture on any
  // MPR viewport. safetyZoneMM is the radius around the polyline
  // rendered as an overlay (clinical default 2mm — inferior alveolar
  // nerve injury risk threshold for implant proximity).
  const [nervePoints, setNervePoints]     = useState([]);
  const [tracingNerve, setTracingNerve]   = useState(false);
  const [safetyZoneMM, setSafetyZoneMM]   = useState(2);
  // How thick a slab around the active slice plane to highlight the
  // nerve in. User-adjustable so they can widen if the nerve disappears
  // between slices, or narrow for surgical precision. Default 5mm gives
  // a generous view; 2mm matches the actual canal diameter.
  const [nerveSlabMM, setNerveSlabMM]     = useState(5);

  // Phase 3.4 implant placement. implants is an array of:
  //   { id, apex: [x,y,z], head: [x,y,z], diameterMM, lengthMM, label }
  // placingImplant: when set to a catalog entry { diameterMM, lengthMM, label },
  // the next two Shift+Clicks on MPR define apex then head.
  const [implants, setImplants]                 = useState([]);
  const [placingImplant, setPlacingImplant]     = useState(null);
  const [pendingApex, setPendingApex]           = useState(null);
  const [implantCatalogOpen, setImplantCatalogOpen] = useState(false);

  // ── Interaction layer (tools / display / annotations / tracing) ──────
  const {
    selectTool,
    applyPreset,
    switchViewMode,
    handleResetViews,
    handleClearMeasurements,
    handleSaveMeasurements,
  } = useCbctTools({
    stage,
    enginRef,
    cachedVolumeRef,
    cachedVolumeIdRef,
    axialRef,
    coronalRef,
    sagittalRef,
    vrRef,
    viewMode,
    setViewMode,
    invert,
    setInvert,
    showRefLines,
    slabThickness,
    activeTool,
    setActiveTool,
    presetTable,
    activePreset,
    setActivePreset,
    setSliceHud,
    setAnnotations,
    archPoints,
    setArchPoints,
    archSlabMM,
    setArchSlabMM,
    tracingArch,
    xsWidthMM,
    xsCanvasRefs,
    panoCanvasRef,
    setPanoRenderError,
    nervePoints,
    setNervePoints,
    safetyZoneMM,
    setSafetyZoneMM,
    tracingNerve,
    implants,
    setImplants,
    placingImplant,
    setPlacingImplant,
    pendingApex,
    setPendingApex,
    studyId,
    readOnly,
    sharePayload,
  });

  // ── Live co-viewing wiring ─────────────────────────────────────────
  // Refresh the follower's setter closures + the current packed frame on
  // every render (applyPreset/switchViewMode are re-created per render, so a
  // ref keeps applyCbctState calling the live versions).
  remoteSettersRef.current = {
    setViewMode: (m) => { switchViewMode(m); },
    applyPresetByName: (name) => {
      const p = presetTable.find((x) => x.name === name);
      if (p) applyPreset(p);
    },
    setInvert,
    setSlab: setSlabThickness,
  };
  cbctStateRef.current = serializeCbctState({
    mode: viewMode, preset: activePreset, invert, slab: slabThickness,
  });

  // Operator: broadcast whenever a shared control changes while live. The
  // hook throttles + dedupes; the first run after "Go live" sends the
  // current frame so an already-waiting follower syncs immediately.
  useEffect(() => {
    if (stage !== 'ready' || roomRole !== 'operator') return;
    if (applyingRemoteRef.current) return;
    const s = serializeCbctState({
      mode: viewMode, preset: activePreset, invert, slab: slabThickness,
    });
    if (s) roomPublish(s);
  }, [stage, roomRole, roomPublish, viewMode, activePreset, invert, slabThickness]);

  // ── AI actions ───────────────────────────────────────────────────────
  // Run an AI inference model on this study. The viewer doesn't call
  // the inference service directly (internal-key never leaves server);
  // it POSTs to the EMR's /api/ai-infer route which forwards.
  //
  // W3 (audit finding #2): synthetic placeholder output is flagged
  // SIMULATED and is NEVER auto-applied to clinical overlays — a real
  // result only lands when the user clicks "Apply to viewer" in the
  // AI panel (applyAiResult below).
  const runAiInference = useCallback(async (modelKey) => {
    if (!studyId || readOnly) return;
    setAiRunning((r) => ({ ...r, [modelKey]: true }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      // Same-origin call — /api/ai-infer is now hosted on the imaging
      // project itself (the EMR project has Vercel SSO Deployment
      // Protection enabled which 401'd cross-origin fetches at the edge
      // before our handler could run).
      const resp = await fetch(`/api/ai-infer`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session?.access_token || ''}`,
        },
        body: JSON.stringify({ study_id: studyId, model: modelKey }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(body?.error || resp.statusText);

      const simulated = isSimulatedAiResult(body);
      const canApply = !simulated && (
        (modelKey === 'nerve-canal' && Array.isArray(body.polyline) && body.polyline.length >= 2) ||
        (modelKey === 'arch-curve' && Array.isArray(body.archPoints) && body.archPoints.length >= 3)
      );
      setAiLastRun((r) => ({ ...r, [modelKey]: { ts: Date.now(), result: body, simulated, canApply } }));
      if (simulated) {
        toast.info('SIMULATED result — not applied to clinical overlays', {
          description: 'The placeholder model returned synthetic output (model_state: placeholder).',
        });
      } else if (canApply) {
        toast.success('AI result ready — review and apply it from the AI panel.');
      } else {
        toast.success('AI run finished.');
      }
    } catch (e) {
      console.error('[cbct] AI infer failed:', e);
      toast.error(`AI inference failed: ${e?.message || e}`);
    } finally {
      setAiRunning((r) => ({ ...r, [modelKey]: false }));
    }
  }, [studyId, readOnly]);

  // Apply a NON-simulated AI result to the viewer's clinical overlays.
  // Hard block on synthetic output — placeholder geometry must never
  // reach the nerve/arch overlays (audit finding #2).
  const applyAiResult = useCallback((modelKey) => {
    const entry = aiLastRun[modelKey];
    if (!entry || entry.simulated) return;
    const body = entry.result;
    if (modelKey === 'nerve-canal' && Array.isArray(body?.polyline) && body.polyline.length >= 2) {
      setNervePoints(body.polyline);
      if (typeof body.safety_zone_mm === 'number') setSafetyZoneMM(body.safety_zone_mm);
      setAiLastRun((r) => { const n = { ...r }; delete n[modelKey]; return n; });
      toast.success(`Nerve trace applied (${body.polyline.length} points)`);
    } else if (modelKey === 'arch-curve' && Array.isArray(body?.archPoints) && body.archPoints.length >= 3) {
      setArchPoints(body.archPoints);
      setAiLastRun((r) => { const n = { ...r }; delete n[modelKey]; return n; });
      toast.success(`Arch curve applied (${body.archPoints.length} points)`);
    }
  }, [aiLastRun]);

  const dismissAiResult = useCallback((modelKey) => {
    setAiLastRun((r) => { const n = { ...r }; delete n[modelKey]; return n; });
  }, []);

  // Run the Claude-vision CBCT reader on the panes currently on screen.
  // Captures each visible Cornerstone viewport canvas as PNG (plus the
  // reformatted-pano canvas in Pano view), then POSTs the labeled set to the
  // ai-read-cbct edge function with the caller's JWT — the function
  // RLS-checks the study and persists the reading into
  // imaging_studies.ai_analysis.cbct_reader.
  const runAiVisionRead = useCallback(async () => {
    if (!studyId || readOnly) return;
    setAiReadStage('running');
    setAiReadError(null);
    try {
      const engine = enginRef.current;
      const cfg = VIEW_MODES[viewMode];
      const images = [];
      for (const v of (cfg?.viewports || [])) {
        try {
          const canvas = engine?.getViewport(v.id)?.getCanvas?.();
          const dataUrl = canvas?.toDataURL?.('image/png');
          if (dataUrl) {
            images.push({
              label: AI_VIEW_LABELS[v.id] || v.id.toLowerCase(),
              data: dataUrl,
              mediaType: 'image/png',
            });
          }
        } catch { /* pane not capturable — skip it, don't fail the run */ }
      }
      if (viewMode === 'pano' && panoCanvasRef.current) {
        try {
          const dataUrl = panoCanvasRef.current.toDataURL('image/png');
          if (dataUrl) images.push({ label: 'panoramic', data: dataUrl, mediaType: 'image/png' });
        } catch { /* pano not traced yet */ }
      }
      if (images.length === 0) {
        throw new Error('No panes could be captured in this view mode — switch to MPR + 3D and retry.');
      }
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/ai-read-cbct`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session?.access_token || ''}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ study_id: studyId, images }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(resp.status === 503
          ? 'AI service not configured on this deployment.'
          : (body?.error || `AI request failed (${resp.status}).`));
      }
      setAiReadResult(body?.cbct_reader || null);
      setAiReadStage('done');
    } catch (e) {
      setAiReadError(e?.message || String(e));
      setAiReadStage('error');
    }
  }, [studyId, readOnly, viewMode]);

  // Promote the current implant plan into a formal treatment_plans row
  // in the EMR. Looks up the study's patient + clinic, generates a
  // treatment_items array from the placed implants, and inserts the
  // plan. RLS on treatment_plans is already in place by clinic_id.
  const handlePromoteToTreatmentPlan = useCallback(async () => {
    if (!studyId || implants.length === 0) return;
    setPromotingPlan(true);
    setPromoteResult(null);
    setPromoteError(null);
    try {
      // 1. Look up the imaging study to get patient_id + clinic_id
      const { data: study, error: sErr } = await supabase
        .from('imaging_studies')
        .select('id, patient_id, clinic_id, study_date')
        .eq('id', studyId)
        .single();
      if (sErr) throw new Error('Study lookup failed: ' + sErr.message);
      if (!study?.patient_id || !study?.clinic_id) {
        throw new Error('Study is missing patient or clinic — cannot promote.');
      }

      // 2. Current user = doctor_id
      const { data: { session } } = await supabase.auth.getSession();
      const doctorId = session?.user?.id;
      if (!doctorId) throw new Error('Not signed in.');

      // 3. Build treatment_items from implants
      const items = implants.map((imp, i) => ({
        type: 'implant',
        label: imp.label,
        diameter_mm: imp.diameterMM,
        length_mm: imp.lengthMM,
        tooth_fdi: null, // user can map later in EMR
        unit_price: Number(promoteFeePerImplant) || 0,
        quantity: 1,
        phase: 1,
        notes: `Implant ${i + 1} from CBCT plan`,
      }));
      const totalAmount = items.reduce((s, it) => s + (it.unit_price || 0), 0);

      // 4. Insert the plan
      const { data: plan, error: pErr } = await supabase
        .from('treatment_plans')
        .insert({
          patient_id: study.patient_id,
          clinic_id:  study.clinic_id,
          doctor_id:  doctorId,
          imaging_study_id: study.id,
          source: 'cbct_viewer',
          title: promoteTitle || 'Implant treatment plan',
          description: `Generated from CBCT viewer on ${new Date().toISOString().slice(0, 10)}. ` +
                       `${implants.length} implant${implants.length > 1 ? 's' : ''} planned` +
                       (nervePoints.length >= 2 ? `, IAN traced with ${safetyZoneMM}mm safety zone.` : '.'),
          start_date: new Date().toISOString().slice(0, 10),
          total_amount: totalAmount,
          status: 'draft',
          treatment_items: items,
        })
        .select('id')
        .single();
      if (pErr) throw new Error('Plan insert failed: ' + pErr.message);

      setPromoteResult({ planId: plan.id, count: items.length, total: totalAmount });
    } catch (e) {
      console.error('[cbct] promote-to-plan failed:', e);
      // W1: inline dialog error instead of alert() — the form stays open.
      setPromoteError('Could not create plan: ' + (e?.message || e));
    } finally {
      setPromotingPlan(false);
    }
  }, [studyId, implants, promoteTitle, promoteFeePerImplant, nervePoints, safetyZoneMM]);

  // ── AI panel feature lists ───────────────────────────────────────────
  // Placeholder (synthetic) models — only rendered by AiPanel when the
  // ENABLE_PLACEHOLDER_AI_MODELS dev flag is on.
  const placeholderFeatures = [
    {
      featureKey: 'nerve-canal',
      label: 'Mandibular nerve canal',
      status: 'placeholder',
      desc: 'IAN trace with safety zone — placeholder returns synthetic polyline; real nnU-Net model lands v0.2.',
      onRun: () => runAiInference('nerve-canal'),
      running: !!aiRunning['nerve-canal'],
      lastRun: aiLastRun['nerve-canal'] || null,
    },
    {
      featureKey: 'teeth-segment',
      label: 'Tooth segmentation',
      status: 'placeholder',
      desc: 'Per-tooth labels (FDI). Placeholder returns empty list; real model = ToothFairy3.',
      onRun: () => runAiInference('teeth-segment'),
      running: !!aiRunning['teeth-segment'],
      lastRun: aiLastRun['teeth-segment'] || null,
    },
    {
      featureKey: 'landmarks-ceph',
      label: 'Cephalometric landmarks',
      status: 'placeholder',
      desc: '19 standard landmarks (Sella, Nasion, etc.) on lateral MIP.',
      onRun: () => runAiInference('landmarks-ceph'),
      running: !!aiRunning['landmarks-ceph'],
      lastRun: aiLastRun['landmarks-ceph'] || null,
    },
  ];
  const plannedFeatures = [
    { label: 'Sinus segmentation',          status: 'planned', desc: 'Maxillary sinus boundary for sinus-lift planning' },
    { label: 'Caries detection',            status: 'planned', desc: 'Per-tooth caries flag with confidence score' },
    { label: 'Periapical lesion detection', status: 'planned', desc: 'Auto-flagged radiolucent lesions' },
    { label: 'Implant suggestion',          status: 'planned', desc: 'AI proposes implant positions with collision warnings' },
    { label: 'IOS-CBCT registration',       status: 'planned', desc: 'Align intraoral scan to CBCT for unified planning' },
  ];

  return (
    <div className="h-screen w-screen flex flex-col bg-background-primary text-labels-primary">
      <MinWidthGuard />
      <ViewerTopBar
        readOnly={readOnly}
        embedded={!!shareKey}
        viewMode={viewMode}
        onSwitchMode={switchViewMode}
        stage={stage}
        studyId={studyId}
        effectiveStudyId={effectiveStudyId}
        goLive={goLive}
        onToggleGoLive={() => setGoLive((v) => !v)}
        participants={participants}
        operatorPresent={operatorPresent}
        operatorName={operatorName}
        onShare={() => setShowShareDialog(true)}
        patientMeta={studyMeta}
        onClose={() => window.close() || navigate('/')}
      />

      {showShareDialog && studyId && (
        <ShareInviteDialog
          studyId={studyId}
          patientName={studyMeta?.patientName}
          onClose={() => setShowShareDialog(false)}
        />
      )}

      {/* Body: left toolbox | viewport area */}
      <div className="flex-1 flex relative">
        {stage === 'ready' && (
          <ToolRail
            viewMode={viewMode}
            activeTool={activeTool}
            onSelectTool={selectTool}
            readOnly={readOnly}
            onResetViews={handleResetViews}
            onSaveMeasurements={handleSaveMeasurements}
            onClearMeasurements={handleClearMeasurements}
            invert={invert}
            onToggleInvert={() => setInvert((v) => !v)}
            showRefLines={showRefLines}
            onToggleRefLines={() => setShowRefLines((v) => !v)}
            slabThickness={slabThickness}
            onSlabChange={setSlabThickness}
            presetTable={presetTable}
            activePreset={activePreset}
            onApplyPreset={applyPreset}
            annotations={annotations}
            implants={implants}
            placingImplant={placingImplant}
            pendingApex={pendingApex}
            implantCatalogOpen={implantCatalogOpen}
            onToggleCatalog={() => setImplantCatalogOpen((v) => !v)}
            onPickImplant={(cat) => {
              setPlacingImplant(cat);
              setImplantCatalogOpen(false);
              setPendingApex(null);
            }}
            onCancelPlacement={() => { setPlacingImplant(null); setPendingApex(null); }}
            onClearImplants={() => setImplants([])}
            onOpenPromote={() => { setPromoteResult(null); setPromoteError(null); setShowPromoteModal(true); }}
            nervePoints={nervePoints}
            tracingNerve={tracingNerve}
            onToggleTracingNerve={() => setTracingNerve((v) => !v)}
            safetyZoneMM={safetyZoneMM}
            onSafetyZoneChange={setSafetyZoneMM}
            nerveSlabMM={nerveSlabMM}
            onNerveSlabChange={setNerveSlabMM}
            onUndoNerve={() => setNervePoints((p) => p.slice(0, -1))}
            onClearNerve={() => setNervePoints([])}
            archPointCount={archPoints.length}
            tracingArch={tracingArch}
            onToggleTracingArch={() => setTracingArch((v) => !v)}
            archSlabMM={archSlabMM}
            onArchSlabChange={setArchSlabMM}
            onArchUndo={() => setArchPoints((p) => p.slice(0, -1))}
            onArchReset={() => setArchPoints([])}
            archAiRunning={!!aiRunning['arch-curve']}
            onRunArchAi={() => runAiInference('arch-curve')}
            xsWidthMM={xsWidthMM}
            onXsWidthChange={setXsWidthMM}
            onOpenAi={() => setShowAiModal(true)}
          />
        )}

        <ViewportGrid
          stage={stage}
          error={error}
          progress={progress}
          onRetry={retry}
          onOpen2D={() => studyId && navigate(`/viewer/dicom?study=${studyId}`, { replace: true })}
          onGoHome={() => navigate('/')}
          viewMode={viewMode}
          onSwitchMode={switchViewMode}
          engine={enginRef.current}
          viewportRefs={[axialRef, coronalRef, sagittalRef, vrRef]}
          panoCanvasRef={panoCanvasRef}
          xsCanvasRefs={xsCanvasRefs}
          sliceHud={sliceHud}
          nervePoints={nervePoints}
          safetyZoneMM={safetyZoneMM}
          nerveSlabMM={nerveSlabMM}
          implants={implants}
          pendingApex={pendingApex}
          archPoints={archPoints}
          tracingArch={tracingArch}
          readOnly={readOnly}
          panoRenderError={panoRenderError}
          studyId={studyId}
        />
      </div>

      {/* Phase 3.6.2 — Promote-to-Treatment-Plan dialog (Radix) */}
      <PromotePlanModal
        open={showPromoteModal}
        onOpenChange={setShowPromoteModal}
        promoting={promotingPlan}
        error={promoteError}
        result={promoteResult}
        title={promoteTitle}
        onTitleChange={setPromoteTitle}
        feePerImplant={promoteFeePerImplant}
        onFeeChange={setPromoteFeePerImplant}
        implants={implants}
        onCreate={handlePromoteToTreatmentPlan}
      />

      {/* AI dialog (Radix) — live vision read + flag-gated placeholders */}
      <AiPanel
        open={showAiModal}
        onOpenChange={setShowAiModal}
        canRunAi={!!studyId && !readOnly}
        aiReadStage={aiReadStage}
        aiReadError={aiReadError}
        aiReadResult={aiReadResult}
        onRunVision={runAiVisionRead}
        placeholderFeatures={placeholderFeatures}
        plannedFeatures={plannedFeatures}
        onApplyResult={applyAiResult}
        onDismissResult={dismissAiResult}
      />
    </div>
  );
}
