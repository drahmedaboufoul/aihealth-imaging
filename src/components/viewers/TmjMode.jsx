/*
 * TmjMode — the dual-condyle TMJ tab of the CBCT viewer.
 *
 * Clinically standard bilateral temporomandibular-joint display, built entirely
 * client-side off the SAME loaded NIfTI/DICOM volume the MPR tab uses (handed in
 * via getCurrentVolume — TmjMode never touches the parent's cornerstone engine).
 *
 * Layout (radiological, maxilla-up, R | L per side):
 *   per condyle → PARASAGITTAL oblique (⊥ the condylar long axis, rotatable),
 *                 CORONAL oblique through the centre, a small AXIAL locator with
 *                 the cut lines drawn (also the REFINE-by-click target).
 *   slab thickness + step controls; scroll ±15 mm around the centre.
 *
 * FOV honesty: if locateCondyles can't confirm a side inside the scan's field
 * of view (small dento-alveolar scans), that side shows "Condyles outside this
 * scan's field of view" instead of a garbage reconstruction.
 *
 * Measurement: linear mm on any pane; joint-space quick-measures (anterior /
 * superior / posterior) per side, shown in a left-vs-right comparison table.
 *
 * Persistence: refined centres, angles, slab/scroll, and measures live in
 * imaging_studies.viewer_annotations.tmj (jsonb, no schema change); merged
 * without clobbering arch / mesh_registrations (same pattern as CompareMode).
 *
 * Capture: reuses the parent gallery via onCapture(dataUrl, label) when given,
 * else falls back to a PNG download.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Loader2, Activity, Camera, Save, AlertTriangle,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import {
  locateCondyles, buildCondylePlanes, planeWindow, measurePixels,
  lrLabelsForUaxis, sampleObliquePlane, patientAxes,
} from '@/lib/tmjViews';

// ── plane → canvas helpers ───────────────────────────────────────────────────
function planeToDataUrl(plane, win) {
  const { width, height, data } = plane;
  const lower = win?.lower ?? 0;
  const upper = win?.upper ?? 1;
  const span = upper > lower ? upper - lower : 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    let g = 0;
    if (Number.isFinite(v)) g = Math.max(0, Math.min(255, Math.round(((v - lower) / span) * 255)));
    const o = i * 4;
    rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(width, height);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

// Map a client-space click to plane pixel coords, honouring the letterbox the
// <img>'s object-contain fit introduces when the pane's aspect ratio differs
// from the plane's. The old mapping assumed the image filled the wrapper, so
// on a letterboxed pane clicks landed on the wrong voxels (wrong-distance
// measurements). Returns null for clicks in the letterbox gutters or when the
// boxes are degenerate.
function clientToPlanePixel(e, wrapEl, plane) {
  if (!plane || !wrapEl) return null;
  const rect = wrapEl.getBoundingClientRect();
  if (!rect.width || !rect.height || !plane.width || !plane.height) return null;
  const scale = Math.min(rect.width / plane.width, rect.height / plane.height);
  const drawnW = plane.width * scale;
  const drawnH = plane.height * scale;
  const left = rect.left + (rect.width - drawnW) / 2;
  const top = rect.top + (rect.height - drawnH) / 2;
  const fx = (e.clientX - left) / drawnW;
  const fy = (e.clientY - top) / drawnH;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return {
    c: Math.round(fx * (plane.width - 1)),
    r: Math.round(fy * (plane.height - 1)),
  };
}

const DEFAULTS = { angleDeg: 0, scrollMm: 0, slabMm: 2 };

// A single measurement-capable pane. Click two points to measure (mm). Draws
// the L/R edge labels derived from the plane uAxis (never mirrored).
function MeasurePane({ plane, win, label, color, onMeasure, measureMm }) {
  const url = useMemo(() => (plane ? planeToDataUrl(plane, win) : null), [plane, win]);
  const [pts, setPts] = useState([]);
  const wrapRef = useRef(null);
  const lr = plane ? lrLabelsForUaxis(plane.uAxis) : null;

  // The drawn points belong to ONE specific cut — drop them whenever the
  // plane rebuilds (angle/scroll/slab/centre change), otherwise a stale
  // measurement overlays a slice it was never taken on.
  useEffect(() => { setPts([]); }, [plane]);

  const onClick = (e) => {
    const px = clientToPlanePixel(e, wrapRef.current, plane);
    if (!px) return;
    const next = pts.length >= 2 ? [px] : [...pts, px];
    setPts(next);
    if (next.length === 2) {
      const mm = measurePixels(plane, next[0], next[1]);
      onMeasure?.(mm, next);
    }
  };

  return (
    <div className="relative bg-black rounded overflow-hidden border border-neutral-800" style={{ minHeight: 0 }}>
      <div ref={wrapRef} className="w-full h-full cursor-crosshair" onClick={onClick}>
        {url ? (
          <img src={url} alt={label} className="w-full h-full object-contain select-none" draggable={false} />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-neutral-600 text-xs">no image</div>
        )}
      </div>
      <span className="absolute top-1 left-2 text-[10px] font-semibold tracking-wide" style={{ color }}>{label}</span>
      {lr && (
        <>
          <span className="absolute top-1/2 left-1 -translate-y-1/2 text-[11px] font-bold text-amber-300/80">{lr.leftEdge}</span>
          <span className="absolute top-1/2 right-1 -translate-y-1/2 text-[11px] font-bold text-amber-300/80">{lr.rightEdge}</span>
        </>
      )}
      {/* xMidYMid meet letterboxes the viewBox exactly like the img's
          object-contain, so the overlay lands on the image, not the wrapper. */}
      {pts.length > 0 && plane && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${plane.width} ${plane.height}`} preserveAspectRatio="xMidYMid meet">
          {pts.map((p, i) => (
            <circle key={i} cx={p.c} cy={p.r} r={Math.max(1, plane.width / 120)} fill="rgb(245,158,11)" />
          ))}
          {pts.length === 2 && (
            <line x1={pts[0].c} y1={pts[0].r} x2={pts[1].c} y2={pts[1].r} stroke="rgb(245,158,11)" strokeWidth={Math.max(0.5, plane.width / 200)} />
          )}
        </svg>
      )}
      {measureMm != null && (
        <span className="absolute bottom-1 right-2 text-[10px] font-mono text-amber-300 bg-black/60 px-1 rounded">{measureMm.toFixed(1)} mm</span>
      )}
    </div>
  );
}

// Build a small axial locator slab (u = patient LEFT, v = patient ANTERIOR so
// "up" on the locator is anterior) through a condyle centre. MIP for clarity.
function makeAxialLocator(vol, center) {
  const ax = patientAxes(vol.direction);
  return sampleObliquePlane(vol, center, ax.left, ax.anterior, {
    widthMm: 44, heightMm: 44, slabThicknessMm: 3, projection: 'mip',
  });
}

function SideColumn({
  side, label, state, win, onMeasure, measures, onRefineCenter, controls,
}) {
  if (!state) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm p-4">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Locating {label} condyle…
      </div>
    );
  }
  if (!state.inFov || !state.planes) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-neutral-950">
        <AlertTriangle className="h-8 w-8 text-amber-400 mb-3" />
        <div className="text-sm font-medium text-neutral-200 mb-1">{label} condyle</div>
        <div className="text-xs text-neutral-400 max-w-[16rem]">
          Condyles outside this scan&apos;s field of view. This looks like a
          dento-alveolar (limited) scan — the joint is not captured.
        </div>
      </div>
    );
  }
  const { planes, locator } = state;
  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 gap-1 p-1">
      <div className="text-[11px] font-semibold text-amber-400 px-1">{label} CONDYLE</div>
      <div className="grid grid-cols-2 gap-1 flex-1 min-h-0">
        <MeasurePane
          plane={planes.parasagittal} win={win} label="PARASAGITTAL" color="rgb(120,160,240)"
          onMeasure={(mm, pts) => onMeasure(side, 'parasagittal', mm, pts)}
          measureMm={measures?.[`${side}.parasagittal`]?.mm}
        />
        <MeasurePane
          plane={planes.coronal} win={win} label="CORONAL" color="rgb(120,200,120)"
          onMeasure={(mm, pts) => onMeasure(side, 'coronal', mm, pts)}
          measureMm={measures?.[`${side}.coronal`]?.mm}
        />
        <div className="col-span-2 h-24">
          <LocatorPane
            plane={locator}
            onRefine={(world) => onRefineCenter(side, world)}
          />
        </div>
      </div>
      {controls}
    </div>
  );
}

// Axial reference locator with cut lines + click-to-refine.
function LocatorPane({ plane, onRefine }) {
  const url = useMemo(() => (plane ? planeToDataUrl(plane, planeWindow(plane)) : null), [plane]);
  const wrapRef = useRef(null);
  const lr = plane ? lrLabelsForUaxis(plane.uAxis) : null;
  const onClick = (e) => {
    if (!onRefine) return;
    const px = clientToPlanePixel(e, wrapRef.current, plane);
    if (!px) return;
    const { c, r } = px;
    // map pixel → world via plane axes
    const halfW = (plane.width - 1) / 2;
    const halfH = (plane.height - 1) / 2;
    const uOff = (c - halfW) * plane.pixelMm;
    const vOff = (halfH - r) * plane.pixelMm;
    const w = [
      plane.centerWorld[0] + plane.uAxis[0] * uOff + plane.vAxis[0] * vOff,
      plane.centerWorld[1] + plane.uAxis[1] * uOff + plane.vAxis[1] * vOff,
      plane.centerWorld[2] + plane.uAxis[2] * uOff + plane.vAxis[2] * vOff,
    ];
    onRefine(w);
  };
  return (
    <div className="relative w-full h-full bg-black rounded overflow-hidden border border-neutral-800">
      <div ref={wrapRef} className="w-full h-full cursor-crosshair" onClick={onClick} title="Click to refine the condyle centre">
        {url ? <img src={url} alt="axial locator" className="w-full h-full object-contain select-none" draggable={false} />
          : <div className="w-full h-full flex items-center justify-center text-neutral-600 text-[10px]">locator</div>}
      </div>
      <span className="absolute top-0.5 left-1.5 text-[9px] font-semibold text-neutral-300">AXIAL · click to refine</span>
      {/* parasagittal + coronal cut lines through centre (centre = mid pixel);
          xMidYMid meet matches the img's object-contain letterbox. */}
      {plane && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${plane.width} ${plane.height}`} preserveAspectRatio="xMidYMid meet">
          <line x1={plane.width / 2} y1={0} x2={plane.width / 2} y2={plane.height} stroke="rgb(120,160,240)" strokeWidth={Math.max(0.4, plane.width / 220)} opacity="0.7" />
          <line x1={0} y1={plane.height / 2} x2={plane.width} y2={plane.height / 2} stroke="rgb(120,200,120)" strokeWidth={Math.max(0.4, plane.width / 220)} opacity="0.7" />
          <circle cx={plane.width / 2} cy={plane.height / 2} r={Math.max(1, plane.width / 90)} fill="none" stroke="rgb(245,158,11)" strokeWidth={Math.max(0.4, plane.width / 220)} />
        </svg>
      )}
      {lr && (
        <>
          <span className="absolute bottom-0.5 left-1 text-[10px] font-bold text-amber-300/80">{lr.leftEdge}</span>
          <span className="absolute bottom-0.5 right-1 text-[10px] font-bold text-amber-300/80">{lr.rightEdge}</span>
        </>
      )}
    </div>
  );
}

