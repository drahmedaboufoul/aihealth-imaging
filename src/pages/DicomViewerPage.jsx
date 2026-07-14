/*
 * DicomViewerPage — 2D DICOM viewer for X-rays, panoramic, periapical,
 * mammography, US, and CBCT series stack-scrolling.
 *
 * Stage B.3.2 (this revision): Cornerstone3D StackViewport.
 * Replaces the V1 dicom-parser-only renderer because the V1 couldn't
 * decode compressed transfer syntaxes (JPEG 2000, JPEG-LS,
 * JPEG-Lossless) which are what every modern CBCT / mammography /
 * many panoramic machines emit.
 *
 * URL contract:
 *   /viewer/dicom?id=<patient_files.id>      single DICOM file by id
 *   /viewer/dicom?path=<bucket/key>          direct path
 *   /viewer/dicom?study=<imaging_studies.id> CBCT / multi-instance series
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Loader2, AlertCircle, ArrowLeft, Sun, RotateCcw, RotateCw, Camera,
  Contrast, Move, ZoomIn, Ruler, Triangle, Plus, Activity,
  Square, Circle as CircleIcon, Trash2, FlipHorizontal, FlipVertical,
  Sparkles, X as XIcon, Share2, Radio, Users,
} from 'lucide-react';
import ShareInviteDialog from '../components/ShareInviteDialog';
import { resolveSignedUrl, resolveStudyDicomFiles } from '../lib/signedUrl';
import { initCornerstone, imageIdFromSignedUrl, cornerstone, cornerstoneTools } from '../lib/cornerstoneInit';
import { formatPatientName, formatDate } from '../lib/dicomFormat';
import { readSharePayload, shareDicomFiles, SHARE_EXPIRED_MESSAGE } from '../lib/sharePayload';
import { severityColor, typeLabel, anchorFindingToWorld, projectAnchoredBox } from '../lib/aiOverlay';
import { serialize2DState, apply2DState } from '../lib/viewerRoom';
import { useViewerRoom } from '../hooks/useViewerRoom';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/supabase';

const SHELL_BG = '#0b0d10';
const PANEL_BG = '#15181c';
const ACCENT   = '#9C8562';

const RENDERING_ENGINE_ID = 'aihRenderingEngine';
const VIEWPORT_ID         = 'STACK_VIEWPORT';
const TOOL_GROUP_ID       = 'aihToolGroup';

// Modality-aware W/L presets. Cornerstone's voiRange takes lower/upper
// in the same units as the rescaled pixel values (Hounsfield for CT).
const WL_PRESETS_BY_MODALITY = {
  CT: [
    { name: 'Soft Tissue', wc:   40, ww:  400 },
    { name: 'Lung',        wc: -600, ww: 1500 },
    { name: 'Bone',        wc:  400, ww: 2000 },
    { name: 'Brain',       wc:   40, ww:   80 },
    { name: 'Abdomen',     wc:   60, ww:  400 },
    { name: 'Mediastinum', wc:   50, ww:  350 },
  ],
  MR: [{ name: 'Default', wc: 600, ww: 1600 }],
  DEFAULT: [],
};

// Left-click tool palette. Key → { toolName getter, icon, label, hotkey }.
// WindowLevel/Pan keep their radiology-convention secondary bindings
// (right-drag / middle-drag) even while another tool owns left-click.
const LEFT_TOOLS = [
  { key: 'zoom',          icon: ZoomIn,     label: 'Zoom (1)',            hotkey: '1' },
  { key: 'wl',            icon: Contrast,   label: 'Window/Level (2)',    hotkey: '2' },
  { key: 'pan',           icon: Move,       label: 'Pan (3)',             hotkey: '3' },
  { key: 'length',        icon: Ruler,      label: 'Length (4)',          hotkey: '4' },
  { key: 'angle',         icon: Triangle,   label: 'Angle (5)',           hotkey: '5' },
  { key: 'bidirectional', icon: Plus,       label: 'Bidirectional (6)',   hotkey: '6' },
  { key: 'probe',         icon: Activity,   label: 'Pixel probe (7)',     hotkey: '7' },
  { key: 'ellipseROI',    icon: CircleIcon, label: 'Ellipse ROI (8)',     hotkey: '8' },
  { key: 'rectROI',       icon: Square,     label: 'Rectangle ROI (9)',   hotkey: '9' },
];

function leftToolName(key) {
  const t = cornerstoneTools;
  return {
    zoom:          t.ZoomTool.toolName,
    wl:            t.WindowLevelTool.toolName,
    pan:           t.PanTool.toolName,
    length:        t.LengthTool.toolName,
    angle:         t.AngleTool.toolName,
    bidirectional: t.BidirectionalTool.toolName,
    probe:         t.ProbeTool.toolName,
    ellipseROI:    t.EllipticalROITool.toolName,
    rectROI:       t.RectangleROITool.toolName,
  }[key];
}

export default function DicomViewerPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const fileId   = searchParams.get('id');
  const filePath = searchParams.get('path');
  const studyId  = searchParams.get('study');
  const isDemo   = searchParams.get('demo') === '1';
  // Tokenized share flow: SharedViewerPage validated the token server-side
  // and stashed the resolved payload (signed URLs) in sessionStorage.
  const shareKey = searchParams.get('share');
  const sharePayload = useMemo(() => readSharePayload(shareKey), [shareKey]);
  // Read-only sessions (shared links / patient embeds) hide write actions
  // like AI diagnosis, which needs an authed JWT and writes an audit row.
  const readOnly = searchParams.get('readonly') === '1' || !!shareKey;

  const [stage, setStage] = useState('init'); // init | fetching | rendering | ready | error
  const [error, setError] = useState(null);
  const [imageIds, setImageIds] = useState([]);
  const [instanceIdx, setInstanceIdx] = useState(0);
  const [imageMeta, setImageMeta] = useState(null); // metadata of current image
  const [windowCenter, setWindowCenter] = useState(40);
  const [windowWidth,  setWindowWidth]  = useState(400);
  const [invert, setInvert] = useState(false);
  const [activeTool, setActiveTool] = useState('zoom');
  // rotation in degrees (0/90/180/270) + flips, applied via setViewPresentation
  const [orientation, setOrientation] = useState({ rotation: 0, flipH: false, flipV: false });

  // AI diagnosis state. aiFindings carry worldCorners (anchored at capture)
  // so the numbered boxes track anatomy through zoom/pan/rotate.
  const [aiStage, setAiStage] = useState('idle'); // idle | running | done | error
  const [aiFindings, setAiFindings] = useState([]);
  const [aiSummary, setAiSummary] = useState('');
  const [aiError, setAiError] = useState(null);
  const [aiModel, setAiModel] = useState(null);
  const [showAiBoxes, setShowAiBoxes] = useState(true);
  const [activeFinding, setActiveFinding] = useState(null); // index or null
  const [boxTick, setBoxTick] = useState(0); // bump to re-project boxes on camera move
  const overlayLayerRef = useRef(null);
  const [showShareDialog, setShowShareDialog] = useState(false);

  // Live co-viewing. Operator = authed clinician who flips "Go live"; follower
  // = a shared/read-only session (auto-joins and mirrors when an operator is
  // live). Room is keyed by the study id, which both sides already hold.
  const roomStudyId = studyId || sharePayload?.study?.id || null;
  const [goLive, setGoLive] = useState(false);
  const applyingRemoteRef = useRef(false); // guard so applied frames don't echo
  const roomRole = readOnly ? 'follower' : (goLive ? 'operator' : null);

  const onRemoteState = useCallback((s) => {
    applyingRemoteRef.current = true;
    apply2DState(viewportRef.current, s);
    setTimeout(() => { applyingRemoteRef.current = false; }, 0);
  }, []);

  const { participants, operatorPresent, operatorName, publish: roomPublish } = useViewerRoom({
    roomId: roomStudyId,
    role: roomRole,
    onRemoteState,
  });

  // Operator: broadcast view state on every camera move while live. The
  // initial send() lets a follower who is already waiting sync immediately.
  useEffect(() => {
    if (stage !== 'ready' || roomRole !== 'operator') return;
    const el = viewportContainerRef.current;
    if (!el) return;
    const send = () => {
      if (applyingRemoteRef.current) return;
      const s = serialize2DState(viewportRef.current);
      if (s) roomPublish(s);
    };
    el.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, send);
    el.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, send);
    send();
    return () => {
      el.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, send);
      el.removeEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, send);
    };
  }, [stage, roomRole, roomPublish]);

  const viewportContainerRef = useRef(null);
  const renderingEngineRef = useRef(null);
  const viewportRef = useRef(null);

  // Resolve URLs based on URL contract
  useEffect(() => {
    document.title = 'DICOM viewer · aiHealth Imaging';
    let cancelled = false;
    (async () => {
      setStage('fetching');
      setError(null);
      try {
        // Shared session: the token was already validated server-side and
        // the payload carries pre-signed URLs — no Supabase auth needed.
        if (shareKey) {
          if (!sharePayload) throw new Error(SHARE_EXPIRED_MESSAGE);
          const dicoms = shareDicomFiles(sharePayload);
          if (dicoms.length === 0) throw new Error('This shared study has no DICOM files.');
          if (cancelled) return;
          setImageIds(dicoms.map((f) => imageIdFromSignedUrl(f.url)));
          setInstanceIdx(0);
          return;
        }
        if (!isDemo) {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) {
            const back = encodeURIComponent(location.pathname + location.search);
            navigate(`/login?next=${back}`, { replace: true });
            return;
          }
        }
        if (isDemo) throw new Error('Demo mode for DICOM not wired yet.');
        if (!fileId && !filePath && !studyId) {
          throw new Error('Missing ?id=, ?path=, or ?study= URL parameter.');
        }

        let urls = [];
        if (studyId) {
          const list = await resolveStudyDicomFiles(studyId);
          urls = list.map((f) => f.url);
        } else {
          const { url } = await resolveSignedUrl({ id: fileId, path: filePath });
          urls = [url];
        }
        if (cancelled) return;
        setImageIds(urls.map(imageIdFromSignedUrl));
        setInstanceIdx(0);
      } catch (err) {
        if (cancelled) return;
        setError(err?.message || String(err));
        setStage('error');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, filePath, studyId, isDemo, shareKey, sharePayload]);

  // Initialise Cornerstone + create viewport once imageIds resolved
  useEffect(() => {
    if (imageIds.length === 0) return;
    let cancelled = false;
    (async () => {
      setStage('rendering');
      try {
        await initCornerstone();
        if (cancelled) return;

        const element = viewportContainerRef.current;
        if (!element) return;

        // Reuse rendering engine across re-mounts if possible
        let engine = cornerstone.getRenderingEngine(RENDERING_ENGINE_ID);
        if (!engine) {
          engine = new cornerstone.RenderingEngine(RENDERING_ENGINE_ID);
        }
        renderingEngineRef.current = engine;

        // Enable element as a STACK viewport
        engine.enableElement({
          viewportId: VIEWPORT_ID,
          element,
          type: cornerstone.Enums.ViewportType.STACK,
        });
        const viewport = engine.getViewport(VIEWPORT_ID);
        viewportRef.current = viewport;

        await viewport.setStack(imageIds, 0);
        viewport.render();

        // Set up tool group + bindings (idempotent: destroy if already exists)
        const existingGroup = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
        if (existingGroup) {
          cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
        }
        const toolGroup = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_ID);

        const tools = [
          cornerstoneTools.WindowLevelTool,
          cornerstoneTools.PanTool,
          cornerstoneTools.ZoomTool,
          cornerstoneTools.StackScrollTool,
          cornerstoneTools.LengthTool,
          cornerstoneTools.AngleTool,
          cornerstoneTools.BidirectionalTool,
          cornerstoneTools.ProbeTool,
          cornerstoneTools.EllipticalROITool,
          cornerstoneTools.RectangleROITool,
        ];
        // addTool throws if a tool is already registered globally (e.g. a
        // previous mount of this page in the same window).
        for (const T of tools) {
          try { cornerstoneTools.addTool(T); } catch { /* already added */ }
        }
        for (const T of tools) toolGroup.addTool(T.toolName);

        // Wheel always scrolls the stack; the left/right/middle bindings are
        // owned by the activeTool effect below (radiology convention:
        // right-drag = W/L, middle-drag = pan, left-drag = selected tool).
        toolGroup.setToolActive(cornerstoneTools.StackScrollTool.toolName);

        toolGroup.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID);

        // Listen for image changes so the slice slider + HUD stay synced
        const handleImageRendered = () => {
          if (!viewportRef.current) return;
          const v = viewportRef.current;
          const idx = v.getCurrentImageIdIndex();
          setInstanceIdx(idx);
          const props = v.getProperties();
          if (props?.voiRange) {
            const lower = props.voiRange.lower;
            const upper = props.voiRange.upper;
            setWindowCenter(Math.round((lower + upper) / 2));
            setWindowWidth(Math.round(upper - lower));
          }
          // Pull metadata for HUD
          const imageId = v.getCurrentImageId();
          if (imageId && cornerstone.metaData) {
            const generalSeries = cornerstone.metaData.get('generalSeriesModule', imageId) || {};
            const generalStudy  = cornerstone.metaData.get('generalStudyModule', imageId)  || {};
            const patientStudy  = cornerstone.metaData.get('patientStudyModule', imageId)  || {};
            const patient       = cornerstone.metaData.get('patientModule', imageId)       || {};
            const imagePlane    = cornerstone.metaData.get('imagePlaneModule', imageId)    || {};
            setImageMeta({
              patientName:  formatPatientName(patient.patientName),
              // DICOM naming: the patient module exposes `patientID`
              patientId:    patient.patientID || patient.patientId,
              studyDate:    formatDate(generalStudy.studyDate),
              studyDescription: generalStudy.studyDescription,
              modality:     generalSeries.modality,
              seriesDescription: generalSeries.seriesDescription,
              rows:         imagePlane.rows,
              columns:      imagePlane.columns,
            });
          }
        };

        element.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, handleImageRendered);
        // Trigger a synthetic refresh of the HUD after first render
        setTimeout(handleImageRendered, 100);

        setStage('ready');

        // Cleanup: detach listener on unmount or re-init
        return () => {
          element.removeEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, handleImageRendered);
        };
      } catch (err) {
        if (cancelled) return;
        console.error('Cornerstone init/render failed:', err);
        setError(err?.message || String(err));
        setStage('error');
      }
    })();
    return () => { cancelled = true; };
  }, [imageIds]);

  // Re-bind mouse buttons whenever the selected left-click tool changes.
  // setToolActive REPLACES a tool's bindings, so W/L and Pan are re-issued
  // their secondary/auxiliary bindings on every pass to keep the radiology
  // convention alive regardless of which tool owns left-drag.
  useEffect(() => {
    if (stage !== 'ready') return;
    const toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
    if (!toolGroup) return;
    const { MouseBindings } = cornerstoneTools.Enums;
    const active = leftToolName(activeTool) || leftToolName('zoom');
    for (const { key } of LEFT_TOOLS) {
      const name = leftToolName(key);
      const bindings = [];
      if (name === active) bindings.push({ mouseButton: MouseBindings.Primary });
      if (name === cornerstoneTools.WindowLevelTool.toolName) bindings.push({ mouseButton: MouseBindings.Secondary });
      if (name === cornerstoneTools.PanTool.toolName) bindings.push({ mouseButton: MouseBindings.Auxiliary });
      try {
        if (bindings.length > 0) toolGroup.setToolActive(name, { bindings });
        else toolGroup.setToolPassive(name);
      } catch { /* tool not in group */ }
    }
  }, [stage, activeTool]);

  // Sync slice slider -> viewport
  const onSliceChange = useCallback((idx) => {
    setInstanceIdx(idx);
    if (viewportRef.current) {
      viewportRef.current.setImageIdIndex(idx);
      viewportRef.current.render();
    }
  }, []);

  // Apply a W/L preset
  const applyPreset = useCallback(({ wc, ww }) => {
    if (!viewportRef.current) return;
    viewportRef.current.setProperties({
      voiRange: { lower: wc - ww / 2, upper: wc + ww / 2 },
    });
    viewportRef.current.render();
    setWindowCenter(wc);
    setWindowWidth(ww);
  }, []);

  // Manual W/L from sliders
  const onWindowChange = useCallback((wc, ww) => {
    if (!viewportRef.current) return;
    viewportRef.current.setProperties({
      voiRange: { lower: wc - ww / 2, upper: wc + ww / 2 },
    });
    viewportRef.current.render();
    setWindowCenter(wc);
    setWindowWidth(ww);
  }, []);

  const toggleInvert = useCallback(() => {
    if (!viewportRef.current) return;
    const next = !invert;
    viewportRef.current.setProperties({ invert: next });
    viewportRef.current.render();
    setInvert(next);
  }, [invert]);

  // Rotation + flips ride on the viewport's ViewPresentation (Cornerstone3D
  // 4.x); resetCamera alone doesn't clear them, so reset re-issues zeros.
  const applyOrientation = useCallback((next) => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.setViewPresentation({
      rotation: next.rotation,
      flipHorizontal: next.flipH,
      flipVertical: next.flipV,
    });
    vp.render();
    setOrientation(next);
  }, []);

  const rotateBy = useCallback((deg) => {
    applyOrientation({ ...orientation, rotation: (orientation.rotation + deg + 360) % 360 });
  }, [applyOrientation, orientation]);

  const toggleFlip = useCallback((axis) => {
    applyOrientation({ ...orientation, [axis]: !orientation[axis] });
  }, [applyOrientation, orientation]);

  const clearAnnotations = useCallback(() => {
    try {
      cornerstoneTools.annotation?.state?.removeAllAnnotations?.();
    } catch (e) {
      console.warn('[dicom] clearAnnotations failed:', e?.message);
    }
    renderingEngineRef.current?.render();
  }, []);

  const resetView = useCallback(() => {
    if (!viewportRef.current) return;
    viewportRef.current.resetCamera();
    viewportRef.current.resetProperties();
    viewportRef.current.setViewPresentation({ rotation: 0, flipHorizontal: false, flipVertical: false });
    viewportRef.current.render();
    setOrientation({ rotation: 0, flipH: false, flipV: false });
    setInvert(false);
  }, []);

  const saveScreenshot = useCallback(() => {
    if (!viewportRef.current) return;
    const canvas = viewportRef.current.getCanvas();
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `dicom-${Date.now()}.png`;
    a.click();
  }, []);

  const clearAiFindings = useCallback(() => {
    setAiFindings([]);
    setAiSummary('');
    setAiError(null);
    setAiModel(null);
    setActiveFinding(null);
    setAiStage('idle');
  }, []);

  // Run the AI radiograph reader on the currently displayed frame. Captures
  // the viewport canvas as PNG, POSTs it to the ai-read-radiograph edge
  // function with the caller's JWT, then anchors each returned box to world
  // coordinates so it tracks the anatomy through later navigation.
  const runAiDiagnosis = useCallback(async () => {
    const vp = viewportRef.current;
    if (!vp || readOnly) return;
    setAiStage('running');
    setAiError(null);
    try {
      const canvas = vp.getCanvas();
      const dataUrl = canvas.toDataURL('image/png');
      // canvasToWorld expects CSS-pixel coordinates; use the element's CSS box.
      const rect = canvas.getBoundingClientRect();
      const cw = rect.width || canvas.width;
      const ch = rect.height || canvas.height;

      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(
        `${SUPABASE_URL}/functions/v1/ai-read-radiograph`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session?.access_token || ''}`,
            apikey: SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            study_id: studyId || undefined,
            study_type: imageMeta?.modality === 'PANO' ? 'panoramic' : (imageMeta?.modality || 'radiograph'),
            image: dataUrl,
            mediaType: 'image/png',
          }),
        }
      );
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = resp.status === 503
          ? 'AI service not configured on this deployment.'
          : (body?.error || `AI request failed (${resp.status}).`);
        setAiError(msg);
        setAiStage('error');
        return;
      }
      const reader = body?.radiograph_reader || {};
      const findings = Array.isArray(reader.findings) ? reader.findings : [];
      // Anchor to world NOW, before any camera change, using the same canvas
      // size the AI saw.
      const anchored = findings.map((f) => {
        try { return anchorFindingToWorld(f, vp, cw, ch); }
        catch { return f; }
      });
      setAiFindings(anchored);
      setAiSummary(reader.summary || '');
      setAiModel(reader.model || null);
      setAiStage('done');
      setShowAiBoxes(true);
    } catch (e) {
      setAiError(e?.message || String(e));
      setAiStage('error');
    }
  }, [readOnly, studyId, imageMeta]);

  // Re-project AI boxes whenever the camera moves (zoom/pan/rotate/flip) so
  // they stay pinned to anatomy. We just bump a tick; the overlay reads the
  // live viewport on render.
  useEffect(() => {
    if (stage !== 'ready' || aiFindings.length === 0) return;
    const el = viewportContainerRef.current;
    if (!el) return;
    const onCam = () => setBoxTick((t) => (t + 1) % 1000000);
    el.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, onCam);
    el.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, onCam);
    return () => {
      el.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, onCam);
      el.removeEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, onCam);
    };
  }, [stage, aiFindings.length]);

  // Findings belong to one frame — clear them when the user scrolls slices.
  useEffect(() => {
    clearAiFindings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceIdx]);

  // Keyboard slice navigation
  useEffect(() => {
    if (imageIds.length <= 1) return;
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const N = imageIds.length;
      let next = instanceIdx;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = Math.min(N - 1, instanceIdx + 1);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = Math.max(0, instanceIdx - 1);
      else if (e.key === 'PageDown') next = Math.min(N - 1, instanceIdx + 10);
      else if (e.key === 'PageUp') next = Math.max(0, instanceIdx - 10);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = N - 1;
      else return;
      e.preventDefault();
      onSliceChange(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [imageIds.length, instanceIdx, onSliceChange]);

  // Tool hotkeys: 1-9 select the left-click tool, R = reset, I = invert.
  useEffect(() => {
    if (stage !== 'ready') return;
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const byHotkey = LEFT_TOOLS.find((t) => t.hotkey === e.key);
      if (byHotkey) {
        e.preventDefault();
        setActiveTool(byHotkey.key);
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        resetView();
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        toggleInvert();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage, resetView, toggleInvert]);

  const presets = WL_PRESETS_BY_MODALITY[imageMeta?.modality] || WL_PRESETS_BY_MODALITY.DEFAULT;
  const activeToolLabel = LEFT_TOOLS.find((t) => t.key === activeTool)?.label.replace(/ \(\d\)$/, '') || 'Zoom';

  return (
    <div className="h-screen w-screen flex flex-col" style={{ backgroundColor: SHELL_BG, color: '#cdd2d8' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: '#1d2128' }}>
        <button
          onClick={() => window.close() || navigate('/')}
          className="text-sm px-2 py-1 rounded hover:bg-white/5 flex items-center gap-1.5"
        >
          <ArrowLeft size={14} /> Close
        </button>
        <div className="text-sm font-semibold tracking-wide">
          DICOM Viewer
          {imageIds.length > 1 && <span className="ml-2 text-[11px] text-gray-400 font-normal">({imageIds.length} slices)</span>}
        </div>
        <div className="flex items-center gap-2">
          {/* Follower: show when an operator is presenting live. */}
          {stage === 'ready' && readOnly && roomStudyId && operatorPresent && (
            <span className="text-[11px] px-2 py-1 rounded bg-red-900/50 text-red-300 border border-red-700/50 flex items-center gap-1.5">
              <Radio size={12} className="animate-pulse" /> Following{operatorName ? ` ${operatorName}` : ''} · live
            </span>
          )}
          {/* Operator: Go-live toggle + participant count. */}
          {stage === 'ready' && studyId && !readOnly && (
            <>
              <button
                onClick={() => setGoLive((v) => !v)}
                className={`text-[11px] px-2 py-1 rounded flex items-center gap-1.5 ${
                  goLive ? 'bg-red-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
                }`}
                title={goLive ? 'Stop the live session' : 'Start a live session — viewers with the share link follow your navigation'}
              >
                <Radio size={12} className={goLive ? 'animate-pulse' : ''} />
                {goLive ? 'Live' : 'Go live'}
                {goLive && participants > 1 && (
                  <span className="inline-flex items-center gap-0.5 ml-0.5"><Users size={11} /> {participants}</span>
                )}
              </button>
              <button
                onClick={() => setShowShareDialog(true)}
                className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-amber-600 hover:text-white flex items-center gap-1.5"
                title="Create a share link for this study"
              >
                <Share2 size={12} /> Share
              </button>
            </>
          )}
          <span className="text-[11px] text-gray-500">Powered by Cornerstone3D</span>
        </div>
      </div>

      {showShareDialog && studyId && (
        <ShareInviteDialog
          studyId={studyId}
          patientName={imageMeta?.patientName}
          onClose={() => setShowShareDialog(false)}
        />
      )}

      <div className="flex-1 flex relative">
        {/* Loading overlay */}
        {(stage === 'fetching' || stage === 'rendering') && (
          <div className="absolute inset-0 flex items-center justify-center z-20" style={{ backgroundColor: 'rgba(11,13,16,0.95)' }}>
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={28} className="animate-spin text-amber-500" />
              <p className="text-xs text-gray-400">
                {stage === 'fetching' ? 'Resolving signed URLs…' : 'Initialising Cornerstone3D…'}
              </p>
            </div>
          </div>
        )}

        {/* Error overlay */}
        {stage === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center z-30 p-8" style={{ backgroundColor: 'rgba(11,13,16,0.97)' }}>
            <div className="max-w-md text-center">
              <AlertCircle size={28} className="mx-auto text-red-500 mb-3" />
              <h2 className="text-sm font-semibold text-white mb-2">Could not load DICOM</h2>
              <pre className="text-[11px] text-red-300 font-mono whitespace-pre-wrap break-words text-left px-3 py-2 rounded" style={{ backgroundColor: '#1a1d22' }}>
                {error}
              </pre>
            </div>
          </div>
        )}

        {/* Cornerstone viewport */}
        <div
          ref={viewportContainerRef}
          className="flex-1 relative"
          style={{ backgroundColor: SHELL_BG }}
          onContextMenu={(e) => e.preventDefault()}
        />

        {/* AI finding boxes — re-projected from world anchors each camera move.
            boxTick forces recompute; reading the live viewport keeps them
            pinned to anatomy through zoom/pan/rotate. */}
        {stage === 'ready' && showAiBoxes && aiFindings.length > 0 && viewportRef.current && (
          <div ref={overlayLayerRef} className="absolute inset-0 pointer-events-none z-10" data-tick={boxTick}>
            {aiFindings.map((f, i) => {
              const rect = f.worldCorners
                ? projectAnchoredBox(f.worldCorners, viewportRef.current)
                : null;
              if (!rect || rect.width < 2 || rect.height < 2) return null;
              const color = severityColor(f.severity);
              const isActive = activeFinding === i;
              return (
                <div
                  key={i}
                  className="absolute"
                  style={{
                    left: rect.left, top: rect.top, width: rect.width, height: rect.height,
                    border: `2px solid ${color}`,
                    boxShadow: isActive ? `0 0 0 2px ${color}66, 0 0 12px ${color}88` : 'none',
                    borderRadius: 3,
                    transition: 'box-shadow 0.15s',
                  }}
                >
                  <span
                    className="absolute -top-5 left-0 text-[10px] font-bold px-1.5 py-0.5 rounded pointer-events-auto cursor-pointer"
                    style={{ backgroundColor: color, color: '#0b0d10' }}
                    onMouseEnter={() => setActiveFinding(i)}
                    onMouseLeave={() => setActiveFinding((v) => (v === i ? null : v))}
                  >
                    {i + 1}{f.tooth ? ` · ${f.tooth}` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* HUD overlays — only visible once ready */}
        {stage === 'ready' && imageMeta && (
          <>
            <div className="absolute top-3 left-3 text-[11px] leading-tight font-mono pointer-events-none" style={{ color: '#cdd2d8', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
              {imageMeta.patientName && <div className="text-white">{imageMeta.patientName}</div>}
              {imageMeta.patientId && <div>ID: {imageMeta.patientId}</div>}
              {imageMeta.studyDate && <div>{imageMeta.studyDate}</div>}
              {imageMeta.studyDescription && <div className="text-gray-400">{imageMeta.studyDescription}</div>}
            </div>
            <div className="absolute top-3 right-3 text-[11px] leading-tight font-mono text-right pointer-events-none" style={{ color: '#cdd2d8', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
              {imageMeta.modality && <div className="text-amber-400 font-semibold">{imageMeta.modality}</div>}
              {imageMeta.seriesDescription && <div className="text-gray-300">{imageMeta.seriesDescription}</div>}
              {imageMeta.rows && imageMeta.columns && <div>{imageMeta.columns}×{imageMeta.rows}</div>}
              {imageIds.length > 1 && (
                <div>Slice {instanceIdx + 1} / {imageIds.length}</div>
              )}
            </div>
            <div className="absolute bottom-3 left-3 text-[11px] font-mono pointer-events-none" style={{ color: '#9aa1ab', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
              WC: {Math.round(windowCenter)}  WW: {Math.round(windowWidth)}
              <span className="ml-3 text-gray-500">left={activeToolLabel.toLowerCase()} · right=W/L · wheel=scroll · middle=pan</span>
            </div>
          </>
        )}
      </div>

      {/* Right rail */}
      {stage === 'ready' && (
        <div
          className="absolute right-3 top-16 w-60 rounded-lg p-3 z-10 text-xs max-h-[calc(100vh-6rem)] overflow-y-auto"
          style={{ backgroundColor: PANEL_BG, border: '1px solid #1d2128' }}
        >
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Tools</div>
          <div className="grid grid-cols-5 gap-1 mb-3">
            {LEFT_TOOLS.map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                onClick={() => setActiveTool(key)}
                title={label}
                className={`h-8 rounded flex items-center justify-center ${
                  activeTool === key ? 'bg-amber-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
              >
                <Icon size={13} />
              </button>
            ))}
            <button
              onClick={clearAnnotations}
              title="Clear all measurements"
              className="h-8 rounded flex items-center justify-center bg-gray-800 hover:bg-red-700 text-gray-300 hover:text-white"
            >
              <Trash2 size={13} />
            </button>
          </div>

          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Orient</div>
          <div className="grid grid-cols-4 gap-1 mb-3">
            <button
              onClick={() => rotateBy(-90)}
              title="Rotate 90° counter-clockwise"
              className="h-8 rounded flex items-center justify-center bg-gray-800 hover:bg-gray-700 text-gray-300"
            >
              <RotateCcw size={13} />
            </button>
            <button
              onClick={() => rotateBy(90)}
              title="Rotate 90° clockwise"
              className="h-8 rounded flex items-center justify-center bg-gray-800 hover:bg-gray-700 text-gray-300"
            >
              <RotateCw size={13} />
            </button>
            <button
              onClick={() => toggleFlip('flipH')}
              title="Flip horizontal"
              className={`h-8 rounded flex items-center justify-center ${
                orientation.flipH ? 'bg-amber-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
              }`}
            >
              <FlipHorizontal size={13} />
            </button>
            <button
              onClick={() => toggleFlip('flipV')}
              title="Flip vertical"
              className={`h-8 rounded flex items-center justify-center ${
                orientation.flipV ? 'bg-amber-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
              }`}
            >
              <FlipVertical size={13} />
            </button>
          </div>

          {presets.length > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Presets</div>
              <div className="grid grid-cols-2 gap-1 mb-3">
                {presets.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => applyPreset(p)}
                    className="text-[11px] py-1.5 rounded bg-gray-800 hover:bg-gray-700"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="mb-2">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gray-400 mb-1">
              <span>Window Center</span>
              <span className="tabular-nums text-gray-300">{Math.round(windowCenter)}</span>
            </div>
            <input
              type="range"
              min={-1000}
              max={3000}
              step={1}
              value={windowCenter}
              onChange={(e) => onWindowChange(Number(e.target.value), windowWidth)}
              className="w-full"
            />
          </div>

          <div className="mb-3">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gray-400 mb-1">
              <span>Window Width</span>
              <span className="tabular-nums text-gray-300">{Math.round(windowWidth)}</span>
            </div>
            <input
              type="range"
              min={1}
              max={4000}
              step={1}
              value={windowWidth}
              onChange={(e) => onWindowChange(windowCenter, Number(e.target.value))}
              className="w-full"
            />
          </div>

          {imageIds.length > 1 && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gray-400 mb-1">
                <span>Slice</span>
                <span className="tabular-nums text-gray-300">
                  {instanceIdx + 1} / {imageIds.length}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={imageIds.length - 1}
                step={1}
                value={instanceIdx}
                onChange={(e) => onSliceChange(Number(e.target.value))}
                className="w-full"
              />
              <p className="text-[10px] text-gray-500 mt-1 leading-snug">
                Wheel scrolls; ↑/↓ one slice; PgUp/PgDn ten.
              </p>
            </div>
          )}

          <div className="grid grid-cols-3 gap-1">
            <button
              onClick={resetView}
              className="text-[11px] py-1.5 rounded bg-gray-800 hover:bg-gray-700 flex items-center justify-center gap-1"
              title="Reset W/L + zoom"
            >
              <RotateCcw size={11} /> Reset
            </button>
            <button
              onClick={toggleInvert}
              className={`text-[11px] py-1.5 rounded flex items-center justify-center gap-1 ${invert ? 'bg-amber-600' : 'bg-gray-800 hover:bg-gray-700'}`}
              title="Invert grayscale"
            >
              <Sun size={11} /> Invert
            </button>
            <button
              onClick={saveScreenshot}
              className="text-[11px] py-1.5 rounded bg-gray-800 hover:bg-gray-700 flex items-center justify-center gap-1"
              title="Download as PNG"
            >
              <Camera size={11} /> Save
            </button>
          </div>

          {/* AI diagnosis — hidden in read-only / shared sessions (needs an
              authed JWT + writes an audit row). */}
          {!readOnly && (
            <div className="mt-3 pt-3 border-t" style={{ borderColor: '#1d2128' }}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] uppercase tracking-wider text-gray-400 flex items-center gap-1">
                  <Sparkles size={11} className="text-purple-400" /> AI diagnosis
                </span>
                {aiFindings.length > 0 && (
                  <button
                    onClick={() => setShowAiBoxes((v) => !v)}
                    className="text-[9px] text-gray-500 hover:text-gray-300"
                    title="Toggle boxes"
                  >
                    {showAiBoxes ? 'Hide boxes' : 'Show boxes'}
                  </button>
                )}
              </div>

              <button
                onClick={runAiDiagnosis}
                disabled={aiStage === 'running'}
                className="w-full text-[11px] py-1.5 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-60 text-white flex items-center justify-center gap-1.5"
              >
                {aiStage === 'running'
                  ? <><Loader2 size={11} className="animate-spin" /> Analyzing…</>
                  : <><Sparkles size={11} /> {aiFindings.length > 0 ? 'Re-analyze frame' : 'Analyze frame'}</>}
              </button>

              {aiStage === 'error' && (
                <p className="text-[10px] text-red-300 mt-2 leading-snug">{aiError}</p>
              )}

              {aiStage === 'done' && aiFindings.length === 0 && (
                <p className="text-[10px] text-gray-400 mt-2 leading-snug">
                  No clearly abnormal findings flagged.{aiSummary ? ` ${aiSummary}` : ''}
                </p>
              )}

              {aiFindings.length > 0 && (
                <>
                  {aiSummary && (
                    <p className="text-[10px] text-gray-400 mt-2 leading-snug">{aiSummary}</p>
                  )}
                  <div className="mt-2 space-y-1 max-h-56 overflow-y-auto">
                    {aiFindings.map((f, i) => {
                      const color = severityColor(f.severity);
                      return (
                        <button
                          key={i}
                          onMouseEnter={() => setActiveFinding(i)}
                          onMouseLeave={() => setActiveFinding((v) => (v === i ? null : v))}
                          className={`w-full text-left rounded px-1.5 py-1 flex items-start gap-1.5 ${
                            activeFinding === i ? 'bg-gray-800' : 'bg-gray-900 hover:bg-gray-800'
                          }`}
                        >
                          <span
                            className="mt-0.5 text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                            style={{ backgroundColor: color, color: '#0b0d10' }}
                          >
                            {i + 1}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="flex items-center justify-between gap-1">
                              <span className="text-[10.5px] text-gray-200 font-medium truncate">
                                {typeLabel(f.type)}{f.tooth ? ` · ${f.tooth}` : ''}
                              </span>
                              <span className="text-[9px] font-mono tabular-nums" style={{ color }}>
                                {Math.round(f.confidence * 100)}%
                              </span>
                            </span>
                            <span className="block text-[9.5px] text-gray-500 leading-snug">{f.description}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    onClick={clearAiFindings}
                    className="w-full mt-1.5 text-[9.5px] text-gray-500 hover:text-red-300 flex items-center justify-center gap-1"
                  >
                    <XIcon size={9} /> Clear findings
                  </button>
                  <p className="text-[8.5px] text-gray-600 mt-1.5 leading-tight">
                    AI-assisted · verify before use. Not a diagnosis.{aiModel ? ` (${aiModel})` : ''}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
