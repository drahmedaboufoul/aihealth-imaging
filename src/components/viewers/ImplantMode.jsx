/*
 * ImplantMode — the Implant planning tab of the CBCT viewer.
 *
 * An honest 2D implant-planning workflow on the reconstructed views (NOT a
 * surgical-guide CAD):
 *
 *   1. Interactive cross-section browser: a panoramic strip (generatePanoramic
 *      along the saved/traced/auto arch) with a draggable position marker, and
 *      a LARGE perpendicular cross-section at that exact arc-length position
 *      (implantPlanning.crossSectionAt — single arbitrary position, unlike the
 *      fixed-count generateCrossSections). Prev/next stepping (0.5–2 mm), slab
 *      thickness, zoom, and an approximate FDI tooth-zone readout.
 *   2. Measurements on the cross-section in exact mm (the sampling grid is in
 *      mm-space): click-drag linear, vertical "crest height", and a one-click
 *      "ridge width @ depth" estimate. Persisted per arc position.
 *   3. Mandibular canal marking: click the canal centre on several posterior
 *      sections; the path interpolates between marks (never extrapolates) and
 *      every nearby section shows the canal + a configurable safety-margin
 *      ring. Implants too close to the canal flag red.
 *   4. Implant placement: generic cylinders (3.0–5.0 mm × 6–16 mm + custom)
 *      placed on the cross-section (drag platform to move, drag apex to
 *      angulate), with per-implant site label, dimensions and distance-to-
 *      canal readout. Ticks on the pano strip mark every implant's position.
 *
 * Persistence: imaging_studies.viewer_annotations.implant_plans (jsonb, same
 * pattern as `arch` / `mesh_registrations` — no schema change). Explicit Save,
 * dirty indicator; the saved plan reloads when the tab reopens.
 *
 * All volume math lives in src/lib/implantPlanning.js (pure, unit-tested);
 * this file is canvas drawing + interaction + persistence wiring only. It
 * never touches the parent's cornerstone engine — it samples the cached
 * volume's typed array via getCurrentVolume(), exactly like Compare does.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Loader2, Save, Camera, Trash2, AlertTriangle, ChevronLeft, ChevronRight,
  ZoomIn, ZoomOut, Ruler, MousePointer2, MoveVertical, Route, Plus, Crosshair,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { generatePanoramic, computeImageWindow, sanitizeArchPoints } from '@/lib/curvedMpr';
import { detectDentalArch } from '@/lib/autoArch';
import { EmptyState } from '@/components/viewers/cbctViewModes';
import {
  createArchFrame, crossSectionAt, sectionPixelToPlane, planeToSectionPixel,
  planeDistanceMm, estimateRidgeWidth, estimateFdiZone,
  upsertCanalPoint, removeCanalPointNear, canalCenterAt, canalRange,
  makeImplant, implantPlaneEndpoints, implantCanalClearance,
  emptyImplantPlan, getImplantPlan, upsertImplantPlan, measurementKey,
  IMPLANT_DIAMETERS_MM, IMPLANT_LENGTHS_MM, CANAL_DEFAULTS,
} from '@/lib/implantPlanning';

const DISCLAIMER = 'Planning aid — not a surgical guide. Verify all measurements clinically.';

// Section sampling window (mm). 34 mm bucco-lingually covers any ridge; ±45 mm
// vertically spans crest → canal → inferior border.
const SECTION_OPTS = { widthMm: 34, vertAboveMm: 45, vertBelowMm: 45, maxDim: 512 };
// Measurements/canal marks drawn on a section when within this arc distance.
const SHOW_TOL_MM = 0.45;

// Float32 grayscale {width,height,data} (NaN = outside) → PNG data URL.
function floatImageToDataUrl(img, lower, upper) {
  const { width, height, data } = img;
  if (!width || !height) return null;
  const span = upper > lower ? upper - lower : 1;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imgData = ctx.createImageData(width, height);
  const rgba = imgData.data;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const g = Number.isFinite(v)
      ? Math.max(0, Math.min(255, Math.round(((v - lower) / span) * 255)))
      : 0;
    const o = i * 4;
    rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png');
}

// 2D point→segment distance in plane mm ({u,t} space).
function planePointToSegmentMm(p, a, b) {
  const du = b.u - a.u;
  const dt = b.t - a.t;
  const d2 = du * du + dt * dt;
  let f = d2 > 0 ? ((p.u - a.u) * du + (p.t - a.t) * dt) / d2 : 0;
  f = Math.max(0, Math.min(1, f));
  return Math.hypot(p.u - (a.u + du * f), p.t - (a.t + dt * f));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e5).toString(36)}`;

const TOOLS = [
  { id: 'select', label: 'Select / move implants', short: 'Select', Icon: MousePointer2 },
  { id: 'measure', label: 'Linear measure (drag)', short: 'Measure', Icon: Ruler },
  { id: 'height', label: 'Vertical height measure (drag — locks to vertical)', short: 'Height', Icon: MoveVertical },
  { id: 'ridge', label: 'Ridge width @ depth (one click on bone)', short: 'Ridge', Icon: Crosshair },
  { id: 'canal', label: 'Mark mandibular canal centre (click on several posterior sections)', short: 'Canal', Icon: Route },
];

const SmallBtn = ({ children, onClick, title, active = false, disabled = false, tone = '' }) => (
  <button
    type="button" title={title} onClick={onClick} disabled={disabled}
    className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors disabled:opacity-40 ${
      active
        ? 'bg-amber-500 text-black border-amber-500'
        : `bg-neutral-800 border-neutral-700 hover:bg-neutral-700 ${tone || 'text-neutral-200'}`
    }`}
  >
    {children}
  </button>
);

const SideSection = ({ title, children }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">{title}</div>
    {children}
  </div>
);

export default function ImplantMode({
  studyId = null, fileName = 'CBCT', getCurrentVolume, getArchControlPoints, onCapture,
}) {
  // ── boot: volume → saved plan → arch → pano ───────────────────────────────
  const [boot, setBoot] = useState({ phase: 'volume', error: null });
  const [bootSeq, setBootSeq] = useState(0);
  const [ctx, setCtx] = useState(null); // { vol, frame, archPts, archSource, panoUrl, lengthMm, leftAtStart }
  const [plan, setPlan] = useState(null);
  const [dirty, setDirty] = useState(false);

  // ── browsing / tools ──────────────────────────────────────────────────────
  const [s, setS] = useState(null);
  const [stepMm, setStepMm] = useState(1);
  const [slabMm, setSlabMm] = useState(1);
  const [zoom, setZoom] = useState(2);
  const [jaw, setJaw] = useState('lower');
  const [tool, setTool] = useState('select');
  const [selectedId, setSelectedId] = useState(null);
  const [msg, setMsg] = useState('');
  const [libDiam, setLibDiam] = useState(4.0);
  const [libLen, setLibLen] = useState(10);
  const [saving, setSaving] = useState(false);

  const canvasRef = useRef(null);
  const panoBoxRef = useRef(null);
  const dragRef = useRef(null);
  const [dragTick, setDragTick] = useState(0); // repaint during drags

  useEffect(() => {
    let off = false;
    let timer = null;
    setBoot({ phase: 'volume', error: null });
    const tryBoot = async () => {
      const vol = getCurrentVolume?.();
      if (!vol) {
        // The parent volume may still be streaming — poll until its voxel
        // data is available (same approach as Compare's backdrop builder).
        timer = setTimeout(tryBoot, 1200);
        return;
      }
      try {
        setBoot({ phase: 'building', error: null });
        await new Promise((r) => setTimeout(r, 30)); // paint the busy state
        if (off) return;
        // 1. Saved plan (its arch snapshot keeps stored s/u/t meaningful).
        let loaded = null;
        if (studyId) {
          try {
            const { data } = await supabase
              .from('imaging_studies').select('viewer_annotations').eq('id', studyId).single();
            loaded = getImplantPlan(data?.viewer_annotations);
          } catch (_) { /* plan stays null */ }
        }
        if (off) return;
        // 2. Arch: plan snapshot > traced/saved arch > auto-detection.
        let pts = sanitizeArchPoints(loaded?.arch?.points || []);
        let source = 'saved plan';
        if (pts.length < 3) {
          pts = sanitizeArchPoints(getArchControlPoints?.() || []);
          source = 'traced/saved arch';
        }
        if (pts.length < 3) {
          pts = detectDentalArch(vol).pointsWorld;
          source = 'auto-detected';
        }
        const kAxis = [vol.direction[6], vol.direction[7], vol.direction[8]];
        const frame = createArchFrame(pts, { verticalAxis: kAxis });
        // 3. Panoramic strip along the same arch (marker x ↔ arc length s).
        const pano = generatePanoramic(vol, pts, { verticalAxis: kAxis });
        const win = computeImageWindow(pano) || { lower: 0, upper: 1 };
        const panoUrl = floatImageToDataUrl(pano, win.lower, win.upper);
        // Patient-left end (LPS: +X = left) → correct FDI quadrant side.
        const leftAtStart = frame.posAt(0)[0] > frame.posAt(frame.lengthMm)[0];
        const planNext = loaded || emptyImplantPlan();
        if (!planNext.arch) planNext.arch = { points: pts, source };
        if (off) return;
        setPlan(planNext);
        setCtx({ vol, frame, archPts: pts, archSource: source, panoUrl, lengthMm: frame.lengthMm, leftAtStart });
        setS(Number.isFinite(planNext.implants[0]?.s) ? planNext.implants[0].s : frame.lengthMm / 2);
        setDirty(false);
        setBoot({ phase: 'ready', error: null });
      } catch (e) {
        console.error('[ImplantMode] init failed:', e);
        if (!off) setBoot({ phase: 'error', error: e?.message || 'Could not initialise implant planning' });
      }
    };
    tryBoot();
    return () => { off = true; clearTimeout(timer); };
  }, [studyId, getCurrentVolume, getArchControlPoints, bootSeq]);

  // ── current cross-section ─────────────────────────────────────────────────
  const sQ = s == null ? null : Math.round(s * 10) / 10; // quantize for sampling
  const section = useMemo(() => {
    if (!ctx || sQ == null) return null;
    try {
      return crossSectionAt(ctx.vol, ctx.frame, sQ, { ...SECTION_OPTS, slabThicknessMm: slabMm });
    } catch (e) {
      console.warn('[ImplantMode] cross-section failed:', e?.message);
      return null;
    }
  }, [ctx, sQ, slabMm]);

  // Grayscale backdrop, windowed to the section's own distribution.
  const baseCanvas = useMemo(() => {
    if (!section) return null;
    const win = computeImageWindow(section, 0.02, 0.995) || { lower: 0, upper: 1 };
    const c = document.createElement('canvas');
    c.width = section.width;
    c.height = section.height;
    const g = c.getContext('2d');
    if (!g) return null;
    const img = g.createImageData(section.width, section.height);
    const rgba = img.data;
    const span = win.upper > win.lower ? win.upper - win.lower : 1;
    for (let i = 0; i < section.data.length; i++) {
      const v = section.data[i];
      const gray = Number.isFinite(v)
        ? Math.max(0, Math.min(255, Math.round(((v - win.lower) / span) * 255)))
        : 0;
      const o = i * 4;
      rgba[o] = gray; rgba[o + 1] = gray; rgba[o + 2] = gray; rgba[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }, [section]);

  const fdi = useMemo(
    () => (ctx && sQ != null
      ? estimateFdiZone(sQ, ctx.lengthMm, { jaw, leftAtStart: ctx.leftAtStart })
      : null),
    [ctx, sQ, jaw]
  );

  // Per-implant canal clearance (3D, via the arch frame).
  const clearances = useMemo(() => {
    if (!ctx || !plan) return {};
    const out = {};
    for (const imp of plan.implants) {
      try { out[imp.id] = implantCanalClearance(ctx.frame, imp, plan.canal); } catch (_) { out[imp.id] = null; }
    }
    return out;
  }, [ctx, plan]);

  const range = plan ? canalRange(plan.canal) : null;

  // ── plan mutation helpers ─────────────────────────────────────────────────
  const updatePlan = useCallback((fn) => {
    setPlan((p) => (p ? fn(p) : p));
    setDirty(true);
  }, []);

  const measurementsNear = useMemo(() => {
    if (!plan || sQ == null) return [];
    const out = [];
    for (const [key, list] of Object.entries(plan.measurements || {})) {
      if (Math.abs(parseFloat(key) - sQ) <= SHOW_TOL_MM) {
        list.forEach((m) => out.push({ ...m, key }));
      }
    }
    return out;
  }, [plan, sQ]);

  const addMeasurement = useCallback((m) => {
    updatePlan((p) => {
      const key = measurementKey(sQ);
      const list = p.measurements[key] ? [...p.measurements[key]] : [];
      list.push({ id: newId('m'), ...m });
      return { ...p, measurements: { ...p.measurements, [key]: list } };
    });
  }, [updatePlan, sQ]);

  const removeMeasurement = useCallback((key, id) => {
    updatePlan((p) => {
      const list = (p.measurements[key] || []).filter((m) => m.id !== id);
      const measurements = { ...p.measurements };
      if (list.length) measurements[key] = list; else delete measurements[key];
      return { ...p, measurements };
    });
  }, [updatePlan]);

  const updateImplant = useCallback((id, patch) => {
    updatePlan((p) => ({
      ...p,
      implants: p.implants.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    }));
  }, [updatePlan]);

  const addImplant = useCallback(() => {
    if (sQ == null) return;
    const imp = makeImplant({
      s: sQ, u: 0, t: -1,
      diameterMm: libDiam, lengthMm: libLen,
      site: fdi ? `FDI ${fdi.fdi}` : '',
    });
    updatePlan((p) => ({ ...p, implants: [...p.implants, imp] }));
    setSelectedId(imp.id);
    setTool('select');
    setMsg('Implant added — drag its platform to position, drag the apex dot to angulate.');
  }, [sQ, libDiam, libLen, fdi, updatePlan]);

  const removeImplant = useCallback((id) => {
    updatePlan((p) => ({ ...p, implants: p.implants.filter((i) => i.id !== id) }));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, [updatePlan]);

  const jumpTo = useCallback((sVal) => {
    if (!ctx) return;
    setS(clamp(sVal, 0, ctx.lengthMm));
  }, [ctx]);

  const stepBy = useCallback((dir) => {
    if (!ctx || sQ == null) return;
    setS(clamp(sQ + dir * stepMm, 0, ctx.lengthMm));
  }, [ctx, sQ, stepMm]);

  // Arrow keys step the position.
  useEffect(() => {
    if (boot.phase !== 'ready') return undefined;
    const onKey = (e) => {
      if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepBy(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); stepBy(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [boot.phase, stepBy]);

  // ── canvas drawing ────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !section || !baseCanvas || !plan) return;
    const S = zoom;
    const W = Math.round(section.width * S);
    const H = Math.round(section.height * S);
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.imageSmoothingEnabled = true;
    g.clearRect(0, 0, W, H);
    g.drawImage(baseCanvas, 0, 0, W, H);

    const toPx = (u, t) => {
      const p = planeToSectionPixel(section, u, t);
      return [p.x * S, p.y * S];
    };
    const mmX = S / section.colSpacing; // px per mm horizontally
    const mmY = S / section.rowSpacing; // px per mm vertically

    // Arch-curve locus (u = 0): subtle dashed centre line.
    g.save();
    g.strokeStyle = 'rgba(245,158,11,0.35)';
    g.setLineDash([4, 6]);
    g.lineWidth = 1;
    const [cx0] = toPx(0, 0);
    g.beginPath(); g.moveTo(cx0, 0); g.lineTo(cx0, H); g.stroke();
    g.restore();

    // Canal: interpolated centre + safety-margin ring.
    const cCenter = canalCenterAt(plan.canal, sQ);
    if (cCenter) {
      const [px, py] = toPx(cCenter.u, cCenter.t);
      const radius = Number.isFinite(plan.canal.radiusMm) ? plan.canal.radiusMm : CANAL_DEFAULTS.radiusMm;
      const margin = Number.isFinite(plan.canal.marginMm) ? plan.canal.marginMm : CANAL_DEFAULTS.marginMm;
      g.save();
      g.fillStyle = 'rgba(239,68,68,0.30)';
      g.strokeStyle = 'rgba(239,68,68,0.95)';
      g.lineWidth = 1.5;
      g.beginPath(); g.ellipse(px, py, radius * mmX, radius * mmY, 0, 0, 2 * Math.PI); g.fill(); g.stroke();
      g.setLineDash([5, 4]);
      g.strokeStyle = 'rgba(251,146,60,0.9)';
      g.beginPath(); g.ellipse(px, py, (radius + margin) * mmX, (radius + margin) * mmY, 0, 0, 2 * Math.PI); g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(252,165,165,0.95)';
      g.font = '10px sans-serif';
      g.fillText('canal', px + (radius + margin) * mmX + 4, py);
      g.restore();
    }
    // Exact marked canal point on THIS section.
    (plan.canal.points || []).forEach((pt) => {
      if (Math.abs(pt.s - sQ) > SHOW_TOL_MM) return;
      const [px, py] = toPx(pt.u, pt.t);
      g.save();
      g.strokeStyle = 'rgb(248,113,113)';
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(px - 5, py); g.lineTo(px + 5, py); g.moveTo(px, py - 5); g.lineTo(px, py + 5); g.stroke();
      g.restore();
    });

    // Measurements at (or within tolerance of) this position.
    const drawMeasure = (m, preview = false) => {
      const [x0, y0] = toPx(m.p0.u, m.p0.t);
      const [x1, y1] = toPx(m.p1.u, m.p1.t);
      g.save();
      g.strokeStyle = m.kind === 'ridge' ? 'rgb(34,211,238)' : 'rgb(251,191,36)';
      g.fillStyle = g.strokeStyle;
      g.lineWidth = preview ? 1 : 1.5;
      if (preview) g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      [[x0, y0], [x1, y1]].forEach(([x, y]) => {
        g.beginPath(); g.arc(x, y, 2.5, 0, 2 * Math.PI); g.fill();
      });
      const val = Number.isFinite(m.valueMm) ? m.valueMm : planeDistanceMm(m.p0, m.p1);
      g.font = 'bold 11px sans-serif';
      const label = `${val.toFixed(1)} mm${m.kind === 'ridge' ? ' ridge' : m.kind === 'height' ? ' ht' : ''}`;
      const lx = (x0 + x1) / 2 + 6;
      const ly = (y0 + y1) / 2 - 5;
      g.strokeStyle = 'rgba(0,0,0,0.85)';
      g.lineWidth = 3;
      g.strokeText(label, lx, ly);
      g.fillText(label, lx, ly);
      g.restore();
    };
    measurementsNear.forEach((m) => drawMeasure(m));
    const drag = dragRef.current;
    if (drag?.type === 'measure') drawMeasure({ kind: drag.kind, p0: drag.p0, p1: drag.p1 }, true);

    // Implants: solid near this s, ghosted when a little further along the arch.
    plan.implants.forEach((imp) => {
      const ds = Math.abs(imp.s - sQ);
      const solidTol = Math.max(1.5, imp.diameterMm / 2);
      if (ds > 6) return;
      const alpha = ds <= solidTol ? 1 : 0.3;
      const ends = implantPlaneEndpoints(imp);
      const a = ((imp.angulationDeg || 0) * Math.PI) / 180;
      const perp = { u: Math.cos(a), t: Math.sin(a) };
      const r = imp.diameterMm / 2;
      const corners = [
        toPx(ends.platform.u - perp.u * r, ends.platform.t - perp.t * r),
        toPx(ends.platform.u + perp.u * r, ends.platform.t + perp.t * r),
        toPx(ends.apex.u + perp.u * r, ends.apex.t + perp.t * r),
        toPx(ends.apex.u - perp.u * r, ends.apex.t - perp.t * r),
      ];
      const unsafe = clearances[imp.id] && !clearances[imp.id].safe;
      const selected = imp.id === selectedId;
      g.save();
      g.globalAlpha = alpha;
      g.fillStyle = unsafe ? 'rgba(239,68,68,0.30)' : 'rgba(52,211,153,0.22)';
      g.strokeStyle = unsafe ? 'rgb(248,113,113)' : selected ? 'rgb(251,191,36)' : 'rgb(52,211,153)';
      g.lineWidth = selected ? 2 : 1.25;
      g.beginPath();
      g.moveTo(corners[0][0], corners[0][1]);
      corners.slice(1).forEach(([x, y]) => g.lineTo(x, y));
      g.closePath(); g.fill(); g.stroke();
      // Axis + handles: platform square (move), apex dot (rotate).
      const [pxx, pxy] = toPx(ends.platform.u, ends.platform.t);
      const [axx, axy] = toPx(ends.apex.u, ends.apex.t);
      g.beginPath(); g.moveTo(pxx, pxy); g.lineTo(axx, axy);
      g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]);
      g.fillStyle = g.strokeStyle;
      g.fillRect(pxx - 3.5, pxy - 3.5, 7, 7);
      g.beginPath(); g.arc(axx, axy, 4, 0, 2 * Math.PI); g.fill();
      // Label.
      g.font = 'bold 10px sans-serif';
      const label = `${imp.site || '?'} ${imp.diameterMm}×${imp.lengthMm}`;
      g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = 3;
      g.strokeText(label, pxx + 8, pxy - 6);
      g.fillText(label, pxx + 8, pxy - 6);
      g.restore();
    });

    // 10 mm scale bar.
    g.save();
    g.strokeStyle = 'rgb(212,212,212)';
    g.fillStyle = 'rgb(212,212,212)';
    g.lineWidth = 2;
    const bx = 10;
    const by = H - 12;
    g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + 10 * mmX, by); g.stroke();
    g.font = '10px sans-serif';
    g.fillText('10 mm', bx, by - 4);
    g.restore();
  }, [section, baseCanvas, plan, zoom, sQ, selectedId, clearances, measurementsNear]);

  useEffect(() => { draw(); }, [draw, dragTick]);

  // ── section pointer interaction ───────────────────────────────────────────
  const eventToPlane = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas || !section) return null;
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * section.width;
    const py = ((e.clientY - rect.top) / rect.height) * section.height;
    return sectionPixelToPlane(section, px, py);
  }, [section]);

  const onSectionDown = useCallback((e) => {
    if (e.button !== 0 || !plan || sQ == null) return;
    const p = eventToPlane(e);
    if (!p) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);

    if (tool === 'canal') {
      updatePlan((pl) => ({ ...pl, canal: upsertCanalPoint(pl.canal, { s: sQ, u: p.u, t: p.t }) }));
      setMsg(`Canal centre marked at ${sQ.toFixed(1)} mm. Mark several sections along the posterior arch.`);
      return;
    }
    if (tool === 'ridge') {
      const hit = estimateRidgeWidth(section, p.u, p.t);
      if (hit) {
        addMeasurement({
          kind: 'ridge',
          p0: { u: hit.u0, t: hit.tMm }, p1: { u: hit.u1, t: hit.tMm },
          valueMm: hit.widthMm,
        });
        setMsg(`Ridge width ≈ ${hit.widthMm.toFixed(1)} mm at this depth (threshold-based estimate — verify).`);
      } else {
        setMsg('Click ON the bony ridge to estimate its width at that depth.');
      }
      return;
    }
    if (tool === 'measure' || tool === 'height') {
      dragRef.current = { type: 'measure', kind: tool === 'height' ? 'height' : 'linear', p0: p, p1: p };
      setDragTick((v) => v + 1);
      return;
    }
    // select: hit-test implants near this section (platform move / apex rotate).
    let best = null;
    plan.implants.forEach((imp) => {
      if (Math.abs(imp.s - sQ) > Math.max(1.5, imp.diameterMm / 2)) return;
      const ends = implantPlaneEndpoints(imp);
      const dApex = Math.hypot(p.u - ends.apex.u, p.t - ends.apex.t);
      const dBody = planePointToSegmentMm(p, ends.platform, ends.apex);
      if (dApex <= 2.5 && (!best || dApex < best.d)) best = { imp, mode: 'rotate', d: dApex };
      else if (dBody <= imp.diameterMm / 2 + 1.5 && (!best || dBody < best.d)) best = { imp, mode: 'move', d: dBody };
    });
    if (best) {
      setSelectedId(best.imp.id);
      dragRef.current = {
        type: best.mode === 'rotate' ? 'implant-rotate' : 'implant-move',
        id: best.imp.id,
        grabDU: p.u - best.imp.u,
        grabDT: p.t - best.imp.t,
      };
    } else {
      setSelectedId(null);
    }
  }, [plan, sQ, tool, section, eventToPlane, updatePlan, addMeasurement]);

  const onSectionMove = useCallback((e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = eventToPlane(e);
    if (!p) return;
    if (drag.type === 'measure') {
      drag.p1 = drag.kind === 'height' ? { u: drag.p0.u, t: p.t } : p;
      setDragTick((v) => v + 1);
    } else if (drag.type === 'implant-move') {
      updateImplant(drag.id, { u: p.u - drag.grabDU, t: p.t - drag.grabDT });
    } else if (drag.type === 'implant-rotate') {
      const imp = plan?.implants.find((i) => i.id === drag.id);
      if (!imp) return;
      const du = p.u - imp.u;
      const dt = p.t - imp.t;
      if (Math.hypot(du, dt) < 1) return;
      const deg = (Math.atan2(du, -dt) * 180) / Math.PI;
      updateImplant(drag.id, { angulationDeg: Math.round(clamp(deg, -89, 89) * 2) / 2 });
    }
  }, [eventToPlane, updateImplant, plan]);

  const onSectionUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.type === 'measure') {
      const lenMm = planeDistanceMm(drag.p0, drag.p1);
      if (lenMm >= 0.5) {
        addMeasurement({ kind: drag.kind, p0: drag.p0, p1: drag.p1, valueMm: lenMm });
      }
      setDragTick((v) => v + 1);
    }
  }, [addMeasurement]);

  // ── pano strip interaction ────────────────────────────────────────────────
  const panoSeek = useCallback((e) => {
    if (!ctx || !panoBoxRef.current) return;
    const rect = panoBoxRef.current.getBoundingClientRect();
    const f = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    setS(f * ctx.lengthMm);
  }, [ctx]);

  const onPanoDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { type: 'pano' };
    panoSeek(e);
  }, [panoSeek]);

  const onPanoMove = useCallback((e) => {
    if (dragRef.current?.type === 'pano') panoSeek(e);
  }, [panoSeek]);

  const onPanoUp = useCallback(() => {
    if (dragRef.current?.type === 'pano') dragRef.current = null;
  }, []);

  // ── persistence ───────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!plan) return;
    if (!studyId) { setMsg('Cannot save — this viewer was opened without a study.'); return; }
    setSaving(true);
    try {
      const { data: row } = await supabase
        .from('imaging_studies').select('viewer_annotations').eq('id', studyId).single();
      const merged = upsertImplantPlan(row?.viewer_annotations, plan);
      const { error } = await supabase
        .from('imaging_studies')
        .update({ viewer_annotations: merged, viewer_annotations_updated_at: new Date().toISOString() })
        .eq('id', studyId);
      if (error) throw error;
      setDirty(false);
      setMsg('Implant plan saved to the study.');
    } catch (e) {
      setMsg('Save failed: ' + (e?.message || 'error'));
    } finally {
      setSaving(false);
    }
  }, [plan, studyId]);

  // ── capture: pano + section composite → Gallery + download ───────────────
  const capture = useCallback(async () => {
    const sectionCanvas = canvasRef.current;
    if (!sectionCanvas || !ctx?.panoUrl || sQ == null) return;
    try {
      const panoImg = new Image();
      await new Promise((resolve, reject) => {
        panoImg.onload = resolve;
        panoImg.onerror = () => reject(new Error('pano image failed'));
        panoImg.src = ctx.panoUrl;
      });
      const W = Math.max(sectionCanvas.width + 20, 720);
      const panoH = Math.max(80, Math.round((panoImg.height / panoImg.width) * W));
      const headH = 26;
      const footH = 22;
      const gap = 6;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = headH + panoH + gap + sectionCanvas.height + footH;
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#fbbf24';
      g.font = 'bold 13px sans-serif';
      g.fillText(
        `${fileName} — implant plan @ ${sQ.toFixed(1)} mm${fdi ? ` (≈ ${fdi.label})` : ''} · ${new Date().toLocaleString()}`,
        10, 17
      );
      g.drawImage(panoImg, 0, headH, W, panoH);
      // Position marker on the pano.
      const mx = (sQ / ctx.lengthMm) * W;
      g.strokeStyle = 'rgb(251,191,36)';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(mx, headH); g.lineTo(mx, headH + panoH); g.stroke();
      g.drawImage(sectionCanvas, Math.round((W - sectionCanvas.width) / 2), headH + panoH + gap);
      g.fillStyle = '#fbbf24';
      g.font = '11px sans-serif';
      g.fillText(DISCLAIMER, 10, c.height - 8);
      const url = c.toDataURL('image/png');
      const label = `implant_plan_${sQ.toFixed(1)}mm`;
      if (onCapture) onCapture(url, label);
      const a = document.createElement('a');
      a.download = `${fileName}_${label}.png`;
      a.href = url;
      a.click();
      setMsg(onCapture ? 'Capture added to the Gallery and downloaded.' : 'Capture downloaded.');
    } catch (e) {
      setMsg('Capture failed: ' + (e?.message || 'error'));
    }
  }, [ctx, sQ, fdi, fileName, onCapture]);

  // ── render ────────────────────────────────────────────────────────────────
  const allMeasurements = useMemo(() => {
    if (!plan) return [];
    return Object.entries(plan.measurements || {})
      .flatMap(([key, list]) => list.map((m) => ({ ...m, key, sMm: parseFloat(key) })))
      .sort((a, b) => a.sMm - b.sMm);
  }, [plan]);

  const cursorByTool = {
    select: 'cursor-default', measure: 'cursor-crosshair', height: 'cursor-crosshair',
    ridge: 'cursor-crosshair', canal: 'cursor-crosshair',
  }[tool];

  return (
    <div className="h-full flex flex-col bg-neutral-950 text-neutral-200">
      {/* Header: disclaimer + arch source + save/capture */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-900 border-b border-neutral-800 flex-wrap">
        <span className="text-xs font-semibold text-amber-400">Implant planning</span>
        <span className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-2 py-0.5 inline-flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" /> {DISCLAIMER}
        </span>
        {ctx && (
          <span className="text-[10px] text-neutral-500">
            arch: {ctx.archSource} · {ctx.lengthMm.toFixed(0)} mm
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {msg && <span className="text-[10px] text-amber-300 truncate max-w-[28rem]">{msg}</span>}
          <button
            type="button" onClick={capture} disabled={boot.phase !== 'ready'}
            title="Capture pano + cross-section into the Gallery (and download PNG)"
            className="px-2 py-1 rounded bg-neutral-800 border border-neutral-700 text-[11px] hover:bg-neutral-700 inline-flex items-center gap-1 disabled:opacity-40"
          >
            <Camera className="h-3.5 w-3.5" /> Capture
          </button>
          <button
            type="button" onClick={save} disabled={boot.phase !== 'ready' || saving}
            title="Save the implant plan to this study"
            className="px-2 py-1 rounded bg-emerald-600 text-white text-[11px] font-semibold hover:bg-emerald-500 inline-flex items-center gap-1 disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save{dirty ? ' *' : ''}
          </button>
        </div>
      </div>

      {boot.phase === 'error' && (
        <div className="flex-1 relative">
          <EmptyState
            Icon={AlertTriangle}
            title="Implant planning unavailable"
            body={`${boot.error || 'Initialisation failed'}. If the automatic arch detection failed, trace the dental arch on the MPR axial pane (Arch tool), save it, then reopen this tab.`}
          />
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
            <button
              type="button" onClick={() => setBootSeq((v) => v + 1)}
              className="px-4 py-1.5 rounded-full bg-amber-500 text-black text-xs font-semibold hover:bg-amber-400"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {(boot.phase === 'volume' || boot.phase === 'building') && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2">
          <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
          <span className="text-xs text-neutral-400">
            {boot.phase === 'volume'
              ? 'Waiting for the CBCT volume to finish loading…'
              : 'Building the panoramic and arch frame…'}
          </span>
        </div>
      )}

      {boot.phase === 'ready' && ctx && plan && (
        <>
          {/* Pano strip with draggable position marker */}
          <div
            ref={panoBoxRef}
            className="relative h-32 shrink-0 bg-black border-b border-neutral-800 cursor-crosshair select-none touch-none"
            onPointerDown={onPanoDown}
            onPointerMove={onPanoMove}
            onPointerUp={onPanoUp}
            title="Click / drag to choose the cross-section position along the arch"
          >
            {ctx.panoUrl
              ? <img src={ctx.panoUrl} alt="Panoramic (OPG)" draggable={false} className="h-full w-full object-fill opacity-90" />
              : <div className="h-full w-full flex items-center justify-center text-xs text-neutral-500">Panoramic unavailable</div>}
            {/* canal marked range */}
            {range && (
              <div
                className="absolute bottom-0 h-1.5 bg-red-500/60 pointer-events-none"
                style={{ left: `${(range.minS / ctx.lengthMm) * 100}%`, width: `${(Math.max(range.maxS - range.minS, 0.3) / ctx.lengthMm) * 100}%` }}
                title="Marked canal range"
              />
            )}
            {/* implant ticks */}
            {plan.implants.map((imp) => (
              <div
                key={imp.id}
                className={`absolute top-0 bottom-0 w-[2px] pointer-events-none ${clearances[imp.id] && !clearances[imp.id].safe ? 'bg-red-400/80' : 'bg-emerald-400/70'}`}
                style={{ left: `${(clamp(imp.s, 0, ctx.lengthMm) / ctx.lengthMm) * 100}%` }}
              />
            ))}
            {/* position marker */}
            {sQ != null && (
              <div
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{ left: `${(sQ / ctx.lengthMm) * 100}%` }}
              >
                <div className="absolute top-0 bottom-0 w-[2px] -translate-x-1/2 bg-amber-400" />
                <div className="absolute top-0 -translate-x-1/2 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-amber-400" />
              </div>
            )}
            <span className="absolute top-1.5 left-2 text-[10px] font-semibold tracking-wide text-amber-400 pointer-events-none">
              PANORAMIC — drag the marker to browse cross-sections
            </span>
          </div>

          {/* Cross-section + sidebar */}
          <div className="flex-1 flex min-h-0">
            <div className="flex-1 min-w-0 relative overflow-auto bg-black">
              <div className="min-h-full flex items-start justify-center py-2">
                {section ? (
                  <canvas
                    ref={canvasRef}
                    className={`touch-none ${cursorByTool}`}
                    onPointerDown={onSectionDown}
                    onPointerMove={onSectionMove}
                    onPointerUp={onSectionUp}
                    onPointerCancel={onSectionUp}
                    onContextMenu={(e) => e.preventDefault()}
                  />
                ) : (
                  <div className="text-xs text-neutral-500 mt-10">Cross-section unavailable at this position.</div>
                )}
              </div>
              <div className="absolute top-2 left-3 pointer-events-none text-[11px] leading-snug">
                <div className="font-semibold text-amber-400">
                  CROSS-SECTION @ {sQ?.toFixed(1)} mm / {ctx.lengthMm.toFixed(0)} mm
                </div>
                {fdi && (
                  <div className="text-neutral-300">
                    ≈ {fdi.label} zone <span className="text-neutral-500">(approximate — arc-length estimate)</span>
                  </div>
                )}
                <div className="text-neutral-500">slab {slabMm} mm MIP · buccal-lingual ↔ · superior ↑</div>
              </div>
            </div>

            <aside className="w-80 shrink-0 bg-neutral-900 border-l border-neutral-800 overflow-y-auto p-3 space-y-4">
              <SideSection title="Position">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <SmallBtn title={`Step back ${stepMm} mm (←)`} onClick={() => stepBy(-1)}><ChevronLeft className="h-3 w-3" /></SmallBtn>
                  <SmallBtn title={`Step forward ${stepMm} mm (→)`} onClick={() => stepBy(1)}><ChevronRight className="h-3 w-3" /></SmallBtn>
                  <span className="text-[11px] text-neutral-300 tabular-nums">{sQ?.toFixed(1)} mm</span>
                  <span className="text-[10px] text-neutral-500">step</span>
                  {[0.5, 1, 2].map((v) => (
                    <SmallBtn key={v} active={stepMm === v} onClick={() => setStepMm(v)}>{v}</SmallBtn>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                  <span className="text-[10px] text-neutral-500">slab</span>
                  {[0.5, 1, 2, 3, 5].map((v) => (
                    <SmallBtn key={v} active={slabMm === v} onClick={() => setSlabMm(v)} title={`${v} mm MIP slab`}>{v}</SmallBtn>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                  <span className="text-[10px] text-neutral-500">zoom</span>
                  <SmallBtn title="Zoom out" onClick={() => setZoom((z) => Math.max(1, z - 0.5))}><ZoomOut className="h-3 w-3" /></SmallBtn>
                  <span className="text-[11px] text-neutral-300">{zoom.toFixed(1)}×</span>
                  <SmallBtn title="Zoom in" onClick={() => setZoom((z) => Math.min(6, z + 0.5))}><ZoomIn className="h-3 w-3" /></SmallBtn>
                  <span className="text-[10px] text-neutral-500 ml-2">jaw</span>
                  <SmallBtn active={jaw === 'lower'} onClick={() => setJaw('lower')} title="FDI quadrants 3/4">Lower</SmallBtn>
                  <SmallBtn active={jaw === 'upper'} onClick={() => setJaw('upper')} title="FDI quadrants 1/2">Upper</SmallBtn>
                </div>
              </SideSection>

              <SideSection title="Tool">
                <div className="grid grid-cols-5 gap-1">
                  {TOOLS.map(({ id, label, short, Icon }) => (
                    <button
                      key={id} type="button" title={label} onClick={() => setTool(id)}
                      className={`flex flex-col items-center gap-0.5 py-1.5 rounded text-[9px] border transition-colors ${
                        tool === id ? 'bg-amber-500 text-black border-amber-500' : 'bg-neutral-800 border-neutral-700 text-neutral-300 hover:bg-neutral-700'}`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {short}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-neutral-500 mt-1 leading-snug">
                  {{
                    select: 'Drag an implant body to move it; drag its apex dot to angulate.',
                    measure: 'Click-drag a line on the cross-section — exact mm.',
                    height: 'Click-drag — the line locks vertical (crest-to-landmark height).',
                    ridge: 'One click ON the ridge: estimates bone width at that depth (verify).',
                    canal: 'Click the canal centre. Repeat on several posterior sections; the path interpolates between marks.',
                  }[tool]}
                </p>
              </SideSection>

              <SideSection title={`Mandibular canal ${range ? `· ${range.count} pts (${range.minS.toFixed(0)}–${range.maxS.toFixed(0)} mm)` : '· not marked'}`}>
                <div className="flex items-center gap-2 flex-wrap text-[11px]">
                  <label className="flex items-center gap-1 text-neutral-400">
                    radius
                    <input
                      type="number" min="0.5" max="3" step="0.25" value={plan.canal.radiusMm}
                      onChange={(e) => updatePlan((p) => ({ ...p, canal: { ...p.canal, radiusMm: clamp(Number(e.target.value) || CANAL_DEFAULTS.radiusMm, 0.5, 3) } }))}
                      className="w-14 bg-neutral-800 border border-neutral-700 rounded px-1 py-0.5 text-neutral-200"
                    /> mm
                  </label>
                  <label className="flex items-center gap-1 text-neutral-400">
                    margin
                    <input
                      type="number" min="0.5" max="4" step="0.5" value={plan.canal.marginMm}
                      onChange={(e) => updatePlan((p) => ({ ...p, canal: { ...p.canal, marginMm: clamp(Number(e.target.value) || CANAL_DEFAULTS.marginMm, 0.5, 4) } }))}
                      className="w-14 bg-neutral-800 border border-neutral-700 rounded px-1 py-0.5 text-neutral-200"
                    /> mm
                  </label>
                </div>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <SmallBtn
                    title="Remove the canal point nearest this section (±2 mm)"
                    onClick={() => updatePlan((p) => ({ ...p, canal: removeCanalPointNear(p.canal, sQ) }))}
                    disabled={!range}
                  >
                    Remove point here
                  </SmallBtn>
                  <SmallBtn
                    tone="text-red-300"
                    title="Clear all canal points"
                    disabled={!range}
                    onClick={() => updatePlan((p) => ({ ...p, canal: { ...p.canal, points: [] } }))}
                  >
                    Clear canal
                  </SmallBtn>
                </div>
                <p className="text-[10px] text-neutral-500 mt-1 leading-snug">
                  The canal renders only INSIDE the marked range (no extrapolation). Implants closer than the margin flag red.
                </p>
              </SideSection>

              <SideSection title={`Implants · ${plan.implants.length}`}>
                <div className="flex items-center gap-1.5 flex-wrap text-[11px] mb-1.5">
                  <span className="text-neutral-500">Ø</span>
                  <select
                    value={String(libDiam)}
                    onChange={(e) => setLibDiam(Number(e.target.value))}
                    className="bg-neutral-800 border border-neutral-700 rounded px-1 py-0.5 text-neutral-200"
                    aria-label="Implant diameter"
                  >
                    {IMPLANT_DIAMETERS_MM.map((d) => <option key={d} value={d}>{d.toFixed(1)}</option>)}
                  </select>
                  <span className="text-neutral-500">× L</span>
                  <select
                    value={String(libLen)}
                    onChange={(e) => setLibLen(Number(e.target.value))}
                    className="bg-neutral-800 border border-neutral-700 rounded px-1 py-0.5 text-neutral-200"
                    aria-label="Implant length"
                  >
                    {IMPLANT_LENGTHS_MM.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                  <span className="text-neutral-500">mm</span>
                  <button
                    type="button" onClick={addImplant}
                    className="ml-auto px-2 py-1 rounded bg-amber-500 text-black text-[11px] font-semibold hover:bg-amber-400 inline-flex items-center gap-1"
                  >
                    <Plus className="h-3 w-3" /> Add here
                  </button>
                </div>
                <div className="space-y-2">
                  {plan.implants.map((imp) => {
                    const cl = clearances[imp.id];
                    const unsafe = cl && !cl.safe;
                    return (
                      <div
                        key={imp.id}
                        className={`rounded border p-2 text-[11px] space-y-1 cursor-pointer ${
                          imp.id === selectedId ? 'border-amber-500 bg-neutral-800/60' : 'border-neutral-700 bg-neutral-800/30'}`}
                        onClick={() => { setSelectedId(imp.id); jumpTo(imp.s); }}
                      >
                        <div className="flex items-center gap-1.5">
                          <input
                            value={imp.site}
                            placeholder="site (FDI)"
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => updateImplant(imp.id, { site: e.target.value })}
                            className="w-20 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-neutral-200"
                            aria-label="Implant site"
                          />
                          <span className="text-neutral-300 tabular-nums">Ø{imp.diameterMm.toFixed(1)} × {imp.lengthMm} mm</span>
                          <button
                            type="button" title="Delete implant"
                            onClick={(e) => { e.stopPropagation(); removeImplant(imp.id); }}
                            className="ml-auto p-1 rounded hover:bg-neutral-700 text-red-300"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap text-neutral-400">
                          <label className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            s
                            <input
                              type="number" step="0.5" value={imp.s}
                              onChange={(e) => updateImplant(imp.id, { s: clamp(Number(e.target.value) || 0, 0, ctx.lengthMm) })}
                              className="w-16 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-neutral-200"
                              aria-label="Implant arch position (mm)"
                            />
                          </label>
                          <label className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            angle
                            <input
                              type="number" step="1" min="-89" max="89" value={imp.angulationDeg}
                              onChange={(e) => updateImplant(imp.id, { angulationDeg: clamp(Number(e.target.value) || 0, -89, 89) })}
                              className="w-14 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-neutral-200"
                              aria-label="Implant angulation (degrees)"
                            />°
                          </label>
                        </div>
                        <div className={unsafe ? 'text-red-400 font-semibold' : 'text-neutral-400'}>
                          {cl
                            ? `canal clearance ${cl.clearanceMm.toFixed(1)} mm (centre ${cl.centerDistanceMm.toFixed(1)} mm)${unsafe ? ` — INSIDE ${cl.marginMm} mm margin` : ''}`
                            : 'canal not marked — no clearance check'}
                        </div>
                      </div>
                    );
                  })}
                  {!plan.implants.length && (
                    <p className="text-[10px] text-neutral-500">No implants yet — pick a size and “Add here”.</p>
                  )}
                </div>
              </SideSection>

              <SideSection title={`Measurements · ${allMeasurements.length}`}>
                <div className="space-y-1">
                  {allMeasurements.map((m) => (
                    <div key={m.id} className="flex items-center gap-1.5 text-[11px] text-neutral-300">
                      <button
                        type="button" className="text-amber-300 hover:underline tabular-nums"
                        title="Jump to this section" onClick={() => jumpTo(m.sMm)}
                      >
                        @{m.key} mm
                      </button>
                      <span className="capitalize text-neutral-500">{m.kind}</span>
                      <span className="tabular-nums">{(m.valueMm ?? planeDistanceMm(m.p0, m.p1)).toFixed(1)} mm</span>
                      <button
                        type="button" title="Delete measurement"
                        onClick={() => removeMeasurement(m.key, m.id)}
                        className="ml-auto p-0.5 rounded hover:bg-neutral-700 text-red-300"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  {!allMeasurements.length && (
                    <p className="text-[10px] text-neutral-500">Use Measure / Height / Ridge on the cross-section.</p>
                  )}
                </div>
              </SideSection>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