export default function TmjMode({ studyId, getCurrentVolume, fileName = 'CBCT', onCapture }) {
  const [status, setStatus] = useState('init'); // init | ready | error | nofov
  const [error, setError] = useState(null);
  // per-side refined centre (world) + view params, persisted to viewer_annotations.tmj
  const [sides, setSides] = useState({
    left: { center: null, inFov: false, ...DEFAULTS },
    right: { center: null, inFov: false, ...DEFAULTS },
  });
  const [planesBySide, setPlanesBySide] = useState({ left: null, right: null });
  const [win, setWin] = useState(null);
  // measures: { 'left.parasagittal': { mm, pts }, ... } plus joint-space quick measures
  const [measures, setMeasures] = useState({});
  const [jointSpace, setJointSpace] = useState({ left: {}, right: {} });
  const [saveMsg, setSaveMsg] = useState('');
  const volRef = useRef(null);
  const captureRef = useRef(null);

  // ── locate condyles + load any saved TMJ annotations ─────────────────────
  useEffect(() => {
    let off = false;
    let timer = null;
    setStatus('init');
    setError(null);
    const tryInit = async () => {
      const vol = getCurrentVolume?.();
      if (!vol) {
        // The parent volume may still be streaming — poll until its voxel
        // data is available (ImplantMode's boot pattern). The old one-shot
        // check errored out permanently when TMJ opened before the volume
        // finished loading.
        if (!off) timer = setTimeout(tryInit, 1200);
        return;
      }
      volRef.current = vol;
      await new Promise((r) => setTimeout(r, 30));
      let res;
      try {
        res = locateCondyles(vol);
      } catch (e) {
        if (off) return;
        setStatus('error'); setError(e?.message || 'Condyle localization failed.');
        return;
      }
      if (off) return;

      // load saved refinements (override the auto centres / angles / measures)
      let saved = null;
      if (studyId) {
        try {
          const { data } = await supabase.from('imaging_studies')
            .select('viewer_annotations').eq('id', studyId).single();
          saved = data?.viewer_annotations?.tmj || null;
        } catch (_) { /* ignore */ }
      }
      if (off) return;

      const mk = (sideRes, savedSide) => ({
        center: savedSide?.center || sideRes.centerWorld,
        inFov: sideRes.inFov || !!savedSide?.center,
        angleDeg: savedSide?.angleDeg ?? DEFAULTS.angleDeg,
        scrollMm: savedSide?.scrollMm ?? DEFAULTS.scrollMm,
        slabMm: savedSide?.slabMm ?? DEFAULTS.slabMm,
        support: sideRes.support,
      });
      setSides({
        left: mk(res.left, saved?.left),
        right: mk(res.right, saved?.right),
      });
      // Fresh init: forget the previous build signatures so the FIRST rebuild
      // (which reproduces the saved side params) keeps the saved measures.
      lastBuiltRef.current = { left: null, right: null };
      if (saved?.measures) setMeasures(saved.measures);
      if (saved?.jointSpace) setJointSpace(saved.jointSpace);
      const anyFov = res.left.inFov || res.right.inFov || saved?.left?.center || saved?.right?.center;
      setStatus(anyFov ? 'ready' : 'nofov');
    };
    tryInit();
    return () => { off = true; clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyId]);

  // ── (re)build planes when a side's centre / angle / slab / scroll changes ──
  // Geometry signature of the last-built planes per side: when it changes, the
  // recorded pane measurements refer to a cut that no longer exists and must
  // be dropped (stale-measurement bug). The first build after init is exempt —
  // it reproduces the SAVED side params, so saved measures stay valid.
  const lastBuiltRef = useRef({ left: null, right: null });
  const rebuildSide = useCallback((sideKey, sideState) => {
    const vol = volRef.current;
    if (!vol || !sideState.center) { setPlanesBySide((p) => ({ ...p, [sideKey]: null })); return; }
    const sig = JSON.stringify([sideState.center, sideState.angleDeg, sideState.scrollMm, sideState.slabMm]);
    if (lastBuiltRef.current[sideKey] != null && lastBuiltRef.current[sideKey] !== sig) {
      setMeasures((m) => {
        const kPara = `${sideKey}.parasagittal`;
        const kCor = `${sideKey}.coronal`;
        if (!(kPara in m) && !(kCor in m)) return m;
        const next = { ...m };
        delete next[kPara];
        delete next[kCor];
        return next;
      });
    }
    lastBuiltRef.current[sideKey] = sig;
    try {
      const planes = buildCondylePlanes(vol, sideState.center, {
        angleDeg: sideState.angleDeg,
        offsetMm: sideState.scrollMm,
        slabThicknessMm: sideState.slabMm,
        projection: 'mean',
        sizeMm: 46,
      });
      setPlanesBySide((p) => ({
        ...p,
        [sideKey]: { ...planes, locator: makeAxialLocator(vol, sideState.center) },
      }));
    } catch (e) {
      setPlanesBySide((p) => ({ ...p, [sideKey]: null }));
    }
  }, []);

  useEffect(() => { if (status === 'ready' || status === 'nofov') rebuildSide('left', sides.left); }, [sides.left, status, rebuildSide]);
  useEffect(() => { if (status === 'ready' || status === 'nofov') rebuildSide('right', sides.right); }, [sides.right, status, rebuildSide]);

  // shared display window from whichever side has planes
  useEffect(() => {
    const p = planesBySide.left?.parasagittal || planesBySide.right?.parasagittal;
    if (p && !win) { const w = planeWindow(p); if (w) setWin(w); }
  }, [planesBySide, win]);

  const refineCenter = useCallback((sideKey, world) => {
    setSides((s) => ({ ...s, [sideKey]: { ...s[sideKey], center: world, inFov: true } }));
  }, []);

  const setParam = useCallback((sideKey, key, value) => {
    setSides((s) => ({ ...s, [sideKey]: { ...s[sideKey], [key]: value } }));
  }, []);

  const onMeasure = useCallback((sideKey, pane, mm, pts) => {
    setMeasures((m) => ({ ...m, [`${sideKey}.${pane}`]: { mm, pts } }));
  }, []);

  // joint-space quick measure: records the current parasagittal linear measure
  // into anterior/superior/posterior slot for that side.
  const recordJointSpace = useCallback((sideKey, slot) => {
    const meas = measures[`${sideKey}.parasagittal`];
    if (!meas) { setSaveMsg('Measure on the parasagittal pane first (click two points).'); return; }
    setJointSpace((j) => ({ ...j, [sideKey]: { ...j[sideKey], [slot]: Number(meas.mm.toFixed(2)) } }));
  }, [measures]);

  const saveTmj = useCallback(async () => {
    if (!studyId) { setSaveMsg('No study to save to.'); return; }
    try {
      const payload = {
        left: pickSide(sides.left), right: pickSide(sides.right),
        measures, jointSpace, updatedAt: new Date().toISOString(),
      };
      const { data: row } = await supabase.from('imaging_studies')
        .select('viewer_annotations').eq('id', studyId).single();
      const merged = { ...(row?.viewer_annotations || {}), tmj: payload };
      const { error: upErr } = await supabase.from('imaging_studies')
        .update({ viewer_annotations: merged, viewer_annotations_updated_at: new Date().toISOString() })
        .eq('id', studyId);
      if (upErr) throw upErr;
      setSaveMsg('TMJ analysis saved.');
    } catch (e) {
      setSaveMsg('Save failed: ' + (e?.message || 'error'));
    }
  }, [studyId, sides, measures, jointSpace]);

  const capture = useCallback(() => {
    const node = captureRef.current;
    if (!node) return;
    // Compose the two parasagittal + coronal panes into one PNG for the gallery.
    const imgs = Array.from(node.querySelectorAll('img'));
    if (!imgs.length) return;
    const canvas = document.createElement('canvas');
    const cols = 2; const cellW = 256; const cellH = 256;
    const rows = Math.ceil(imgs.length / cols);
    canvas.width = cellW * cols; canvas.height = cellH * rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    imgs.forEach((im, i) => {
      const x = (i % cols) * cellW; const y = Math.floor(i / cols) * cellH;
      try { ctx.drawImage(im, x, y, cellW, cellH); } catch (_) { /* ignore */ }
    });
    const url = canvas.toDataURL('image/png');
    const label = `${fileName}_TMJ`;
    if (onCapture) { onCapture(url, 'TMJ'); setSaveMsg('Captured to Gallery.'); }
    else { const a = document.createElement('a'); a.download = `${label}.png`; a.href = url; a.click(); }
  }, [fileName, onCapture]);

  const Controls = (sideKey) => {
    const s = sides[sideKey];
    if (!s?.inFov) return null;
    return (
      <div className="flex flex-wrap items-center gap-2 px-1 text-[10px] text-neutral-300">
        <label className="flex items-center gap-1">Angle
          <input type="range" min={-40} max={40} value={s.angleDeg}
            onChange={(e) => setParam(sideKey, 'angleDeg', Number(e.target.value))} className="w-16" />
          <span className="w-7 font-mono">{s.angleDeg}°</span>
        </label>
        <label className="flex items-center gap-1">Scroll
          <input type="range" min={-15} max={15} value={s.scrollMm}
            onChange={(e) => setParam(sideKey, 'scrollMm', Number(e.target.value))} className="w-16" />
          <span className="w-9 font-mono">{s.scrollMm}mm</span>
        </label>
        <label className="flex items-center gap-1">Slab
          <input type="range" min={0} max={10} value={s.slabMm}
            onChange={(e) => setParam(sideKey, 'slabMm', Number(e.target.value))} className="w-14" />
          <span className="w-9 font-mono">{s.slabMm}mm</span>
        </label>
        <div className="flex items-center gap-1">
          <span className="text-neutral-500">Joint:</span>
          {['anterior', 'superior', 'posterior'].map((slot) => (
            <button key={slot} type="button" onClick={() => recordJointSpace(sideKey, slot)}
              className="px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-[9px]"
              title={`Record current parasagittal measure as ${slot} joint space`}>
              {slot[0].toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    );
  };

  if (status === 'init') {
    return (
      <div className="h-full w-full flex items-center justify-center bg-neutral-950 text-neutral-300">
        <Loader2 className="h-6 w-6 animate-spin text-amber-400 mr-2" /> Loading volume · locating condyles…
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-neutral-950 text-center p-6">
        <AlertTriangle className="h-8 w-8 text-red-400 mb-3" />
        <div className="text-sm text-neutral-200 mb-1">TMJ mode unavailable</div>
        <div className="text-xs text-neutral-400 max-w-sm">{error}</div>
      </div>
    );
  }
  if (status === 'nofov') {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-neutral-950 text-center p-6">
        <Activity className="h-9 w-9 text-amber-400 mb-3" />
        <div className="text-base font-semibold text-neutral-100 mb-1">Condyles outside this scan&apos;s field of view</div>
        <div className="text-sm text-neutral-400 max-w-md">
          This appears to be a limited dento-alveolar scan — the temporomandibular
          joints are not captured in the volume, so a dual-condyle TMJ view can&apos;t
          be reconstructed. Use a TMJ or full-FOV CBCT for joint assessment.
        </div>
      </div>
    );
  }

  const sideState = (key) => {
    const s = sides[key];
    const planes = planesBySide[key];
    return {
      inFov: s.inFov, center: s.center,
      planes: planes ? { parasagittal: planes.parasagittal, coronal: planes.coronal } : null,
      locator: planes?.locator || null,
    };
  };

  return (
    <div className="h-full w-full flex flex-col bg-neutral-950">
      {/* toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-900 border-b border-neutral-800">
        <Activity className="h-4 w-4 text-amber-400" />
        <span className="text-xs font-semibold text-amber-400">TMJ — dual condyle</span>
        <span className="text-[10px] text-neutral-500 hidden md:inline">
          Maxilla-up · radiological L/R from the direction matrix · click two points on a pane to measure
        </span>
        <div className="flex-1" />
        {saveMsg && <span className="text-[10px] text-amber-300 mr-2">{saveMsg}</span>}
        <button type="button" onClick={capture} title="Capture to gallery"
          className="px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-[11px] inline-flex items-center gap-1">
          <Camera className="h-3.5 w-3.5" /> Capture
        </button>
        <button type="button" onClick={saveTmj} title="Save TMJ analysis"
          className="px-2 py-1 rounded bg-amber-500 text-black text-[11px] inline-flex items-center gap-1 hover:bg-amber-400">
          <Save className="h-3.5 w-3.5" /> Save
        </button>
      </div>

      {/* dual-condyle stage: radiological R | L (patient RIGHT on viewer left) */}
      <div ref={captureRef} className="flex-1 flex min-h-0">
        <SideColumn
          side="right" label="RIGHT" state={sideState('right')} win={win}
          onMeasure={onMeasure} measures={measures} onRefineCenter={refineCenter}
          controls={Controls('right')}
        />
        <div className="w-px bg-neutral-800" />
        <SideColumn
          side="left" label="LEFT" state={sideState('left')} win={win}
          onMeasure={onMeasure} measures={measures} onRefineCenter={refineCenter}
          controls={Controls('left')}
        />
      </div>

      {/* comparison table: left vs right joint-space + measures */}
      <div className="shrink-0 bg-neutral-900 border-t border-neutral-800 px-3 py-2">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">Joint-space comparison (mm)</div>
        <table className="text-[11px] text-neutral-300 w-full max-w-md">
          <thead>
            <tr className="text-neutral-500">
              <th className="text-left font-normal">Space</th>
              <th className="text-right font-normal">Right</th>
              <th className="text-right font-normal">Left</th>
              <th className="text-right font-normal">Δ</th>
            </tr>
          </thead>
          <tbody>
            {['anterior', 'superior', 'posterior'].map((slot) => {
              const r = jointSpace.right?.[slot];
              const l = jointSpace.left?.[slot];
              const d = (Number.isFinite(r) && Number.isFinite(l)) ? Math.abs(r - l) : null;
              return (
                <tr key={slot}>
                  <td className="capitalize">{slot}</td>
                  <td className="text-right font-mono">{Number.isFinite(r) ? r.toFixed(1) : '—'}</td>
                  <td className="text-right font-mono">{Number.isFinite(l) ? l.toFixed(1) : '—'}</td>
                  <td className="text-right font-mono">{d != null ? d.toFixed(1) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function pickSide(s) {
  return s?.center ? {
    center: s.center, angleDeg: s.angleDeg, scrollMm: s.scrollMm, slabMm: s.slabMm,
  } : null;
}
