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

const VOLUME_PRESETS = [
  { name: 'Bone',        wc:  400, ww: 2000 },
  { name: 'Soft Tissue', wc:   40, ww:  400 },
  { name: 'Lung',        wc: -600, ww: 1500 },
  { name: 'Brain',       wc:   40, ww:   80 },
  { name: 'Air',         wc: -400, ww: 1000 },
];

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

export default function CBCTViewerPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const studyId = searchParams.get('study');

  const [stage, setStage] = useState('init'); // init | resolving | loading-volume | ready | error
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(0);
  const [activePreset, setActivePreset] = useState('Bone');

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

        // Pixels are already cached from the pre-load above; calling load()
        // populates the volume's voxel buffer from those cached images. Fast.
        volume.load();

        // Bind the volume to all 4 viewports
        await cornerstone.setVolumesForViewports(
          engine,
          [{ volumeId }],
          VIEWPORTS.map((v) => v.id),
        );

        // Default bone window on MPR (CBCT looks like noise without it)
        for (const id of MPR_VIEWPORT_IDS) {
          const vp = engine.getViewport(id);
          vp.setProperties({ voiRange: { lower: 400 - 2000 / 2, upper: 400 + 2000 / 2 } });
        }

        // Default CT-Bone preset on the 3D volume render
        try {
          const vp3d = engine.getViewport('CBCT_3D');
          if (vp3d && cornerstoneTools.utilities?.voi?.applyPreset) {
            cornerstoneTools.utilities.voi.applyPreset(vp3d, 'CT-Bone');
          } else if (vp3d?.setProperties) {
            // Fallback: at minimum set a reasonable VOI range so the user
            // sees something rather than a black box.
            vp3d.setProperties({ voiRange: { lower: -600, upper: 1400 } });
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

        // MPR bindings:
        //   left-click on crosshair handle  -> CrosshairsTool (snaps cross-hairs across all 3)
        //   right-click drag                 -> Window/Level
        //   middle-click drag                -> Pan
        //   wheel                            -> StackScroll within plane
        //   The CrosshairsTool also handles its own "show reference lines"
        //   so each panel labels which planes are crossing it.
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
        for (const id of MPR_VIEWPORT_IDS) mprGroup.addViewport(id, RENDERING_ENGINE_ID);

        // 3D bindings: trackball rotate on primary, zoom on wheel.
        vrGroup.addTool(cornerstoneTools.TrackballRotateTool.toolName);
        vrGroup.addTool(cornerstoneTools.ZoomTool.toolName);
        vrGroup.setToolActive(cornerstoneTools.TrackballRotateTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });
        vrGroup.setToolActive(cornerstoneTools.ZoomTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
        });
        vrGroup.addViewport('CBCT_3D', RENDERING_ENGINE_ID);

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
              {VOLUME_PRESETS.map((p) => (
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
