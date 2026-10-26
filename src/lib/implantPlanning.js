/*
 * implantPlanning — pure math + persistence helpers for the CBCT Implant
 * planning mode (ImplantMode.jsx).
 *
 * The planning workflow lives entirely in the arch-curve coordinate system the
 * existing curved-MPR (OPG) pipeline already defines:
 *
 *   s  — arc-length position (mm) along the dental arch curve (the same curve
 *        generatePanoramic samples, so a pano-strip x-fraction maps linearly
 *        to s: s = fraction · archLength).
 *   u  — lateral (buccal↔lingual) offset (mm) within the cross-section plane,
 *        along the in-plane normal n(s) = normalize(vAxis × tangent(s)).
 *   t  — vertical offset (mm) along the volume's superior axis (vAxis),
 *        relative to the arch curve point (the traced occlusal level).
 *
 * world(s, u, t) = curve(s) + n(s)·u + vAxis·t — so distances in (u, t) are
 * exact millimetres, and canal/implant geometry round-trips to world space for
 * 3D distance checks.
 *
 * Pure math / typed-array code: no DOM, no cornerstone, no three.js — fully
 * unit-testable. Canvas/rendering stays in ImplantMode.jsx.
 *
 * Persistence (NO schema change): imaging_studies.viewer_annotations gains an
 * `implant_plans` key (same jsonb pattern as `arch` and `mesh_registrations`):
 *   viewer_annotations.implant_plans = {
 *     version: 1,
 *     updated_at: ISO string,
 *     arch: { points: [[x,y,z],…], source } — snapshot of the arch the plan
 *           was built on, so saved s/u/t stay meaningful across sessions even
 *           if the study's main arch is later retraced,
 *     canal: { points: [{ s, u, t }, …], radiusMm, marginMm },
 *     implants: [{ id, site, s, u, t, angulationDeg, diameterMm, lengthMm,
 *                  created_at }, …],
 *     measurements: { "<s key>": [{ id, kind, p0:{u,t}, p1:{u,t}, valueMm }] }
 *   }
 */
import { sanitizeArchPoints, sampleArchCurve } from '@/lib/curvedMpr';

// ── vec3 helpers (plain arrays, no deps) ────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a) => Math.sqrt(dot(a, a));
const normalize = (a) => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── arch frame ──────────────────────────────────────────────────────────────
/**
 * Build a reusable arc-length frame over the dental arch: fast position /
 * tangent / in-plane-normal lookups at ANY arc position s ∈ [0, lengthMm].
 * The same Catmull-Rom + arc-length resampling as the OPG, pre-sampled finely
 * and linearly interpolated.
 *
 * @param {number[][]} archPointsWorld  >= 3 control points (world mm)
 * @param {Object} [options]
 * @param {number[]} [options.verticalAxis] superior axis (default [0,0,1] —
 *        pass the volume's k axis like the OPG does)
 * @param {number} [options.stepMm] pre-sample spacing (default 0.25)
 * @returns frame: { controlPoints, lengthMm, spacing, vAxis,
 *                   clampS(s), posAt(s), tanAt(s), nrmAt(s) }
 */
