/*
 * CBCTViewerPage — true 3D CBCT viewer with MPR + volume rendering.
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
 * Each MPR view shows a single slice through the volume in its respective
 * plane; the user scrolls through slices independently per view. The 3D
 * panel renders the whole volume with a bone-preset transfer function by
 * default (the typical CBCT default).
 *
 * Foundation for future B.3.4 features: synchronized crosshairs, panoramic
 * reconstruction, MIP / SSD / iso-surface, implant planning, measurements.
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
];

const VIEWPORTS = [
  { id: 'CBCT_AXIAL',    label: 'Axial',     orientationKey: 'AXIAL'    },
  { id: 'CBCT_CORONAL',  label: 'Coronal',   orientationKey: 'CORONAL'  },
  { id: 'CBCT_SAGITTAL', label: 'Sagittal',  orientationKey: 'SAGITTAL' },
  { id: 'CBCT_3D',       label: '3D',        orientationKey: 'CORONAL'  }, // initial cam orientation
];

export default function CBCTViewerPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const studyId = searchParams.get('study');

  const [stage, setStage] = useState('init'); // init | resolving | loading-volume | ready | error
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(0); // 0..100, fraction of volume slices loaded

  const axialRef    = useRef(null);
  const coronalRef  = useRef(null);
  const sagittalRef = useRef(null);
  const vrRef       = useRef(null);
  const enginRef    = useRef(null);

  // Resolve URLs + initialise Cornerstone + load volume into 4 viewports.
  useEffect(() => {
    document.title = 'CBCT Viewer · aiHealth Imaging';
    let cancelled = false;

    (async () => {
      try {
        if (!studyId) {
          throw new Error('Missing ?study=<imaging_studies.id> URL parameter.');
        }
        // Auth gate
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
            `Volume rendering needs at least 3 instances; got ${list.length}. ` +
            `Use /viewer/dicom?study=${studyId} for 2D viewing.`
          );
        }

        await initCornerstone();
        if (cancelled) return;

        const imageIds = list.map((f) => imageIdFromSignedUrl(f.url));
        const volumeId = `cornerstoneStreamingImageVolume:study-${studyId}`;

        // Create + cache the volume. Slices are streamed in the background;
        // the first viewport draw shows whatever has loaded, then refreshes
        // as more slices arrive.
        const volume = await cornerstone.volumeLoader.createAndCacheVolume(volumeId, { imageIds });
        if (cancelled) return;

        setStage('loading-volume');

        // Build viewports
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

        // Start streaming slices. The viewport refreshes as data arrives.
        volume.load((evt) => {
          if (cancelled) return;
          // Cornerstone fires a percentage roughly per-slice
          if (typeof evt?.framesProcessed === 'number' && typeof evt?.totalNumFrames === 'number') {
            setProgress(Math.round((evt.framesProcessed / evt.totalNumFrames) * 100));
          }
        });

        // Bind the volume to all 4 viewports
        await cornerstone.setVolumesForViewports(
          engine,
          [{ volumeId }],
          VIEWPORTS.map((v) => v.id),
        );

        // Apply a default bone-window VOI to the MPR viewports (CBCT looks
        // like garbage with the file's default WL; bone-window is what
        // dental clinicians expect on first frame).
        const mprIds = ['CBCT_AXIAL', 'CBCT_CORONAL', 'CBCT_SAGITTAL'];
        for (const id of mprIds) {
          const vp = engine.getViewport(id);
          vp.setProperties({ voiRange: { lower: 400 - 2000 / 2, upper: 400 + 2000 / 2 } });
        }

        // Apply CT-Bone preset to the 3D volume render so the user sees
        // teeth + bone immediately rather than a black box.
        try {
          const vp3d = engine.getViewport('CBCT_3D');
          if (vp3d && cornerstoneTools.utilities?.viewport?.applyPreset) {
            cornerstoneTools.utilities.viewport.applyPreset(vp3d, 'CT-Bone');
          }
        } catch (presetErr) {
          console.warn('[cbct] preset apply failed:', presetErr?.message);
        }

        // Tool group for MPR — left-drag = pan, right-drag = W/L,
        // wheel = stack scroll within the plane
        try {
          cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_MPR_ID);
        } catch (e) { /* ignore — first time through */ }
        const mprGroup = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_MPR_ID);
        const Tools = [
          cornerstoneTools.WindowLevelTool,
          cornerstoneTools.PanTool,
          cornerstoneTools.ZoomTool,
          cornerstoneTools.StackScrollMouseWheelTool,
        ];
        for (const T of Tools) cornerstoneTools.addTool(T);
        mprGroup.addTool(cornerstoneTools.WindowLevelTool.toolName);
        mprGroup.addTool(cornerstoneTools.PanTool.toolName);
        mprGroup.addTool(cornerstoneTools.ZoomTool.toolName);
        mprGroup.addTool(cornerstoneTools.StackScrollMouseWheelTool.toolName);
        mprGroup.setToolActive(cornerstoneTools.WindowLevelTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
        });
        mprGroup.setToolActive(cornerstoneTools.ZoomTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });
        mprGroup.setToolActive(cornerstoneTools.PanTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }],
        });
        mprGroup.setToolActive(cornerstoneTools.StackScrollMouseWheelTool.toolName);
        for (const id of mprIds) mprGroup.addViewport(id, RENDERING_ENGINE_ID);

        // Tool group for 3D — left-drag = trackball rotate (default volume tool)
        try {
          cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_3D_ID);
        } catch (e) { /* ignore */ }
        const vrGroup = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_3D_ID);
        try {
          cornerstoneTools.addTool(cornerstoneTools.TrackballRotateTool);
        } catch (e) { /* already added */ }
        vrGroup.addTool(cornerstoneTools.TrackballRotateTool.toolName);
        vrGroup.setToolActive(cornerstoneTools.TrackballRotateTool.toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
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

  const applyPreset = ({ wc, ww }) => {
    const engine = enginRef.current;
    if (!engine) return;
    for (const id of ['CBCT_AXIAL', 'CBCT_CORONAL', 'CBCT_SAGITTAL']) {
      const vp = engine.getViewport(id);
      vp.setProperties({ voiRange: { lower: wc - ww / 2, upper: wc + ww / 2 } });
    }
    engine.render();
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
        <div className="text-[11px] text-gray-500">Powered by Cornerstone3D</div>
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
                <div className="absolute top-2 left-2 text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded pointer-events-none"
                     style={{ backgroundColor: 'rgba(11,13,16,0.6)', color: idx === 3 ? '#f59e0b' : '#cdd2d8' }}>
                  {v.label}
                </div>
              </div>
            );
          })}
        </div>

        {/* Right rail with presets */}
        {stage === 'ready' && (
          <div
            className="absolute right-3 top-3 w-48 rounded-lg p-3 z-10 text-xs"
            style={{ backgroundColor: PANEL_BG, border: '1px solid #1d2128' }}
          >
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">MPR Window</div>
            <div className="grid grid-cols-2 gap-1 mb-3">
              {VOLUME_PRESETS.map((p) => (
                <button
                  key={p.name}
                  onClick={() => applyPreset(p)}
                  className="text-[11px] py-1.5 rounded bg-gray-800 hover:bg-gray-700"
                >
                  {p.name}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-500 leading-snug">
              Each MPR panel: <span className="text-gray-300">left-drag zoom · right-drag W/L · wheel scroll · middle pan</span>.
              <br />
              3D panel: <span className="text-gray-300">left-drag rotate</span>.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
