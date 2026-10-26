/*
 * CBCTVolumeViewer — real cornerstone3D MPR + 3D volume viewer for CBCT
 * (and any multi-slice DICOM series). Reconstructs a volume from a wadouri
 * image stack and shows synchronized axial / coronal / sagittal MPR with a
 * 3D volume render.
 *
 * Props:
 *   imageIds : string[]  — `wadouri:<signed-url>` for each DICOM instance
 *   fileName : string    — title
 *   onClose  : () => void
 *
 * Browser-only (WebGL + web workers). Cannot be validated headlessly —
 * needs live testing.
 */
import React, { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import {
  Loader2, X, Contrast, Move, Crosshair, Ruler, Camera,
  RotateCcw, AlertTriangle, Spline, Save, Trash2, Download,
  GalleryHorizontal, Wand2, Sparkles, FileText,
} from 'lucide-react';
import { ensureCornerstone } from '@/lib/cornerstoneInit';
import { supabase } from '@/integrations/supabase/client';
import { sanitizeArchPoints } from '@/lib/curvedMpr';
import { functionErrorMessage, tokenCostNote, useAiTokens } from '@/lib/aiTokens';
import { viewToPngDataUrl } from '@/lib/cbctAiViews';
// Heavy voxel compute (curved-MPR panoramic, auto-arch detection, AI-view
// rendering) runs in a module Web Worker — the client wraps the worker
// lifecycle and falls back to the same pure task code on the main thread
// where Worker is unavailable (jsdom tests).
import { createCbctComputeClient, isComputeCancelled } from '@/components/viewers/cbctComputeClient';
import { createArchTraceTool, ARCH_TRACE_TOOL_NAME } from '@/lib/archTraceTool';
import {
  ViewModeTabs, GalleryPanel, EmptyState,
} from '@/components/viewers/cbctViewModes';
import {
  AiFindingsPanel, AiAssistBanner, AiViewLightbox,
} from '@/components/viewers/cbctAiFindings';

// Compare (CBCT↔CBCT, CBCT↔mesh, overlay registration) — lazy so the three.js
// stack and registration math stay out of the viewer's initial load.
const CompareMode = React.lazy(() => import('@/components/viewers/CompareMode'));
// TMJ (dual-condyle oblique views + joint-space measures) — lazy like Compare so
// the condyle-localization / oblique-sampling math stays out of the initial load.
const TmjMode = React.lazy(() => import('@/components/viewers/TmjMode'));
// Cephalometric (synthetic lateral ceph + landmark tracing + analysis) — lazy
// so the projection math stays out of the viewer's initial load, like Compare.
const CephMode = React.lazy(() => import('@/components/viewers/CephMode'));
// Radiology report dialog (imaging_reports) — same dialog the worklist uses,
// lazy so the emr module stays out of the viewer's initial bundle.
const ImagingReportDialog = React.lazy(() => import('@/modules/emr/pages/ImagingReportDialog'));
// Implant planning (interactive cross-sections, canal marking, implant
// placement) — lazy like Compare so the planning stack stays out of the
// viewer's initial load.
const ImplantMode = React.lazy(() => import('@/components/viewers/ImplantMode'));

const RENDERING_ENGINE_ID = 'cbctRenderingEngine';
const MPR_TOOLGROUP_ID = 'cbctMprToolGroup';
const VOL3D_TOOLGROUP_ID = 'cbctVol3dToolGroup';
const VP = { AXIAL: 'CBCT_AXIAL', CORONAL: 'CBCT_CORONAL', SAGITTAL: 'CBCT_SAGITTAL', VOL3D: 'CBCT_VOL3D' };
const MPR_VP_IDS = [VP.AXIAL, VP.CORONAL, VP.SAGITTAL, VP.VOL3D];

const MPR_TOOLS = [
  { id: 'Crosshairs', label: 'Crosshairs', short: 'Cross', Icon: Crosshair },
  { id: 'WindowLevel', label: 'Window / Level', short: 'W/L', Icon: Contrast },
  { id: 'Length', label: 'Measure length', short: 'Measure', Icon: Ruler },
  { id: 'Pan', label: 'Pan', short: 'Pan', Icon: Move },
];

// Tool rail grouping (DentalX-style left sidebar). Each group renders a small
// caption above its icon buttons; ids resolve against MPR_TOOLS.
const TOOL_GROUPS = [
  { title: 'Navigate', ids: ['Crosshairs', 'Pan'] },
  { title: 'Adjust', ids: ['WindowLevel'] },
  { title: 'Measure', ids: ['Length'] },
];
const TOOL_BY_ID = Object.fromEntries(MPR_TOOLS.map((t) => [t.id, t]));

// Derive a display window from the volume's actual voxel range. Server-converted
// NIfTI volumes carry no DICOM window-center/width, so cornerstone's default VOI
// can map every voxel to black (black MPR + black 3D). Sampling the scalar data
// gives a sane lower/upper so the reformats actually show. Returns null when the
// data isn't available yet (e.g. frames failed to load) — which is itself a
// useful diagnostic.
function getVolumeScalarData(volume) {
  let data = null;
  try { if (typeof volume?.getScalarData === 'function') data = volume.getScalarData(); } catch (_) { /* try next */ }
  if (!data) { try { data = volume?.voxelManager?.getCompleteScalarDataArray?.(); } catch (_) { /* try next */ } }
  if (!data) { try { data = volume?.scalarData; } catch (_) { /* none */ } }
  return data && data.length ? data : null;
}

// Short stable hash (djb2) — disambiguates the cornerstone volumeId when a
// study id isn't available (e.g. ad-hoc file viewing).
function hashId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function computeScalarRange(volume) {
  const data = getVolumeScalarData(volume);
  if (!data) return null;
  // Use the 1st–99th percentile of the real values, not the absolute min/max:
  // declared/extreme ranges (e.g. 0..65535) posterise the image to black/white.
  const stride = Math.max(1, Math.floor(data.length / 250000));
  const sample = [];
  for (let i = 0; i < data.length; i += stride) sample.push(data[i]);
  if (!sample.length) return null;
  sample.sort((a, b) => a - b);
  const n = sample.length;
  let lower = sample[Math.floor(n * 0.01)];
  let upper = sample[Math.floor(n * 0.99)];
  if (!(upper > lower)) { lower = sample[0]; upper = sample[n - 1]; }
  if (!(upper > lower)) return null;
  return { lower, upper };
}

// Render a Float32 grayscale image ({ width, height, data }, NaN = outside) to
// a PNG data URL, windowed to [lower,upper] with an optional display gamma
// (<1 brightens mid-tones — pair with computeImageWindow's data-derived
// window+gamma). Shared by the panoramic strip and the perpendicular
// cross-sections. Returns null if a 2D canvas is unavailable.
function floatImageToDataUrl(img, lower, upper, gamma = 1) {
  const { width, height, data } = img;
  if (!width || !height) return null;
  const span = upper > lower ? upper - lower : 1;
  const useGamma = Number.isFinite(gamma) && gamma > 0 && gamma !== 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    let g = 0;
    if (Number.isFinite(v)) {
      let t = (v - lower) / span;
      t = t <= 0 ? 0 : t >= 1 ? 1 : t;
      if (useGamma) t = Math.pow(t, gamma);
      g = Math.round(t * 255);
    }
    const o = i * 4;
    rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imgData = ctx.createImageData(width, height);
  imgData.data.set(rgba);
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png');
}

/*
 * Layout building blocks — these MUST live at module scope, not inside the
 * viewer component. They used to be defined inside CBCTVolumeViewer's body,
 * which created a brand-new component TYPE on every render: React reconciles
 * by element type, so each state update (load progress, tool click, arch
 * message…) unmounted and remounted every <Pane>. The divs cornerstone had
 * been given — and the WebGL canvases it rendered into — were thrown away
 * and replaced with fresh empty ones, while the rendering engine kept drawing
 * into the detached originals. Net effect: the volume flashed once and the
 * screen went black, and mouse events (crosshairs, arch tracing) landed on
 * divs cornerstone never attached listeners to. Hoisting them keeps the pane
 * DOM stable across renders.
 */
const Pane = ({ label, color, paneRef }) => (
  <div className="relative bg-black overflow-hidden" style={{ minHeight: 0 }}>
    <div ref={paneRef} className="w-full h-full" onContextMenu={(e) => e.preventDefault()} />
    <span className="absolute top-1.5 left-2 text-[11px] font-semibold tracking-wide" style={{ color }}>{label}</span>
  </div>
);

// ── Left tool rail (DentalX-style) ─────────────────────────────────────────
const RailButton = ({ label, short, Icon, active = false, onClick, tone = 'text-neutral-300' }) => (
  <button
    type="button" title={label} onClick={onClick}
    className={`flex flex-col items-center gap-1 w-full px-1 py-2 rounded-md transition-colors ${
      active ? 'bg-amber-500 text-black' : `${tone} hover:bg-neutral-800`}`}
  >
    <Icon className="h-5 w-5" />
    <span className="text-[9px] leading-none font-medium">{short || label}</span>
  </button>
);

const RailSection = ({ title, children }) => (
  <div className="w-full px-1.5">
    <div className="text-[8px] uppercase tracking-wider text-neutral-600 text-center mt-3 mb-1">{title}</div>
    <div className="flex flex-col gap-1">{children}</div>
  </div>
);

export default function CBCTVolumeViewer({ imageIds = [], fallbackImageIds = null, fileName = 'CBCT', studyId = null, onClose }) {
  const axialRef = useRef(null);
  const coronalRef = useRef(null);
  const sagittalRef = useRef(null);
  const vol3dRef = useRef(null);
  const engineRef = useRef(null);
  const csRef = useRef(null);
  // Snapshot of each MPR/3D viewport's camera + VOI taken when the grid is
  // about to be hidden (switching away from MPR), restored after it's shown
  // again. cornerstone v4 reframes a viewport on resize() and the grid's
  // canvases collapse while hidden — so on the way back we resize + re-render
  // AND restore the pre-hide framing, otherwise the panes come back black or
  // mis-framed. Keyed by viewport id.
  const mprViewStateRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Bumped by the error overlay's Retry button — re-runs the whole setup
  // effect (teardown decaches the failed volume first).
  const [setupSeq, setSetupSeq] = useState(0);
  const [progress, setProgress] = useState(0);
  const [loadNote, setLoadNote] = useState('');
  const [activeTool, setActiveTool] = useState('Crosshairs');
  // Stage 1 — arch tracing: a Catmull-Rom spline drawn on the AXIAL pane whose
  // control points (volume world coords) define the dental arch for the
  // panoramic reconstruction (Stage 2). Persisted on imaging_studies.
  const [archMode, setArchMode] = useState(false);
  const [archMsg, setArchMsg] = useState('');
  // Stage 2 — panoramic (OPG): curved MPR sampled along the traced arch,
  // shown as a strip under the MPR grid and in the 3D Pano view mode.
  const [panoUrl, setPanoUrl] = useState(null);
  const [panoBusy, setPanoBusy] = useState(false);
  const [crossSections, setCrossSections] = useState(null); // [{ url, positionMm }]
  const volumeInfoRef = useRef(null); // { volumeId, range } of the displayed volume
  const createdVolumeIdsRef = useRef(new Set()); // volumeIds this mount cached — decached on unmount
  // Off-main-thread compute (cbctCompute.worker.js) — created lazily on the
  // first pano/auto-arch/AI job, terminated on unmount and on mode switches
  // away from the surfaces that show its output.
  const computeClientRef = useRef(null);
  // Monotonic id of the LATEST busy-overlay pano flow (OPG / Auto OPG): a
  // superseded flow must not clear the busy flag the newer one owns.
  const panoFlowSeqRef = useRef(0);
  const savedArchRef = useRef(null);  // arch persisted on imaging_studies, if any
  // Latest "trace finished" handler — the tool is configured once at setup but
  // must call into fresh React state (reconstructFromArch).
  const onTraceFinishedRef = useRef(null);
  // Live arch editing: latest "arch edited" handler (drag/add/remove control
  // points) + the trailing-debounce timer for the drag preview regeneration.
  const onArchEditedRef = useRef(null);
  const archEditTimerRef = useRef(null);

  // DentalX-style top view-mode tabs. The MPR grid stays mounted across modes
  // (toggled with CSS visibility) so the cornerstone WebGL canvases never
  // detach — switching modes must not re-trigger the flash-then-black bug.
  const [viewMode, setViewMode] = useState('mpr');
  // Gallery — screenshots captured during this session (object URLs).
  const [shots, setShots] = useState([]);
  const shotSeq = useRef(0);
  // Compare — selection lives here so it survives tab switches; the rest of
  // the Compare state (second volume, mesh, registration) lives in CompareMode.
  const [compareStudyId, setCompareStudyId] = useState(null);
  // AI Read (Phase 1, ASSISTIVE) — manual button only, no auto-run. Findings
  // live on imaging_studies.ai_analysis.cbct_reader; nothing touches the chart.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const [aiError, setAiError] = useState(null);
  const [aiResult, setAiResult] = useState(null);   // ai_analysis.cbct_reader
  const [aiViewShown, setAiViewShown] = useState(null); // { label, url } lightbox
  const aiViewUrlsRef = useRef(null); // label -> data URL of this session's AI views
  // Clinician review of the AI reading (ai_analysis.clinician_review) — the
  // reading is a draft the doctor amends: confirm/dismiss per finding, add
  // missed findings, record an impression. Saved explicitly.
  const [aiReview, setAiReview] = useState(null);
  const [aiReviewSaving, setAiReviewSaving] = useState(false);
  const [aiReviewMsg, setAiReviewMsg] = useState('');
  // Radiology report — {study, clinicId, userId} while the dialog is open.
  const [reportCtx, setReportCtx] = useState(null);
  // AI tokens: the study clinic's balance and the AI Read price (metered clinics only).
  const aiTokens = useAiTokens(studyId);

  useEffect(() => {
    let mounted = true;

    async function setup() {
      try {
        setLoading(true);
        setError(null);

        if (!imageIds || imageIds.length === 0) {
          throw new Error('No DICOM images for this study');
        }

        const cs = await ensureCornerstone();
        if (!mounted) return;
        csRef.current = cs;
        const { core, tools } = cs;
        const { RenderingEngine, Enums, volumeLoader, setVolumesForViewports } = core;
        const { ViewportType, OrientationAxis } = Enums;

        const renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);
        engineRef.current = renderingEngine;

        const viewportInput = [
          { viewportId: VP.AXIAL, type: ViewportType.ORTHOGRAPHIC, element: axialRef.current,
            defaultOptions: { orientation: OrientationAxis.AXIAL, background: [0, 0, 0] } },
          { viewportId: VP.CORONAL, type: ViewportType.ORTHOGRAPHIC, element: coronalRef.current,
            defaultOptions: { orientation: OrientationAxis.CORONAL, background: [0, 0, 0] } },
          { viewportId: VP.SAGITTAL, type: ViewportType.ORTHOGRAPHIC, element: sagittalRef.current,
            defaultOptions: { orientation: OrientationAxis.SAGITTAL, background: [0, 0, 0] } },
          { viewportId: VP.VOL3D, type: ViewportType.VOLUME_3D, element: vol3dRef.current,
            defaultOptions: { orientation: OrientationAxis.CORONAL, background: [0, 0, 0] } },
        ];
        renderingEngine.setViewports(viewportInput);

        // Build the volume from the image stack (NIfTI frames or wadouri DICOM).
        // Streaming loader sorts by ImagePositionPatient from per-image metadata.
        // If the primary set (e.g. the server-converted NIfTI) fails to build or
        // render, retry once with the DICOM fallback so a NIfTI problem can't
        // dead-end the viewer on a black screen.
        // The cornerstone cache is keyed by volumeId, so the id must be unique
        // per study/source: the old `CBCT_${tag}_${sliceCount}` key collided
        // across studies with the same slice count, silently rendering the
        // FIRST study's cached voxels when a second was opened. Key on the
        // study identity (hash of the first image URL when unsaved) instead.
        const studyTag = studyId || hashId(String(imageIds[0] || 'volume'));
        const loadVolume = async (ids, tag) => {
          const volumeId = `cornerstoneStreamingImageVolume:CBCT_${studyTag}_${tag}_${ids.length}`;
          console.log(`[CBCTVolumeViewer] ${tag}: building volume from ${ids.length} images; first id:`, ids[0]);
          const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds: ids });
          createdVolumeIdsRef.current.add(volumeId);
          if (!mounted) return null;
          // volume.load(callback) returns void in cornerstone3D v4 — completion
          // must be detected from the per-frame callback (framesProcessed ===
          // totalNumFrames), NOT by awaiting the return value. Awaiting void
          // resolved immediately, so the data-driven VOI below ran before any
          // frames existed and silently never applied (black NIfTI panes).
          const loadPromise = new Promise((resolve) => {
            let settled = false;
            const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
            // Safety net: window from whatever loaded if streaming stalls.
            const timer = setTimeout(finish, 120000);
            volume.load((evt) => {
              const total = evt?.totalNumFrames ?? evt?.total ?? ids.length;
              const done = evt?.framesProcessed ?? evt?.numFrames ?? 0;
              if (mounted && total) setProgress(Math.min(100, Math.round((done / total) * 100)));
              if (total && done >= total) finish();
            });
          });
          await setVolumesForViewports(
            renderingEngine, [{ volumeId }],
            [VP.AXIAL, VP.CORONAL, VP.SAGITTAL, VP.VOL3D]
          );
          volumeInfoRef.current = { volumeId, range: null };
          // Once the frames are in, window the MPR from the real data range so the
          // reformats aren't black (NIfTI carries no DICOM window metadata). Done
          // off the critical path so progressive rendering still shows.
          Promise.resolve(loadPromise).then(async () => {
            if (!mounted) return;
            const range = computeScalarRange(volume);
            console.log(`[CBCTVolumeViewer] ${tag}: load complete, scalarRange =`, range);
            if (volumeInfoRef.current?.volumeId === volumeId) volumeInfoRef.current.range = range;
            if (range) {
              [VP.AXIAL, VP.CORONAL, VP.SAGITTAL].forEach((id) => {
                try { renderingEngine.getViewport(id)?.setProperties({ voiRange: range }); } catch (_) { /* ignore */ }
              });
              try { renderingEngine.renderViewports([VP.AXIAL, VP.CORONAL, VP.SAGITTAL, VP.VOL3D]); } catch (_) { /* ignore */ }
              return;
            }
            // No voxel data after streaming "finished": the frames failed to
            // fetch/decode and the panes are black. Don't leave that silent —
            // run the advertised DICOM fallback once, else surface the error
            // overlay (message + Retry) instead of a dead black grid.
            console.warn(`[CBCTVolumeViewer] ${tag}: no scalar data after load — frames likely failed to decode/fetch (black panes).`);
            if (tag === 'primary' && fallbackImageIds && fallbackImageIds.length) {
              try {
                setLoadNote('Clean 3D volume rendered no image data — loading raw DICOM stack…');
                setProgress(0);
                setLoading(true);
                await loadVolume(fallbackImageIds, 'fallback');
                // The dead primary volume is no longer displayed — release it
                // now instead of holding both volumes until unmount.
                try {
                  csRef.current?.core?.cache?.removeVolumeLoadObject?.(volumeId);
                  createdVolumeIdsRef.current.delete(volumeId);
                } catch (_) { /* ignore */ }
                if (mounted) setLoading(false);
              } catch (eFb) {
                console.error('[CBCTVolumeViewer] fallback volume failed:', eFb);
                if (mounted) { setError(eFb?.message || 'CBCT volume failed to render'); setLoading(false); }
              }
            } else if (mounted) {
              setError('The CBCT volume streamed no image data — the frames could not be downloaded or decoded, so the views cannot render.');
              setLoading(false);
            }
          }).catch((e) => console.error(`[CBCTVolumeViewer] ${tag}: volume.load rejected:`, e?.message || e));
          return volumeId;
        };

        try {
          await loadVolume(imageIds, 'primary');
        } catch (ePrimary) {
          console.error('[CBCTVolumeViewer] primary volume failed:', ePrimary);
          if (fallbackImageIds && fallbackImageIds.length) {
            setLoadNote('Clean 3D volume failed — loading raw DICOM stack…');
            setProgress(0);
            await loadVolume(fallbackImageIds, 'fallback');
          } else {
            throw ePrimary;
          }
        }
        if (!mounted) return;

        // Best-effort bone preset on the 3D render; failure must not break MPR.
        try {
          const vp3d = renderingEngine.getViewport(VP.VOL3D);
          vp3d.setProperties({ preset: 'CT-Bone' });
        } catch (e) {
          console.warn('[CBCTVolumeViewer] 3D preset failed (MPR unaffected):', e?.message);
        }

        setupTools(tools, renderingEngine);

        renderingEngine.renderViewports([VP.AXIAL, VP.CORONAL, VP.SAGITTAL, VP.VOL3D]);
        setProgress(100);
        setLoading(false);
      } catch (err) {
        console.error('[CBCTVolumeViewer] setup error:', err);
        if (mounted) { setError(err?.message || 'Failed to load CBCT'); setLoading(false); }
      }
    }

    function setupTools(tools, renderingEngine) {
      const {
        ToolGroupManager, CrosshairsTool, WindowLevelTool, ZoomTool, PanTool,
        StackScrollTool, LengthTool, TrackballRotateTool, SplineROITool, Enums: toolEnums,
      } = tools;
      const { MouseBindings } = toolEnums;

      // Clean up any prior groups (re-mount safety).
      try { ToolGroupManager.destroyToolGroup(MPR_TOOLGROUP_ID); } catch (_) { /* none */ }
      try { ToolGroupManager.destroyToolGroup(VOL3D_TOOLGROUP_ID); } catch (_) { /* none */ }

      const mpr = ToolGroupManager.createToolGroup(MPR_TOOLGROUP_ID);
      [VP.AXIAL, VP.CORONAL, VP.SAGITTAL].forEach((v) => mpr.addViewport(v, RENDERING_ENGINE_ID));
      mpr.addTool(CrosshairsTool.toolName, {
        getReferenceLineColor: (id) =>
          ({ [VP.AXIAL]: 'rgb(240,180,60)', [VP.CORONAL]: 'rgb(120,200,120)', [VP.SAGITTAL]: 'rgb(120,160,240)' }[id] || 'rgb(200,200,200)'),
      });
      mpr.addTool(WindowLevelTool.toolName);
      mpr.addTool(LengthTool.toolName);
      mpr.addTool(ZoomTool.toolName);
      mpr.addTool(PanTool.toolName);
      mpr.addTool(StackScrollTool.toolName);
      // Arch-tracing spline (Stage 1) — an OPEN-curve subclass of SplineROITool
      // (left-click adds points, RIGHT-CLICK or double-click finishes the trace
      // WITHOUT closing the loop, Escape cancels). Registered passive; the Arch
      // button activates it on the axial pane's primary button.
      try {
        if (SplineROITool) {
          const ArchTraceTool = createArchTraceTool(tools);
          try { tools.addTool(ArchTraceTool); } catch (_) { /* already added */ }
          mpr.addTool(ARCH_TRACE_TOOL_NAME, {
            onTraceFinished: (pts, annotation) => onTraceFinishedRef.current?.(pts, annotation),
            // Live arch editing: dragging a control point regenerates the
            // panoramic (debounced preview; full quality + persist on release).
            onArchEdited: (pts, info) => onArchEditedRef.current?.(pts, info),
          });
          // Green arch curve/points so the "drag the green points" hint
          // matches what's on screen.
          try {
            tools.annotation?.config?.style?.setToolGroupToolStyles?.(MPR_TOOLGROUP_ID, {
              [ARCH_TRACE_TOOL_NAME]: {
                color: 'rgb(110, 220, 110)',
                colorHighlighted: 'rgb(80, 255, 80)',
                colorSelected: 'rgb(80, 255, 80)',
              },
            });
          } catch (_) { /* default yellow styling is fine */ }
        }
      } catch (e) {
        console.warn('[CBCTVolumeViewer] arch trace tool unavailable:', e?.message);
      }

      mpr.setToolActive(CrosshairsTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
      mpr.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
      mpr.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
      // Scroll through slices with the mouse wheel.
      try {
        mpr.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
      } catch (_) { mpr.setToolActive(StackScrollTool.toolName); }

      // 3D viewport: trackball rotate + zoom/pan.
      const vol3d = ToolGroupManager.createToolGroup(VOL3D_TOOLGROUP_ID);
      vol3d.addViewport(VP.VOL3D, RENDERING_ENGINE_ID);
      if (TrackballRotateTool) {
        vol3d.addTool(TrackballRotateTool.toolName);
        vol3d.setToolActive(TrackballRotateTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
      }
      vol3d.addTool(ZoomTool.toolName);
      vol3d.addTool(PanTool.toolName);
      vol3d.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
      vol3d.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
    }

    setup();

    // cornerstone3D doesn't watch element size itself — keep the GL canvases
    // matched to the panes when the popup window is resized.
    const onWinResize = () => { try { engineRef.current?.resize(true, true); } catch (_) { /* ignore */ } };
    window.addEventListener('resize', onWinResize);

    return () => {
      mounted = false;
      window.removeEventListener('resize', onWinResize);
      // A volume swap (retry / new study) invalidates any in-flight compute —
      // its results would describe a volume that is no longer displayed.
      try { computeClientRef.current?.cancelAll({ terminate: true }); } catch (_) { /* ignore */ }
      try {
        const tools = csRef.current?.tools;
        tools?.ToolGroupManager?.destroyToolGroup(MPR_TOOLGROUP_ID);
        tools?.ToolGroupManager?.destroyToolGroup(VOL3D_TOOLGROUP_ID);
      } catch (_) { /* ignore */ }
      try { engineRef.current?.destroy(); } catch (_) { /* ignore */ }
      engineRef.current = null;
      // Release the volume(s) this mount cached (cornerstone3D v4:
      // cache.removeVolumeLoadObject). Without this every viewer visit leaked
      // the full voxel buffer — hundreds of MB per CBCT — in cornerstone's
      // cache until the tab died.
      const cache = csRef.current?.core?.cache;
      createdVolumeIdsRef.current.forEach((id) => {
        try { cache?.removeVolumeLoadObject?.(id); } catch (_) { /* already gone */ }
      });
      createdVolumeIdsRef.current.clear();
      volumeInfoRef.current = null;
    };
  }, [imageIds, fallbackImageIds, studyId, setupSeq]);

  // ── Compute worker lifecycle ─────────────────────────────────────────────
  // Lazy accessor: the worker only exists once some compute is requested (and
  // module import stays Worker-free for jsdom/tests).
  const getComputeClient = useCallback(() => {
    if (!computeClientRef.current) computeClientRef.current = createCbctComputeClient();
    return computeClientRef.current;
  }, []);

  // Leaving every surface that shows the panoramic / AI output ('mpr' shows
  // the OPG strip + AI panel, 'pano' the pano view) cancels in-flight compute
  // jobs and terminates a mid-crunch worker so the CPU is freed immediately.
  // The cancelled promises reject with CbctComputeCancelled, which the
  // callers treat as a quiet no-op (busy flags cleared, no error surfaced).
  useEffect(() => {
    if (viewMode === 'mpr' || viewMode === 'pano') return;
    try { computeClientRef.current?.cancelAll({ terminate: true }); } catch (_) { /* ignore */ }
  }, [viewMode]);

  // Unmount: cancel + terminate the compute worker.
  useEffect(() => () => {
    try { computeClientRef.current?.dispose(); } catch (_) { /* ignore */ }
    computeClientRef.current = null;
  }, []);

  // Switch the MPR primary-button tool.
  const selectTool = useCallback((toolId) => {
    const tools = csRef.current?.tools;
    if (!tools) return;
    const mpr = tools.ToolGroupManager.getToolGroup(MPR_TOOLGROUP_ID);
    if (!mpr) return;
    const { MouseBindings } = tools.Enums;
    // The ArchTrace tool also binds the primary button when arch mode is on —
    // passivate it and drop the mode flag too, or BOTH tools stay active and
    // every left-click keeps planting arch points on top of the picked tool.
    try {
      if (mpr.getToolInstance?.(ARCH_TRACE_TOOL_NAME)) mpr.setToolPassive(ARCH_TRACE_TOOL_NAME);
    } catch (_) { /* arch tool not registered */ }
    setArchMode(false);
    const PRIMARY = [tools.CrosshairsTool, tools.WindowLevelTool, tools.LengthTool, tools.PanTool];
    PRIMARY.forEach((Tool) => {
      if (!Tool) return;
      try {
        if (Tool.toolName === toolId) mpr.setToolActive(Tool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
        else mpr.setToolPassive(Tool.toolName);
      } catch (_) { /* ignore */ }
    });
    // Pan also stays on auxiliary regardless.
    try { mpr.setToolActive(tools.PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] }); } catch (_) { /* ignore */ }
    setActiveTool(toolId);
  }, []);

  const resetViews = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    Object.values(VP).forEach((id) => { try { engine.getViewport(id)?.resetCamera(); } catch (_) { /* ignore */ } });
    engine.renderViewports(Object.values(VP));
  }, []);

  // ── Arch tracing (Stage 1) ───────────────────────────────────────────────
  // Note where a saved arch already exists for this study, and load a prior
  // AI reading (ai_analysis.cbct_reader) so we show it instead of re-running.
  useEffect(() => {
    if (!studyId) return undefined;
    let off = false;
    (async () => {
      try {
        const { data } = await supabase.from('imaging_studies')
          .select('viewer_annotations, ai_analysis').eq('id', studyId).single();
        if (off) return;
        const arch = data?.viewer_annotations?.arch;
        if (Array.isArray(arch?.points) && arch.points.length) {
          savedArchRef.current = arch;
          setArchMsg(`Saved arch on file: ${arch.points.length} points — press OPG to rebuild the panoramic.`);
        }
        const reader = data?.ai_analysis?.cbct_reader;
        if (reader && Array.isArray(reader.findings)) setAiResult(reader);
        const review = data?.ai_analysis?.clinician_review;
        if (review && typeof review === 'object') setAiReview(review);
      } catch (_) { /* ignore */ }
    })();
    return () => { off = true; };
  }, [studyId]);

  const toggleArch = useCallback(() => {
    const tools = csRef.current?.tools;
    if (!tools) return;
    const mpr = tools.ToolGroupManager.getToolGroup(MPR_TOOLGROUP_ID);
    if (!mpr || !mpr.getToolInstance?.(ARCH_TRACE_TOOL_NAME)) { setArchMsg('Spline tool unavailable'); return; }
    const { MouseBindings } = tools.Enums;
    setArchMode((on) => {
      const next = !on;
      try {
        if (next) {
          [tools.CrosshairsTool, tools.WindowLevelTool, tools.LengthTool].forEach((T) => {
            try { if (T) mpr.setToolPassive(T.toolName); } catch (_) { /* ignore */ }
          });
          mpr.setToolActive(ARCH_TRACE_TOOL_NAME, { bindings: [{ mouseButton: MouseBindings.Primary }] });
          setArchMsg('Trace the arch on the AXIAL pane — Left-click to add points · Right-click to finish · Esc to cancel.');
        } else {
          try { mpr.setToolPassive(ARCH_TRACE_TOOL_NAME); } catch (_) { /* ignore */ }
          mpr.setToolActive(tools.CrosshairsTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
          setActiveTool('Crosshairs');
        }
      } catch (_) { /* ignore */ }
      return next;
    });
  }, []);

  // Persist arch control points on imaging_studies.viewer_annotations.arch —
  // the single save path shared by the explicit Save button and the live-edit
  // drag end (an edited arch persists exactly like a fresh trace).
  const persistArchPoints = useCallback(async (pts, meta = {}) => {
    if (!studyId) throw new Error('no study');
    const arch = {
      points: pts,
      viewPlaneNormal: meta.viewPlaneNormal || null,
      viewUp: meta.viewUp || null,
      frameOfReferenceUID: meta.FrameOfReferenceUID || meta.frameOfReferenceUID || null,
      updatedAt: new Date().toISOString(),
    };
    const { data: row } = await supabase.from('imaging_studies').select('viewer_annotations').eq('id', studyId).single();
    const merged = { ...(row?.viewer_annotations || {}), arch };
    const { error: upErr } = await supabase.from('imaging_studies')
      .update({ viewer_annotations: merged, viewer_annotations_updated_at: new Date().toISOString() })
      .eq('id', studyId);
    if (upErr) throw upErr;
    savedArchRef.current = arch;
    return arch;
  }, [studyId]);

  const saveArch = useCallback(async () => {
    const cs = csRef.current;
    const el = axialRef.current;
    if (!cs || !el || !studyId) { setArchMsg('Cannot save (no study).'); return; }
    try {
      const list = cs.tools.annotation.state.getAnnotations(ARCH_TRACE_TOOL_NAME, el) || [];
      const last = list[list.length - 1];
      const pts = sanitizeArchPoints(last?.data?.handles?.points || []);
      if (pts.length < 3) { setArchMsg('Trace at least 3 arch points first.'); return; }
      await persistArchPoints(pts, last.metadata || {});
      setArchMsg(`Arch saved (${pts.length} points).`);
    } catch (e) {
      setArchMsg('Save failed: ' + (e?.message || 'error'));
    }
  }, [studyId, persistArchPoints]);

  // ── Panoramic (Stage 2): curved MPR along the traced arch ────────────────
  // Control points come from the live spline on the axial pane, falling back
  // to the arch saved on the study row.
  const getArchControlPoints = useCallback(() => {
    const cs = csRef.current;
    try {
      const list = cs?.tools?.annotation?.state?.getAnnotations(ARCH_TRACE_TOOL_NAME, axialRef.current) || [];
      const last = list[list.length - 1];
      const pts = sanitizeArchPoints(last?.data?.handles?.points || []);
      if (pts.length >= 3) return pts;
    } catch (_) { /* fall through to saved arch */ }
    // Saved arches may pre-date the open-curve fix — sanitize them too.
    const saved = sanitizeArchPoints(savedArchRef.current?.points || []);
    return saved.length >= 3 ? saved : null;
  }, []);

  // Pull the loaded volume's geometry + voxel data, ready for the curved-MPR
  // sampler. Returns { vol, range, verticalAxis, volumeKey, volumeLoaded } or
  // throws with a clear reason. volumeKey/volumeLoaded drive the compute
  // worker's snapshot cache: while frames are still streaming (volumeLoaded
  // false) every job re-posts fresh voxels, matching what the old synchronous
  // code saw when it read the live array at call time.
  const getVolumeForSampling = useCallback(() => {
    const cs = csRef.current;
    const info = volumeInfoRef.current;
    if (!cs || !info?.volumeId) throw new Error('Volume not loaded yet.');
    const volume = cs.core?.cache?.getVolume?.(info.volumeId);
    const scalarData = getVolumeScalarData(volume);
    if (!volume || !scalarData) throw new Error('Volume voxel data unavailable (still loading?)');
    let verticalAxis = null;
    try { verticalAxis = engineRef.current?.getViewport(VP.AXIAL)?.getCamera()?.viewPlaneNormal || null; } catch (_) { /* default to k axis */ }
    // Prefer the LIVE axial W/L (the user may have adjusted it) so the OPG
    // panels match what the MPR shows; fall back to the data-derived range.
    let range = null;
    try {
      const voi = engineRef.current?.getViewport(VP.AXIAL)?.getProperties?.()?.voiRange;
      if (voi && Number.isFinite(voi.lower) && Number.isFinite(voi.upper) && voi.upper > voi.lower) range = voi;
    } catch (_) { /* fall back */ }
    if (!range) range = info.range || computeScalarRange(volume) || { lower: 0, upper: 1 };
    const vol = {
      dimensions: volume.dimensions, spacing: volume.spacing,
      origin: volume.origin, direction: volume.direction, scalarData,
    };
    return { vol, range, verticalAxis, volumeKey: info.volumeId, volumeLoaded: Boolean(info.range) };
  }, []);

  // Shared reconstruction: build the panoramic strip + perpendicular
  // cross-sections from a set of WORLD control points and publish them. The
  // voxel sampling runs in the compute worker; the main thread only windows
  // the returned Float32 strips into PNG data URLs.
  const reconstructFromArch = useCallback(async (pts, sourceLabel) => {
    const flow = ++panoFlowSeqRef.current;
    setPanoBusy(true);
    setViewMode('pano');
    setArchMsg(`Reconstructing panoramic (${sourceLabel})…`);
    // Yield a frame so the busy message paints before the volume snapshot copy.
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const { vol, range, verticalAxis, volumeKey, volumeLoaded } = getVolumeForSampling();
      const { pano, panoWin, sections, sectionsWin, sectionsError } = await getComputeClient().run(
        'pano',
        { volumeKey, vol, volumeLoaded, params: { archPoints: pts, verticalAxis, wantSections: true, sectionCount: 12 } },
        { onProgress: (note) => setArchMsg(`Reconstructing panoramic (${sourceLabel})… ${note}`) }
      );
      // The MIP strip is dominated by bone/enamel — window it to its OWN
      // non-background value distribution (robust percentiles + gentle gamma,
      // computed in the worker) instead of the full-volume range, which is
      // mostly air/soft tissue and washes it out.
      const win = panoWin || range;
      const url = floatImageToDataUrl(pano, win.lower, win.upper, win.gamma);
      setPanoUrl(url);
      // Cross-sections perpendicular to the arch (the dental cross-section
      // row) — same data-derived window treatment as the panoramic.
      if (sections) {
        const sWin = sectionsWin || panoWin || range;
        setCrossSections(
          sections.map((s, i) => ({
            id: i,
            url: floatImageToDataUrl(s, sWin.lower, sWin.upper, sWin.gamma),
            positionMm: s.positionMm,
          }))
        );
      } else {
        if (sectionsError) console.warn('[CBCTVolumeViewer] cross-sections failed (pano unaffected):', sectionsError);
        setCrossSections(null);
      }
      setArchMsg(
        `Panoramic reconstructed (${pano.width}×${pano.height}, ${pts.length}-point arch · ${sourceLabel}). ` +
        'Drag the green points on the AXIAL pane to refine the arch — the panoramic updates live.'
      );
      return true;
    } catch (e) {
      // Cancelled = superseded / mode switch / unmount — quiet no-op.
      if (isComputeCancelled(e)) return false;
      console.error('[CBCTVolumeViewer] OPG reconstruction failed:', e);
      setArchMsg('OPG failed: ' + (e?.message || 'error'));
      return false;
    } finally {
      if (panoFlowSeqRef.current === flow) setPanoBusy(false);
    }
  }, [getVolumeForSampling, getComputeClient]);

  // ── Live arch editing (drag-to-update panoramic) ─────────────────────────
  // Regenerate the panoramic IN PLACE (no tab switch, no busy overlay) from a
  // set of arch points. During a drag a half-resolution preview keeps the
  // strip fluid; on release the full-quality strip + cross-sections rebuild.
  // Async now that the sampling runs in the worker; resolves true/false and
  // never rejects. A newer regeneration supersedes an in-flight one (the
  // client cancels same-task jobs), so a fast drag can't queue a backlog.
  const regeneratePanoInPlace = useCallback(async (pts, { preview = false } = {}) => {
    try {
      const { vol, range, verticalAxis, volumeKey, volumeLoaded } = getVolumeForSampling();
      const { pano, panoWin, sections, sectionsWin } = await getComputeClient().run('pano', {
        volumeKey, vol, volumeLoaded,
        params: {
          archPoints: pts,
          verticalAxis,
          panoOptions: preview ? { columns: 512, maxRows: 384, maxSlabSamples: 9 } : {},
          wantSections: !preview,
          sectionCount: 12,
        },
      });
      const win = panoWin || range;
      const url = floatImageToDataUrl(pano, win.lower, win.upper, win.gamma);
      if (url) setPanoUrl(url);
      if (!preview && sections) {
        const sWin = sectionsWin || panoWin || range;
        setCrossSections(
          sections.map((s, i) => ({
            id: i,
            url: floatImageToDataUrl(s, sWin.lower, sWin.upper, sWin.gamma),
            positionMm: s.positionMm,
          }))
        );
      } // on a sections failure keep the previous cross-sections (as before)
      return true;
    } catch (e) {
      if (isComputeCancelled(e)) return false; // superseded — quiet
      console.warn('[CBCTVolumeViewer] live panoramic regeneration failed:', e?.message);
      return false;
    }
  }, [getVolumeForSampling, getComputeClient]);

  // Arch edited on the axial pane (control point dragged / added / removed).
  // Drag ticks (final:false) regenerate a preview with a trailing ~150ms
  // debounce; drag end (final:true) rebuilds full quality and persists the
  // arch through the SAME save path as a fresh trace (drag-end only — never
  // per-frame). Kept in a ref so the tool (configured once) calls fresh state.
  useEffect(() => {
    const ARCH_EDIT_DEBOUNCE_MS = 150;
    onArchEditedRef.current = (pts, { final = false, annotation } = {}) => {
      const clean = sanitizeArchPoints(pts || []);
      if (clean.length < 3) return;
      if (archEditTimerRef.current) {
        clearTimeout(archEditTimerRef.current);
        archEditTimerRef.current = null;
      }
      if (final) {
        // regeneratePanoInPlace resolves (never rejects) with success/failure;
        // the persist below runs immediately — it must not wait on the worker.
        regeneratePanoInPlace(clean, { preview: false }).then((ok) => {
          if (ok) {
            setArchMsg(
              `Arch updated (${clean.length} points) — panoramic rebuilt. ` +
              'Drag the green points to refine the arch — the panoramic updates live ' +
              '(Shift+Click the curve adds a point · Ctrl+Click a point removes it).'
            );
          }
        });
        if (studyId) {
          persistArchPoints(clean, annotation?.metadata || {})
            .catch((e) => console.warn('[CBCTVolumeViewer] arch auto-save failed:', e?.message));
        }
      } else {
        archEditTimerRef.current = setTimeout(() => {
          archEditTimerRef.current = null;
          regeneratePanoInPlace(clean, { preview: true });
        }, ARCH_EDIT_DEBOUNCE_MS);
      }
    };
    return () => {
      onArchEditedRef.current = null;
      if (archEditTimerRef.current) {
        clearTimeout(archEditTimerRef.current);
        archEditTimerRef.current = null;
      }
    };
  }, [regeneratePanoInPlace, persistArchPoints, studyId]);

  // Materialize arch points as a real, editable ArchTrace annotation on the
  // axial pane — used after Auto OPG (and an OPG rebuilt from a SAVED arch) so
  // the control points are visible and draggable just like a manual trace.
  // `replace: true` swaps out any existing trace (one arch drives the OPG).
  const ensureEditableArch = useCallback((pts, { replace = false } = {}) => {
    const tools = csRef.current?.tools;
    const el = axialRef.current;
    if (!tools || !el) return;
    try {
      const existing = tools.annotation?.state?.getAnnotations?.(ARCH_TRACE_TOOL_NAME, el) || [];
      const hasLiveArch = existing.some(
        (a) => sanitizeArchPoints(a?.data?.handles?.points || []).length >= 3
      );
      if (hasLiveArch && !replace) return; // a manual trace is already editable
      const ArchTraceTool = createArchTraceTool(tools);
      const mpr = tools.ToolGroupManager?.getToolGroup?.(MPR_TOOLGROUP_ID);
      const toolInstance = mpr?.getToolInstance?.(ARCH_TRACE_TOOL_NAME) || undefined;
      existing.slice().forEach((a) => {
        try { tools.annotation.state.removeAnnotation(a.annotationUID); } catch (_) { /* ignore */ }
      });
      const annotation = ArchTraceTool.hydrateArch?.(VP.AXIAL, pts, { toolInstance });
      if (annotation) {
        // Jump the axial view to the arch slice so the points are on-screen.
        try { engineRef.current?.getViewport(VP.AXIAL)?.jumpToWorld?.(pts[Math.floor(pts.length / 2)]); } catch (_) { /* ignore */ }
        try { engineRef.current?.renderViewports([VP.AXIAL]); } catch (_) { /* ignore */ }
      }
    } catch (e) {
      console.warn('[CBCTVolumeViewer] could not materialize an editable arch:', e?.message);
    }
  }, []);

  // Manual OPG — reconstruct along the traced/saved arch. A SAVED arch is
  // materialized as an editable annotation so it can be refined live too.
  const generateOpg = useCallback(async () => {
    if (panoBusy) return;
    const pts = getArchControlPoints();
    if (!pts) {
      setArchMsg('No arch yet. Use Auto OPG, or trace 3+ points along the teeth on the AXIAL pane, then OPG.');
      return;
    }
    const ok = await reconstructFromArch(pts, 'traced arch');
    if (ok) ensureEditableArch(pts);
  }, [panoBusy, getArchControlPoints, reconstructFromArch, ensureEditableArch]);

  // A finished manual trace (right-click / double-click) rebuilds the
  // panoramic immediately — no extra OPG click needed. Kept in a ref so the
  // tool (configured once at setup) always calls the fresh closure.
  useEffect(() => {
    onTraceFinishedRef.current = (pts) => {
      const clean = sanitizeArchPoints(pts || []);
      if (clean.length < 3) {
        setArchMsg('Trace needs at least 3 points — Left-click to add points · Right-click to finish · Esc to cancel.');
        return;
      }
      setArchMsg(`Arch traced (${clean.length} points) — building the panoramic…`);
      reconstructFromArch(clean, 'traced arch');
    };
    return () => { onTraceFinishedRef.current = null; };
  }, [reconstructFromArch]);

  // Escape cancels an in-progress trace. The tool handles Escape itself when
  // the pane has focus; this window-level fallback catches it regardless.
  useEffect(() => {
    if (!archMode) return undefined;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      try {
        const mpr = csRef.current?.tools?.ToolGroupManager?.getToolGroup(MPR_TOOLGROUP_ID);
        const inst = mpr?.getToolInstance?.(ARCH_TRACE_TOOL_NAME);
        if (inst?.isDrawing && axialRef.current) {
          inst.cancel(axialRef.current);
          setArchMsg('Trace cancelled — Left-click to add points · Right-click to finish · Esc to cancel.');
        }
      } catch (_) { /* ignore */ }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [archMode]);

  // Auto OPG — detect the dental arch from the volume and reconstruct in one
  // click (no manual tracing). Falls back to a traced/saved arch on failure.
  // The full-volume arch scan runs in the compute worker.
  const autoOpg = useCallback(async () => {
    if (panoBusy) return;
    const flow = ++panoFlowSeqRef.current;
    setPanoBusy(true);
    setViewMode('pano');
    setArchMsg('Detecting the dental arch automatically…');
    await new Promise((resolve) => setTimeout(resolve, 30));
    let pts = null;
    let detected = false;
    let cancelled = false;
    try {
      const { vol, volumeKey, volumeLoaded } = getVolumeForSampling();
      const result = await getComputeClient().run(
        'autoArch',
        { volumeKey, vol, volumeLoaded },
        { onProgress: (note) => setArchMsg(`Detecting the dental arch automatically… ${note}`) }
      );
      pts = result.pointsWorld;
      detected = true;
    } catch (e) {
      if (isComputeCancelled(e)) cancelled = true; // mode switch / unmount — stop quietly
      else console.warn('[CBCTVolumeViewer] auto-arch failed, will try a traced arch:', e?.message);
    } finally {
      if (panoFlowSeqRef.current === flow) setPanoBusy(false);
    }
    if (cancelled) return;
    if (!pts) pts = getArchControlPoints();
    if (!pts) {
      setArchMsg('Auto-arch could not find the dentition. Trace the arch manually (Arch tool), then OPG.');
      return;
    }
    const ok = await reconstructFromArch(pts, detected ? 'auto-arch' : 'traced arch');
    // The detected arch replaces any prior trace so its control points are
    // draggable on the axial pane — refine it live like a manual trace.
    if (ok) ensureEditableArch(pts, { replace: detected });
  }, [panoBusy, getVolumeForSampling, getComputeClient, getArchControlPoints, reconstructFromArch, ensureEditableArch]);

  // ── AI Read (Phase 1, ASSISTIVE) ─────────────────────────────────────────
  // Deterministically render the AI input views from the loaded volume
  // (cbctAiViews reuses autoArch + curvedMpr — all of it running in the
  // compute worker), preferring the clinician's traced/saved arch for the
  // panoramic. PNG encoding stays on the main thread (it needs <canvas> and
  // is cheap next to the voxel sampling) and reproduces generateCbctAiViews'
  // output byte-for-byte. Cached per session so clicking a finding's view
  // reference doesn't recompute.
  const buildAiViewSet = useCallback(async (onProgress) => {
    const { vol, range, verticalAxis, volumeKey, volumeLoaded } = getVolumeForSampling();
    const archPointsWorld = getArchControlPoints(); // traced/saved arch or null → auto-arch
    const { views, range: usedRange } = await getComputeClient().run(
      'aiViews',
      { volumeKey, vol, volumeLoaded, params: { options: { range, verticalAxis, archPointsWorld } } },
      { onProgress }
    );
    const images = [];
    const viewUrls = {};
    for (const view of views) {
      const url = viewToPngDataUrl(view, usedRange.lower, usedRange.upper);
      if (!url) continue;
      viewUrls[view.label] = url;
      images.push({ label: view.label, data: url.split(',')[1], mediaType: 'image/png' });
    }
    aiViewUrlsRef.current = viewUrls;
    return images;
  }, [getVolumeForSampling, getArchControlPoints, getComputeClient]);

  // Manual "AI Read" — never auto-runs (Phase 3 adds auto-run on ingest).
  // Generates the views client-side, sends them to the JWT-verified
  // ai-read-cbct edge function, and shows the returned findings. The function
  // persists the result on imaging_studies.ai_analysis.cbct_reader.
  const runAiRead = useCallback(async () => {
    if (aiBusy) return;
    if (!studyId) { setAiError('AI Read needs a saved imaging study.'); setAiOpen(true); return; }
    setAiOpen(true);
    setAiBusy(true);
    setAiError(null);
    setAiNote('Rendering AI views (panoramic, axial slabs, coronal/sagittal)…');
    // Yield a frame so the busy state paints before the volume snapshot copy.
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const images = await buildAiViewSet((note) => setAiNote(`Rendering AI views… ${note}`));
      if (!images.length) throw new Error('Could not render any AI views from this volume.');
      setAiNote(`Sending ${images.length} views for assistive reading…`);
      const { data, error: fnErr } = await supabase.functions.invoke('ai-read-cbct', {
        body: { study_id: studyId, images },
      });
      aiTokens.refresh();
      if (fnErr) throw new Error(await functionErrorMessage(fnErr, 'AI reading failed'));
      if (data?.error) throw new Error(data.error);
      if (!data?.cbct_reader) throw new Error('AI reading returned no findings payload');
      setAiResult(data.cbct_reader);
      // Decisions are positional against the reading they reviewed — a fresh
      // reading resets them (the doctor's own additions and impression stay).
      setAiReview((prev) => (prev
        ? { ...prev, decisions: {}, reader_created_at: data.cbct_reader.created_at || null }
        : prev));
    } catch (e) {
      if (!isComputeCancelled(e)) { // cancelled = mode switch / unmount — quiet
        console.error('[CBCTVolumeViewer] AI read failed:', e);
        setAiError(e?.message || 'AI reading failed');
      }
    } finally {
      setAiBusy(false);
      setAiNote('');
    }
  }, [aiBusy, studyId, buildAiViewSet, aiTokens.refresh]);

  // Open the AI panel (shows the stored reading when one exists; Run/Re-run is
  // always explicit — no auto-run in Phase 1).
  const toggleAiPanel = useCallback(() => setAiOpen((v) => !v), []);

  // Open the radiology report dialog for this study (fetches the study row +
  // current user the dialog needs; same imaging_reports flow as the worklist).
  const openReport = useCallback(async () => {
    if (!studyId) return;
    try {
      const [{ data: study }, { data: auth }] = await Promise.all([
        supabase.from('imaging_studies')
          .select('id, study_type, patient_id, clinic_id, customers(name)')
          .eq('id', studyId).single(),
        supabase.auth.getUser(),
      ]);
      if (!study) throw new Error('Study not accessible');
      setReportCtx({ study, clinicId: study.clinic_id, userId: auth?.user?.id || null });
    } catch (e) {
      console.error('[CBCTVolumeViewer] report open failed:', e);
    }
  }, [studyId]);

  // ── clinician review of the AI reading ────────────────────────────────────
  const patchAiReview = useCallback((patch) => {
    setAiReview((prev) => ({ decisions: {}, added: [], impression: '', ...prev, ...patch }));
    setAiReviewMsg('');
  }, []);

  const decideAiFinding = useCallback((index, status) => {
    setAiReview((prev) => {
      const base = { decisions: {}, added: [], impression: '', ...prev };
      const decisions = { ...base.decisions };
      if (!status) delete decisions[index];
      else decisions[index] = { ...decisions[index], status };
      return { ...base, decisions };
    });
    setAiReviewMsg('');
  }, []);

  const noteAiFinding = useCallback((index, note) => {
    setAiReview((prev) => {
      const base = { decisions: {}, added: [], impression: '', ...prev };
      const existing = base.decisions[index];
      if (!existing) return base;
      return { ...base, decisions: { ...base.decisions, [index]: { ...existing, note } } };
    });
  }, []);

  const addAiFinding = useCallback((finding) => {
    setAiReview((prev) => {
      const base = { decisions: {}, added: [], impression: '', ...prev };
      return { ...base, added: [...base.added, finding] };
    });
    setAiReviewMsg('');
  }, []);

  const removeAiAddedFinding = useCallback((index) => {
    setAiReview((prev) => {
      const base = { decisions: {}, added: [], impression: '', ...prev };
      return { ...base, added: base.added.filter((_, i) => i !== index) };
    });
  }, []);

  const setAiImpression = useCallback((impression) => {
    patchAiReview({ impression });
  }, [patchAiReview]);

  // Persist on ai_analysis.clinician_review with the same non-clobbering merge
  // the reader itself uses — sibling keys (cbct_reader, diagnose-imaging) stay.
  const saveAiReview = useCallback(async () => {
    if (!studyId) { setAiReviewMsg('Cannot save (no study).'); return; }
    setAiReviewSaving(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const entry = {
        decisions: {}, added: [], impression: '',
        ...aiReview,
        reader_created_at: aiResult?.created_at || null,
        reader_version: aiResult?.version || null,
        reviewed_by: auth?.user?.email || auth?.user?.id || null,
        reviewed_at: new Date().toISOString(),
      };
      const { data: row } = await supabase.from('imaging_studies')
        .select('ai_analysis').eq('id', studyId).single();
      const merged = {
        ...((row?.ai_analysis && typeof row.ai_analysis === 'object') ? row.ai_analysis : {}),
        clinician_review: entry,
      };
      const { error: upErr } = await supabase.from('imaging_studies')
        .update({ ai_analysis: merged, updated_at: new Date().toISOString() })
        .eq('id', studyId);
      if (upErr) throw upErr;
      setAiReview(entry);
      const n = Object.values(entry.decisions).filter((d) => d?.status).length;
      setAiReviewMsg(`Review saved (${n} decided, ${entry.added.length} added).`);
    } catch (e) {
      console.error('[CBCTVolumeViewer] review save failed:', e);
      setAiReviewMsg('Save failed: ' + (e?.message || 'error'));
    } finally {
      setAiReviewSaving(false);
    }
  }, [studyId, aiReview, aiResult]);

  // Show the view a finding references. Views are regenerated locally
  // (deterministic, no AI call) when this session hasn't rendered them yet —
  // e.g. when the reading was loaded from the study row. The rebuild runs in
  // the worker; the panel's existing busy note covers the wait (the findings
  // list — and so this handler — is hidden while busy, preventing re-entry).
  const showAiView = useCallback(async (label) => {
    let url = aiViewUrlsRef.current?.[label];
    if (!url) {
      setAiBusy(true);
      setAiNote('Rendering the referenced view…');
      try {
        await buildAiViewSet((note) => setAiNote(`Rendering the referenced view… ${note}`));
        url = aiViewUrlsRef.current?.[label];
      } catch (e) {
        if (!isComputeCancelled(e)) setAiError('Could not render the referenced view: ' + (e?.message || 'error'));
        return;
      } finally {
        setAiBusy(false);
        setAiNote('');
      }
    }
    if (url) setAiViewShown({ label, url });
  }, [buildAiViewSet]);

  // Capture every MPR/3D viewport's camera + VOI so we can restore the exact
  // framing after the grid has been hidden and shown again. Done right BEFORE
  // hiding, while the canvases still have their real size and a valid camera.
  const snapshotMprViewState = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const snap = {};
    MPR_VP_IDS.forEach((id) => {
      try {
        const vp = engine.getViewport(id);
        if (!vp) return;
        const entry = {};
        try { entry.camera = vp.getCamera?.(); } catch (_) { /* skip camera */ }
        try { entry.voiRange = vp.getProperties?.()?.voiRange; } catch (_) { /* skip voi */ }
        snap[id] = entry;
      } catch (_) { /* ignore this viewport */ }
    });
    mprViewStateRef.current = snap;
  }, []);

  // Make the MPR grid render correctly after it becomes visible again. A
  // cornerstone viewport whose canvas was display/visibility-hidden collapses
  // its drawing surface; cornerstone v4 does NOT auto-recover the canvas size
  // on a visibility change, and its renderer silently bails when sWidth/sHeight
  // is below the minimum — leaving the panes BLACK. So once the grid is laid
  // out and visible we (1) resize(true) to rebuild the canvases at their real
  // size, (2) restore the pre-hide camera/VOI in case resize reframed them, and
  // (3) explicitly re-render. Runs post-layout via rAF so client sizes are real.
  const showAndRefreshMpr = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    try { engine.resize(true, true); } catch (_) { /* ignore */ }
    const snap = mprViewStateRef.current;
    if (snap) {
      MPR_VP_IDS.forEach((id) => {
        const entry = snap[id];
        if (!entry) return;
        try {
          const vp = engine.getViewport(id);
          if (!vp) return;
          if (entry.voiRange) { try { vp.setProperties?.({ voiRange: entry.voiRange }); } catch (_) { /* ignore */ } }
          if (entry.camera) { try { vp.setCamera?.(entry.camera); } catch (_) { /* ignore */ } }
        } catch (_) { /* ignore this viewport */ }
      });
    }
    try { engine.renderViewports(MPR_VP_IDS); } catch (_) { /* ignore */ }
  }, []);

  // View-mode show/hide lifecycle for the (always-mounted) MPR grid.
  //   • Leaving MPR  → snapshot the framing while the canvases are still real.
  //   • Entering MPR → after the grid is laid out & visible, resize + restore +
  //                    re-render so the panes never come back black (the
  //                    regression after returning from Compare). Two rAFs so the
  //                    work runs strictly AFTER the browser applied the
  //                    visibility change and recomputed layout.
  // useLayoutEffect's cleanup runs synchronously on the OLD (visible) DOM, which
  // is the right moment to snapshot before the grid is hidden.
  const prevViewModeRef = useRef('mpr');
  useLayoutEffect(() => {
    const wasMpr = prevViewModeRef.current === 'mpr';
    const isMpr = viewMode === 'mpr';
    prevViewModeRef.current = viewMode;

    if (wasMpr && !isMpr) {
      // About to hide the grid — capture current framing on the live canvases.
      snapshotMprViewState();
      return undefined;
    }
    if (isMpr) {
      // The grid is (about to be) visible again — refresh after layout settles.
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => showAndRefreshMpr());
      });
      return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
    }
    return undefined;
  }, [viewMode, snapshotMprViewState, showAndRefreshMpr]);

  // The OPG strip and the AI panel change the MPR pane geometry WITHOUT a mode
  // switch — resize the GL canvases to match once the layout settles (panes
  // stay mounted, so cornerstone keeps the same canvases; they just need
  // re-sizing + a re-render so the reframe paints).
  useEffect(() => {
    if (viewMode !== 'mpr') return undefined;
    const raf = requestAnimationFrame(() => {
      try { engineRef.current?.resize(true, true); } catch (_) { /* ignore */ }
      try { engineRef.current?.renderViewports(MPR_VP_IDS); } catch (_) { /* ignore */ }
    });
    return () => cancelAnimationFrame(raf);
  }, [panoUrl, aiOpen, viewMode]);

  const clearArch = useCallback(() => {
    const cs = csRef.current;
    const el = axialRef.current;
    if (!cs || !el) return;
    try {
      const list = cs.tools.annotation.state.getAnnotations(ARCH_TRACE_TOOL_NAME, el) || [];
      list.slice().forEach((a) => { try { cs.tools.annotation.state.removeAnnotation(a.annotationUID); } catch (_) { /* ignore */ } });
      engineRef.current?.renderViewports([VP.AXIAL]);
      setArchMsg('Arch cleared.');
    } catch (_) { /* ignore */ }
  }, []);

  // Add a capture to the in-session Gallery (also used by Compare's fused
  // CBCT+mesh overlay snapshots).
  const addShot = useCallback((url, label, which = 'capture') => {
    const id = `shot_${shotSeq.current++}`;
    setShots((prev) => [{ id, url, label, which }, ...prev]);
  }, []);

  // Capture a pane into the in-session Gallery (and download it). `which` keys
  // the pane element; defaults to the axial pane (preserves prior behaviour).
  const capturePane = useCallback((which = 'axial') => {
    const refs = { axial: axialRef, coronal: coronalRef, sagittal: sagittalRef, vol3d: vol3dRef };
    const ref = refs[which] || axialRef;
    const canvas = ref.current?.querySelector('canvas');
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const label = `${fileName}_${which}`;
    addShot(url, label, which);
    const link = document.createElement('a');
    link.download = `${label}.png`;
    link.href = url;
    link.click();
  }, [fileName, addShot]);

  // Compare's overlay capture: into the gallery, no auto-download.
  const captureFromCompare = useCallback((url, label) => {
    addShot(url, `${fileName}_${label}`, 'compare');
  }, [fileName, addShot]);

  const screenshot = useCallback(() => capturePane('axial'), [capturePane]);
  const removeShot = useCallback((id) => setShots((prev) => prev.filter((s) => s.id !== id)), []);

  // Accessors handed to CompareMode (it must never reach into this component's
  // engine — it builds its own rendering engine off the SAME cached volume).
  const getCurrentVolumeId = useCallback(() => volumeInfoRef.current?.volumeId || null, []);
  const getCurrentVolumeSafe = useCallback(() => {
    try { return getVolumeForSampling().vol; } catch (_) { return null; }
  }, [getVolumeForSampling]);

  // Clean up gallery object URLs on unmount (data URLs are GC'd, but guard).
  useEffect(() => () => {
    shots.forEach((s) => { try { if (s.url?.startsWith('blob:')) URL.revokeObjectURL(s.url); } catch (_) { /* ignore */ } });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeShort = TOOL_BY_ID[activeTool]?.short || activeTool;

  return (
    <div className="h-screen w-screen flex flex-col bg-neutral-950">
      {/* Slim top title strip — filename + active-binding hint */}
      <div className="flex items-center px-3 py-1.5 bg-neutral-900 border-b border-neutral-800">
        <span className="text-sm font-semibold text-amber-400 truncate max-w-[45%]">{fileName}</span>
        <div className="flex-1" />
        {archMsg && <span className="text-[11px] text-amber-300 mr-3 truncate max-w-[45%]">{archMsg}</span>}
        <span className="text-[11px] text-neutral-500 hidden lg:inline">
          {archMode
            ? 'Left-click to add points · Right-click to finish · Esc to cancel'
            : `Left: ${activeShort} · Right: Zoom · Wheel: Scroll`}
        </span>
      </div>

      {/* DentalX-style top view-mode tab bar */}
      <ViewModeTabs mode={viewMode} onChange={setViewMode} />

      {/* Persistent assistive-AI banner — pinned whenever an AI reading is
          present or the AI panel is open, across every view mode. */}
      {(aiOpen || aiResult) && <AiAssistBanner />}

      {/* Body: left tool rail + viewport grid */}
      <div className="flex-1 flex min-h-0">
        {/* DentalX-style vertical tool rail */}
        <aside className="w-[72px] shrink-0 bg-neutral-900 border-r border-neutral-800 overflow-y-auto flex flex-col pb-2">
          {TOOL_GROUPS.map(({ title, ids }) => (
            <RailSection key={title} title={title}>
              {ids.map((id) => {
                const tool = TOOL_BY_ID[id];
                if (!tool) return null;
                return (
                  <RailButton key={id} {...tool} active={!archMode && activeTool === id} onClick={() => selectTool(id)} />
                );
              })}
            </RailSection>
          ))}

          <RailSection title="Panoramic">
            <RailButton
              label="Auto OPG — detect the dental arch and reconstruct the panoramic in one click"
              short="Auto OPG"
              Icon={panoBusy ? Loader2 : Wand2}
              tone="text-amber-300"
              onClick={autoOpg}
            />
            <RailButton label="Trace dental arch (axial)" short="Arch" Icon={Spline} active={archMode} onClick={toggleArch} />
            <RailButton
              label="Reconstruct panoramic (OPG) along the traced arch"
              short="OPG"
              Icon={panoBusy ? Loader2 : GalleryHorizontal}
              tone="text-neutral-300"
              onClick={generateOpg}
            />
            {archMode && (
              <>
                <RailButton label="Save arch" short="Save" Icon={Save} tone="text-emerald-300" onClick={saveArch} />
                <RailButton label="Clear arch (axial)" short="Clear" Icon={Trash2} tone="text-red-300" onClick={clearArch} />
              </>
            )}
          </RailSection>

          <RailSection title="AI">
            <RailButton
              label="AI Read — assistive CBCT reading (findings must be verified by the treating clinician)"
              short="AI Read"
              Icon={aiBusy ? Loader2 : Sparkles}
              tone="text-amber-300"
              active={aiOpen}
              onClick={toggleAiPanel}
            />
            <RailButton
              label="Radiology report — draft or finalize the report for this study (seeds from the reviewed AI read)"
              short="Report"
              Icon={FileText}
              tone="text-emerald-300"
              active={!!reportCtx}
              onClick={openReport}
            />
          </RailSection>

          <RailSection title="View">
            <RailButton label="Reset views" short="Reset" Icon={RotateCcw} onClick={resetViews} />
            <RailButton label="Screenshot (axial)" short="Capture" Icon={Camera} onClick={screenshot} />
          </RailSection>

          {onClose && (
            <>
              <div className="flex-1" />
              <RailSection title="">
                <RailButton label="Close viewer" short="Close" Icon={X} onClick={onClose} />
              </RailSection>
            </>
          )}
        </aside>

        {/* Mode stage. The MPR grid stays MOUNTED across every mode (toggled
            with CSS visibility) so cornerstone's WebGL canvases never detach —
            switching tabs must not re-trigger the flash-then-black bug. Other
            modes render as overlays above the (hidden) grid. */}
        <div className="flex-1 relative min-h-0 min-w-0">
          {/* MPR — the 2x2 grid + optional pano strip. We hide it with
              `invisible` (visibility:hidden), NOT `display:none`: visibility
              keeps the grid LAID OUT, so the cornerstone canvases keep a real
              box (clientWidth/Height > 0). display:none would collapse them to
              0×0 and cornerstone v4's renderer silently bails below its minimum
              size, so the panes would never repaint on return. Even with
              visibility:hidden cornerstone won't auto-repaint on a visibility
              change, so the show/hide effect below resizes + re-renders (and
              restores camera/VOI) once the grid is visible again — that is the
              actual fix for the black-after-Compare regression. */}
          <div
            className={`absolute inset-0 flex flex-col min-h-0 min-w-0 ${
              viewMode === 'mpr' ? '' : 'invisible pointer-events-none'
            }`}
          >
            <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-px bg-neutral-800 min-h-0">
              <Pane label="AXIAL" color="rgb(240,180,60)" paneRef={axialRef} />
              <Pane label="CORONAL" color="rgb(120,200,120)" paneRef={coronalRef} />
              <Pane label="SAGITTAL" color="rgb(120,160,240)" paneRef={sagittalRef} />
              <Pane label="3D" color="rgb(220,220,220)" paneRef={vol3dRef} />
            </div>

            {/* Panoramic (OPG) strip — shown inline under the MPR grid too. */}
            {panoUrl && viewMode === 'mpr' && (
              <div className="relative h-44 shrink-0 bg-black border-t border-neutral-700">
                <img src={panoUrl} alt="Panoramic (OPG) reconstruction" className="h-full w-full object-contain" />
                <span className="absolute top-1.5 left-2 text-[11px] font-semibold tracking-wide text-amber-400">
                  PANORAMIC (OPG)
                </span>
                <div className="absolute top-1.5 right-2 flex gap-1">
                  <button type="button" title="Open in 3D Pano" onClick={() => setViewMode('pano')}
                    className="px-2 py-1 rounded bg-neutral-900/80 text-[11px] text-amber-300 hover:bg-neutral-700">Open Pano view</button>
                  <a href={panoUrl} download={`${fileName}_OPG.png`} title="Download panoramic"
                    className="p-1.5 rounded bg-neutral-900/80 text-neutral-300 hover:bg-neutral-700"><Download className="h-4 w-4" /></a>
                  <button type="button" title="Close panoramic strip" onClick={() => setPanoUrl(null)}
                    className="p-1.5 rounded bg-neutral-900/80 text-neutral-300 hover:bg-neutral-700"><X className="h-4 w-4" /></button>
                </div>
              </div>
            )}
          </div>

          {/* 3D PANO — panoramic strip + perpendicular cross-sections. */}
          {viewMode === 'pano' && (
            <div className="absolute inset-0 flex flex-col bg-neutral-950 overflow-auto">
              {panoUrl ? (
                <>
                  <div className="relative shrink-0 bg-black border-b border-neutral-800" style={{ height: '46%' }}>
                    <img src={panoUrl} alt="Panoramic (OPG)" className="h-full w-full object-contain" />
                    <span className="absolute top-2 left-3 text-xs font-semibold tracking-wide text-amber-400">PANORAMIC (OPG)</span>
                    <a href={panoUrl} download={`${fileName}_OPG.png`} title="Download"
                      className="absolute top-2 right-3 p-1.5 rounded bg-neutral-900/80 text-neutral-300 hover:bg-neutral-700"><Download className="h-4 w-4" /></a>
                  </div>
                  <div className="flex-1 min-h-0 p-3">
                    <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">
                      Cross-sections (perpendicular to the arch)
                    </div>
                    {crossSections && crossSections.length ? (
                      <div className="flex gap-2 overflow-x-auto pb-2">
                        {crossSections.map((cs) => (
                          <figure key={cs.id} className="shrink-0 bg-black rounded border border-neutral-800 overflow-hidden">
                            <img src={cs.url} alt={`Cross-section ${cs.id + 1}`} className="h-40 w-auto object-contain bg-black" />
                            <figcaption className="text-[10px] text-neutral-400 text-center py-0.5">#{cs.id + 1}</figcaption>
                          </figure>
                        ))}
                      </div>
                    ) : (
                      <p className="text-neutral-500 text-sm">Cross-sections unavailable for this reconstruction.</p>
                    )}
                  </div>
                </>
              ) : (
                <EmptyState
                  Icon={GalleryHorizontal}
                  title={panoBusy ? 'Reconstructing panoramic…' : 'No panoramic yet'}
                  body={panoBusy ? 'Sampling the curved MPR along the arch.' : 'Use “Auto OPG” on the left rail to detect the arch and build the panoramic in one click, or trace the arch and press OPG.'}
                />
              )}
              {!panoUrl && !panoBusy && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
                  <button type="button" onClick={autoOpg}
                    className="px-4 py-2 rounded-full bg-amber-500 text-black text-sm font-semibold inline-flex items-center gap-2 shadow-lg hover:bg-amber-400">
                    <Wand2 className="h-4 w-4" /> Auto OPG
                  </button>
                </div>
              )}
            </div>
          )}

          {/* GALLERY — captures from this session. */}
          {viewMode === 'gallery' && (
            <div className="absolute inset-0">
              <GalleryPanel shots={shots} onRemove={removeShot} />
            </div>
          )}

          {/* COMPARE — real cross-study compare: CBCT↔CBCT side-by-side with
              patient-space sync, CBCT↔mesh side-by-side with linked
              orientation presets, and the CBCT+mesh Overlay (registration). */}
          {viewMode === 'compare' && (
            <div className="absolute inset-0 bg-neutral-950">
              <React.Suspense
                fallback={
                  <div className="h-full w-full flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
                  </div>
                }
              >
                <CompareMode
                  csRef={csRef}
                  studyId={studyId}
                  getCurrentVolumeId={getCurrentVolumeId}
                  getCurrentVolume={getCurrentVolumeSafe}
                  currentLabel={fileName}
                  selectedId={compareStudyId}
                  onSelect={setCompareStudyId}
                  onCapture={captureFromCompare}
                />
              </React.Suspense>
            </div>
          )}

          {/* TMJ — dual-condyle oblique views + joint-space measures. Builds off
              the SAME cached volume (never touches the MPR engine), lazy like
              Compare. */}
          {viewMode === 'tmj' && (
            <div className="absolute inset-0 bg-neutral-950">
              <React.Suspense
                fallback={
                  <div className="h-full w-full flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
                  </div>
                }
              >
                <TmjMode
                  studyId={studyId}
                  getCurrentVolume={getCurrentVolumeSafe}
                  fileName={fileName}
                  onCapture={captureFromCompare}
                />
              </React.Suspense>
            </div>
          )}

          {/* CEPHALOMETRIC — synthetic lateral ceph + manual landmark tracing +
              standard (Steiner/Tweed) analysis. Lazy, like Compare. */}
          {viewMode === 'ceph' && (
            <div className="absolute inset-0 bg-neutral-950">
              <React.Suspense
                fallback={
                  <div className="h-full w-full flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
                  </div>
                }
              >
                <CephMode
                  studyId={studyId}
                  getCurrentVolume={getCurrentVolumeSafe}
                  fileName={fileName}
                  onCapture={captureFromCompare}
                />
              </React.Suspense>
            </div>
          )}

          {/* IMPLANT — planning mode: interactive cross-section browser along
              the arch, mm measurements, mandibular-canal marking with safety
              margin, and virtual implant placement (persisted in
              viewer_annotations.implant_plans). Wired exactly like Compare. */}
          {viewMode === 'implant' && (
            <div className="absolute inset-0 bg-neutral-950">
              <React.Suspense
                fallback={
                  <div className="h-full w-full flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
                  </div>
                }
              >
                <ImplantMode
                  studyId={studyId}
                  fileName={fileName}
                  getCurrentVolume={getCurrentVolumeSafe}
                  getArchControlPoints={getArchControlPoints}
                  onCapture={captureFromCompare}
                />
              </React.Suspense>
            </div>
          )}

          {/* AI view lightbox — the rendered input view a finding references. */}
          {aiViewShown && <AiViewLightbox view={aiViewShown} onClose={() => setAiViewShown(null)} />}

          {/* Radiology report dialog — same imaging_reports flow as the
              worklist, opened in-viewer so read → review → report is one
              screen. Renders its own fixed overlay. */}
          {reportCtx && (
            <React.Suspense fallback={null}>
              <ImagingReportDialog
                study={reportCtx.study}
                clinicId={reportCtx.clinicId}
                userId={reportCtx.userId}
                onClose={() => setReportCtx(null)}
                onSaved={() => setReportCtx(null)}
              />
            </React.Suspense>
          )}
        </div>

        {/* AI findings panel — docked right; rendered on the MPR AND 3D Pano
            tabs. Manual Run/Re-run only (no auto-run in Phase 1); findings are
            assistive and never written to the chart from here. */}
        {aiOpen && (viewMode === 'mpr' || viewMode === 'pano') && (
          <aside className="w-80 shrink-0 min-h-0">
            <AiFindingsPanel
              result={aiResult}
              busy={aiBusy}
              busyNote={aiNote}
              error={aiError}
              costNote={tokenCostNote(aiTokens, 'cbct_ai_read')}
              onRun={runAiRead}
              onClose={() => setAiOpen(false)}
              onShowView={showAiView}
              review={aiReview}
              onDecide={decideAiFinding}
              onDecisionNote={noteAiFinding}
              onAddFinding={addAiFinding}
              onRemoveAdded={removeAiAddedFinding}
              onImpression={setAiImpression}
              onSaveReview={saveAiReview}
              reviewSaving={aiReviewSaving}
              reviewMsg={aiReviewMsg}
            />
          </aside>
        )}
      </div>

      {/* Loading / error overlays */}
      {loading && (
        <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-50">
          <Loader2 className="h-10 w-10 animate-spin text-amber-500 mb-3" />
          <p className="text-white">Reconstructing CBCT volume… {progress}%</p>
          <p className="text-neutral-400 text-xs mt-1">{imageIds.length} slices</p>
          {loadNote && <p className="text-amber-300 text-xs mt-2 max-w-sm text-center px-4">{loadNote}</p>}
        </div>
      )}
      {error && (
        <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center z-50 px-6 text-center">
          <AlertTriangle className="h-10 w-10 text-red-400 mb-3" />
          <p className="text-white mb-1">Failed to load CBCT</p>
          <p className="text-neutral-400 text-sm mb-4 max-w-md">{error}</p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setError(null); setSetupSeq((s) => s + 1); }}
              className="px-4 py-2 rounded-md bg-amber-500 text-black text-sm inline-flex items-center gap-1.5"
            >
              <RotateCcw className="h-4 w-4" /> Retry
            </button>
            {onClose && <button onClick={onClose} className="px-4 py-2 rounded-md bg-neutral-700 text-white text-sm">Close</button>}
          </div>
        </div>
      )}
    </div>
  );
}
