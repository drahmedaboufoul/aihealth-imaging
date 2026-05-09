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
 */

import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { Loader2, AlertCircle, ArrowLeft, Box } from 'lucide-react';
import { resolveStudyDicomFiles } from '../lib/signedUrl';
import {
  initCornerstone,
  imageIdFromSignedUrl,
  cornerstone,
  cornerstoneTools,
} from '../lib/cornerstoneInit';
import { supabase } from '../lib/supabase';

const SHELL_BG = '#0b0d10';
const PANEL_BG = '#15181c';

const RENDERING_ENGINE_ID = 'aihCbctRenderingEngine';
const TOOL_GROUP_MPR_ID   = 'aihCbctMprToolGroup';
const TOOL_GROUP_3D_ID    = 'aihCbct3dToolGroup';

// Two preset tables — one for HU-scaled CT, one for raw 12-bit CBCT data
// (most cone-beam scanners ship without rescale slope/intercept). We pick
// which table to use based on the volume's actual data range after load.
const VOLUME_PRESETS_HU = [
  { name: 'Bone',        wc:  400, ww: 2000 },
  { name: 'Soft Tissue', wc:   40, ww:  400 },
  { name: 'Lung',        wc: -600, ww: 1500 },
  { name: 'Brain',       wc:   40, ww:   80 },
  { name: 'Air',         wc: -400, ww: 1000 },
];
// Raw-pixel presets are computed from the volume's [min, max] range — see
// rawPresets() in the body. The names mirror the HU presets so the UI is
// consistent regardless of the underlying scale.
const PRESET_NAMES = ['Bone', 'Soft Tissue', 'Lung', 'Brain', 'Air'];

const VIEWPORTS = [
  { id: 'CBCT_AXIAL',    label: 'Axial',     orientationKey: 'AXIAL',    color: '#10b981' },
  { id: 'CBCT_CORONAL',  label: 'Coronal',   orientationKey: 'CORONAL',  color: '#3b82f6' },
  { id: 'CBCT_SAGITTAL', label: 'Sagittal',  orientationKey: 'SAGITTAL', color: '#f59e0b' },
  { id: 'CBCT_3D',       label: '3D',        orientationKey: 'CORONAL',  color: '#ef4444' },
];

// MPR viewport IDs in render order — used by the crosshairs tool to know
// which viewports are MPR (so it doesn't try to draw crosshairs on the 3D
// panel).
const MPR_VIEWPORT_IDS = ['CBCT_AXIAL', 'CBCT_CORONAL', 'CBCT_SAGITTAL'];

/**
 * Read the volume's actual scalar data range. Used to detect HU vs raw
 * pixel scaling and to compute auto-W/L. Samples sparsely so we don't
 * iterate 100M+ voxels on a typical CBCT.
 */