export function createArchFrame(archPointsWorld, options = {}) {
  const { verticalAxis = null, stepMm = 0.25, maxSamples = 20000 } = options;
  const pts = sanitizeArchPoints(archPointsWorld || []);
  if (pts.length < 3) throw new Error('Arch needs at least 3 distinct points');
  const curve = sampleArchCurve(pts, Math.max(stepMm, 0.01), maxSamples);
  let vAxis = normalize(verticalAxis || [0, 0, 1]);
  if (len(vAxis) === 0) vAxis = [0, 0, 1];

  const { positions, tangents, length: lengthMm, spacing } = curve;
  const last = positions.length - 1;
  const clampS = (s) => clampNum(Number.isFinite(s) ? s : 0, 0, lengthMm);
  const interp = (arr, s) => {
    const f = clampS(s) / spacing;
    const i = Math.min(last - 1, Math.max(0, Math.floor(f)));
    const w = clampNum(f - i, 0, 1);
    const a = arr[i];
    const b = arr[Math.min(last, i + 1)];
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
  };
  const posAt = (s) => interp(positions, s);
  const tanAt = (s) => {
    const t = normalize(interp(tangents, s));
    return len(t) > 0 ? t : [1, 0, 0];
  };
  const nrmAt = (s) => {
    const t = tanAt(s);
    let n = normalize(cross(vAxis, t));
    if (len(n) === 0) n = normalize(cross([0, 0, 1], t));
    if (len(n) === 0) n = [1, 0, 0];
    return n;
  };
  return { controlPoints: pts, lengthMm, spacing, vAxis, clampS, posAt, tanAt, nrmAt };
}

/** Is `arch` already a frame from createArchFrame (vs raw control points)? */
const isFrame = (arch) => !!arch && typeof arch.posAt === 'function';

/** Plane (s, u, t) → world [x, y, z] (see module header for the convention). */
export function planeToWorld(frame, s, u, t) {
  const p = frame.posAt(s);
  const n = frame.nrmAt(s);
  const v = frame.vAxis;
  return [p[0] + n[0] * u + v[0] * t, p[1] + n[1] * u + v[1] * t, p[2] + n[2] * u + v[2] * t];
}

// ── cross-section at an arbitrary arc-length position ───────────────────────
/**
 * Sample ONE cross-section perpendicular to the arch at arc position s (mm) —
 * the single-position counterpart of curvedMpr's fixed-count
 * generateCrossSections, with an optional slab (collapsed along the arch
 * tangent) and a vertical window centred on the arch's occlusal level.
 *
 * @param {Object} vol  { dimensions, spacing, origin, direction, scalarData }
 * @param {number[][]|Object} arch  arch control points (world) OR a frame from
 *        createArchFrame (pass the frame to avoid rebuilding it per call)
 * @param {number} s  arc-length position in mm (clamped to [0, archLength])
 * @param {Object} [options]
 * @param {number}   [options.widthMm=34]        buccal-lingual width
 * @param {number}   [options.vertAboveMm=45]    window above the arch level
 * @param {number}   [options.vertBelowMm=45]    window below the arch level
 * @param {number}   [options.maxDim=512]        pixel cap per axis
 * @param {number}   [options.slabThicknessMm=0] slab depth along the tangent
 * @param {'mip'|'mean'} [options.projection='mip'] slab collapse
 * @param {number[]} [options.verticalAxis]      superior axis (default vol k)
 * @returns {{ data:Float32Array, width, height, colSpacing, rowSpacing,
 *             positionMm, widthMm, vertAboveMm, vertBelowMm,
 *             center:number[], tangent:number[], normal:number[], vAxis:number[] }}
 *          data row-major; row 0 = +vertAboveMm (superior); NaN = outside.
 */
