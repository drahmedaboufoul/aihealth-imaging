/*
 * DicomViewerPage — 2D DICOM viewer for X-rays, panoramic, periapical,
 * mammography, US single-frame.
 *
 * URL contract:
 *   /viewer/dicom?id=<patient_files.id>     single DICOM file by id
 *   /viewer/dicom?path=<bucket/key>         direct path
 *   /viewer/dicom?demo=1                    demo (deferred — needs sample)
 *
 * Stage B.3 V1 — uncompressed transfer syntaxes only. Compressed support
 * (JPEG-Lossless / JPEG-LS / JPEG-2000 / RLE) needs Cornerstone3D and ships
 * in B.3.2.
 *
 * Layout: full-screen dark canvas (medical convention) with overlay HUDs:
 *   - Top-left:  patient/study metadata
 *   - Top-right: modality + dimensions
 *   - Right rail: W/L sliders + presets, frame slider for multi-frame, reset
 *   - Bottom:    instructions
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSearchParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { Loader2, AlertCircle, ArrowLeft, ExternalLink, Sun, RotateCcw, Camera } from 'lucide-react';
import { resolveSignedUrl } from '../lib/signedUrl';
import { loadDicom, WL_PRESETS } from '../lib/dicomLoader';
import { supabase } from '../lib/supabase';

const SHELL_BG = '#0b0d10';
const PANEL_BG = '#15181c';
const ACCENT   = '#9C8562';

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function formatPatientName(name) {
  if (!name) return null;
  // DICOM PN format is "Family^Given^Middle" — convert to display form
  return name.split('^').filter(Boolean).join(' ');
}

function formatDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length < 8) return yyyymmdd;
  return `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`;
}

export default function DicomViewerPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const fileId   = searchParams.get('id');
  const filePath = searchParams.get('path');
  const isDemo   = searchParams.get('demo') === '1';

  const [loadStage, setLoadStage] = useState('init'); // init | fetching | parsing | ready | error
  const [error, setError] = useState(null);
  const [dicom, setDicom] = useState(null);    // result of loadDicom

  // Display state
  const [windowCenter, setWindowCenter] = useState(40);
  const [windowWidth,  setWindowWidth]  = useState(400);
  const [frameIndex,   setFrameIndex]   = useState(0);
  const [zoom,    setZoom]    = useState(1);
  const [panX,    setPanX]    = useState(0);
  const [panY,    setPanY]    = useState(0);
  const [invert,  setInvert]  = useState(false);

  // Refs for canvas + offscreen pixel buffer
  const canvasRef       = useRef(null);
  const offscreenCanvas = useRef(null);  // raw-DICOM-resolution canvas
  const imageDataRef    = useRef(null);
  const isPanning       = useRef(false);
  const lastPan         = useRef({ x: 0, y: 0 });
  const wlDragging      = useRef(false);
  const wlStart         = useRef({ x: 0, y: 0, wc: 0, ww: 0 });

  // Auth gate (study/id paths require auth) + signed URL resolution
  useEffect(() => {
    document.title = 'DICOM viewer · aiHealth Imaging';
    let cancelled = false;
    (async () => {
      setLoadStage('fetching');
      setError(null);
      try {
        if (!isDemo) {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) {
            const back = encodeURIComponent(location.pathname + location.search);
            navigate(`/login?next=${back}`, { replace: true });
            return;
          }
        }
        if (isDemo) {
          throw new Error('Demo mode for DICOM not wired yet — drop a sample DICOM in test-fixtures/ first.');
        }
        if (!fileId && !filePath) {
          throw new Error('No DICOM source specified. URL must include ?id=<file_id> or ?path=<bucket/key>.');
        }
        const { url } = await resolveSignedUrl({ id: fileId, path: filePath });
        if (cancelled) return;

        // Stream the file
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        setLoadStage('parsing');
        const parsed = await loadDicom(buf);
        if (cancelled) return;

        // Apply file's default W/L
        setWindowCenter(parsed.defaultWindowCenter);
        setWindowWidth(parsed.defaultWindowWidth);
        setFrameIndex(0);
        setZoom(1);
        setPanX(0);
        setPanY(0);
        setInvert(false);

        // Set up offscreen canvas at native resolution
        const ocan = document.createElement('canvas');
        ocan.width  = parsed.meta.columns;
        ocan.height = parsed.meta.rows;
        offscreenCanvas.current = ocan;
        const octx = ocan.getContext('2d');
        imageDataRef.current = octx.createImageData(parsed.meta.columns, parsed.meta.rows);

        setDicom(parsed);
        setLoadStage('ready');
      } catch (err) {
        if (cancelled) return;
        setError(err?.message || String(err));
        setLoadStage('error');
      }
    })();
    return () => { cancelled = true; };
  }, [fileId, filePath, isDemo, navigate, location.pathname, location.search]);

  // Render the current frame to canvas whenever W/L, frame, or zoom changes
  useEffect(() => {
    if (loadStage !== 'ready' || !dicom) return;
    const off = offscreenCanvas.current;
    const onCanvas = canvasRef.current;
    if (!off || !onCanvas) return;

    // Rasterize raw-resolution frame into offscreen ImageData
    const id = imageDataRef.current;
    dicom.renderFrame(frameIndex, windowCenter, windowWidth, id);
    if (invert) {
      // Invert via per-pixel flip on the rasterized RGBA. (loadDicom already
      // handles MONOCHROME1; this lets the user override.)
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i];
        d[i + 1] = d[i];
        d[i + 2] = d[i];
      }
    }
    const octx = off.getContext('2d');
    octx.putImageData(id, 0, 0);

    // Composite to the visible canvas with zoom + pan (CSS-pixel canvas)
    const ctx = onCanvas.getContext('2d');
    const cw = onCanvas.width;
    const ch = onCanvas.height;
    ctx.fillStyle = SHELL_BG;
    ctx.fillRect(0, 0, cw, ch);

    // Fit-to-screen scale factor
    const fitScale = Math.min(cw / dicom.meta.columns, ch / dicom.meta.rows) * 0.95;
    const scale = fitScale * zoom;
    const drawW = dicom.meta.columns * scale;
    const drawH = dicom.meta.rows * scale;
    const drawX = (cw - drawW) / 2 + panX;
    const drawY = (ch - drawH) / 2 + panY;

    ctx.imageSmoothingEnabled = scale < 2; // crisp pixels when zoomed in
    ctx.drawImage(off, drawX, drawY, drawW, drawH);
  }, [dicom, loadStage, windowCenter, windowWidth, frameIndex, zoom, panX, panY, invert]);

  // Resize visible canvas to window
  useEffect(() => {
    const onResize = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width  = c.clientWidth  * window.devicePixelRatio;
      c.height = c.clientHeight * window.devicePixelRatio;
      // Force a re-render
      setPanX((v) => v);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Mouse handlers — left-drag pan, right-drag W/L, wheel zoom
  const onCanvasMouseDown = useCallback((e) => {
    e.preventDefault();
    if (e.button === 0) {
      isPanning.current = true;
      lastPan.current = { x: e.clientX, y: e.clientY };
    } else if (e.button === 2) {
      wlDragging.current = true;
      wlStart.current = { x: e.clientX, y: e.clientY, wc: windowCenter, ww: windowWidth };
    }
  }, [windowCenter, windowWidth]);

  const onCanvasMouseMove = useCallback((e) => {
    if (isPanning.current) {
      const dx = e.clientX - lastPan.current.x;
      const dy = e.clientY - lastPan.current.y;
      lastPan.current = { x: e.clientX, y: e.clientY };
      setPanX((p) => p + dx);
      setPanY((p) => p + dy);
    } else if (wlDragging.current) {
      const dx = e.clientX - wlStart.current.x;
      const dy = e.clientY - wlStart.current.y;
      // Horizontal = window width, vertical = window center (DICOM convention)
      const range = (dicom?.pixelRange?.max ?? 4095) - (dicom?.pixelRange?.min ?? 0);
      const wwScale = Math.max(1, range / 500);
      const wcScale = Math.max(1, range / 500);
      setWindowWidth((w) => Math.max(1, w + dx * wwScale));
      setWindowCenter((c) => c + dy * wcScale);
    }
  }, [dicom]);

  const onCanvasMouseUp = useCallback(() => {
    isPanning.current = false;
    wlDragging.current = false;
  }, []);

  const onCanvasWheel = useCallback((e) => {
    e.preventDefault();
    setZoom((z) => clamp(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.1, 30));
  }, []);

  const onCanvasContextMenu = useCallback((e) => e.preventDefault(), []);

  const resetView = useCallback(() => {
    if (!dicom) return;
    setWindowCenter(dicom.defaultWindowCenter);
    setWindowWidth(dicom.defaultWindowWidth);
    setZoom(1);
    setPanX(0);
    setPanY(0);
  }, [dicom]);

  const screenshot = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const link = document.createElement('a');
    link.download = `dicom-${dicom?.meta?.modality || 'image'}-${Date.now()}.png`;
    link.href = c.toDataURL('image/png');
    link.click();
  }, [dicom]);

  const presets = useMemo(() => {
    const mod = (dicom?.meta?.modality || '').toUpperCase();
    return WL_PRESETS[mod] || WL_PRESETS.DEFAULT;
  }, [dicom]);

  // ──────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────
  if (loadStage === 'init' || loadStage === 'fetching' || loadStage === 'parsing') {
    return (
      <div style={{ height: '100vh', backgroundColor: SHELL_BG }} className="flex items-center justify-center text-white">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={28} className="animate-spin" style={{ color: ACCENT }} />
          <div className="text-sm">
            {loadStage === 'fetching' && 'Fetching DICOM…'}
            {loadStage === 'parsing'  && 'Parsing image…'}
            {loadStage === 'init'     && 'Initialising…'}
          </div>
        </div>
      </div>
    );
  }

  if (loadStage === 'error') {
    return (
      <div style={{ height: '100vh', backgroundColor: SHELL_BG }} className="flex items-center justify-center text-white p-6">
        <div className="max-w-md w-full text-center flex flex-col items-center gap-4">
          <AlertCircle size={28} className="text-red-500" />
          <div>
            <p className="text-sm font-medium">Could not load DICOM</p>
            <p className="text-xs text-gray-400 font-mono break-words mt-2">{error}</p>
          </div>
          <p className="text-[11.5px] text-gray-400 leading-relaxed mt-2">
            URL contract: <code className="font-mono text-amber-400">?id=&lt;file_id&gt;</code> or{' '}
            <code className="font-mono text-amber-400">?path=&lt;bucket/key&gt;</code>.
          </p>
          <Link to="/" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] border border-gray-700 hover:border-amber-500/40 mt-2">
            <ArrowLeft size={12} /> Home
          </Link>
        </div>
      </div>
    );
  }

  const m = dicom.meta;
  const totalFrames = m.numberOfFrames || 1;

  return (
    <div className="relative" style={{ height: '100vh', backgroundColor: SHELL_BG, overflow: 'hidden', userSelect: 'none' }}>
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        onMouseDown={onCanvasMouseDown}
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onMouseLeave={onCanvasMouseUp}
        onWheel={onCanvasWheel}
        onContextMenu={onCanvasContextMenu}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          cursor: isPanning.current ? 'grabbing' : (wlDragging.current ? 'crosshair' : 'grab'),
        }}
      />

      {/* Top-left HUD: patient + study */}
      <div className="absolute top-3 left-3 text-white text-[12px] leading-snug font-mono pointer-events-none">
        {formatPatientName(m.patientName) && <div>{formatPatientName(m.patientName)}</div>}
        {m.patientId && <div className="text-gray-400">ID: {m.patientId}</div>}
        {m.studyDate && <div className="text-gray-400">{formatDate(m.studyDate)}</div>}
        {m.studyDescription && <div className="text-gray-400 mt-0.5">{m.studyDescription}</div>}
      </div>

      {/* Top-right HUD: modality + dimensions */}
      <div className="absolute top-3 right-3 text-white text-[12px] leading-snug font-mono text-right pointer-events-none">
        {m.modality && <div className="font-semibold" style={{ color: ACCENT }}>{m.modality}</div>}
        {m.bodyPart && <div className="text-gray-400">{m.bodyPart}</div>}
        <div className="text-gray-400">{m.columns}×{m.rows}{totalFrames > 1 ? ` · ${totalFrames}f` : ''}</div>
        {m.bitsStored && <div className="text-gray-400">{m.bitsStored}-bit</div>}
      </div>

      {/* Bottom HUD: W/L readout + instructions */}
      <div className="absolute bottom-3 left-3 text-white text-[11px] leading-tight font-mono pointer-events-none">
        <div>WC {Math.round(windowCenter)} · WW {Math.round(windowWidth)}</div>
        <div className="text-gray-500 mt-1">Drag = pan · Right-drag = W/L · Wheel = zoom</div>
      </div>

      {/* Right rail: controls */}
      <div
        className="absolute top-16 right-3 w-60 p-3 rounded-lg text-white text-[12px]"
        style={{ backgroundColor: PANEL_BG, border: '1px solid #25282d' }}
      >
        {/* Presets */}
        {presets.length > 0 && (
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-1.5">Window presets</div>
            <div className="grid grid-cols-2 gap-1">
              {presets.map((p) => (
                <button
                  key={p.name}
                  onClick={() => { setWindowCenter(p.wc); setWindowWidth(p.ww); }}
                  className="text-[11px] py-1 rounded bg-gray-800 hover:bg-gray-700"
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* W/L sliders */}
        <div className="mb-3">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gray-400 mb-1">
            <span>Window center</span>
            <span className="tabular-nums text-gray-300">{Math.round(windowCenter)}</span>
          </div>
          <input
            type="range"
            min={dicom.pixelRange.min}
            max={dicom.pixelRange.max}
            step={1}
            value={windowCenter}
            onChange={(e) => setWindowCenter(Number(e.target.value))}
            className="w-full"
          />
        </div>
        <div className="mb-3">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gray-400 mb-1">
            <span>Window width</span>
            <span className="tabular-nums text-gray-300">{Math.round(windowWidth)}</span>
          </div>
          <input
            type="range"
            min={1}
            max={Math.max(1, (dicom.pixelRange.max - dicom.pixelRange.min) * 2)}
            step={1}
            value={windowWidth}
            onChange={(e) => setWindowWidth(Number(e.target.value))}
            className="w-full"
          />
        </div>

        {/* Frame slider for multi-frame */}
        {totalFrames > 1 && (
          <div className="mb-3">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gray-400 mb-1">
              <span>Frame</span>
              <span className="tabular-nums text-gray-300">{frameIndex + 1} / {totalFrames}</span>
            </div>
            <input
              type="range"
              min={0}
              max={totalFrames - 1}
              step={1}
              value={frameIndex}
              onChange={(e) => setFrameIndex(Number(e.target.value))}
              className="w-full"
            />
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
            onClick={() => setInvert((i) => !i)}
            className={`text-[11px] py-1.5 rounded flex items-center justify-center gap-1 ${invert ? 'bg-amber-600' : 'bg-gray-800 hover:bg-gray-700'}`}
            title="Invert grayscale"
          >
            <Sun size={11} /> Invert
          </button>
          <button
            onClick={screenshot}
            className="text-[11px] py-1.5 rounded bg-gray-800 hover:bg-gray-700 flex items-center justify-center gap-1"
            title="Download PNG"
          >
            <Camera size={11} /> Save
          </button>
        </div>
      </div>

      {/* Close / home button */}
      <button
        onClick={() => window.close()}
        className="absolute top-3 left-1/2 -translate-x-1/2 text-white text-[11px] px-3 py-1 rounded-full bg-gray-800 hover:bg-gray-700 flex items-center gap-1"
        title="Close window"
      >
        <ExternalLink size={11} /> Close
      </button>
    </div>
  );
}