function readVolumeDataRange(volume) {
  let scalarData = null;
  try {
    if (typeof volume?.getScalarData === 'function') {
      scalarData = volume.getScalarData();
    } else if (volume?.imageData?.getPointData) {
      scalarData = volume.imageData.getPointData().getScalars().getData();
    } else if (volume?.scalarData) {
      scalarData = volume.scalarData;
    }
  } catch {}
  if (!scalarData?.length) return null;
  const SAMPLES = 100000;
  const step = Math.max(1, Math.floor(scalarData.length / SAMPLES));
  let min = Infinity;
  let max = -Infinity;
  const samples = [];
  for (let i = 0; i < scalarData.length; i += step) {
    const v = scalarData[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (v !== 0) samples.push(v); // skip background for percentile calc
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  // Percentile-based bounds for window auto-fit (1st / 99th)
  let p1 = min;
  let p99 = max;
  if (samples.length > 100) {
    samples.sort((a, b) => a - b);
    p1  = samples[Math.floor(samples.length * 0.01)];
    p99 = samples[Math.floor(samples.length * 0.99)];
  }
  return { min, max, p1, p99 };
}

/**
 * Build presets for a raw-pixel volume (no modality LUT). We anchor "Bone"
 * to the upper part of the data range and "Soft Tissue" to the middle, so
 * the user gets a sensible default view regardless of the scanner's
 * arbitrary scale.
 */
function rawPresetsForRange(range) {
  if (!range) return VOLUME_PRESETS_HU;
  const lo  = range.p1;
  const hi  = range.p99;
  const mid = (lo + hi) / 2;
  const span = Math.max(1, hi - lo);
  return [
    // Bone — upper-half emphasis
    { name: 'Bone',        wc: lo + span * 0.65, ww: span * 0.55 },
    // Soft tissue — center, narrower window
    { name: 'Soft Tissue', wc: mid,              ww: span * 0.40 },
    // Lung-equivalent — lower bias, wide
    { name: 'Lung',        wc: lo + span * 0.30, ww: span * 0.80 },
    // Brain-equivalent — narrow, near-center
    { name: 'Brain',       wc: mid,              ww: span * 0.18 },
    // Air — low end
    { name: 'Air',         wc: lo + span * 0.20, ww: span * 0.50 },
  ];
}

export default function CBCTViewerPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const studyId = searchParams.get('study');

  const [stage, setStage] = useState('init'); // init | resolving | loading-volume | ready | error
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(0);
  const [activePreset, setActivePreset] = useState('Bone');
  const [presetTable, setPresetTable] = useState(VOLUME_PRESETS_HU);

  const axialRef    = useRef(null);
  const coronalRef  = useRef(null);
  const sagittalRef = useRef(null);
  const vrRef       = useRef(null);
  const enginRef    = useRef(null);

  useEffect(() => {
    document.title = 'CBCT Viewer · aiHealth Imaging';
    let cancelled = false;

    (async () => {
      try {
        if (!studyId) {
          throw new Error('Missing ?study=<imaging_studies.id> URL parameter.');
        }
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          const back = encodeURIComponent(location.pathname + location.search);
          navigate(`/login?next=${back}`, { replace: true });
          return;
        }
        if (cancelled) return;

        setStage('resolving');
        const list = await resolveStudyDicomFiles(studyId);
        if (cancelled) return;
        if (list.length < 3) {
          throw new Error(
            `Volume rendering needs at least 3 DICOM instances; got ${list.length}.`
          );
        }

        await initCornerstone();
        if (cancelled) return;

        const imageIds = list.map((f) => imageIdFromSignedUrl(f.url));
        const volumeId = `cornerstoneStreamingImageVolume:study-${studyId}`;

        setStage('loading-volume');

        // Pre-load every instance so the metadata providers are populated
        // BEFORE we ask the volume loader to sort by ImagePositionPatient.
        // Without this, the streaming volume loader creates a volume with
        // slices in arbitrary order — axial looks fine (just shows one
        // slice) but coronal + sagittal sample across mis-ordered Z and
        // produce diagonal-stripe garbage. Pre-loading takes ~10-30s for
        // a 400-slice CBCT but is mandatory for correct MPR geometry.
        let loaded = 0;
        await Promise.all(imageIds.map(async (id) => {
          try {
            await cornerstone.imageLoader.loadAndCacheImage(id);
          } catch (e) {
            console.warn('[cbct] image preload failed for', id, e?.message);
          } finally {
            loaded += 1;
            // Throttle progress updates so React isn't crushed by 400 setStates
            if (loaded % 5 === 0 || loaded === imageIds.length) {
              setProgress(Math.round((loaded / imageIds.length) * 100));
            }
          }
        }));
        if (cancelled) return;

        // Sort by image position. Cornerstone's helper reads the now-cached
        // metadata and returns the correct slice order + spacing.
        let sortedImageIds = imageIds;
        try {
          const result = cornerstone.utilities.sortImageIdsAndGetSpacing
            ? cornerstone.utilities.sortImageIdsAndGetSpacing(imageIds)
            : { sortedImageIds: imageIds };
          if (Array.isArray(result?.sortedImageIds) && result.sortedImageIds.length > 0) {
            sortedImageIds = result.sortedImageIds;
          } else if (Array.isArray(result)) {
            sortedImageIds = result;
          }
        } catch (sortErr) {
          console.warn('[cbct] sortImageIdsAndGetSpacing failed:', sortErr?.message);
        }

        // Now build the volume from sorted IDs.
        const volume = await cornerstone.volumeLoader.createAndCacheVolume(volumeId, { imageIds: sortedImageIds });
        if (cancelled) return;

        // Build rendering engine + viewports
        let engine = cornerstone.getRenderingEngine(RENDERING_ENGINE_ID);
        if (!engine) engine = new cornerstone.RenderingEngine(RENDERING_ENGINE_ID);
        enginRef.current = engine;

        const Enums = cornerstone.Enums;
        const elements = {
          CBCT_AXIAL:    axialRef.current,
          CBCT_CORONAL:  coronalRef.current,
          CBCT_SAGITTAL: sagittalRef.current,
          CBCT_3D:       vrRef.current,
        };

        const viewportInputs = VIEWPORTS.map((v) => ({
          viewportId: v.id,
          element: elements[v.id],
          type: v.id === 'CBCT_3D' ? Enums.ViewportType.VOLUME_3D : Enums.ViewportType.ORTHOGRAPHIC,
          defaultOptions: {
            orientation: Enums.OrientationAxis[v.orientationKey],
            background: [0, 0, 0],
          },
        }));
        engine.setViewports(viewportInputs);

        // Wait for the volume's voxel buffer to be fully populated before
        // we apply any properties or bind it to viewports. We attach the
        // listener BEFORE calling load(), because the pre-loaded images
        // mean load() can complete synchronously and we'd miss the event.
        const volumeLoadComplete = new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            try {
              cornerstone.eventTarget.removeEventListener(
                cornerstone.Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, handler
              );
            } catch {}
            resolve();
          };
          const handler = (e) => {
            const detail = e?.detail;
            const vid = detail?.volumeId || detail?.imageVolume?.volumeId;
            if (vid === volumeId) finish();
          };
          try {
            cornerstone.eventTarget.addEventListener(
              cornerstone.Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, handler
            );
          } catch {}
          // Hard timeout — we have all images cached so this should never fire,
          // but if cornerstone never emits the event we still want to render.
          setTimeout(finish, 8000);
        });
        const loadResult = volume.load();
        if (loadResult && typeof loadResult.then === 'function') {
          await loadResult;
        }
        await volumeLoadComplete;
        if (cancelled) return;

        // Inspect the volume's actual data range so we can pick the correct
        // window. CBCT scanners often skip the modality LUT, so pixel values
        // arrive as raw 12-bit (0–4095ish) rather than HU (-1000–3000). The
        // wrong default makes everything blow out white.
        const dataRange = readVolumeDataRange(volume);
        const isHU = dataRange ? (dataRange.min < -200) : true;
        const presets = isHU ? VOLUME_PRESETS_HU : rawPresetsForRange(dataRange);
        if (!cancelled) setPresetTable(presets);
        const defaultPreset = presets.find((p) => p.name === 'Bone') || presets[0];

        // Bind the volume to all 4 viewports
        await cornerstone.setVolumesForViewports(
          engine,
          [{ volumeId }],
          VIEWPORTS.map((v) => v.id),
        );

        // Apply Bone window to the three MPR viewports.
        for (const id of MPR_VIEWPORT_IDS) {
          const vp = engine.getViewport(id);
          if (!vp) continue;
          vp.setProperties({
            voiRange: {
              lower: defaultPreset.wc - defaultPreset.ww / 2,
              upper: defaultPreset.wc + defaultPreset.ww / 2,
            },
          });
        }

        // 3D viewport: VOLUME_3D needs a transfer-function preset, NOT a
        // voiRange — the latter has no effect on volume rendering. v4 ships
        // built-in CT-* presets we can name directly.
        try {
          const vp3d = engine.getViewport('CBCT_3D');
          if (vp3d?.setProperties) {
            vp3d.setProperties({ preset: isHU ? 'CT-Bone' : 'CT-AAA' });
          }
        } catch (presetErr) {
          console.warn('[cbct] 3D preset apply failed:', presetErr?.message);
        }

        // Tool groups — MPR + 3D ----------------------------------------------
        try { cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_MPR_ID); } catch {}
        try { cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_3D_ID);  } catch {}
        const mprGroup = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_MPR_ID);
        const vrGroup  = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_3D_ID);

        const mprTools = [
          cornerstoneTools.WindowLevelTool,
          cornerstoneTools.PanTool,
          cornerstoneTools.ZoomTool,
          cornerstoneTools.StackScrollTool,
          cornerstoneTools.CrosshairsTool,
        ];
        for (const T of mprTools) cornerstoneTools.addTool(T);
        try { cornerstoneTools.addTool(cornerstoneTools.TrackballRotateTool); } catch {}

        // Configure tools on the group
        mprGroup.addTool(cornerstoneTools.WindowLevelTool.toolName);
        mprGroup.addTool(cornerstoneTools.PanTool.toolName);
        mprGroup.addTool(cornerstoneTools.ZoomTool.toolName);
        mprGroup.addTool(cornerstoneTools.StackScrollTool.toolName);
        mprGroup.addTool(cornerstoneTools.CrosshairsTool.toolName, {
          getReferenceLineColor: (vid) => {
            const v = VIEWPORTS.find((x) => x.id === vid);
            return v?.color || '#f59e0b';
          },
          getReferenceLineControllable: () => true,
          getReferenceLineDraggableRotatable: () => true,
          getReferenceLineSlabThicknessControlsOn: () => false,
        });

        // CRITICAL: viewports must be added to the group BEFORE setToolActive
        // for CrosshairsTool — otherwise it warns "at least two viewports must
        // be given" and the cross-hairs never wire up across panels.
        for (const id of MPR_VIEWPORT_IDS) mprGroup.addViewport(id, RENDERING_ENGINE_ID);

        mprGroup.setToolActive(cornerstoneTools.CrosshairsTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });
        mprGroup.setToolActive(cornerstoneTools.WindowLevelTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
        });
        mprGroup.setToolActive(cornerstoneTools.PanTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }],
        });
        mprGroup.setToolActive(cornerstoneTools.StackScrollTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
        });

        // 3D bindings: trackball rotate on primary, zoom on wheel.
        vrGroup.addTool(cornerstoneTools.TrackballRotateTool.toolName);
        vrGroup.addTool(cornerstoneTools.ZoomTool.toolName);
        vrGroup.addViewport('CBCT_3D', RENDERING_ENGINE_ID);
        vrGroup.setToolActive(cornerstoneTools.TrackballRotateTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });
        vrGroup.setToolActive(cornerstoneTools.ZoomTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
        });

        engine.render();
        setStage('ready');
      } catch (err) {
        if (cancelled) return;
        console.error('[CBCT viewer] init failed:', err);
        setError(err?.message || String(err));
        setStage('error');
      }
    })();

    return () => { cancelled = true; };
  }, [studyId, navigate, location.pathname, location.search]);

  const applyPreset = (preset) => {
    const engine = enginRef.current;
    if (!engine) return;
    for (const id of MPR_VIEWPORT_IDS) {
      const vp = engine.getViewport(id);
      vp.setProperties({ voiRange: { lower: preset.wc - preset.ww / 2, upper: preset.wc + preset.ww / 2 } });
    }
    engine.render();
    setActivePreset(preset.name);
  };

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
        <div className="text-sm font-semibold tracking-wide flex items-center gap-2">
          <Box size={14} className="text-amber-500" />
          CBCT Viewer
          <span className="ml-2 text-[11px] text-gray-400 font-normal">MPR + 3D</span>
        </div>
        <div className="text-[11px] text-gray-500">Cornerstone3D v4 · synchronized crosshairs</div>
      </div>

      {/* 4-panel grid */}
      <div className="flex-1 relative">
        {(stage !== 'ready') && (
          <div className="absolute inset-0 flex items-center justify-center z-30" style={{ backgroundColor: 'rgba(11,13,16,0.95)' }}>
            {stage === 'error' ? (
              <div className="max-w-md text-center px-6">
                <AlertCircle size={28} className="mx-auto text-red-500 mb-3" />
                <h2 className="text-sm font-semibold text-white mb-2">Could not load CBCT</h2>
                <pre className="text-[11px] text-red-300 font-mono whitespace-pre-wrap break-words text-left px-3 py-2 rounded" style={{ backgroundColor: '#1a1d22' }}>
                  {error}
                </pre>
                <button
                  onClick={() => navigate(`/viewer/dicom?study=${studyId}`, { replace: true })}
                  className="mt-3 text-[11px] px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-white"
                >
                  Open as 2D stack instead
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Loader2 size={28} className="animate-spin text-amber-500" />
                <p className="text-xs text-gray-400">
                  {stage === 'resolving' && 'Resolving CBCT instances…'}
                  {stage === 'loading-volume' && (progress > 0 ? `Loading volume (${progress}%)…` : 'Streaming volume…')}
                  {stage === 'init' && 'Initialising…'}
                </p>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 grid-rows-2 gap-px h-full" style={{ backgroundColor: '#1d2128' }}>
          {VIEWPORTS.map((v, idx) => {
            const ref = idx === 0 ? axialRef : idx === 1 ? coronalRef : idx === 2 ? sagittalRef : vrRef;
            return (
              <div key={v.id} className="relative" style={{ backgroundColor: SHELL_BG }}>
                <div
                  ref={ref}
                  className="w-full h-full"
                  onContextMenu={(e) => e.preventDefault()}
                />
                <div
                  className="absolute top-2 left-2 text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded pointer-events-none"
                  style={{
                    backgroundColor: 'rgba(11,13,16,0.6)',
                    color: v.color,
                    borderLeft: `2px solid ${v.color}`,
                  }}
                >
                  {v.label}
                </div>
              </div>
            );
          })}
        </div>

        {/* Right rail with presets */}
        {stage === 'ready' && (
          <div
            className="absolute right-3 top-3 w-52 rounded-lg p-3 z-10 text-xs"
            style={{ backgroundColor: PANEL_BG, border: '1px solid #1d2128' }}
          >
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">MPR Window</div>
            <div className="grid grid-cols-2 gap-1 mb-3">
              {presetTable.map((p) => (
                <button
                  key={p.name}
                  onClick={() => applyPreset(p)}
                  className={`text-[11px] py-1.5 rounded ${activePreset === p.name ? 'bg-amber-600 text-white' : 'bg-gray-800 hover:bg-gray-700'}`}
                >
                  {p.name}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-500 leading-snug">
              <span className="text-gray-300 font-semibold">MPR:</span> drag a crosshair to re-slice all three planes.
              Right-drag = W/L · middle-drag = pan · wheel = scroll.
              <br />
              <span className="text-gray-300 font-semibold">3D:</span> left-drag = rotate · wheel = zoom.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