export function crossSectionAt(vol, arch, s, options = {}) {
  const { dimensions, spacing, origin, direction, scalarData } = vol || {};
  if (!dimensions || !spacing || !origin || !direction || !scalarData) {
    throw new Error('Volume geometry/voxel data unavailable');
  }
  const {
    widthMm = 34,
    vertAboveMm = 45,
    vertBelowMm = 45,
    maxDim = 512,
    slabThicknessMm = 0,
    projection = 'mip',
    verticalAxis = null,
  } = options;

  const [nx, ny, nz] = dimensions;
  const iAxis = normalize([direction[0], direction[1], direction[2]]);
  const jAxis = normalize([direction[3], direction[4], direction[5]]);
  const kAxis = normalize([direction[6], direction[7], direction[8]]);

  const frame = isFrame(arch)
    ? arch
    : createArchFrame(arch, { verticalAxis: verticalAxis || kAxis });
  const sC = frame.clampS(s);
  const p = frame.posAt(sC);
  const tan = frame.tanAt(sC);
  const nrm = frame.nrmAt(sC);
  const vAxis = frame.vAxis;

  const minSpacing = Math.min(spacing[0], spacing[1], spacing[2]);

  let colSpacing = minSpacing;
  let width = Math.floor(widthMm / colSpacing) + 1;
  if (width > maxDim) { width = maxDim; colSpacing = widthMm / (width - 1); }
  if (width < 2) width = 2;

  const heightMm = vertAboveMm + vertBelowMm;
  let rowSpacing = minSpacing;
  let height = Math.floor(heightMm / rowSpacing) + 1;
  if (height > maxDim) { height = maxDim; rowSpacing = heightMm / (height - 1); }
  if (height < 2) height = 2;

  // Slab along the arch TANGENT (the OPG slab is along the in-plane normal;
  // a cross-section's "thickness" is along the curve instead).
  let slabN = slabThicknessMm > 0 ? Math.floor(slabThicknessMm / minSpacing) + 1 : 1;
  if (slabN > 15) slabN = 15;
  if (slabN < 1) slabN = 1;
  if (slabN % 2 === 0) slabN += 1; // centred
  const slabStep = slabN > 1 ? slabThicknessMm / (slabN - 1) : 0;
  const isMip = projection !== 'mean';

  const sx = spacing[0];
  const sy = spacing[1];
  const sz = spacing[2];
  const data = new Float32Array(width * height);

  for (let r = 0; r < height; r++) {
    const tOff = vertAboveMm - r * rowSpacing;
    const rx = p[0] + vAxis[0] * tOff;
    const ry = p[1] + vAxis[1] * tOff;
    const rz = p[2] + vAxis[2] * tOff;
    for (let c = 0; c < width; c++) {
      const uOff = (c - (width - 1) / 2) * colSpacing;
      const bx = rx + nrm[0] * uOff;
      const by = ry + nrm[1] * uOff;
      const bz = rz + nrm[2] * uOff;

      let acc = isMip ? -Infinity : 0;
      let count = 0;
      for (let q = 0; q < slabN; q++) {
        const off = slabN > 1 ? q * slabStep - slabThicknessMm / 2 : 0;
        const dx = bx + tan[0] * off - origin[0];
        const dy = by + tan[1] * off - origin[1];
        const dz = bz + tan[2] * off - origin[2];
        const xi = Math.round((dx * iAxis[0] + dy * iAxis[1] + dz * iAxis[2]) / sx);
        if (xi < 0 || xi >= nx) continue;
        const yi = Math.round((dx * jAxis[0] + dy * jAxis[1] + dz * jAxis[2]) / sy);
        if (yi < 0 || yi >= ny) continue;
        const zi = Math.round((dx * kAxis[0] + dy * kAxis[1] + dz * kAxis[2]) / sz);
        if (zi < 0 || zi >= nz) continue;
        const v = scalarData[xi + yi * nx + zi * nx * ny];
        if (isMip) { if (v > acc) acc = v; } else { acc += v; }
        count++;
      }
      data[r * width + c] = count === 0 ? NaN : (isMip ? acc : acc / count);
    }
  }

  return {
    data, width, height, colSpacing, rowSpacing,
    positionMm: sC, widthMm, vertAboveMm, vertBelowMm,
    center: p, tangent: tan, normal: nrm, vAxis,
  };
}

/** Section pixel (px, py — fractional ok) → plane mm { u, t }. */
export function sectionPixelToPlane(section, px, py) {
  return {
    u: (px - (section.width - 1) / 2) * section.colSpacing,
    t: section.vertAboveMm - py * section.rowSpacing,
  };
}

/** Plane mm { u, t } → section pixel { x, y } (fractional). */
export function planeToSectionPixel(section, u, t) {
  return {
    x: u / section.colSpacing + (section.width - 1) / 2,
    y: (section.vertAboveMm - t) / section.rowSpacing,
  };
}

