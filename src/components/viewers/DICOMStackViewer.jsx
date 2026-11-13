/*
 * DICOMStackViewer — real cornerstone3D 2D stack viewer. Renders one or more
 * DICOM instances as a windowed, scrollable image stack (panoramic, periapical,
 * bitewing, or any single .dcm). For a multi-slice series it also works as a
 * plain slice scroller.
 *
 * Props:
 *   imageIds : string[]  — `wadouri:<signed-url>`
 *   fileName : string
 *   onClose  : () => void
 *
 * Browser-only (WebGL + workers); cannot be validated headlessly.
 */
import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Loader2, X, Contrast, Move, ZoomIn, Ruler, Camera, RotateCcw, AlertTriangle } from 'lucide-react';
import { ensureCornerstone } from '@/lib/cornerstoneInit';

const ENGINE_ID = 'dicomStackEngine';
const VIEWPORT_ID = 'dicomStackViewport';
const TOOLGROUP_ID = 'dicomStackToolGroup';

const TOOLBAR = [
  { id: 'WindowLevel', label: 'Window/Level', Icon: Contrast },
  { id: 'Zoom', label: 'Zoom', Icon: ZoomIn },
  { id: 'Pan', label: 'Pan', Icon: Move },
  { id: 'Length', label: 'Measure', Icon: Ruler },
];

