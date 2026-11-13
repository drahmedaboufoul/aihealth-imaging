/*
 * CephMode — the Cephalometric tab of the CBCT viewer.
 *
 * Builds a SYNTHETIC LATERAL CEPHALOGRAM from the loaded CBCT volume (parallel
 * projection along the patient L-R axis), lets the clinician trace the standard
 * landmark set by click-to-place, and computes the classic Steiner/Tweed
 * analysis LIVE from whatever subset of landmarks exists — pure geometry, NO AI.
 *
 * Standard orientation: patient faces RIGHT, maxilla UP. The projection derives
 * the L-R / anterior / superior senses from the volume DIRECTION matrix (never
 * hard-coded) so the ceph is never mirrored regardless of DICOM-vs-NIfTI load
 * orientation.
 *
 * Persistence: imaging_studies.viewer_annotations.ceph (jsonb, no schema
 * change) — landmarks (in mm/normalized form), projection mode, and the
 * computed values. Reloaded on open. "Reset tracing" clears it.
 *
 * Lazy-loaded from CBCTVolumeViewer (like CompareMode) so the projection math
 * stays out of the viewer's initial load.
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Loader2, Ruler, RotateCcw, Save, Download, Camera, Contrast, Crosshair,
  AlertTriangle, Info, Check, Sparkles,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { functionErrorMessage } from '@/lib/aiTokens';
import {
  generateLateralCeph, assessCephFov,
} from '@/lib/cephProjection';
import { computeImageWindow } from '@/lib/curvedMpr';
import {
  LANDMARKS, computeCephAnalysis,
} from '@/lib/cephAnalysis';

const CEPH_KEY = 'ceph';
const LONG_EDGE_PX = 1024;

// The classic tracing lines, drawn live as soon as both endpoints exist —
// they are what makes the dot set read as a cephalometric tracing and make
// a misplaced landmark visually obvious. `extend` stretches the segment
// beyond both endpoints (incisor axes are read as long axes, not stubs).
const TRACE_LINES = [
  { a: 'S', b: 'N', color: 'rgba(56,189,248,0.85)', label: 'SN' },
  { a: 'Po', b: 'Or', color: 'rgba(167,139,250,0.85)', dash: [7, 5], label: 'FH' },
  { a: 'Go', b: 'Me', color: 'rgba(52,211,153,0.85)', label: 'MP' },
  { a: 'N', b: 'A', color: 'rgba(251,191,36,0.75)', label: 'NA' },
  { a: 'N', b: 'B', color: 'rgba(251,146,60,0.75)', label: 'NB' },
  { a: 'N', b: 'Pog', color: 'rgba(212,212,216,0.5)', dash: [2, 5], label: '' },
  { a: 'U1A', b: 'U1T', color: 'rgba(248,113,113,0.9)', extend: 0.6, label: 'U1' },
  { a: 'L1A', b: 'L1T', color: 'rgba(248,113,113,0.9)', extend: 0.6, label: 'L1' },
];

// Float32 image ({width,height,data}, NaN = outside) → grayscale RGBA, windowed.
function floatImageToRgba(img, lower, upper) {
  const { width, height, data } = img;
  const span = upper > lower ? upper - lower : 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    let g = 0;
    if (Number.isFinite(v)) g = Math.max(0, Math.min(255, Math.round(((v - lower) / span) * 255)));
    const o = i * 4;
    rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
  }
  return { rgba, width, height };
}

// Merge the ceph annotation into viewer_annotations WITHOUT clobbering siblings
// (arch, mesh_registrations, …). Mirrors meshRegistration's upsert pattern.
function upsertCeph(viewerAnnotations, cephEntry) {
  const prev = viewerAnnotations && typeof viewerAnnotations === 'object' ? viewerAnnotations : {};
  return { ...prev, [CEPH_KEY]: cephEntry };
}

const StatusDot = ({ status }) => {
  const color = {
    green: 'bg-emerald-500', amber: 'bg-amber-400', red: 'bg-red-500', na: 'bg-neutral-600',
  }[status] || 'bg-neutral-600';
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />;
};

export default function CephMode({ studyId, getCurrentVolume, fileName = 'CBCT', onCapture }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const cephRef = useRef(null);        // last generateLateralCeph result (with mappers)
  const baseRgbaRef = useRef(null);    // ImageData-ready base image bytes

  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const [projection, setProjection] = useState('mip'); // 'mip' | 'mean'
  const [fov, setFov] = useState(null);
  const [imgDims, setImgDims] = useState({ width: 0, height: 0 });

  // Landmarks keyed by landmark key → { col, row } pixel coords on the ceph.
  // AI-drafted points carry ai:true (and confidence) until the clinician
  // touches them — touching a dot is the "verified" gesture that clears it.
  const [landmarks, setLandmarks] = useState({});
  const [aiTracing, setAiTracing] = useState(false);
  const [placingKey, setPlacingKey] = useState(LANDMARKS[0].key);
  const [draggingKey, setDraggingKey] = useState(null);
  const [hoverPx, setHoverPx] = useState(null); // {x,y} CSS px for the loupe
  const [saveMsg, setSaveMsg] = useState('');
  const [loadedFromStore, setLoadedFromStore] = useState(false);

  // ── build the ceph projection ──────────────────────────────────────────────
  const build = useCallback((proj) => {
    setBusy(true);
    setError(null);
    // Yield a frame so the spinner paints before the synchronous projection.
    return new Promise((resolve) => setTimeout(resolve, 20)).then(() => {
      try {
        const vol = getCurrentVolume?.();
        if (!vol) throw new Error('Volume not loaded yet.');
        const ceph = generateLateralCeph(vol, { projection: proj, longEdgePx: LONG_EDGE_PX });
        cephRef.current = ceph;
        const win = computeImageWindow(ceph) || { lower: 0, upper: 1 };
        baseRgbaRef.current = floatImageToRgba(ceph, win.lower, win.upper);
        setImgDims({ width: ceph.width, height: ceph.height });
        setFov(assessCephFov(vol));
      } catch (e) {
        setError(e?.message || 'Could not build the lateral ceph from this volume.');
        cephRef.current = null;
        baseRgbaRef.current = null;
      } finally {
        setBusy(false);
      }
    });
  }, [getCurrentVolume]);

  useEffect(() => { build(projection); }, [build, projection]);

  // ── load any saved tracing on open ─────────────────────────────────────────
  useEffect(() => {
    if (!studyId || loadedFromStore) return undefined;
    let off = false;
    (async () => {
      try {
        const { data } = await supabase.from('imaging_studies')
          .select('viewer_annotations').eq('id', studyId).single();
        if (off) return;
        const saved = data?.viewer_annotations?.[CEPH_KEY];
        if (saved?.landmarks && typeof saved.landmarks === 'object') {
          setLandmarks(saved.landmarks);
          if (saved.projection === 'mip' || saved.projection === 'mean') setProjection(saved.projection);
          setSaveMsg('Loaded saved tracing.');
        }
      } catch (_) { /* ignore */ }
      finally { if (!off) setLoadedFromStore(true); }
    })();
    return () => { off = true; };
  }, [studyId, loadedFromStore]);

  // ── live analysis ──────────────────────────────────────────────────────────
  const analysis = useMemo(() => {
    const mmPerPixel = cephRef.current?.colSpacingMm || 1;
    return computeCephAnalysis(landmarks, { mmPerPixel });
  }, [landmarks, imgDims]);

  // ── canvas paint (base image + landmark dots) ──────────────────────────────
  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    const base = baseRgbaRef.current;
    if (!canvas || !base) return;
    const { width, height, rgba } = base;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imgData = ctx.createImageData(width, height);
    imgData.data.set(rgba);
    ctx.putImageData(imgData, 0, 0);
    // Tracing lines first (under the dots): drawn for every pair whose two
    // landmarks are placed, labelled at the midpoint.
    const lw = Math.max(1, Math.round(width / 900));
    ctx.font = `${Math.max(10, Math.round(width / 100))}px sans-serif`;
    for (const ln of TRACE_LINES) {
      const pa = landmarks[ln.a];
      const pb = landmarks[ln.b];
      if (!pa || !pb) continue;
      let { col: ax, row: ay } = pa;
      let { col: bx, row: by } = pb;
      if (ln.extend) {
        const dx = bx - ax;
        const dy = by - ay;
        ax -= dx * ln.extend; ay -= dy * ln.extend;
        bx += dx * ln.extend; by += dy * ln.extend;
      }
      ctx.save();
      ctx.strokeStyle = ln.color;
      ctx.lineWidth = lw;
      ctx.setLineDash(ln.dash || []);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.restore();
      if (ln.label) {
        ctx.fillStyle = ln.color;
        ctx.fillText(ln.label, (ax + bx) / 2 + 4, (ay + by) / 2 - 4);
      }
    }
    // Landmark dots + labels (drawn in image pixel space).
    const r = Math.max(3, Math.round(width / 220));
    ctx.font = `${Math.max(10, Math.round(width / 90))}px sans-serif`;
    for (const lm of LANDMARKS) {
      const p = landmarks[lm.key];
      if (!p) continue;
      const active = lm.key === placingKey;
      ctx.beginPath();
      ctx.arc(p.col, p.row, r, 0, Math.PI * 2);
      if (p.ai) {
        // AI draft: hollow amber ring until the clinician touches it.
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(245,158,11,0.95)';
        ctx.stroke();
      } else {
        ctx.fillStyle = active ? 'rgba(245,158,11,0.95)' : 'rgba(56,189,248,0.9)';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.stroke();
      }
      ctx.fillStyle = p.ai ? 'rgb(253,186,116)' : active ? 'rgb(253,224,71)' : 'rgb(186,230,253)';
      ctx.fillText(lm.key, p.col + r + 2, p.row - r);
    }
  }, [landmarks, placingKey]);

  useEffect(() => { repaint(); }, [repaint, imgDims, busy]);

  // Map a mouse event to ceph image pixel coordinates.
  const eventToImagePx = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const col = (e.clientX - rect.left) * sx;
    const row = (e.clientY - rect.top) * sy;
    return { col, row, cssX: e.clientX - rect.left, cssY: e.clientY - rect.top };
  }, []);

  // Find an existing landmark near a click (for repositioning).
  const hitLandmark = useCallback((col, row) => {
    const tol = Math.max(6, (imgDims.width || 1) / 120);
    let best = null;
    let bestD = tol;
    for (const lm of LANDMARKS) {
      const p = landmarks[lm.key];
      if (!p) continue;
      const d = Math.hypot(p.col - col, p.row - row);
      if (d < bestD) { bestD = d; best = lm.key; }
    }
    return best;
  }, [landmarks, imgDims]);

  const advancePlacing = useCallback((justPlaced) => {
    // Move "place next" to the next unplaced landmark after the one just set.
    const order = LANDMARKS.map((l) => l.key);
    const start = order.indexOf(justPlaced);
    for (let i = 1; i <= order.length; i++) {
      const k = order[(start + i) % order.length];
      if (!landmarks[k] && k !== justPlaced) { setPlacingKey(k); return; }
    }
  }, [landmarks]);

  const onCanvasMouseDown = useCallback((e) => {
    const px = eventToImagePx(e);
    if (!px) return;
    const hit = hitLandmark(px.col, px.row);
    if (hit) { setDraggingKey(hit); setPlacingKey(hit); return; }
    // Place the current target landmark.
    setLandmarks((prev) => ({ ...prev, [placingKey]: { col: px.col, row: px.row } }));
    setDraggingKey(placingKey);
  }, [eventToImagePx, hitLandmark, placingKey]);

  const onCanvasMouseMove = useCallback((e) => {
    const px = eventToImagePx(e);
    if (!px) return;
    setHoverPx({ x: px.cssX, y: px.cssY, col: px.col, row: px.row });
    if (draggingKey) {
      setLandmarks((prev) => ({ ...prev, [draggingKey]: { col: px.col, row: px.row } }));
    }
  }, [eventToImagePx, draggingKey]);

  const onCanvasMouseUp = useCallback(() => {
    if (draggingKey) {
      const placed = draggingKey;
      // Touching a dot verifies it: clear the AI-draft flag.
      setLandmarks((prev) => {
        const p = prev[placed];
        if (!p?.ai) return prev;
        return { ...prev, [placed]: { col: p.col, row: p.row } };
      });
      setDraggingKey(null);
      advancePlacing(placed);
    }
  }, [draggingKey, advancePlacing]);

  const onCanvasLeave = useCallback(() => { setHoverPx(null); }, []);

  // ── AI auto-trace (assistive draft, two-pass) ──────────────────────────────
  // Pass 1 sends BOTH renderings (MIP + film-like average) of the projection
  // with a labeled coordinate grid — vision models read gridded coordinates
  // far more reliably than they estimate them on a borderless radiograph.
  // Pass 2 sends a magnified, gridded crop around each first-pass point for
  // local correction. Already-placed points are never overwritten — Reset
  // first for a full redraft.
  const autoTrace = useCallback(async () => {
    if (aiTracing) return;
    const base = baseRgbaRef.current;
    if (!studyId) { setSaveMsg('Auto-trace needs a saved imaging study.'); return; }
    if (!base) { setSaveMsg('Ceph image not ready yet.'); return; }
    setAiTracing(true);
    setSaveMsg('AI pass 1/2: estimating landmark positions…');
    try {
      const { width, height } = base;

      const rgbaToCanvas = (img) => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('Canvas unavailable.');
        const d = ctx.createImageData(img.width, img.height);
        d.data.set(img.rgba);
        ctx.putImageData(d, 0, 0);
        return c;
      };

      // Labeled 0.1-step grid the model reads coordinates from.
      const drawGrid = (ctx, w, h) => {
        ctx.save();
        ctx.strokeStyle = 'rgba(56,189,248,0.45)';
        ctx.fillStyle = 'rgba(125,211,252,0.95)';
        ctx.lineWidth = Math.max(1, Math.round(w / 1100));
        const font = Math.max(11, Math.round(w / 75));
        ctx.font = `${font}px sans-serif`;
        for (let i = 1; i <= 9; i++) {
          const x = (i / 10) * w;
          const y = (i / 10) * h;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
          const lx = `0.${i}`;
          ctx.fillText(lx, x + 3, font + 2);            // x labels along the top
          ctx.fillText(lx, x + 3, h - 4);               // …and the bottom
          ctx.fillText(lx, 3, y - 3);                   // y labels along the left
          ctx.fillText(lx, w - font * 2.2, y - 3);      // …and the right
        }
        ctx.restore();
      };

      // Rendering 1: the current base (already windowed). Rendering 2: the
      // OTHER projection of the same geometry — more soft-tissue/profile cues.
      const mainCanvas = rgbaToCanvas(base);
      drawGrid(mainCanvas.getContext('2d'), width, height);
      const images = [{
        label: projection === 'mean' ? 'average_grid' : 'mip_grid',
        image: mainCanvas.toDataURL('image/png'),
        mediaType: 'image/png',
      }];
      try {
        const vol = getCurrentVolume?.();
        if (vol) {
          const other = generateLateralCeph(vol, {
            projection: projection === 'mean' ? 'mip' : 'mean', longEdgePx: LONG_EDGE_PX,
          });
          if (other.width === width && other.height === height) {
            const win = computeImageWindow(other) || { lower: 0, upper: 1 };
            const otherCanvas = rgbaToCanvas(floatImageToRgba(other, win.lower, win.upper));
            drawGrid(otherCanvas.getContext('2d'), width, height);
            images.push({
              label: projection === 'mean' ? 'mip_grid' : 'average_grid',
              image: otherCanvas.toDataURL('image/png'),
              mediaType: 'image/png',
            });
          }
        }
      } catch (_) { /* second rendering is a bonus — proceed with one */ }

      const { data, error: fnErr } = await supabase.functions.invoke('ai-ceph-trace', {
        body: { study_id: studyId, mode: 'estimate', images },
      });
      // Read the body so "Not enough AI tokens…" (402) reaches the user verbatim.
      if (fnErr) throw new Error(await functionErrorMessage(fnErr, 'Auto-trace failed'));
      if (data?.error) throw new Error(data.error);
      const coarse = data?.landmarks;
      if (!coarse || typeof coarse !== 'object') throw new Error('Auto-trace returned no landmarks.');

      // Refine only the keys we will actually place (clinician points stay).
      const keysToPlace = LANDMARKS.map((l) => l.key)
        .filter((k) => coarse[k] && !landmarks[k]);

      setSaveMsg('AI pass 2/2: refining each landmark locally…');
      const refined = { ...coarse };
      if (keysToPlace.length) {
        // Magnified, gridded crop around each coarse point, draft marked.
        const cropSide = Math.max(96, Math.min(280, Math.round(Math.min(width, height) * 0.24)));
        const CROP_PX = 384; // upscaled crop sent to the model
        const cleanBase = rgbaToCanvas(base);
        const buildCrop = (key) => {
          const p = coarse[key];
          const cx = p.x * width;
          const cy = p.y * height;
          let x0 = Math.round(cx - cropSide / 2);
          let y0 = Math.round(cy - cropSide / 2);
          x0 = Math.max(0, Math.min(width - cropSide, x0));
          y0 = Math.max(0, Math.min(height - cropSide, y0));
          const c = document.createElement('canvas');
          c.width = CROP_PX;
          c.height = CROP_PX;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(cleanBase, x0, y0, cropSide, cropSide, 0, 0, CROP_PX, CROP_PX);
          drawGrid(ctx, CROP_PX, CROP_PX);
          // Mark the draft position (crop-local) with a cross.
          const mx = ((cx - x0) / cropSide) * CROP_PX;
          const my = ((cy - y0) / cropSide) * CROP_PX;
          ctx.strokeStyle = 'rgba(245,158,11,0.95)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(mx - 10, my); ctx.lineTo(mx + 10, my);
          ctx.moveTo(mx, my - 10); ctx.lineTo(mx, my + 10);
          ctx.stroke();
          return {
            key,
            image: c.toDataURL('image/png'),
            mediaType: 'image/png',
            rect: {
              x0: x0 / width, y0: y0 / height,
              x1: (x0 + cropSide) / width, y1: (y0 + cropSide) / height,
            },
          };
        };
        const crops = keysToPlace.map(buildCrop);
        const batches = [];
        for (let i = 0; i < crops.length; i += 8) batches.push(crops.slice(i, i + 8));
        try {
          const results = await Promise.all(batches.map((batch) =>
            supabase.functions.invoke('ai-ceph-trace', {
              body: { study_id: studyId, mode: 'refine', crops: batch },
            })));
          for (const r of results) {
            if (r.error || r.data?.error || !r.data?.landmarks) continue;
            for (const [k, p] of Object.entries(r.data.landmarks)) {
              if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) refined[k] = p;
            }
          }
        } catch (_) { /* refinement is best-effort — coarse points stand */ }
      }

      // Merge against the current landmarks OUTSIDE the state updater so the
      // placed count is known synchronously for the status message.
      const next = { ...landmarks };
      let placed = 0;
      for (const lm of LANDMARKS) {
        const p = refined[lm.key];
        if (!p || next[lm.key]) continue; // keep clinician-placed points
        const col = Math.max(0, Math.min(width - 1, p.x * width));
        const row = Math.max(0, Math.min(height - 1, p.y * height));
        if (!Number.isFinite(col) || !Number.isFinite(row)) continue;
        next[lm.key] = { col, row, ai: true, confidence: p.confidence };
        placed += 1;
      }
      setLandmarks(next);
      setSaveMsg(placed
        ? `AI draft: ${placed} landmark${placed === 1 ? '' : 's'} pre-placed and refined — drag each hollow dot to verify.`
        : 'All landmarks already placed — Reset tracing first for a full AI redraft.');
    } catch (e) {
      console.error('[CephMode] auto-trace failed:', e);
      setSaveMsg('Auto-trace failed: ' + (e?.message || 'error'));
    } finally {
      setAiTracing(false);
    }
  }, [aiTracing, studyId, landmarks, projection, getCurrentVolume]);

  // ── persistence ────────────────────────────────────────────────────────────
  const saveTracing = useCallback(async () => {
    if (!studyId) { setSaveMsg('Cannot save (no study).'); return; }
    try {
      const ceph = cephRef.current;
      const entry = {
        landmarks,
        projection,
        image: ceph ? { width: ceph.width, height: ceph.height, colSpacingMm: ceph.colSpacingMm, rowSpacingMm: ceph.rowSpacingMm } : null,
        analysis: analysis.map((a) => ({ key: a.key, label: a.label, value: a.value, unit: a.unit, status: a.status, approximate: a.approximate })),
        updatedAt: new Date().toISOString(),
      };
      const { data: row } = await supabase.from('imaging_studies').select('viewer_annotations').eq('id', studyId).single();
      const merged = upsertCeph(row?.viewer_annotations, entry);
      const { error: upErr } = await supabase.from('imaging_studies')
        .update({ viewer_annotations: merged, viewer_annotations_updated_at: new Date().toISOString() })
        .eq('id', studyId);
      if (upErr) throw upErr;
      setSaveMsg(`Tracing saved (${Object.keys(landmarks).length} landmarks).`);
    } catch (e) {
      setSaveMsg('Save failed: ' + (e?.message || 'error'));
    }
  }, [studyId, landmarks, projection, analysis]);

  const resetTracing = useCallback(() => {
    setLandmarks({});
    setPlacingKey(LANDMARKS[0].key);
    setSaveMsg('Tracing reset.');
  }, []);

  // Capture the traced ceph to the Gallery (and offer a PNG download).
  const captureCeph = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    if (onCapture) onCapture(url, 'ceph');
    const link = document.createElement('a');
    link.download = `${fileName}_ceph.png`;
    link.href = url;
    link.click();
  }, [onCapture, fileName]);

  const placedCount = Object.keys(landmarks).length;
  const draftCount = Object.values(landmarks).filter((p) => p?.ai).length;
  const placingLabel = LANDMARKS.find((l) => l.key === placingKey)?.label || '';
  const placingHint = LANDMARKS.find((l) => l.key === placingKey)?.hint || '';

  // ── loupe (zoom while placing) ──────────────────────────────────────────────
  const Loupe = () => {
    const base = baseRgbaRef.current;
    if (!hoverPx || !base || !canvasRef.current) return null;
    const LP = 120; // loupe size px
    const ZOOM = 3;
    // Offset so it doesn't sit under the cursor.
    const left = Math.min(hoverPx.x + 16, (wrapRef.current?.clientWidth || 9999) - LP - 8);
    const top = Math.max(hoverPx.y - LP - 16, 8);
    return (
      <div
        className="absolute pointer-events-none rounded-full overflow-hidden border-2 border-amber-400 shadow-lg z-20"
        style={{ width: LP, height: LP, left, top }}
      >
        <canvas
          width={LP}
          height={LP}
          ref={(el) => {
            if (!el) return;
            const ctx = el.getContext('2d');
            const src = canvasRef.current;
            if (!ctx || !src) return;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, LP, LP);
            const srcSize = LP / ZOOM;
            ctx.imageSmoothingEnabled = false;
            try {
              ctx.drawImage(src, hoverPx.col - srcSize / 2, hoverPx.row - srcSize / 2, srcSize, srcSize, 0, 0, LP, LP);
            } catch (_) { /* ignore */ }
            ctx.strokeStyle = 'rgba(245,158,11,0.9)';
            ctx.beginPath();
            ctx.moveTo(LP / 2, 0); ctx.lineTo(LP / 2, LP);
            ctx.moveTo(0, LP / 2); ctx.lineTo(LP, LP / 2);
            ctx.stroke();
          }}
        />
      </div>
    );
  };

  return (
    <div className="absolute inset-0 flex bg-neutral-950">
      {/* ── ceph image stage ── */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* toolbar */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-900 border-b border-neutral-800 flex-wrap">
          <Ruler className="h-4 w-4 text-amber-400" />
          <span className="text-xs font-semibold text-amber-300">Lateral cephalogram (synthetic)</span>
          <div className="ml-2 flex rounded overflow-hidden border border-neutral-700">
            <button
              type="button"
              onClick={() => setProjection('mip')}
              className={`px-2 py-1 text-[11px] ${projection === 'mip' ? 'bg-amber-500 text-black' : 'bg-neutral-800 text-neutral-300'}`}
            >MIP (bone)</button>
            <button
              type="button"
              onClick={() => setProjection('mean')}
              className={`px-2 py-1 text-[11px] ${projection === 'mean' ? 'bg-amber-500 text-black' : 'bg-neutral-800 text-neutral-300'}`}
            ><Contrast className="h-3 w-3 inline mr-1" />Average (film-like)</button>
          </div>
          <div className="flex-1" />
          {saveMsg && <span className="text-[11px] text-amber-300 truncate max-w-[40%]">{saveMsg}</span>}
          <button type="button" title="AI pre-places landmark drafts — you verify every point"
            onClick={autoTrace} disabled={aiTracing || busy}
            className="px-2 py-1 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[11px] hover:bg-amber-500/25 disabled:opacity-50 inline-flex items-center gap-1">
            {aiTracing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Auto-trace
          </button>
          <button type="button" title="Save tracing" onClick={saveTracing}
            className="px-2 py-1 rounded bg-neutral-800 text-emerald-300 text-[11px] hover:bg-neutral-700 inline-flex items-center gap-1">
            <Save className="h-3.5 w-3.5" /> Save
          </button>
          <button type="button" title="Reset tracing" onClick={resetTracing}
            className="px-2 py-1 rounded bg-neutral-800 text-red-300 text-[11px] hover:bg-neutral-700 inline-flex items-center gap-1">
            <RotateCcw className="h-3.5 w-3.5" /> Reset tracing
          </button>
          <button type="button" title="Capture to gallery + download PNG" onClick={captureCeph}
            className="px-2 py-1 rounded bg-neutral-800 text-neutral-200 text-[11px] hover:bg-neutral-700 inline-flex items-center gap-1">
            <Camera className="h-3.5 w-3.5" /> Capture
          </button>
        </div>

        {/* FOV honesty banner */}
        {fov?.note && (
          <div className="flex items-start gap-2 px-3 py-2 bg-amber-950/40 border-b border-amber-900/50 text-[11px] text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
            <span>{fov.note}</span>
          </div>
        )}

        {/* place-next guide */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-900/70 border-b border-neutral-800 text-[11px]">
          <Crosshair className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-neutral-300">
            Placing <span className="text-amber-300 font-semibold">{placingLabel}</span>
            {placingHint && <span className="text-neutral-500"> — {placingHint}</span>}
          </span>
          <span className="text-neutral-600">· {placedCount}/{LANDMARKS.length} placed · click to place, drag a dot to reposition</span>
          {draftCount > 0 && (
            <span className="text-amber-400/90">· {draftCount} AI draft{draftCount === 1 ? '' : 's'} unverified (hollow dots)</span>
          )}
        </div>

        {/* canvas */}
        <div ref={wrapRef} className="flex-1 min-h-0 relative bg-black flex items-center justify-center overflow-hidden">
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center z-10 bg-black/60">
              <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
            </div>
          )}
          {error && !busy && (
            <div className="text-center px-6">
              <AlertTriangle className="h-8 w-8 text-red-400 mx-auto mb-2" />
              <p className="text-neutral-300 text-sm">{error}</p>
            </div>
          )}
          {!error && (
            <canvas
              ref={canvasRef}
              className="max-h-full max-w-full object-contain cursor-crosshair"
              style={{ imageRendering: 'auto' }}
              onMouseDown={onCanvasMouseDown}
              onMouseMove={onCanvasMouseMove}
              onMouseUp={onCanvasMouseUp}
              onMouseLeave={onCanvasLeave}
            />
          )}
          {(draggingKey || placingKey) && <Loupe />}
        </div>

        {/* assistive disclaimer */}
        <div className="flex items-center gap-2 px-3 py-1 bg-neutral-900 border-t border-neutral-800 text-[10px] text-neutral-500">
          <Info className="h-3 w-3" />
          Tracing aid — verify clinically. Analysis values are pure geometry from the landmark positions;
          Auto-trace only pre-places draft dots (hollow) for you to verify and adjust.
        </div>
      </div>

      {/* ── right panel: landmark list + analysis ── */}
      <aside className="w-80 shrink-0 bg-neutral-900 border-l border-neutral-800 flex flex-col min-h-0">
        <div className="px-3 py-2 border-b border-neutral-800 text-[11px] uppercase tracking-wider text-neutral-500">
          Landmarks
        </div>
        <div className="overflow-y-auto max-h-[40%] border-b border-neutral-800">
          {LANDMARKS.map((lm) => {
            const placed = !!landmarks[lm.key];
            const active = lm.key === placingKey;
            return (
              <button
                key={lm.key}
                type="button"
                title={lm.hint}
                onClick={() => setPlacingKey(lm.key)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs border-b border-neutral-800/60 ${
                  active ? 'bg-amber-500/15' : 'hover:bg-neutral-800'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${placed ? (landmarks[lm.key]?.ai ? 'bg-amber-400' : 'bg-sky-400') : 'bg-neutral-700'}`} />
                <span className={`font-mono ${active ? 'text-amber-300' : 'text-neutral-300'}`}>{lm.key}</span>
                <span className="text-neutral-500 truncate flex-1">{lm.label}</span>
                {placed && (landmarks[lm.key]?.ai
                  ? <span className="text-[9px] uppercase tracking-wide text-amber-400/90 border border-amber-500/40 rounded px-1">draft</span>
                  : <Check className="h-3 w-3 text-emerald-400" />)}
              </button>
            );
          })}
        </div>

        <div className="px-3 py-2 border-b border-neutral-800 text-[11px] uppercase tracking-wider text-neutral-500">
          Analysis (live)
        </div>
        <div className="overflow-y-auto flex-1 min-h-0">
          {analysis.map((a) => (
            <div key={a.key}
              title={a.norm?.cite || ''}
              className="flex items-center gap-2 px-3 py-1.5 border-b border-neutral-800/60 text-xs">
              <StatusDot status={a.status} />
              <span className="text-neutral-300 w-20">{a.label}</span>
              <span className={`font-mono ${a.value == null ? 'text-neutral-600' : 'text-neutral-100'}`}>
                {a.value == null ? '—' : `${a.value}${a.unit}`}
              </span>
              {a.norm && (
                <span className="text-neutral-600 ml-auto text-[10px]">
                  ({a.norm.range[0]}–{a.norm.range[1]}{a.norm.unit})
                </span>
              )}
            </div>
          ))}
        </div>

        {/* printable summary block */}
        <div className="px-3 py-2 border-t border-neutral-800">
          <button type="button" onClick={() => window.print()}
            className="w-full px-2 py-1.5 rounded bg-neutral-800 text-neutral-200 text-[11px] hover:bg-neutral-700 inline-flex items-center justify-center gap-1">
            <Download className="h-3.5 w-3.5" /> Print summary
          </button>
        </div>
      </aside>
    </div>
  );
}