// ── measurements ────────────────────────────────────────────────────────────
/** Exact mm distance between two plane points { u, t }. */
export const planeDistanceMm = (a, b) => Math.hypot(a.u - b.u, a.t - b.t);

/**
 * Default bone threshold for a section: lower 2nd percentile + 45% of the
 * section's own robust dynamic range — lands inside cortical bone for CT-ish
 * data without depending on calibrated HU.
 */
export function defaultBoneThreshold(section) {
  const data = section?.data;
  if (!data || !data.length) return null;
  const sample = [];
  const stride = Math.max(1, Math.floor(data.length / 50000));
  for (let i = 0; i < data.length; i += stride) {
    const v = data[i];
    if (Number.isFinite(v)) sample.push(v);
  }
  if (sample.length < 16) return null;
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.02)];
  const hi = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.995))];
  if (!(hi > lo)) return null;
  return lo + 0.45 * (hi - lo);
}

/**
 * One-click "ridge width @ depth": from a seed point on bone, walk LEFT and
 * RIGHT along the same row while the value stays >= threshold; the run length
 * is the bucco-lingual ridge width at that depth. Returns null when the seed
 * is off the image or not on bone (caller shows a hint).
 *
 * @returns {{ u0, u1, tMm, widthMm }|null} u0 < u1, pixel-centre coordinates
 */
export function estimateRidgeWidth(section, uMm, tMm, options = {}) {
  if (!section?.data) return null;
  const threshold = Number.isFinite(options.threshold)
    ? options.threshold
    : defaultBoneThreshold(section);
  if (!Number.isFinite(threshold)) return null;
  const { x, y } = planeToSectionPixel(section, uMm, tMm);
  const row = Math.round(y);
  const col = Math.round(x);
  if (row < 0 || row >= section.height || col < 0 || col >= section.width) return null;
  const at = (c) => section.data[row * section.width + c];
  if (!(at(col) >= threshold)) return null; // seed must be on bone
  let c0 = col;
  while (c0 - 1 >= 0 && at(c0 - 1) >= threshold) c0--;
  let c1 = col;
  while (c1 + 1 < section.width && at(c1 + 1) >= threshold) c1++;
  const a = sectionPixelToPlane(section, c0, row);
  const b = sectionPixelToPlane(section, c1, row);
  return {
    u0: Math.min(a.u, b.u),
    u1: Math.max(a.u, b.u),
    tMm: a.t,
    widthMm: (c1 - c0 + 1) * section.colSpacing,
  };
}

// ── FDI tooth-zone estimate (approximate, labelled as such) ─────────────────
// Mean mesiodistal crown widths (mm), tooth 1 (central incisor) → 7 (2nd
// molar), per arch. Only used to scale a half-arch into rough zones.
export const TOOTH_WIDTHS_MM = {
  lower: [5.4, 5.9, 6.9, 7.0, 7.1, 11.0, 10.4],
  upper: [8.6, 6.6, 7.6, 7.1, 6.6, 10.4, 9.8],
};

/**
 * Map an arc-length position to an APPROXIMATE FDI tooth zone. The arch curve
 * runs posterior → anterior (midline at s = L/2) → posterior; tooth widths are
 * scaled so the 2nd molar's distal edge lands at the arch end.
 *
 * @param {number} sMm  arc position
 * @param {number} archLengthMm  total arch length
 * @param {Object} [options]
 * @param {'lower'|'upper'} [options.jaw='lower']
 * @param {boolean} [options.leftAtStart=false]  true when the s=0 end of the
 *        arch is the PATIENT-LEFT side (decide from world X: LPS ⇒ +X = left)
 * @returns {{ fdi, quadrant, tooth, label, approximate: true }|null}
 */