export default function DICOMStackViewer({ imageIds = [], fileName = 'DICOM', onClose }) {
  const elRef = useRef(null);
  const engineRef = useRef(null);
  const csRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTool, setActiveTool] = useState('WindowLevel');
  const [sliceInfo, setSliceInfo] = useState(null);
  const [diag, setDiag] = useState('');

  useEffect(() => {
    let mounted = true;

    async function setup() {
      try {
        setLoading(true);
        setError(null);
        if (!imageIds || imageIds.length === 0) throw new Error('No DICOM images');

        const cs = await ensureCornerstone();
        if (!mounted) return;
        csRef.current = cs;
        const { core, tools } = cs;
        const { RenderingEngine, Enums } = core;

        const renderingEngine = new RenderingEngine(ENGINE_ID);
        engineRef.current = renderingEngine;
        renderingEngine.enableElement({ viewportId: VIEWPORT_ID, type: Enums.ViewportType.STACK, element: elRef.current });

        const viewport = renderingEngine.getViewport(VIEWPORT_ID);
        await viewport.setStack(imageIds, Math.floor(imageIds.length / 2));
        viewport.render();
        if (imageIds.length > 1) setSliceInfo({ index: Math.floor(imageIds.length / 2) + 1, total: imageIds.length });

        // Auto-window from the actual pixel range. CBCT/dental DICOM often lacks
        // usable window-center/width, so the default VOI renders the slice black.
        // Also surfaces an on-screen diagnostic (frame count + pixel range) so a
        // black screen is debuggable on a phone where there's no dev console:
        //   "… px LO–HI"        → pixels decoded fine; this is/was a windowing issue
        //   "… NO PIXELS"       → frames didn't decode/fetch (different problem)
        const applyAutoWindow = () => {
          try {
            const curId = (typeof viewport.getCurrentImageId === 'function' && viewport.getCurrentImageId())
              || imageIds[Math.floor(imageIds.length / 2)];
            const img = core.cache?.getImage?.(curId);
            if (!img) return false;
            const px = img.getPixelData?.();
            if (!px || !px.length) { if (mounted) setDiag(`${imageIds.length}f · NO PIXELS (decode failed?)`); return false; }
            // Window from the ACTUAL data distribution, not the declared range.
            // Declared min/max (often 0..65535 for 16-bit) gives a posterised
            // black/white image; the 1st–99th percentile of the real values gives
            // proper grayscale contrast. The user can still fine-tune with W/L.
            const stride = Math.max(1, Math.floor(px.length / 200000));
            const sample = [];
            for (let i = 0; i < px.length; i += stride) sample.push(px[i]);
            sample.sort((a, b) => a - b);
            const n = sample.length;
            let loV = sample[Math.floor(n * 0.01)];
            let hiV = sample[Math.floor(n * 0.99)];
            if (!(hiV > loV)) { loV = sample[0]; hiV = sample[n - 1]; }
            if (!(hiV > loV)) { if (mounted) setDiag(`${imageIds.length}f · flat`); return false; }
            const slope = img.slope ?? 1, intercept = img.intercept ?? 0;
            const lower = loV * slope + intercept, upper = hiV * slope + intercept;
            try { viewport.setProperties({ voiRange: { lower, upper } }); viewport.render(); } catch (_) { /* ignore */ }
            if (mounted) setDiag(`${imageIds.length}f · W ${Math.round(lower)}–${Math.round(upper)}`);
            return true;
          } catch (e) { if (mounted) setDiag('probe err: ' + (e?.message || '')); return false; }
        };
        // Run now and once more shortly after (the first frame may still be decoding).
        if (!applyAutoWindow()) setTimeout(() => { if (mounted) applyAutoWindow(); }, 1500);

        // Tools
        const { ToolGroupManager, WindowLevelTool, ZoomTool, PanTool, StackScrollTool, LengthTool, Enums: te } = tools;
        const { MouseBindings } = te;
        try { ToolGroupManager.destroyToolGroup(TOOLGROUP_ID); } catch (_) { /* none */ }
        const tg = ToolGroupManager.createToolGroup(TOOLGROUP_ID);
        tg.addViewport(VIEWPORT_ID, ENGINE_ID);
        [WindowLevelTool, ZoomTool, PanTool, StackScrollTool, LengthTool].forEach((T) => { if (T) tg.addTool(T.toolName); });
        tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
        tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
        tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
        if (imageIds.length > 1) {
          try { tg.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] }); }
          catch (_) { tg.setToolActive(StackScrollTool.toolName); }
        }

        setLoading(false);
      } catch (err) {
        console.error('[DICOMStackViewer] setup error:', err);
        if (mounted) { setError(err?.message || 'Failed to load DICOM'); setLoading(false); }
      }
    }

    setup();
    return () => {
      mounted = false;
      try { csRef.current?.tools?.ToolGroupManager?.destroyToolGroup(TOOLGROUP_ID); } catch (_) { /* ignore */ }
      try { engineRef.current?.destroy(); } catch (_) { /* ignore */ }
      engineRef.current = null;
    };
  }, [imageIds]);

  const selectTool = useCallback((toolId) => {
    const tools = csRef.current?.tools;
    if (!tools) return;
    const tg = tools.ToolGroupManager.getToolGroup(TOOLGROUP_ID);
    if (!tg) return;
    const { MouseBindings } = tools.Enums;
    [tools.WindowLevelTool, tools.ZoomTool, tools.PanTool, tools.LengthTool].forEach((T) => {
      if (!T) return;
      try {
        if (T.toolName === toolId) tg.setToolActive(T.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
        else tg.setToolPassive(T.toolName);
      } catch (_) { /* ignore */ }
    });
    // Keep zoom/pan on their secondary/aux bindings.
    try { tg.setToolActive(tools.ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] }); } catch (_) { /* ignore */ }
    try { tg.setToolActive(tools.PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] }); } catch (_) { /* ignore */ }
    setActiveTool(toolId);
  }, []);

  const resetView = useCallback(() => {
    const vp = engineRef.current?.getViewport(VIEWPORT_ID);
    if (vp) { vp.resetCamera(); vp.resetProperties?.(); vp.render(); }
  }, []);

  const screenshot = useCallback(() => {
    const canvas = elRef.current?.querySelector('canvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `${fileName}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }, [fileName]);

  return (
    <div className="h-screen w-screen flex flex-col bg-neutral-950">
      <div className="flex items-center gap-1 px-3 py-2 bg-neutral-900 border-b border-neutral-800">
        <span className="text-sm font-semibold text-amber-400 mr-3 truncate max-w-[40%]">{fileName}</span>
        {TOOLBAR.map(({ id, label, Icon }) => (
          <button key={id} type="button" title={label} onClick={() => selectTool(id)}
            className={`p-2 rounded-md transition-colors ${activeTool === id ? 'bg-amber-500 text-black' : 'text-neutral-300 hover:bg-neutral-800'}`}>
            <Icon className="h-4 w-4" />
          </button>
        ))}
        <div className="w-px h-6 bg-neutral-700 mx-1" />
        <button type="button" title="Reset" onClick={resetView} className="p-2 rounded-md text-neutral-300 hover:bg-neutral-800"><RotateCcw className="h-4 w-4" /></button>
        <button type="button" title="Screenshot" onClick={screenshot} className="p-2 rounded-md text-neutral-300 hover:bg-neutral-800"><Camera className="h-4 w-4" /></button>
        <div className="flex-1" />
        {diag && <span className="text-[11px] text-amber-300 mr-2">{diag}</span>}
        {sliceInfo && <span className="text-[11px] text-neutral-500 mr-2">{sliceInfo.total} slices · scroll</span>}
        {onClose && <button type="button" title="Close" onClick={onClose} className="p-2 rounded-md text-neutral-300 hover:bg-neutral-800"><X className="h-4 w-4" /></button>}
      </div>

      <div className="flex-1 bg-black min-h-0">
        <div ref={elRef} className="w-full h-full" onContextMenu={(e) => e.preventDefault()} />
      </div>

      {loading && (
        <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-50">
          <Loader2 className="h-10 w-10 animate-spin text-amber-500 mb-3" />
          <p className="text-white">Loading DICOM…</p>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center z-50 px-6 text-center">
          <AlertTriangle className="h-10 w-10 text-red-400 mb-3" />
          <p className="text-white mb-1">Failed to load DICOM</p>
          <p className="text-neutral-400 text-sm mb-4 max-w-md">{error}</p>
          {onClose && <button onClick={onClose} className="px-4 py-2 rounded-md bg-amber-500 text-black text-sm">Close</button>}
        </div>
      )}
    </div>
  );
}