export function estimateFdiZone(sMm, archLengthMm, options = {}) {
  if (!(archLengthMm > 0) || !Number.isFinite(sMm)) return null;
  const { jaw = 'lower', leftAtStart = false } = options;
  const s = clampNum(sMm, 0, archLengthMm);
  const half = archLengthMm / 2;
  const onStartHalf = s < half;
  const isLeft = onStartHalf ? leftAtStart : !leftAtStart;
  const distFromMidline = Math.abs(s - half);
  const widths = TOOTH_WIDTHS_MM[jaw === 'upper' ? 'upper' : 'lower'];
  const sum = widths.reduce((a, w) => a + w, 0);
  const k = half / sum; // scale the standard half-arch onto this arch
  let acc = 0;
  let tooth = widths.length;
  for (let i = 0; i < widths.length; i++) {
    acc += widths[i] * k;
    if (distFromMidline <= acc) { tooth = i + 1; break; }
  }
  const quadrant = jaw === 'upper' ? (isLeft ? 2 : 1) : (isLeft ? 3 : 4);
  const fdi = quadrant * 10 + tooth;
  return { fdi, quadrant, tooth, label: `FDI ${fdi}`, approximate: true };
}

// ── mandibular canal ────────────────────────────────────────────────────────
export const CANAL_DEFAULTS = { radiusMm: 1.5, marginMm: 2.0 };

export function emptyCanal() {
  return { points: [], radiusMm: CANAL_DEFAULTS.radiusMm, marginMm: CANAL_DEFAULTS.marginMm };
}

const sortedCanalPoints = (canal) =>
  (canal?.points || [])
    .filter((p) => p && Number.isFinite(p.s) && Number.isFinite(p.u) && Number.isFinite(p.t))
    .slice()
    .sort((a, b) => a.s - b.s);

/**
 * Add/replace a canal centre point ({ s, u, t }). A new click within
 * `mergeWithinMm` of an existing point's s REPLACES it (re-marking a section
 * corrects the point instead of stacking duplicates). Returns a NEW canal.
 */
export function upsertCanalPoint(canal, point, mergeWithinMm = 1.0) {
  const base = canal || emptyCanal();
  const pts = sortedCanalPoints(base).filter((p) => Math.abs(p.s - point.s) >= mergeWithinMm);
  pts.push({ s: point.s, u: point.u, t: point.t });
  pts.sort((a, b) => a.s - b.s);
  return { ...emptyCanal(), ...base, points: pts };
}

/** Remove the canal point nearest to s (within toleranceMm). */
export function removeCanalPointNear(canal, s, toleranceMm = 2.0) {
  const pts = sortedCanalPoints(canal);
  if (!pts.length) return canal;
  let best = -1;
  let bestD = Infinity;
  pts.forEach((p, i) => {
    const d = Math.abs(p.s - s);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best < 0 || bestD > toleranceMm) return canal;
  return { ...emptyCanal(), ...canal, points: pts.filter((_, i) => i !== best) };
}

/**
 * Interpolated canal centre { u, t } at arc position s, linear between marked
 * points. Deliberately NO extrapolation outside the marked range (safety:
 * never invent canal position where the clinician hasn't marked it). A single
 * marked point only answers within ±1 mm of itself.
 */
export function canalCenterAt(canal, s) {
  const pts = sortedCanalPoints(canal);
  if (!pts.length || !Number.isFinite(s)) return null;
  if (pts.length === 1) {
    return Math.abs(s - pts[0].s) <= 1.0 ? { u: pts[0].u, t: pts[0].t } : null;
  }
  if (s < pts[0].s || s > pts[pts.length - 1].s) return null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (s >= a.s && s <= b.s) {
      const w = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
      return { u: a.u + (b.u - a.u) * w, t: a.t + (b.t - a.t) * w };
    }
  }
  return null;
}

/** Marked-range extent { minS, maxS } or null. */
export function canalRange(canal) {
  const pts = sortedCanalPoints(canal);
  if (!pts.length) return null;
  return { minS: pts[0].s, maxS: pts[pts.length - 1].s, count: pts.length };
}

/**
 * Densely sampled canal path in WORLD coordinates (for 3D implant-distance
 * checks). Samples every stepMm across the marked range plus the marked
 * points themselves.
 */
export function canalWorldPolyline(frame, canal, stepMm = 0.5) {
  const pts = sortedCanalPoints(canal);
  if (!pts.length) return [];
  if (pts.length === 1) return [planeToWorld(frame, pts[0].s, pts[0].u, pts[0].t)];
  const out = [];
  const s0 = pts[0].s;
  const s1 = pts[pts.length - 1].s;
  const n = Math.max(2, Math.ceil((s1 - s0) / Math.max(stepMm, 0.05)) + 1);
  for (let i = 0; i < n; i++) {
    const s = s0 + ((s1 - s0) * i) / (n - 1);
    const c = canalCenterAt(canal, s);
    if (c) out.push(planeToWorld(frame, s, c.u, c.t));
  }
  return out;
}

// ── implants ────────────────────────────────────────────────────────────────
export const IMPLANT_DIAMETERS_MM = [3.0, 3.5, 4.0, 4.5, 5.0];
export const IMPLANT_LENGTHS_MM = [6, 8, 10, 11.5, 13, 16];

let implantSeq = 0;
export function makeImplant(props = {}) {
  implantSeq += 1;
  return {
    id: props.id || `imp_${Date.now().toString(36)}_${implantSeq}`,
    site: props.site || '',
    s: Number.isFinite(props.s) ? props.s : 0,
    u: Number.isFinite(props.u) ? props.u : 0,
    t: Number.isFinite(props.t) ? props.t : 0,
    angulationDeg: Number.isFinite(props.angulationDeg) ? props.angulationDeg : 0,
    diameterMm: Number.isFinite(props.diameterMm) ? props.diameterMm : 4.0,
    lengthMm: Number.isFinite(props.lengthMm) ? props.lengthMm : 10,
    created_at: props.created_at || new Date().toISOString(),
  };
}

/**
 * Implant axis endpoints in PLANE coordinates. The platform (crestal end) sits
 * at (u, t); angulation 0° points the apex straight apically (t decreasing,
 * i.e. downward for a mandibular section); positive angles rotate the apex
 * toward +u (buccal/lingual depending on section orientation).
 */
export function implantPlaneEndpoints(implant) {
  const a = ((implant.angulationDeg || 0) * Math.PI) / 180;
  const L = implant.lengthMm;
  return {
    platform: { u: implant.u, t: implant.t },
    apex: { u: implant.u + L * Math.sin(a), t: implant.t - L * Math.cos(a) },
  };
}

/** Implant axis endpoints in WORLD coordinates (for canal distance). */
export function implantWorldSegment(frame, implant) {
  const e = implantPlaneEndpoints(implant);
  return {
    platform: planeToWorld(frame, implant.s, e.platform.u, e.platform.t),
    apex: planeToWorld(frame, implant.s, e.apex.u, e.apex.t),
  };
}

/** Min distance from world point p to segment [a, b] (all mm). */
export function distancePointToSegmentMm(p, a, b) {
  const ab = sub(b, a);
  const ap = sub(p, a);
  const d2 = dot(ab, ab);
  const f = d2 > 0 ? clampNum(dot(ap, ab) / d2, 0, 1) : 0;
  return len([ap[0] - ab[0] * f, ap[1] - ab[1] * f, ap[2] - ab[2] * f]);
}

/**
 * Implant ↔ canal clearance in 3D world space.
 *   centerDistanceMm — min distance from the implant AXIS to the canal CENTER
 *   clearanceMm      — surface-to-surface: center distance − implant radius −
 *                      canal radius
 *   safe             — clearanceMm >= the configured safety margin
 * Returns null when no canal is marked.
 */
export function implantCanalClearance(frame, implant, canal) {
  const poly = canalWorldPolyline(frame, canal, 0.5);
  if (!poly.length) return null;
  const { platform, apex } = implantWorldSegment(frame, implant);
  let min = Infinity;
  for (const pt of poly) {
    const d = distancePointToSegmentMm(pt, platform, apex);
    if (d < min) min = d;
  }
  const radius = Number.isFinite(canal?.radiusMm) ? canal.radiusMm : CANAL_DEFAULTS.radiusMm;
  const margin = Number.isFinite(canal?.marginMm) ? canal.marginMm : CANAL_DEFAULTS.marginMm;
  const clearanceMm = min - implant.diameterMm / 2 - radius;
  return { centerDistanceMm: min, clearanceMm, marginMm: margin, safe: clearanceMm >= margin };
}

// ── persistence (viewer_annotations.implant_plans) ──────────────────────────
export const IMPLANT_PLAN_VERSION = 1;

/** Measurements are keyed by arc position rounded to 0.1 mm. */
export function measurementKey(sMm) {
  return (Math.round(sMm * 10) / 10).toFixed(1);
}

export function emptyImplantPlan(now = null) {
  return {
    version: IMPLANT_PLAN_VERSION,
    updated_at: now || new Date().toISOString(),
    arch: null,
    canal: emptyCanal(),
    implants: [],
    measurements: {},
  };
}

/** Coerce an arbitrary stored value into a well-formed plan (lossy on junk). */
export function normalizeImplantPlan(raw) {
  const base = emptyImplantPlan(raw?.updated_at || undefined);
  if (!raw || typeof raw !== 'object') return base;
  const plan = { ...base };
  if (raw.arch && Array.isArray(raw.arch.points) && raw.arch.points.length >= 3) {
    plan.arch = { points: raw.arch.points, source: raw.arch.source || 'unknown' };
  }
  if (raw.canal && typeof raw.canal === 'object') {
    plan.canal = {
      points: sortedCanalPoints(raw.canal),
      radiusMm: Number.isFinite(raw.canal.radiusMm) ? raw.canal.radiusMm : CANAL_DEFAULTS.radiusMm,
      marginMm: Number.isFinite(raw.canal.marginMm) ? raw.canal.marginMm : CANAL_DEFAULTS.marginMm,
    };
  }
  if (Array.isArray(raw.implants)) {
    plan.implants = raw.implants
      .filter((i) => i && Number.isFinite(i.s) && Number.isFinite(i.diameterMm) && Number.isFinite(i.lengthMm))
      .map((i) => makeImplant(i));
  }
  if (raw.measurements && typeof raw.measurements === 'object') {
    const m = {};
    for (const [key, list] of Object.entries(raw.measurements)) {
      if (!Array.isArray(list)) continue;
      const clean = list.filter(
        (x) => x && x.p0 && x.p1 &&
          Number.isFinite(x.p0.u) && Number.isFinite(x.p0.t) &&
          Number.isFinite(x.p1.u) && Number.isFinite(x.p1.t)
      );
      if (clean.length) m[key] = clean;
    }
    plan.measurements = m;
  }
  return plan;
}

/** Read the plan off a viewer_annotations object (null when none saved). */
export function getImplantPlan(viewerAnnotations) {
  const raw = viewerAnnotations?.implant_plans;
  if (!raw || typeof raw !== 'object') return null;
  return normalizeImplantPlan(raw);
}

/**
 * Merge the plan into viewer_annotations under `implant_plans`, preserving
 * every other key (arch, mesh_registrations, …). Returns a NEW object ready
 * for the imaging_studies update.
 */
export function upsertImplantPlan(viewerAnnotations, plan, now = null) {
  return {
    ...(viewerAnnotations || {}),
    implant_plans: {
      ...normalizeImplantPlan(plan),
      version: IMPLANT_PLAN_VERSION,
      updated_at: now || new Date().toISOString(),
    },
  };
}
