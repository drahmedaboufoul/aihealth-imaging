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

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Loader2, AlertCircle, ArrowLeft, Box,
  Move, ZoomIn, RotateCcw,
  Ruler, Triangle, Crosshair as CrosshairIcon,
  Activity, Trash2, Plus, Save, Sparkles,
  Eye, EyeOff, Contrast, Layers, ChevronRight,
  Square, Circle as CircleIcon, Hexagon, Cylinder,
  Zap, GitBranch, ExternalLink,
} from 'lucide-react';
import { resolveStudyDicomFiles, resolveStudyNiftiVolume } from '../lib/signedUrl';
import { loadNiftiVolume } from '../lib/niftiLoader';
import { renderArchPano, renderCrossSection, getVolumeScalarData, densifyArch } from '../lib/archPano';
import {
  initCornerstone,
  imageIdFromSignedUrl,
  cornerstone,
  cornerstoneTools,
} from '../lib/cornerstoneInit';
import { readSharePayload, shareDicomFiles, SHARE_EXPIRED_MESSAGE } from '../lib/sharePayload';
import { supabase } from '../lib/supabase';

const SHELL_BG = '#0b0d10';
const PANEL_BG = '#15181c';

const RENDERING_ENGINE_ID = 'aihCbctRenderingEngine';
const TOOL_GROUP_MPR_ID   = 'aihCbctMprToolGroup';
const TOOL_GROUP_3D_ID    = 'aihCbct3dToolGroup';
const VOI_SYNC_ID         = 'aihCbctVoiSync';

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
 * Implant catalog — generic mainstream sizes across major brands.
 * Real product-specific catalogs (Straumann BLT, Nobel Replace, MIS V3,
 * etc.) come in Phase 3.4.1 as a per-clinic settings table. For now we
 * use a generic set covering the standard diameter × length matrix.
 */
const IMPLANT_CATALOG = [
  { label: 'Narrow  · 3.3 × 10', diameterMM: 3.3, lengthMM: 10 },
  { label: 'Narrow  · 3.3 × 12', diameterMM: 3.3, lengthMM: 12 },
  { label: 'Standard · 3.75 × 10', diameterMM: 3.75, lengthMM: 10 },
  { label: 'Standard · 3.75 × 12', diameterMM: 3.75, lengthMM: 12 },
  { label: 'Standard · 4.0 × 10', diameterMM: 4.0, lengthMM: 10 },
  { label: 'Standard · 4.0 × 12', diameterMM: 4.0, lengthMM: 12 },
  { label: 'Wide    · 4.8 × 8',  diameterMM: 4.8, lengthMM: 8 },
  { label: 'Wide    · 4.8 × 10', diameterMM: 4.8, lengthMM: 10 },
  { label: 'Wide    · 5.0 × 8',  diameterMM: 5.0, lengthMM: 8 },
];

/**
 * Compute the minimum distance from a 3D line segment (a..b) to a
 * polyline (the nerve canal). Returns the smallest perpendicular
 * distance from any point on a..b to any segment of the polyline.
 * Used for implant-vs-nerve safety check.
 */
function segmentToPolylineDistance(a, b, polyline) {
  if (!Array.isArray(polyline) || polyline.length < 2) return Infinity;
  let min = Infinity;
  // For each segment in the polyline, compute the closest distance
  // between the implant axis and that segment.
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = segmentToSegmentDistance(a, b, polyline[i], polyline[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

/**
 * 3D segment-to-segment minimum distance — based on the standard
 * "Real-Time Collision Detection" algorithm by Christer Ericson.
 */
function segmentToSegmentDistance(p1, q1, p2, q2) {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r  = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s, t;
  const EPS = 1e-9;
  if (a <= EPS && e <= EPS) return len(sub(p1, p2));
  if (a <= EPS) { s = 0; t = clamp01(f / e); }
  else {
    const c = dot(d1, r);
    if (e <= EPS) { t = 0; s = clamp01(-c / a); }
    else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const c1 = add(p1, scale(d1, s));
  const c2 = add(p2, scale(d2, t));
  return len(sub(c1, c2));
}

const sub   = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add   = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot   = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const len   = (a) => Math.sqrt(dot(a, a));
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * View modes — each maps to a different layout + viewport configuration
 * over the SAME underlying volume. Switching modes doesn't reload the
 * volume; it rebuilds viewports + tool group bindings.
 *
 * Today: MPR + 3D and Ceph are wired. Pano / Cross-sections / Implant /
 * TMJ are placeholders for Phase 2/3 with explanatory tooltips so the
 * roadmap is visible from the UI.
 */
const VIEW_MODES = {
  'mpr-3d': {
    name: 'MPR + 3D',
    ready: true,
    layout: 'grid-2x2',
    viewports: [
      { id: 'CBCT_AXIAL',    label: 'Axial',    orientationKey: 'AXIAL',    color: '#10b981', kind: 'orthographic' },
      { id: 'CBCT_CORONAL',  label: 'Coronal',  orientationKey: 'CORONAL',  color: '#3b82f6', kind: 'orthographic' },
      { id: 'CBCT_SAGITTAL', label: 'Sagittal', orientationKey: 'SAGITTAL', color: '#f59e0b', kind: 'orthographic' },
      { id: 'CBCT_3D',       label: '3D',       orientationKey: 'CORONAL',  color: '#ef4444', kind: 'volume_3d' },
    ],
  },
  'ceph': {
    name: 'Ceph',
    ready: true,
    layout: 'side-by-side',
    description: 'Synthetic cephalometric: thick-slab MIP through the full skull. Lateral (left) + PA (right).',
    viewports: [
      { id: 'CEPH_LAT', label: 'Lateral',     orientationKey: 'SAGITTAL', color: '#10b981', kind: 'orthographic', slabMM: 200, blendMode: 'MIP' },
      { id: 'CEPH_PA',  label: 'Postero-Ant', orientationKey: 'CORONAL',  color: '#3b82f6', kind: 'orthographic', slabMM: 200, blendMode: 'MIP' },
    ],
  },
  'pano': {
    name: 'Pano',
    ready: true,
    layout: 'arch-pano',
    description: 'True reformatted panoramic. Click points on the axial inset to define the dental arch; pano regenerates from the curve.',
    viewports: [
      { id: 'PANO_AXIAL', label: 'Axial — click to trace arch', orientationKey: 'AXIAL', color: '#10b981', kind: 'orthographic' },
    ],
  },
  'crosssec': {
    name: 'Cross-sections',
    ready: true,
    layout: 'arch-crosssec',
    description: 'Perpendicular cross-sections sampled along the arch curve. Trace the arch in Pano view first; this generates 16 thin slices at uniform spacing along the curve.',
    viewports: [], // no Cornerstone viewports — pure canvas grid
  },
  'implant': {
    name: 'Implant',
    ready: true,
    layout: 'grid-2x2',
    description: 'Implant planning workspace. Use Length to measure available bone height. Cylinder placement coming Phase 3.',
    viewports: [
      { id: 'CBCT_AXIAL',    label: 'Axial',    orientationKey: 'AXIAL',    color: '#10b981', kind: 'orthographic' },
      { id: 'CBCT_CORONAL',  label: 'Coronal',  orientationKey: 'CORONAL',  color: '#3b82f6', kind: 'orthographic' },
      { id: 'CBCT_SAGITTAL', label: 'Sagittal', orientationKey: 'SAGITTAL', color: '#f59e0b', kind: 'orthographic' },
      { id: 'CBCT_3D',       label: '3D',       orientationKey: 'CORONAL',  color: '#ef4444', kind: 'volume_3d' },
    ],
  },
  'tmj': {
    name: 'TMJ',
    ready: true,
    layout: 'grid-2x2',
    description: 'TMJ workspace. 4 axial slices through condyles + corrected sagittals coming Phase 3.',
    viewports: [
      { id: 'TMJ_AX_R', label: 'Right Condyle (Ax)', orientationKey: 'AXIAL',   color: '#10b981', kind: 'orthographic' },
      { id: 'TMJ_AX_L', label: 'Left Condyle (Ax)',  orientationKey: 'AXIAL',   color: '#3b82f6', kind: 'orthographic' },
      { id: 'TMJ_COR_R', label: 'Right Condyle (Cor)', orientationKey: 'CORONAL', color: '#f59e0b', kind: 'orthographic' },
      { id: 'TMJ_COR_L', label: 'Left Condyle (Cor)',  orientationKey: 'CORONAL', color: '#ef4444', kind: 'orthographic' },
    ],
  },
};

/**
 * Pull `dimensions`, `spacing`, or `origin` from a Cornerstone3D
 * volume in a version-tolerant way. Returns null if every known path
 * fails so callers can skip rendering instead of crashing.
 *
 * Across Cornerstone3D 4.x:
 *   - Some volumes expose these as plain arrays on the volume
 *   - Some require querying volume.imageData via vtk methods
 *   - Local volumes (createLocalVolume) sometimes have the arrays
 *     but not the imageData yet on first render
 */
function safeVolumeAttr(volume, key) {
  if (!volume) return null;
  // Direct property — Cornerstone often stores these as plain Arrays
  // BUT can return TypedArrays (Float64Array) under some build paths,
  // and Array.isArray() is false for TypedArrays. Accept any array-like
  // with length ≥ 3 and normalise to a plain 3-element Array so the
  // downstream pano render's destructuring is safe.
  try {
    const v = volume[key];
    if (v && typeof v.length === 'number' && v.length >= 3) {
      return [Number(v[0]), Number(v[1]), Number(v[2])];
    }
  } catch (_) {}
  // vtk imageData methods (createLocalVolume always builds an imageData)
  const methodMap = {
    dimensions: 'getDimensions',
    spacing: 'getSpacing',
    origin: 'getOrigin',
  };
  try {
    const fn = volume.imageData?.[methodMap[key]];
    if (typeof fn === 'function') {
      const v = fn.call(volume.imageData);
      if (v && typeof v.length === 'number' && v.length >= 3) {
        return [Number(v[0]), Number(v[1]), Number(v[2])];
      }
    }
  } catch (_) {}
  // Last-ditch: some volumes expose getDimensions/getSpacing/getOrigin
  // directly on the volume object.
  try {
    const directFn = volume[methodMap[key]];
    if (typeof directFn === 'function') {
      const v = directFn.call(volume);
      if (v && typeof v.length === 'number' && v.length >= 3) {
        return [Number(v[0]), Number(v[1]), Number(v[2])];
      }
    }
  } catch (_) {}
  return null;
}

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

/**
 * NIfTI fast-path renderer. Downloads the .nii.gz, parses it, and
 * registers it as a local Cornerstone3D volume with explicit geometry
 * from the header. Bypasses the streaming DICOM loader entirely.
 *
 * Sets up the same 4-panel layout (axial/coronal/sagittal/3D) and tool
 * groups as the DICOM path. The viewer code below this is unchanged so
 * features added later (measurements, segmentation, AI overlays) work
 * for both paths uniformly.
 */
async function renderFromNifti({
  niftiUrl,
  volumeId,
  elements,
  setProgress,
  setPresetTable,
  cancelledRef,
  engineRef,
  cachedVolumeRef,
  cachedVolumeIdRef,
}) {
  setProgress(10);
  const nii = await loadNiftiVolume(niftiUrl);
  if (cancelledRef()) return;
  setProgress(60);

  console.log('[cbct] NIfTI loaded', {
    dimensions: nii.dimensions,
    spacing: nii.spacing,
    origin: nii.origin,
    metadata: nii.metadata,
    voxelCount: nii.scalarData.length,
  });

  // Register a local volume so cornerstone treats it like any streamed
  // volume from this point on. v4 ships volumeLoader.createLocalVolume
  // which takes the explicit geometry we already have from the NIfTI
  // header — no auto-detection.
  const localVolumeOptions = {
    scalarData: nii.scalarData,
    metadata: {
      // Cornerstone reads BitsAllocated / PixelRepresentation to pick the
      // right typed array on slice access. We've already standardised on
      // typed arrays so we set sane defaults.
      BitsAllocated: 16,
      BitsStored: 16,
      SamplesPerPixel: 1,
      HighBit: 15,
      PhotometricInterpretation: 'MONOCHROME2',
      PixelRepresentation: 1,
      Modality: 'CT',
    },
    dimensions: nii.dimensions,
    spacing: nii.spacing,
    origin: nii.origin,
    direction: nii.direction,
  };

  // v4 createLocalVolume API has gone through a couple of name
  // variations — try the canonical name first, then aliases.
  let volume = null;
  const vl = cornerstone.volumeLoader;
  if (typeof vl.createLocalVolume === 'function') {
    volume = await vl.createLocalVolume(volumeId, localVolumeOptions);
  } else if (typeof vl.createAndCacheLocalVolume === 'function') {
    volume = await vl.createAndCacheLocalVolume(localVolumeOptions, volumeId);
  } else if (typeof vl.createAndCacheVolumeFromImagesSync === 'function') {
    // Fallback only if the local-volume helpers are unavailable in this
    // exact build of cornerstone — should never hit this on v4.22+.
    throw new Error('cornerstone.volumeLoader.createLocalVolume is unavailable in this build');
  } else {
    throw new Error('No usable createLocalVolume on cornerstone.volumeLoader');
  }
  if (cancelledRef()) return;
  // Cache for view-mode rebuilds (don't reload the volume on switch)
  if (cachedVolumeRef) cachedVolumeRef.current = volume;
  if (cachedVolumeIdRef) cachedVolumeIdRef.current = volumeId;
  setProgress(80);

  // Build rendering engine + viewports
  let engine = cornerstone.getRenderingEngine(RENDERING_ENGINE_ID);
  if (!engine) engine = new cornerstone.RenderingEngine(RENDERING_ENGINE_ID);
  engineRef.current = engine;

  const Enums = cornerstone.Enums;
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

  // Compute auto-VOI from the actual scalar data so presets match the
  // scanner's pixel scale (HU vs raw).
  const dataRange = readVolumeDataRange(volume);
  const isHU = dataRange ? (dataRange.min < -200) : true;
  const presets = isHU ? VOLUME_PRESETS_HU : rawPresetsForRange(dataRange);
  if (!cancelledRef()) setPresetTable(presets);
  const defaultPreset = presets.find((p) => p.name === 'Bone') || presets[0];

  await cornerstone.setVolumesForViewports(
    engine,
    [{ volumeId }],
    VIEWPORTS.map((v) => v.id),
  );

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
  try {
    const vp3d = engine.getViewport('CBCT_3D');
    if (vp3d?.setProperties) {
      vp3d.setProperties({ preset: isHU ? 'CT-Bone' : 'CT-AAA' });
    }
  } catch (e) {
    console.warn('[cbct] 3D preset apply failed:', e?.message);
  }

  // Same tool groups + VOI synchronizer as the DICOM path. We extract
  // this into a helper to avoid duplication.
  setupCbctToolGroups(engine);

  engine.render();
  setProgress(100);
}

/**
 * Tools that take over the primary (left-click) action when the user
 * activates them from the toolbar. The values must be the actual
 * Cornerstone3D toolName property (without the 'Tool' suffix — e.g.
 * `CrosshairsTool.toolName === 'Crosshairs'`). Hardcoding the wrong
 * string silently breaks setToolActive/setToolPassive at runtime.
 *
 * We populate this from cornerstoneTools.* references in initPrimaryToolMap()
 * so it stays in lockstep with whatever Cornerstone version is bundled.
 */
let PRIMARY_TOOLS = {};
function initPrimaryToolMap() {
  PRIMARY_TOOLS = {
    crosshair:     cornerstoneTools.CrosshairsTool.toolName,
    length:        cornerstoneTools.LengthTool.toolName,
    angle:         cornerstoneTools.AngleTool.toolName,
    bidirectional: cornerstoneTools.BidirectionalTool.toolName,
    probe:         cornerstoneTools.ProbeTool.toolName,
    // Phase 2 ROI tools — region-based density measurements (HU mean/min/max/stddev)
    rectROI:       cornerstoneTools.RectangleROITool.toolName,
    circleROI:     cornerstoneTools.CircleROITool.toolName,
    ellipseROI:    cornerstoneTools.EllipticalROITool.toolName,
    pan:           cornerstoneTools.PanTool.toolName,
    zoom:          cornerstoneTools.ZoomTool.toolName,
  };
}

/**
 * Build the MPR + 3D tool groups + VOI synchronizer. Shared between the
 * NIfTI fast path and the DICOM streaming fallback so both render with
 * identical interaction.
 */
function setupCbctToolGroups(engine) {
  // Initialize the primary-tool map from current Cornerstone references
  // so we always use the correct internal toolNames.
  initPrimaryToolMap();
  try { cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_MPR_ID); } catch {}
  try { cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_3D_ID); } catch {}
  const mprGroup = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_MPR_ID);
  const vrGroup  = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_3D_ID);

  const mprTools = [
    cornerstoneTools.WindowLevelTool,
    cornerstoneTools.PanTool,
    cornerstoneTools.ZoomTool,
    cornerstoneTools.StackScrollTool,
    cornerstoneTools.CrosshairsTool,
    cornerstoneTools.LengthTool,
    cornerstoneTools.AngleTool,
    cornerstoneTools.BidirectionalTool,
    cornerstoneTools.ProbeTool,
  ];
  for (const T of mprTools) cornerstoneTools.addTool(T);
  try { cornerstoneTools.addTool(cornerstoneTools.TrackballRotateTool); } catch {}

  // Register every tool in the group (passive by default; we set
  // primary/secondary/wheel bindings below).
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
  mprGroup.addTool(cornerstoneTools.LengthTool.toolName);
  mprGroup.addTool(cornerstoneTools.AngleTool.toolName);
  mprGroup.addTool(cornerstoneTools.BidirectionalTool.toolName);
  mprGroup.addTool(cornerstoneTools.ProbeTool.toolName);

  for (const id of MPR_VIEWPORT_IDS) mprGroup.addViewport(id, RENDERING_ENGINE_ID);

  // Default bindings — Crosshair on Primary, W/L on Secondary, Pan on
  // middle, Wheel scrolls slices. setActivePrimaryTool() swaps Primary
  // when the user picks a measurement tool from the toolbar.
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

  vrGroup.addTool(cornerstoneTools.TrackballRotateTool.toolName);
  vrGroup.addTool(cornerstoneTools.ZoomTool.toolName);
  vrGroup.addViewport('CBCT_3D', RENDERING_ENGINE_ID);
  vrGroup.setToolActive(cornerstoneTools.TrackballRotateTool.toolName, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });
  vrGroup.setToolActive(cornerstoneTools.ZoomTool.toolName, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
  });

  // VOI sync across the three MPR viewports.
  try {
    try { cornerstoneTools.SynchronizerManager?.destroySynchronizer?.(VOI_SYNC_ID); } catch {}
    const voiSync = cornerstoneTools.synchronizers?.createVOISynchronizer
      ? cornerstoneTools.synchronizers.createVOISynchronizer(VOI_SYNC_ID)
      : null;
    if (voiSync) {
      for (const id of MPR_VIEWPORT_IDS) {
        voiSync.add({ renderingEngineId: RENDERING_ENGINE_ID, viewportId: id });
      }
    }
  } catch (e) {
    console.warn('[cbct] VOI synchronizer setup failed:', e?.message);
  }
}

/**
 * Mode-aware tool group setup. Used when the user switches view modes
 * (e.g. MPR + 3D → Ceph) so the new viewport IDs get the same set of
 * tools wired up. Falls back to the default MPR_VIEWPORT_IDS when the
 * mode config is missing.
 */
function setupCbctToolGroupsForMode(engine, modeCfg) {
  initPrimaryToolMap();
  try { cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_MPR_ID); } catch {}
  try { cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_3D_ID); } catch {}
  const mprGroup = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_MPR_ID);
  const vrGroup  = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_3D_ID);

  const mprTools = [
    cornerstoneTools.WindowLevelTool, cornerstoneTools.PanTool, cornerstoneTools.ZoomTool,
    cornerstoneTools.StackScrollTool, cornerstoneTools.CrosshairsTool,
    cornerstoneTools.LengthTool, cornerstoneTools.AngleTool,
    cornerstoneTools.BidirectionalTool, cornerstoneTools.ProbeTool,
    // Phase 2 region tools — density readout (HU stats over a region)
    cornerstoneTools.RectangleROITool,
    cornerstoneTools.CircleROITool,
    cornerstoneTools.EllipticalROITool,
  ];
  for (const T of mprTools) cornerstoneTools.addTool(T);
  try { cornerstoneTools.addTool(cornerstoneTools.TrackballRotateTool); } catch {}

  mprGroup.addTool(cornerstoneTools.WindowLevelTool.toolName);
  mprGroup.addTool(cornerstoneTools.PanTool.toolName);
  mprGroup.addTool(cornerstoneTools.ZoomTool.toolName);
  mprGroup.addTool(cornerstoneTools.StackScrollTool.toolName);
  mprGroup.addTool(cornerstoneTools.CrosshairsTool.toolName, {
    getReferenceLineColor: (vid) => {
      const v = (modeCfg?.viewports || []).find((x) => x.id === vid);
      return v?.color || '#f59e0b';
    },
    getReferenceLineControllable: () => true,
    getReferenceLineDraggableRotatable: () => true,
    getReferenceLineSlabThicknessControlsOn: () => false,
  });
  mprGroup.addTool(cornerstoneTools.LengthTool.toolName);
  mprGroup.addTool(cornerstoneTools.AngleTool.toolName);
  mprGroup.addTool(cornerstoneTools.BidirectionalTool.toolName);
  mprGroup.addTool(cornerstoneTools.ProbeTool.toolName);
  mprGroup.addTool(cornerstoneTools.RectangleROITool.toolName);
  mprGroup.addTool(cornerstoneTools.CircleROITool.toolName);
  mprGroup.addTool(cornerstoneTools.EllipticalROITool.toolName);

  // Add every orthographic viewport from this mode's config to the MPR
  // group, every volume_3d viewport to the 3D group.
  const orthoIds = (modeCfg?.viewports || []).filter((v) => v.kind === 'orthographic').map((v) => v.id);
  const vrIds    = (modeCfg?.viewports || []).filter((v) => v.kind === 'volume_3d').map((v) => v.id);
  for (const id of orthoIds) mprGroup.addViewport(id, RENDERING_ENGINE_ID);
  for (const id of vrIds)    vrGroup.addViewport(id, RENDERING_ENGINE_ID);

  // Default bindings — Crosshair on Primary (only meaningful with >=2
  // ortho viewports, but harmless on a single panel), W/L on Secondary.
  if (orthoIds.length >= 2) {
    mprGroup.setToolActive(cornerstoneTools.CrosshairsTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });
  }
  mprGroup.setToolActive(cornerstoneTools.WindowLevelTool.toolName, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
  });
  mprGroup.setToolActive(cornerstoneTools.PanTool.toolName, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }],
  });
  mprGroup.setToolActive(cornerstoneTools.StackScrollTool.toolName, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
  });

  if (vrIds.length > 0) {
    vrGroup.addTool(cornerstoneTools.TrackballRotateTool.toolName);
    vrGroup.addTool(cornerstoneTools.ZoomTool.toolName);
    vrGroup.setToolActive(cornerstoneTools.TrackballRotateTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });
    vrGroup.setToolActive(cornerstoneTools.ZoomTool.toolName, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
    });
  }

  // VOI sync across orthographic viewports.
  try {
    try { cornerstoneTools.SynchronizerManager?.destroySynchronizer?.(VOI_SYNC_ID); } catch {}
    const voiSync = cornerstoneTools.synchronizers?.createVOISynchronizer
      ? cornerstoneTools.synchronizers.createVOISynchronizer(VOI_SYNC_ID)
      : null;
    if (voiSync) {
      for (const id of orthoIds) {
        voiSync.add({ renderingEngineId: RENDERING_ENGINE_ID, viewportId: id });
      }
    }
  } catch (e) {
    console.warn('[cbct] VOI synchronizer setup failed:', e?.message);
  }
}

/**
 * Swap which tool is active on the Primary mouse button. Used by the
 * toolbar to move between Crosshair / Length / Angle / etc. without
 * disturbing the secondary / wheel bindings.
 */
function setActivePrimaryTool(toolName) {
  const grp = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_MPR_ID);
  if (!grp) return;
  const Primary = cornerstoneTools.Enums.MouseBindings.Primary;
  // First, demote whichever tool currently owns Primary back to passive.
  for (const t of Object.values(PRIMARY_TOOLS)) {
    try { grp.setToolPassive(t); } catch {}
  }
  // Then activate the chosen tool on Primary.
  try {
    grp.setToolActive(toolName, { bindings: [{ mouseButton: Primary }] });
  } catch (e) {
    console.warn('[cbct] setActivePrimaryTool failed for', toolName, e?.message);
  }
}

/**
 * Reset all viewport cameras to their default (initial) position. Useful
 * after the user has zoomed/panned around and wants to "go home".
 */
function resetAllViewports(engine) {
  if (!engine) return;
  for (const v of VIEWPORTS) {
    try {
      const vp = engine.getViewport(v.id);
      vp?.resetCamera?.();
      vp?.resetProperties?.();
    } catch {}
  }
  engine.render();
}

/**
 * Clear all measurement annotations across the MPR viewports. Doesn't
 * touch the volume / camera — just wipes the lengths/angles/probes the
 * user drew.
 */
function clearAllAnnotations() {
  try {
    cornerstoneTools.annotation?.state?.removeAllAnnotations?.();
  } catch (e) {
    console.warn('[cbct] clearAllAnnotations failed:', e?.message);
  }
  // Trigger a re-render so the cleared annotations actually disappear
  const engine = cornerstone.getRenderingEngine(RENDERING_ENGINE_ID);
  engine?.render();
}

export default function CBCTViewerPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const studyId = searchParams.get('study');
  // Tokenized share flow: SharedViewerPage validated the token server-side
  // and stashed the resolved payload (signed URLs + saved annotations) in
  // sessionStorage. In share mode we skip the Supabase auth gate and all
  // DB reads/writes — everything renders from the payload, read-only.
  const shareKey = searchParams.get('share');
  const sharePayload = useMemo(() => readSharePayload(shareKey), [shareKey]);
  const readOnly = searchParams.get('readonly') === '1' || !!shareKey;
  const effectiveStudyId = studyId || sharePayload?.study?.id || null;

  const [stage, setStage] = useState('init'); // init | resolving | loading-volume | ready | error
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(0);
  const [activePreset, setActivePreset] = useState('Bone');
  const [presetTable, setPresetTable] = useState(VOLUME_PRESETS_HU);

  // Phase 1: active measurement / interaction tool. 'crosshair' is default.
  const [activeTool, setActiveTool] = useState('crosshair');

  // Per-panel slice HUD: { CBCT_AXIAL: { current, total }, ... }
  const [sliceHud, setSliceHud] = useState({});

  // HU readout from the Probe tool: { value, x, y, z } in patient mm + voxel value
  const [probeReadout, setProbeReadout] = useState(null);

  // View mode — 'mpr-3d' (default), 'ceph', 'pano' (placeholder), etc.
  const [viewMode, setViewMode] = useState('mpr-3d');

  // Display toggles
  const [invert, setInvert]               = useState(false);
  const [showRefLines, setShowRefLines]   = useState(true);
  const [slabThickness, setSlabThickness] = useState(0); // in mm; 0 = single slice

  // Annotation list (refreshed periodically while the user is drawing).
  // Each entry: { uid, toolName, displayText, viewportId }
  const [annotations, setAnnotations] = useState([]);

  // AI segmentation modal — Phase 4. Each feature can be triggered
  // individually; results either populate viewer state (e.g. nerve
  // polyline → nervePoints) or queue for later display.
  const [showAiModal, setShowAiModal] = useState(false);
  const [aiRunning, setAiRunning] = useState({}); // { 'nerve-canal': true }
  const [aiLastRun, setAiLastRun] = useState({}); // { 'nerve-canal': { ts, result } }

  // Phase 3.6.2 — "Promote to Treatment Plan" dialog state.
  // When the user has placed implants, they can promote the planning
  // session into a formal treatment_plans row that flows into the EMR's
  // billing + plan-acceptance pipeline.
  const [showPromoteModal, setShowPromoteModal] = useState(false);
  const [promoteTitle,     setPromoteTitle]     = useState('Implant treatment plan');
  const [promoteFeePerImplant, setPromoteFeePerImplant] = useState(4500);
  const [promotingPlan,    setPromotingPlan]    = useState(false);
  const [promoteResult,    setPromoteResult]    = useState(null); // { planId } on success

  // Phase 3.2 arch-curve Pano state. archPoints is an array of [worldX, worldY]
  // captured from user clicks on the axial viewport. The pano canvas
  // re-renders whenever the points or VOI change.
  const [archPoints, setArchPoints]   = useState([]);
  const [archSlabMM, setArchSlabMM]   = useState(8); // perp slab thickness mm
  // Surface render-side failures (null scalarData, missing geometry, etc.)
  // in the pano panel so the user sees *why* the right-hand image stays
  // empty instead of staring at a black canvas with no feedback.
  const [panoRenderError, setPanoRenderError] = useState(null);
  // Explicit "Trace Arch" tool — when true, ANY left-click on the axial
  // adds an arch point. When false, only Shift+Click adds points (legacy
  // shortcut). This makes the workflow discoverable instead of hidden
  // behind a keyboard modifier.
  const [tracingArch, setTracingArch] = useState(false);
  // AI auto-trace status flag, used to disable the button + show "Running…"
  const [archAiRunning, setArchAiRunning] = useState(false);
  const panoCanvasRef                 = useRef(null);

  // Phase 3.3 cross-sections — N thin slices perpendicular to the arch
  // curve at uniform arc-length spacing. Each is rendered into its own
  // <canvas>; the refs are collected lazily.
  const CROSSSEC_COUNT = 16;
  const [xsWidthMM, setXsWidthMM] = useState(25);
  const xsCanvasRefs = useRef([]);

  // Phase 3.5 nerve canal trace. nervePoints is an array of 3D world
  // points [x, y, z]. tracingNerve enables Shift+Click capture on any
  // MPR viewport. safetyZoneMM is the radius around the polyline
  // rendered as an overlay (clinical default 2mm — inferior alveolar
  // nerve injury risk threshold for implant proximity).
  const [nervePoints, setNervePoints]     = useState([]);
  const [tracingNerve, setTracingNerve]   = useState(false);
  const [safetyZoneMM, setSafetyZoneMM]   = useState(2);
  // How thick a slab around the active slice plane to highlight the
  // nerve in. User-adjustable so they can widen if the nerve disappears
  // between slices, or narrow for surgical precision. Default 5mm gives
  // a generous view; 2mm matches the actual canal diameter.
  const [nerveSlabMM, setNerveSlabMM]     = useState(5);

  // Phase 3.4 implant placement. implants is an array of:
  //   { id, apex: [x,y,z], head: [x,y,z], diameterMM, lengthMM, label }
  // placingImplant: when set to a catalog entry { diameterMM, lengthMM, label },
  // the next two Shift+Clicks on MPR define apex then head.
  const [implants, setImplants]                 = useState([]);
  const [placingImplant, setPlacingImplant]     = useState(null);
  const [pendingApex, setPendingApex]           = useState(null);
  const [implantCatalogOpen, setImplantCatalogOpen] = useState(false);

  // Cached volume + last loaded volumeId, for fast view-mode rebuilds
  // without reloading the volume.
  const cachedVolumeRef = useRef(null);
  const cachedVolumeIdRef = useRef(null);

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
        if (shareKey && !sharePayload) {
          throw new Error(SHARE_EXPIRED_MESSAGE);
        }
        if (!effectiveStudyId) {
          throw new Error('Missing ?study=<imaging_studies.id> URL parameter.');
        }
        if (!sharePayload) {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) {
            const back = encodeURIComponent(location.pathname + location.search);
            navigate(`/login?next=${back}`, { replace: true });
            return;
          }
        }
        if (cancelled) return;

        setStage('resolving');

        // ── Architecture A fast path ──────────────────────────────────
        // If the EMR converted this study to NIfTI server-side, take the
        // single-file path. Geometry is baked into the header — no IPP
        // guesswork, no scanner-quirk landmines. Falls through to the
        // DICOM streaming path if no NIfTI is available yet.
        // Share mode: the resolve API already signed the NIfTI URL.
        let niftiInfo = { url: null, status: null, error: null };
        if (sharePayload) {
          niftiInfo = { url: sharePayload.niftiUrl || null, status: sharePayload.niftiUrl ? 'ready' : null, error: null };
        } else {
          try {
            niftiInfo = await resolveStudyNiftiVolume(studyId);
          } catch (e) {
            console.warn('[cbct] resolveStudyNiftiVolume failed (will fall back to DICOM):', e?.message);
          }
        }
        if (cancelled) return;

        if (niftiInfo.status === 'converting' || niftiInfo.status === 'queued') {
          throw new Error(
            'This volume is still being processed by the conversion service. ' +
            'Refresh in a minute, or fall back to the 2D DICOM viewer below.'
          );
        }

        if (niftiInfo.url) {
          // NIfTI ready — load + render and we're done. The browser
          // sees one file with explicit geometry and avoids the entire
          // DICOM-stack reconstruction path.
          setStage('loading-volume');
          await initCornerstone();
          if (cancelled) return;

          const volumeId = `cornerstoneVolume:nifti-${effectiveStudyId}`;
          await renderFromNifti({
            niftiUrl: niftiInfo.url,
            volumeId,
            elements: {
              CBCT_AXIAL:    axialRef.current,
              CBCT_CORONAL:  coronalRef.current,
              CBCT_SAGITTAL: sagittalRef.current,
              CBCT_3D:       vrRef.current,
            },
            setProgress,
            setPresetTable,
            cancelledRef: () => cancelled,
            engineRef: enginRef,
            cachedVolumeRef,
            cachedVolumeIdRef,
          });
          if (cancelled) return;
          setStage('ready');
          return;
        }

        // ── Fallback: DICOM streaming path ────────────────────────────
        // Used when the converter hasn't run yet (status null) or failed.
        if (niftiInfo.status === 'failed') {
          console.warn('[cbct] NIfTI conversion failed for this study, falling back to DICOM:', niftiInfo.error);
        }

        const list = sharePayload
          ? shareDicomFiles(sharePayload)
          : await resolveStudyDicomFiles(studyId);
        if (cancelled) return;
        if (list.length < 3) {
          throw new Error(
            `Volume rendering needs at least 3 DICOM instances; got ${list.length}.`
          );
        }

        await initCornerstone();
        if (cancelled) return;

        const imageIds = list.map((f) => imageIdFromSignedUrl(f.url));
        const volumeId = `cornerstoneStreamingImageVolume:study-${effectiveStudyId}`;

        setStage('loading-volume');

        // Pre-load every instance so the metadata providers are populated
        // BEFORE we ask the volume loader to sort by ImagePositionPatient.
        // Without this, the streaming volume loader creates a volume with
        // slices in arbitrary order. Pre-loading takes ~10-30s for a
        // 400-slice CBCT but is mandatory for correct MPR geometry AND
        // for the series-grouping pass below (we need orientation +
        // SeriesInstanceUID populated for every image).
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

        // CBCT uploads almost always contain MORE than one DICOM series:
        // the primary axial reconstruction PLUS scout images, secondary
        // thin recons, MIP volumes, etc. If we feed all of them into one
        // volume the slices end up at conflicting Z positions, the spacing
        // auto-detect picks an average that fits NEITHER series, and
        // cross-axis MPR alternates between series → striped garbage.
        //
        // Fix: group imageIds by (SeriesInstanceUID, orientation), pick
        // the largest coherent group, and build the volume from only that.
        const orientKey = (cosines) =>
          Array.isArray(cosines) ? cosines.map((x) => x.toFixed(3)).join(',') : 'na';
        const groups = new Map();
        for (const id of imageIds) {
          const series = cornerstone.metaData.get('generalSeriesModule', id);
          const plane  = cornerstone.metaData.get('imagePlaneModule', id);
          const seriesUID = series?.seriesInstanceUID || 'unknown';
          const orient = `${orientKey(plane?.rowCosines)}|${orientKey(plane?.columnCosines)}`;
          const key = `${seriesUID}::${orient}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(id);
        }

        // Pick the largest group. Tie-break: prefer the one with valid
        // ImageOrientationPatient (filters out scouts which sometimes
        // ship with no cosines).
        const groupSummary = Array.from(groups.entries())
          .map(([key, ids]) => ({ key, count: ids.length, hasOrient: !key.endsWith('::na|na') }))
          .sort((a, b) => (b.count - a.count) || (Number(b.hasOrient) - Number(a.hasOrient)));
        console.log('[cbct] series groups', groupSummary);

        let groupedImageIds = imageIds;
        if (groupSummary.length > 0) {
          const winner = groupSummary[0];
          groupedImageIds = groups.get(winner.key);
          console.log('[cbct] picked series group', winner.key, '→', winner.count, 'of', imageIds.length, 'slices');
          if (groupedImageIds.length < 3) {
            // Safety: if grouping produced too small a result, fall back
            // to the whole set so the user at least sees something.
            console.warn('[cbct] best group too small, falling back to all images');
            groupedImageIds = imageIds;
          }
        }

        // Manual sort by ImagePositionPatient projected onto the
        // orientation-derived scan axis. We don't rely on cornerstone's
        // sortImageIdsAndGetSpacing here because it returns scanAxisNormal:
        // null on this CBCT, which means it can't determine slice direction
        // from the metadata — and downstream volume geometry is then wrong.
        //
        // Instead we compute the scan-axis normal from row × column cosines
        // (always works for a coherent series) and project each slice's IPP
        // onto it to get an unambiguous Z position.
        const refPlane = cornerstone.metaData.get('imagePlaneModule', groupedImageIds[0]);
        const rowCos = refPlane?.rowCosines || [1, 0, 0];
        const colCos = refPlane?.columnCosines || [0, 1, 0];
        // Normal = row × col
        const normal = [
          rowCos[1] * colCos[2] - rowCos[2] * colCos[1],
          rowCos[2] * colCos[0] - rowCos[0] * colCos[2],
          rowCos[0] * colCos[1] - rowCos[1] * colCos[0],
        ];
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

        const slicesWithPos = groupedImageIds
          .map((id) => {
            const p = cornerstone.metaData.get('imagePlaneModule', id);
            const ipp = p?.imagePositionPatient;
            if (!Array.isArray(ipp) || ipp.length !== 3) return null;
            return { id, ipp, axisProj: dot(ipp, normal) };
          })
          .filter(Boolean)
          .sort((a, b) => a.axisProj - b.axisProj);

        const sortedImageIds = slicesWithPos.map((s) => s.id);

        // Compute true Z spacing from consecutive IPP projections. This is
        // the actual physical distance between adjacent slices.
        const zDeltas = [];
        for (let i = 1; i < slicesWithPos.length; i++) {
          zDeltas.push(slicesWithPos[i].axisProj - slicesWithPos[i - 1].axisProj);
        }
        zDeltas.sort((a, b) => a - b);
        const medianZSpacing = zDeltas.length
          ? zDeltas[Math.floor(zDeltas.length / 2)]
          : 1.0;

        const minDelta = zDeltas[0];
        const maxDelta = zDeltas[zDeltas.length - 1];
        const meanDelta = zDeltas.reduce((s, x) => s + x, 0) / Math.max(1, zDeltas.length);

        console.log('[cbct] manual sort + spacing', {
          slicesWithIpp: slicesWithPos.length,
          totalSlices: groupedImageIds.length,
          rowCosines: rowCos,
          columnCosines: colCos,
          computedNormal: normal,
          medianZSpacing,
          meanZDelta: meanDelta,
          minZDelta: minDelta,
          maxZDelta: maxDelta,
          first5IppZ: slicesWithPos.slice(0, 5).map((s) => s.axisProj),
          last5IppZ: slicesWithPos.slice(-5).map((s) => s.axisProj),
          // First 5 raw IPPs to sanity check
          first5Ipp: slicesWithPos.slice(0, 5).map((s) => s.ipp),
        });

        // Now build the volume from sorted IDs of a single coherent series.
        const volume = await cornerstone.volumeLoader.createAndCacheVolume(volumeId, { imageIds: sortedImageIds });
        if (cancelled) return;

        // Aggressively override the volume's geometry if we computed a
        // sensible Z spacing. This is the line where browser-side metadata
        // detection has been failing — we trust our manual computation.
        try {
          const cur = Array.isArray(volume.spacing) ? [...volume.spacing] : null;
          console.log('[cbct] volume geometry (pre-override)', {
            dimensions: Array.isArray(volume.dimensions) ? [...volume.dimensions] : volume.dimensions,
            spacing: cur,
            origin: Array.isArray(volume.origin) ? [...volume.origin] : volume.origin,
          });
          if (cur && Number.isFinite(medianZSpacing) && medianZSpacing > 0.01 && medianZSpacing < 5) {
            const newSpacing = [cur[0], cur[1], Math.abs(medianZSpacing)];
            if (Math.abs(cur[2] - newSpacing[2]) > 0.005) {
              console.warn('[cbct] forcing Z spacing', cur[2], '→', newSpacing[2], '(from median IPP delta)');
              volume.spacing = newSpacing;
              try {
                if (volume.imageData?.setSpacing) {
                  volume.imageData.setSpacing(newSpacing[0], newSpacing[1], newSpacing[2]);
                  volume.imageData.modified?.();
                }
              } catch {}
            }
          }
        } catch (geomErr) {
          console.warn('[cbct] geometry override failed:', geomErr?.message);
        }

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

        // VOI synchronizer — when the user adjusts W/L on any MPR panel,
        // the same voiRange is mirrored to the other two so all three
        // planes stay in the same window. Without this, right-drag on
        // axial only changes axial (which the user correctly flagged).
        try {
          // Destroy any leftover synchronizer from a previous mount
          try {
            cornerstoneTools.SynchronizerManager?.destroySynchronizer?.(VOI_SYNC_ID);
          } catch {}
          const voiSync = cornerstoneTools.synchronizers?.createVOISynchronizer
            ? cornerstoneTools.synchronizers.createVOISynchronizer(VOI_SYNC_ID)
            : null;
          if (voiSync) {
            for (const id of MPR_VIEWPORT_IDS) {
              voiSync.add({ renderingEngineId: RENDERING_ENGINE_ID, viewportId: id });
            }
            console.log('[cbct] VOI synchronizer attached across MPR viewports');
          } else {
            console.warn('[cbct] createVOISynchronizer not available — W/L will not sync');
          }
        } catch (syncErr) {
          console.warn('[cbct] VOI synchronizer setup failed:', syncErr?.message);
        }

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
  }, [studyId, shareKey, sharePayload, effectiveStudyId, navigate, location.pathname, location.search]);

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

  // ── Slice HUD wiring ────────────────────────────────────────────────
  // Listen for camera-modified events on each MPR viewport and update the
  // current/total slice indicator. Cornerstone3D doesn't expose a
  // first-class "current slice" API on volume orthographic viewports, so
  // we derive it from the focal point projected onto the volume's slice
  // axis.
  useEffect(() => {
    if (stage !== 'ready') return;
    const engine = enginRef.current;
    if (!engine) return;

    const computeSlice = (vp) => {
      try {
        const camera = vp.getCamera();
        const imageData = vp.getImageData?.();
        if (!camera || !imageData) return null;
        const { focalPoint, viewPlaneNormal } = camera;
        const dimensions = imageData.dimensions || vp.getImageData()?.imageData?.getDimensions?.();
        const spacing    = imageData.spacing    || vp.getImageData()?.imageData?.getSpacing?.();
        const origin     = imageData.origin     || vp.getImageData()?.imageData?.getOrigin?.();
        if (!dimensions || !spacing || !origin) return null;
        // Project focal point onto the view plane normal (signed distance
        // from volume origin), divide by spacing along that normal.
        const dx = focalPoint[0] - origin[0];
        const dy = focalPoint[1] - origin[1];
        const dz = focalPoint[2] - origin[2];
        const dist =
          dx * viewPlaneNormal[0] +
          dy * viewPlaneNormal[1] +
          dz * viewPlaneNormal[2];
        // Spacing along the view-plane normal (project unit normal onto
        // each axis to find which voxel-spacing dominates).
        const sliceSpacing =
          Math.abs(viewPlaneNormal[0]) * spacing[0] +
          Math.abs(viewPlaneNormal[1]) * spacing[1] +
          Math.abs(viewPlaneNormal[2]) * spacing[2];
        if (!sliceSpacing) return null;
        const total =
          Math.abs(viewPlaneNormal[0]) * dimensions[0] +
          Math.abs(viewPlaneNormal[1]) * dimensions[1] +
          Math.abs(viewPlaneNormal[2]) * dimensions[2];
        const current = Math.max(1, Math.min(Math.round(total), Math.round(Math.abs(dist) / sliceSpacing) + 1));
        return { current, total: Math.round(total) };
      } catch {
        return null;
      }
    };

    const update = () => {
      const next = {};
      for (const id of MPR_VIEWPORT_IDS) {
        const vp = engine.getViewport(id);
        if (!vp) continue;
        const s = computeSlice(vp);
        if (s) next[id] = s;
      }
      setSliceHud(next);
    };

    // Initial update + listen for camera modifications
    update();
    const handler = (evt) => {
      const vid = evt?.detail?.viewportId;
      if (vid && MPR_VIEWPORT_IDS.includes(vid)) update();
    };
    cornerstone.eventTarget.addEventListener(
      cornerstone.Enums.Events.CAMERA_MODIFIED, handler
    );
    return () => {
      try {
        cornerstone.eventTarget.removeEventListener(
          cornerstone.Enums.Events.CAMERA_MODIFIED, handler
        );
      } catch {}
    };
  }, [stage]);

  // ── Tool selection ─────────────────────────────────────────────────
  const selectTool = useCallback((toolKey) => {
    const toolName = PRIMARY_TOOLS[toolKey];
    if (!toolName) return;
    setActiveTool(toolKey);
    setActivePrimaryTool(toolName);
  }, []);

  const handleResetViews = () => {
    resetAllViewports(enginRef.current);
  };
  const handleClearMeasurements = () => {
    clearAllAnnotations();
    setAnnotations([]);
  };

  // ── Persist annotations ─────────────────────────────────────────────
  // Save the current Cornerstone annotation state as JSON on the
  // imaging_studies row. The shape is whatever cornerstoneTools.annotation
  // .state.getAllAnnotations() returns — we don't transform it, so a
  // future viewer can rehydrate exactly. RLS is already in place on
  // imaging_studies so this respects clinic scoping.
  // Run an AI inference model on this study. The viewer doesn't call
  // the inference service directly (internal-key never leaves server);
  // it POSTs to the EMR's /api/ai-infer route which forwards.
  const runAiInference = useCallback(async (modelKey) => {
    if (!studyId || readOnly) return;
    setAiRunning((r) => ({ ...r, [modelKey]: true }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      // Same-origin call — /api/ai-infer is now hosted on the imaging
      // project itself (the EMR project has Vercel SSO Deployment
      // Protection enabled which 401'd cross-origin fetches at the edge
      // before our handler could run).
      const resp = await fetch(`/api/ai-infer`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session?.access_token || ''}`,
        },
        body: JSON.stringify({ study_id: studyId, model: modelKey }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(body?.error || resp.statusText);
      setAiLastRun((r) => ({ ...r, [modelKey]: { ts: Date.now(), result: body } }));

      // Auto-apply results that map to existing viewer state
      if (modelKey === 'nerve-canal' && Array.isArray(body.polyline) && body.polyline.length >= 2) {
        if (window.confirm(`AI suggested ${body.polyline.length} nerve-canal points (state: ${body.model_state}). Replace existing trace?`)) {
          setNervePoints(body.polyline);
          if (typeof body.safety_zone_mm === 'number') setSafetyZoneMM(body.safety_zone_mm);
        }
      } else if (modelKey === 'arch-curve' && Array.isArray(body.archPoints) && body.archPoints.length >= 3) {
        // Arch-curve returns 2D points [x, y] in world mm (Z is derived
        // from the current Pano focal slice). Auto-apply when on Pano,
        // confirm when on other views.
        const replace = archPoints.length === 0 || window.confirm(
          `AI suggested ${body.archPoints.length} arch points (${body.model_state}). Replace existing arch?`
        );
        if (replace) setArchPoints(body.archPoints);
      }
    } catch (e) {
      console.error('[cbct] AI infer failed:', e);
      alert(`AI inference failed: ${e?.message || e}`);
    } finally {
      setAiRunning((r) => ({ ...r, [modelKey]: false }));
    }
  }, [studyId, readOnly]);

  // Promote the current implant plan into a formal treatment_plans row
  // in the EMR. Looks up the study's patient + clinic, generates a
  // treatment_items array from the placed implants, and inserts the
  // plan. RLS on treatment_plans is already in place by clinic_id.
  const handlePromoteToTreatmentPlan = useCallback(async () => {
    if (!studyId || implants.length === 0) return;
    setPromotingPlan(true);
    setPromoteResult(null);
    try {
      // 1. Look up the imaging study to get patient_id + clinic_id
      const { data: study, error: sErr } = await supabase
        .from('imaging_studies')
        .select('id, patient_id, clinic_id, study_date')
        .eq('id', studyId)
        .single();
      if (sErr) throw new Error('Study lookup failed: ' + sErr.message);
      if (!study?.patient_id || !study?.clinic_id) {
        throw new Error('Study is missing patient or clinic — cannot promote.');
      }

      // 2. Current user = doctor_id
      const { data: { session } } = await supabase.auth.getSession();
      const doctorId = session?.user?.id;
      if (!doctorId) throw new Error('Not signed in.');

      // 3. Build treatment_items from implants
      const items = implants.map((imp, i) => ({
        type: 'implant',
        label: imp.label,
        diameter_mm: imp.diameterMM,
        length_mm: imp.lengthMM,
        tooth_fdi: null, // user can map later in EMR
        unit_price: Number(promoteFeePerImplant) || 0,
        quantity: 1,
        phase: 1,
        notes: `Implant ${i + 1} from CBCT plan`,
      }));
      const totalAmount = items.reduce((s, it) => s + (it.unit_price || 0), 0);

      // 4. Insert the plan
      const { data: plan, error: pErr } = await supabase
        .from('treatment_plans')
        .insert({
          patient_id: study.patient_id,
          clinic_id:  study.clinic_id,
          doctor_id:  doctorId,
          imaging_study_id: study.id,
          source: 'cbct_viewer',
          title: promoteTitle || 'Implant treatment plan',
          description: `Generated from CBCT viewer on ${new Date().toISOString().slice(0, 10)}. ` +
                       `${implants.length} implant${implants.length > 1 ? 's' : ''} planned` +
                       (nervePoints.length >= 2 ? `, IAN traced with ${safetyZoneMM}mm safety zone.` : '.'),
          start_date: new Date().toISOString().slice(0, 10),
          total_amount: totalAmount,
          status: 'draft',
          treatment_items: items,
        })
        .select('id')
        .single();
      if (pErr) throw new Error('Plan insert failed: ' + pErr.message);

      setPromoteResult({ planId: plan.id, count: items.length, total: totalAmount });
    } catch (e) {
      console.error('[cbct] promote-to-plan failed:', e);
      alert('Could not create plan: ' + (e?.message || e));
    } finally {
      setPromotingPlan(false);
    }
  }, [studyId, implants, promoteTitle, promoteFeePerImplant, nervePoints, safetyZoneMM]);

  const handleSaveMeasurements = useCallback(async () => {
    if (!studyId || readOnly) return;
    try {
      const all = cornerstoneTools.annotation?.state?.getAllAnnotations?.() || [];
      const serialized = all.map((a) => ({
        annotationUID: a.annotationUID,
        metadata: a.metadata,
        data: {
          handles: a.data?.handles,
          label: a.data?.label,
          cachedStats: a.data?.cachedStats,
        },
      }));
      // viewer_annotations is now an OBJECT (was an array). Includes
      // both Cornerstone annotations AND viewer-specific state like the
      // arch curve points. Backward-compat load below handles legacy
      // array shape.
      const payload = {
        version: 2,
        annotations: serialized,
        archPoints: archPoints,
        archSlabMM: archSlabMM,
        nervePoints: nervePoints,
        safetyZoneMM: safetyZoneMM,
        implants: implants,
      };
      const { error } = await supabase
        .from('imaging_studies')
        .update({
          viewer_annotations: payload,
          viewer_annotations_updated_at: new Date().toISOString(),
        })
        .eq('id', studyId);
      if (error) throw error;
      console.log('[cbct] saved', serialized.length, 'annotations +', archPoints.length, 'arch points');
      setProbeReadout({ savedAt: Date.now(), count: serialized.length + archPoints.length });
      setTimeout(() => setProbeReadout(null), 2000);
    } catch (e) {
      console.warn('[cbct] save annotations failed:', e?.message);
      alert(`Save failed: ${e?.message || e}`);
    }
  }, [studyId, readOnly, archPoints, archSlabMM, nervePoints, safetyZoneMM, implants]);

  // Auto-load saved annotations once the viewer is ready (best-effort).
  // Share mode: the resolve API already returned viewer_annotations in the
  // payload — no DB read (an anonymous recipient has no RLS access anyway).
  useEffect(() => {
    if (stage !== 'ready' || (!studyId && !sharePayload)) return;
    let cancelled = false;
    (async () => {
      try {
        let saved = null;
        if (sharePayload) {
          saved = sharePayload.viewer_annotations;
        } else {
          const { data } = await supabase
            .from('imaging_studies')
            .select('viewer_annotations')
            .eq('id', studyId)
            .maybeSingle();
          if (cancelled) return;
          saved = data?.viewer_annotations;
        }
        if (!saved) return;
        // Two shapes supported:
        //   v1 (legacy): array of annotations
        //   v2: { version: 2, annotations: [...], archPoints: [...], archSlabMM }
        const annList = Array.isArray(saved) ? saved : (saved.annotations || []);
        const savedArch = !Array.isArray(saved) ? (saved.archPoints || []) : [];
        const savedSlab = !Array.isArray(saved) ? saved.archSlabMM : null;

        // Restore cornerstone annotations
        if (annList.length > 0) {
          const engine = enginRef.current;
          const vp = engine?.getViewport(MPR_VIEWPORT_IDS[0]);
          const FrameOfReferenceUID = vp?.getFrameOfReferenceUID?.();
          if (FrameOfReferenceUID) {
            for (const a of annList) {
              try {
                cornerstoneTools.annotation?.state?.addAnnotation?.(
                  { ...a, metadata: { ...a.metadata, FrameOfReferenceUID } },
                  FrameOfReferenceUID
                );
              } catch {}
            }
            engine?.render();
          }
        }
        // Restore arch curve
        if (Array.isArray(savedArch) && savedArch.length >= 2) {
          setArchPoints(savedArch);
        }
        if (typeof savedSlab === 'number') setArchSlabMM(savedSlab);
        // Restore nerve trace
        const savedNerve = !Array.isArray(saved) ? (saved.nervePoints || []) : [];
        if (Array.isArray(savedNerve) && savedNerve.length >= 2) {
          setNervePoints(savedNerve);
        }
        const savedSafety = !Array.isArray(saved) ? saved.safetyZoneMM : null;
        if (typeof savedSafety === 'number') setSafetyZoneMM(savedSafety);
        // Restore implants
        const savedImplants = !Array.isArray(saved) ? (saved.implants || []) : [];
        if (Array.isArray(savedImplants) && savedImplants.length > 0) {
          setImplants(savedImplants);
        }
        console.log(
          '[cbct] restored', annList.length, 'annotations,',
          savedArch.length, 'arch points,',
          savedNerve.length, 'nerve points'
        );
      } catch (e) {
        console.warn('[cbct] load annotations failed:', e?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [stage, studyId, sharePayload]);

  // ── Display toggles ─────────────────────────────────────────────────
  // Invert image — flips greyscale (negative). Useful for highlighting
  // soft tissue against bone or vice versa.
  useEffect(() => {
    if (stage !== 'ready') return;
    const engine = enginRef.current;
    if (!engine) return;
    for (const v of (VIEW_MODES[viewMode]?.viewports || [])) {
      try {
        const vp = engine.getViewport(v.id);
        if (vp?.setProperties && v.kind === 'orthographic') {
          vp.setProperties({ invert });
        }
      } catch {}
    }
    engine.render();
  }, [invert, stage, viewMode]);

  // Show/hide crosshair reference lines. Cornerstone's CrosshairsTool has
  // a per-tool config — toggling means re-adding with a different
  // getReferenceLineVisibility callback. Simpler: setToolConfig at runtime.
  useEffect(() => {
    if (stage !== 'ready') return;
    try {
      const grp = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_MPR_ID);
      if (!grp) return;
      grp.setToolConfiguration?.(
        cornerstoneTools.CrosshairsTool.toolName,
        { mobile: { enabled: false }, viewportIndicators: showRefLines }
      );
      // Also force a re-render so reference lines redraw
      enginRef.current?.render();
    } catch (e) {
      console.warn('[cbct] toggling reference lines failed:', e?.message);
    }
  }, [showRefLines, stage]);

  // Slab thickness slider — sets slab thickness on each MPR viewport so
  // the user sees a thick-slab MIP instead of a single-slice rendering.
  // Range: 0..30 mm.
  useEffect(() => {
    if (stage !== 'ready') return;
    const engine = enginRef.current;
    if (!engine) return;
    const Enums = cornerstone.Enums;
    for (const v of (VIEW_MODES[viewMode]?.viewports || [])) {
      try {
        const vp = engine.getViewport(v.id);
        if (!vp || v.kind !== 'orthographic') continue;
        // For Ceph mode, viewports specify their own slab (200mm MIP).
        // We don't override that here — slabThickness slider only affects
        // panels that didn't request a fixed slab in their config.
        if (typeof v.slabMM === 'number') continue;
        if (slabThickness <= 0) {
          vp.setSlabThickness?.(0);
          vp.setBlendMode?.(Enums.BlendModes.COMPOSITE);
        } else {
          vp.setSlabThickness?.(slabThickness);
          vp.setBlendMode?.(Enums.BlendModes.MAXIMUM_INTENSITY_BLEND);
        }
      } catch (e) {
        console.warn('[cbct] slab thickness failed for', v.id, e?.message);
      }
    }
    engine.render();
  }, [slabThickness, stage, viewMode]);

  // ── View mode switching ────────────────────────────────────────────
  // When user clicks a tab in the top bar, rebuild the engine's
  // viewport set (using the cached volume — no reload). For modes
  // marked ready=false this just shows an overlay and does nothing.
  const switchViewMode = useCallback(async (modeKey) => {
    const cfg = VIEW_MODES[modeKey];
    if (!cfg) return;
    if (!cfg.ready) {
      setViewMode(modeKey);
      return;
    }
    const engine = enginRef.current;
    const volume = cachedVolumeRef.current;
    const volumeId = cachedVolumeIdRef.current;
    if (!engine || !volume || !volumeId) return;
    setViewMode(modeKey);
    // Layout may change DOM (arch-pano vs grid). Wait for React to
    // commit the new structure before binding viewports.
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    // Build new viewport inputs.
    const Enums = cornerstone.Enums;
    const elements = {
      CBCT_AXIAL: axialRef.current,
      CBCT_CORONAL: coronalRef.current,
      CBCT_SAGITTAL: sagittalRef.current,
      CBCT_3D: vrRef.current,
    };
    // Clear out old viewports' tool group bindings; we'll re-add the
    // new viewport IDs after engine.setViewports().
    try { cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_MPR_ID); } catch {}
    try { cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_3D_ID); } catch {}

    const inputs = cfg.viewports.map((v) => {
      // Reuse one of the existing 4 DOM elements depending on layout
      // slot index. For modes with <4 panels, the unused refs just sit
      // empty — that's fine.
      const slotElement =
        elements[v.id] ||
        (cfg.layout === 'side-by-side'
          ? (cfg.viewports.indexOf(v) === 0 ? axialRef.current : coronalRef.current)
          : axialRef.current);
      return {
        viewportId: v.id,
        element: slotElement,
        type: v.kind === 'volume_3d' ? Enums.ViewportType.VOLUME_3D : Enums.ViewportType.ORTHOGRAPHIC,
        defaultOptions: {
          orientation: Enums.OrientationAxis[v.orientationKey],
          background: [0, 0, 0],
        },
      };
    });
    engine.setViewports(inputs);

    await cornerstone.setVolumesForViewports(
      engine,
      [{ volumeId }],
      cfg.viewports.map((v) => v.id),
    );

    // Apply slab + blend mode + invert per-viewport
    for (const v of cfg.viewports) {
      const vp = engine.getViewport(v.id);
      if (!vp) continue;
      if (v.slabMM && v.kind === 'orthographic') {
        vp.setSlabThickness?.(v.slabMM);
        vp.setBlendMode?.(Enums.BlendModes.MAXIMUM_INTENSITY_BLEND);
      }
      if (v.kind === 'orthographic') vp.setProperties({ invert });
    }

    // Rebuild tool groups for the NEW viewport IDs
    setupCbctToolGroupsForMode(engine, cfg);
    engine.render();
  }, [invert]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    if (stage !== 'ready') return;
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const map = {
        '1': 'crosshair', '2': 'length', '3': 'angle',
        '4': 'bidirectional', '5': 'probe', '6': 'pan', '7': 'zoom',
      };
      if (map[e.key]) { selectTool(map[e.key]); e.preventDefault(); return; }
      if (e.key.toLowerCase() === 'r') { handleResetViews(); e.preventDefault(); return; }
      if (e.key.toLowerCase() === 'i') { setInvert((v) => !v); e.preventDefault(); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage]);

  // ── Phase 3.4 Implant placement ────────────────────────────────────
  // When placingImplant is set (catalog entry chosen), the next two
  // Shift+Clicks on an MPR viewport define apex then head. After head,
  // the implant is committed to `implants[]` and placingImplant resets.
  useEffect(() => {
    if (stage !== 'ready' || !placingImplant) return;
    const engine = enginRef.current;
    if (!engine) return;
    const ids = (VIEW_MODES[viewMode]?.viewports || [])
      .filter((v) => v.kind === 'orthographic')
      .map((v) => v.id);
    const cleanups = [];
    for (const id of ids) {
      const vp = engine.getViewport(id);
      if (!vp?.element) continue;
      const el = vp.element;
      const onClick = (e) => {
        if (e.button !== 0 || !e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = el.getBoundingClientRect();
        const world = vp.canvasToWorld([e.clientX - rect.left, e.clientY - rect.top]);
        if (!world) return;
        const pos = [world[0], world[1], world[2]];
        if (!pendingApex) {
          // First click — apex (deep end, in bone)
          setPendingApex(pos);
        } else {
          // Second click — head (crestal end). Commit.
          const newImplant = {
            id: 'imp-' + Date.now().toString(36),
            apex: pendingApex,
            head: pos,
            diameterMM: placingImplant.diameterMM,
            lengthMM: placingImplant.lengthMM,
            label: placingImplant.label,
          };
          setImplants((prev) => [...prev, newImplant]);
          setPendingApex(null);
          setPlacingImplant(null);
        }
      };
      el.addEventListener('mousedown', onClick, { capture: true });
      cleanups.push(() => el.removeEventListener('mousedown', onClick, { capture: true }));
    }
    return () => cleanups.forEach((fn) => fn());
  }, [stage, placingImplant, pendingApex, viewMode]);

  // ── Phase 3.5 Nerve canal trace ────────────────────────────────────
  // When "Trace nerve" is enabled, Shift+Click on ANY MPR viewport
  // captures a 3D world point and appends to nervePoints. Renders as a
  // green polyline + safety zone in each MPR overlay.
  useEffect(() => {
    if (stage !== 'ready') return;
    if (!tracingNerve) return;
    const engine = enginRef.current;
    if (!engine) return;
    // All MPR viewports across modes that have them
    const ids = (VIEW_MODES[viewMode]?.viewports || [])
      .filter((v) => v.kind === 'orthographic')
      .map((v) => v.id);
    const cleanups = [];
    for (const id of ids) {
      const vp = engine.getViewport(id);
      if (!vp?.element) continue;
      const el = vp.element;
      const onClick = (e) => {
        if (e.button !== 0 || !e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = el.getBoundingClientRect();
        const world = vp.canvasToWorld([e.clientX - rect.left, e.clientY - rect.top]);
        if (!world) return;
        setNervePoints((prev) => [...prev, [world[0], world[1], world[2]]]);
      };
      el.addEventListener('mousedown', onClick, { capture: true });
      cleanups.push(() => el.removeEventListener('mousedown', onClick, { capture: true }));
    }
    return () => cleanups.forEach((fn) => fn());
  }, [stage, tracingNerve, viewMode]);

  // ── Phase 3.2 arch-curve Pano ──────────────────────────────────────
  // In Pano mode, capture clicks on the axial viewport and store the
  // corresponding WORLD coordinates as arch control points. The pano
  // canvas re-renders whenever points (or W/L / slab) change.
  useEffect(() => {
    if (stage !== 'ready') return;
    if (viewMode !== 'pano') return;
    const engine = enginRef.current;
    if (!engine) return;
    // Only the axial viewport in Pano mode (we reuse axialRef as the
    // single Cornerstone viewport in this mode). Its viewportId is
    // 'PANO_AXIAL' per VIEW_MODES.
    const vp = engine.getViewport('PANO_AXIAL');
    if (!vp) return;
    const el = vp.element;
    if (!el) return;

    const onClick = (e) => {
      // Only react to LEFT-click on the canvas itself; ignore right /
      // middle / drag (those are W/L / pan / etc.).
      if (e.button !== 0) return;
      // Two ways to add an arch point:
      //   1. Trace Arch tool active → plain left-click (no modifier)
      //   2. Shift+Click anywhere → quick-add (works regardless of tool)
      // Otherwise the click passes through to whatever crosshair/W/L
      // binding is currently active.
      if (!tracingArch && !e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      // Use viewport.canvasToWorld() to convert click pixels → world mm
      const rect = el.getBoundingClientRect();
      const canvasPos = [e.clientX - rect.left, e.clientY - rect.top];
      const world = vp.canvasToWorld(canvasPos);
      if (!world) return;
      // Store as [x, y] (the Z is fixed on the current axial slice;
      // we ignore it because pano always samples the full Z range).
      setArchPoints((prev) => [...prev, [world[0], world[1]]]);
    };

    el.addEventListener('mousedown', onClick, { capture: true });
    return () => el.removeEventListener('mousedown', onClick, { capture: true });
  }, [stage, viewMode, tracingArch]);

  // Render the 16 cross-section canvases whenever points / VOI change
  // and viewMode is 'crosssec'.
  useEffect(() => {
    if (stage !== 'ready') return;
    if (viewMode !== 'crosssec') return;
    const volume = cachedVolumeRef.current;
    if (!volume || archPoints.length < 3) return;
    try {
      const scalarData = getVolumeScalarData(volume);
      if (!scalarData) {
        console.warn('[crosssec] volume scalarData not accessible — skipping render');
        return;
      }
      const dimensions = safeVolumeAttr(volume, 'dimensions');
      const spacing    = safeVolumeAttr(volume, 'spacing');
      const origin     = safeVolumeAttr(volume, 'origin');
      if (!dimensions || !spacing || !origin) {
        console.warn('[crosssec] volume geometry missing — skipping render');
        return;
      }
      const preset = presetTable.find((p) => p.name === activePreset) || presetTable[0];
      const voi = preset
        ? { lower: preset.wc - preset.ww / 2, upper: preset.wc + preset.ww / 2 }
        : { lower: -1000, upper: 3000 };
      const samples = densifyArch(archPoints, CROSSSEC_COUNT);
      for (let i = 0; i < CROSSSEC_COUNT; i++) {
        const canvas = xsCanvasRefs.current[i];
        const sample = samples[i];
        if (!canvas || !sample) continue;
        renderCrossSection(canvas, {
          scalarData,
          dimensions, spacing, origin,
          sample,
          widthMM: xsWidthMM,
          tangentSlabMM: 1,
          voi,
          outW: 200,
          outH: 300,
          flipZ: true,
        });
      }
    } catch (e) {
      console.error('[crosssec] render crashed:', e);
    }
  }, [stage, viewMode, archPoints, xsWidthMM, activePreset, presetTable]);

  // Render the pano canvas whenever points / VOI / slab changes.
  // Wrapped in try/catch — Cornerstone v4's volume API has multiple
  // null traps (imageData not yet built, scalarData not populated,
  // dimensions/spacing/origin sometimes flat arrays, sometimes via
  // vtk methods). Any one of them throwing would white-screen the
  // entire viewer (React error boundary not yet hooked up).
  useEffect(() => {
    if (stage !== 'ready') return;
    if (viewMode !== 'pano') return;
    const canvas = panoCanvasRef.current;
    const volume = cachedVolumeRef.current;
    if (!canvas || !volume || archPoints.length < 3) return;
    try {
      const scalarData = getVolumeScalarData(volume);
      // Diagnostic dump — surface volume shape on first render attempt so
      // we can tell which code path is failing without the user needing
      // to send a screenshot of the console.
      console.log('[pano] render attempt', {
        archPoints: archPoints.length,
        scalarDataLen: scalarData?.length,
        scalarDataType: scalarData?.constructor?.name,
        volumeKeys: volume ? Object.keys(volume).slice(0, 20) : null,
        hasImageData: !!volume.imageData,
      });
      if (!scalarData) {
        const msg = 'Volume scalar data not accessible (Cornerstone v4 API mismatch).';
        console.warn('[pano]', msg);
        setPanoRenderError(msg);
        return;
      }
      const dimensions = safeVolumeAttr(volume, 'dimensions');
      const spacing    = safeVolumeAttr(volume, 'spacing');
      const origin     = safeVolumeAttr(volume, 'origin');
      console.log('[pano] geometry', { dimensions, spacing, origin });
      if (!dimensions || !spacing || !origin) {
        const msg = `Volume geometry missing (dimensions=${!!dimensions} spacing=${!!spacing} origin=${!!origin}).`;
        console.warn('[pano]', msg);
        setPanoRenderError(msg);
        return;
      }
      const preset = presetTable.find((p) => p.name === activePreset) || presetTable[0];
      const voi = preset
        ? { lower: preset.wc - preset.ww / 2, upper: preset.wc + preset.ww / 2 }
        : { lower: -1000, upper: 3000 };
      renderArchPano(canvas, {
        scalarData,
        dimensions, spacing, origin,
        archPoints,
        slabMM: archSlabMM,
        voi,
        panoWidth: 900,
        panoHeight: 400,
        flipZ: true,
      });
      console.log('[pano] render OK', { w: canvas.width, h: canvas.height });
      setPanoRenderError(null);
    } catch (e) {
      console.error('[pano] render crashed:', e);
      setPanoRenderError(`Render crashed: ${e?.message || e}`);
    }
  }, [stage, viewMode, archPoints, archSlabMM, activePreset, presetTable]);

  // ── Annotation list refresh ────────────────────────────────────────
  // Cornerstone fires ANNOTATION_MODIFIED / ANNOTATION_COMPLETED /
  // ANNOTATION_REMOVED on the eventTarget. We listen and refresh our
  // displayed list with each event.
  useEffect(() => {
    if (stage !== 'ready') return;
    // Tool names that COUNT as measurements for the left-rail panel.
    // Crosshairs writes an annotation per viewport (one per MPR panel)
    // but those are interaction state, not clinical measurements —
    // showing them as "4 measurements" before the user has measured
    // anything is confusing. Filter them out.
    const MEASUREMENT_TOOLS = new Set([
      'Length', 'Angle', 'Bidirectional', 'Probe',
      'RectangleROI', 'CircleROI', 'EllipticalROI',
    ]);

    const refresh = () => {
      try {
        const all = cornerstoneTools.annotation?.state?.getAllAnnotations?.() || [];
        const list = [];
        for (const a of all) {
          const tool = a.metadata?.toolName || '?';
          if (!MEASUREMENT_TOOLS.has(tool)) continue;
          const text = a.data?.cachedStats
            ? Object.values(a.data.cachedStats)[0]
            : null;
          let display = '';
          if (tool === 'Length' && text?.length != null) {
            display = `${text.length.toFixed(2)} mm`;
          } else if (tool === 'Angle' && text?.angle != null) {
            display = `${text.angle.toFixed(1)}°`;
          } else if (tool === 'Bidirectional' && text?.length != null && text?.width != null) {
            display = `${text.length.toFixed(2)} × ${text.width.toFixed(2)} mm`;
          } else if (tool === 'Probe' && text?.value != null) {
            display = `${Math.round(text.value)} HU`;
          } else if (
            (tool === 'RectangleROI' || tool === 'CircleROI' || tool === 'EllipticalROI')
            && text?.mean != null
          ) {
            // ROI tools report mean / min / max / stdDev / area / count
            display = `μ ${Math.round(text.mean)} HU · σ ${text.stdDev?.toFixed(0) || 0}`;
          }
          list.push({
            uid: a.annotationUID,
            toolName: tool,
            display,
            viewportId: a.metadata?.viewportId,
          });
        }
        setAnnotations(list);
      } catch (e) {
        // ignore — annotations API may not be loaded in older cornerstone builds
      }
    };
    const events = [
      cornerstoneTools.Enums?.Events?.ANNOTATION_COMPLETED,
      cornerstoneTools.Enums?.Events?.ANNOTATION_MODIFIED,
      cornerstoneTools.Enums?.Events?.ANNOTATION_REMOVED,
    ].filter(Boolean);
    for (const ev of events) cornerstone.eventTarget.addEventListener(ev, refresh);
    refresh();
    return () => {
      for (const ev of events) {
        try { cornerstone.eventTarget.removeEventListener(ev, refresh); } catch {}
      }
    };
  }, [stage]);

  return (
    <div className="h-screen w-screen flex flex-col" style={{ backgroundColor: SHELL_BG, color: '#cdd2d8' }}>
      {/* Header — Close + View-mode tabs + branding */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b" style={{ borderColor: '#1d2128' }}>
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.close() || navigate('/')}
            className="text-sm px-2 py-1 rounded hover:bg-white/5 flex items-center gap-1.5"
          >
            <ArrowLeft size={14} /> Close
          </button>
          <div className="text-sm font-semibold tracking-wide flex items-center gap-2">
            <Box size={14} className="text-amber-500" />
            CBCT Viewer
            {readOnly && (
              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-300 border border-amber-700/60">
                Read-only
              </span>
            )}
          </div>
        </div>

        {/* View-mode tabs — MPR + 3D and Ceph are wired today; the rest
            are scaffolds for Phase 2/3 with tooltips that explain when
            they ship. Clicking a wired tab rebuilds viewports over the
            same cached volume — no reload. */}
        <div className="flex items-center gap-1 text-[11px]">
          {Object.entries(VIEW_MODES).map(([key, cfg]) => (
            <ViewModeTab
              key={key}
              active={viewMode === key}
              ready={cfg.ready}
              label={cfg.name}
              tooltip={cfg.description}
              onClick={() => switchViewMode(key)}
            />
          ))}
        </div>

        <div className="text-[11px] text-gray-500">Cornerstone3D v4</div>
      </div>

      {/* Body: left toolbox | 4-panel grid | right info rail */}
      <div className="flex-1 flex relative">
        {/* LEFT — full control panel (tools + display + presets + measurements) */}
        {stage === 'ready' && (
          <div
            className="flex flex-col py-2 px-2 border-r overflow-y-auto"
            style={{ backgroundColor: PANEL_BG, borderColor: '#1d2128', width: 200 }}
          >
            {/* Section: Tools */}
            <SectionHeader>Measure</SectionHeader>
            <div className="grid grid-cols-5 gap-1 mb-1">
              <ToolButton active={activeTool === 'crosshair'}     onClick={() => selectTool('crosshair')}     icon={CrosshairIcon} label="Crosshair (1)" />
              <ToolButton active={activeTool === 'length'}        onClick={() => selectTool('length')}        icon={Ruler}         label="Length (2)" />
              <ToolButton active={activeTool === 'angle'}         onClick={() => selectTool('angle')}         icon={Triangle}      label="Angle (3)" />
              <ToolButton active={activeTool === 'bidirectional'} onClick={() => selectTool('bidirectional')} icon={Plus}          label="Bidirectional (4)" />
              <ToolButton active={activeTool === 'probe'}         onClick={() => selectTool('probe')}         icon={Activity}      label="HU Probe (5)" />
            </div>

            <SectionHeader>Density ROI</SectionHeader>
            <div className="grid grid-cols-5 gap-1 mb-1">
              <ToolButton active={activeTool === 'rectROI'}    onClick={() => selectTool('rectROI')}    icon={Square}     label="Rectangle ROI" />
              <ToolButton active={activeTool === 'circleROI'}  onClick={() => selectTool('circleROI')}  icon={CircleIcon} label="Circle ROI" />
              <ToolButton active={activeTool === 'ellipseROI'} onClick={() => selectTool('ellipseROI')} icon={Hexagon}    label="Ellipse ROI" />
            </div>

            <SectionHeader>Navigate</SectionHeader>
            <div className="grid grid-cols-5 gap-1 mb-1">
              <ToolButton active={activeTool === 'pan'}  onClick={() => selectTool('pan')}  icon={Move}   label="Pan (6)" />
              <ToolButton active={activeTool === 'zoom'} onClick={() => selectTool('zoom')} icon={ZoomIn} label="Zoom (7)" />
              <ToolButton active={false} onClick={handleResetViews}        icon={RotateCcw} label="Reset (R)" />
              {!readOnly && (
                <ToolButton active={false} onClick={handleSaveMeasurements} icon={Save} label="Save measurements" />
              )}
              <ToolButton active={false} onClick={handleClearMeasurements} icon={Trash2}    label="Clear annotations" danger />
            </div>

            {/* Section: Display toggles */}
            <SectionHeader>Display</SectionHeader>
            <div className="grid grid-cols-2 gap-1 mb-2">
              <button
                onClick={() => setInvert((v) => !v)}
                title="Invert greyscale (I)"
                className={`text-[10px] py-1.5 rounded flex items-center justify-center gap-1 ${
                  invert ? 'bg-amber-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
              >
                <Contrast size={10} /> Invert
              </button>
              <button
                onClick={() => setShowRefLines((v) => !v)}
                title="Reference lines"
                className={`text-[10px] py-1.5 rounded flex items-center justify-center gap-1 ${
                  showRefLines ? 'bg-amber-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
              >
                {showRefLines ? <Eye size={10} /> : <EyeOff size={10} />}
                Ref lines
              </button>
            </div>
            <div className="mb-2">
              <div className="flex items-center justify-between text-[10px] text-gray-400 mb-0.5">
                <span className="flex items-center gap-1"><Layers size={10} /> Slab MIP</span>
                <span className="font-mono">{slabThickness} mm</span>
              </div>
              <input
                type="range"
                min={0}
                max={30}
                step={1}
                value={slabThickness}
                onChange={(e) => setSlabThickness(Number(e.target.value))}
                className="w-full accent-amber-600"
              />
            </div>

            {/* Section: W/L presets */}
            <SectionHeader>MPR Window</SectionHeader>
            <div className="grid grid-cols-2 gap-1 mb-2">
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

            {/* Section: Measurements list */}
            <SectionHeader>
              Measurements <span className="text-gray-500">({annotations.length})</span>
            </SectionHeader>
            <div className="text-[10px] space-y-0.5 mb-2 max-h-48 overflow-y-auto">
              {annotations.length === 0 && (
                <div className="text-gray-600 italic">No measurements yet.</div>
              )}
              {annotations.map((a) => (
                <div
                  key={a.uid}
                  className="flex items-center justify-between bg-gray-900 rounded px-1.5 py-1"
                >
                  <span className="text-gray-400">{a.toolName}</span>
                  <span className="font-mono text-amber-300">{a.display}</span>
                </div>
              ))}
            </div>

            {/* Section: Implant placement */}
            <SectionHeader>
              Implants {implants.length > 0 && <span className="text-gray-500">({implants.length})</span>}
            </SectionHeader>
            <div className="space-y-1 mb-2">
              <button
                onClick={() => setImplantCatalogOpen((v) => !v)}
                className={`w-full text-[10px] py-1.5 rounded flex items-center justify-center gap-1.5 ${
                  placingImplant ? 'bg-blue-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
              >
                <Cylinder size={10} />
                {placingImplant
                  ? (pendingApex ? 'Click HEAD (crestal)' : 'Click APEX (deep)')
                  : 'Place implant'}
              </button>
              {implantCatalogOpen && !placingImplant && (
                <div
                  className="rounded p-1 space-y-0.5 max-h-40 overflow-y-auto"
                  style={{ backgroundColor: '#0b0d10', border: '1px solid #1d2128' }}
                >
                  {IMPLANT_CATALOG.map((cat) => (
                    <button
                      key={cat.label}
                      onClick={() => {
                        setPlacingImplant(cat);
                        setImplantCatalogOpen(false);
                        setPendingApex(null);
                      }}
                      className="w-full text-left text-[10px] px-2 py-1 rounded bg-gray-800 hover:bg-blue-700 text-gray-300 hover:text-white"
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              )}
              {placingImplant && (
                <button
                  onClick={() => { setPlacingImplant(null); setPendingApex(null); }}
                  className="w-full text-[10px] py-1 rounded bg-gray-800 hover:bg-red-700 text-gray-300 hover:text-white"
                >Cancel placement</button>
              )}
              {implants.length > 0 && (
                <>
                  <div className="text-[10px] space-y-0.5 max-h-32 overflow-y-auto">
                    {implants.map((imp) => {
                      const nerveDistMM = nervePoints.length >= 2
                        ? segmentToPolylineDistance(imp.apex, imp.head, nervePoints)
                        : null;
                      const tooClose = nerveDistMM != null && nerveDistMM < safetyZoneMM;
                      return (
                        <div
                          key={imp.id}
                          className="flex items-center justify-between bg-gray-900 rounded px-1.5 py-1"
                        >
                          <span className="text-gray-300">{imp.label}</span>
                          {nerveDistMM != null && (
                            <span className={`font-mono ${tooClose ? 'text-red-400' : 'text-green-400'}`}>
                              {nerveDistMM.toFixed(1)}mm
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {!readOnly && (
                    <button
                      onClick={() => { setPromoteResult(null); setShowPromoteModal(true); }}
                      className="w-full text-[10px] py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white flex items-center justify-center gap-1"
                      title="Create a Treatment Plan in the EMR linked to this study"
                    >
                      <ExternalLink size={10} /> Promote to Plan
                    </button>
                  )}
                  <button
                    onClick={() => setImplants([])}
                    className="w-full text-[10px] py-1 rounded bg-gray-800 hover:bg-red-700 text-gray-300 hover:text-white"
                  >Clear all implants</button>
                </>
              )}
            </div>

            {/* Section: Nerve canal trace */}
            <SectionHeader>
              Nerve canal {nervePoints.length > 0 && <span className="text-gray-500">({nervePoints.length})</span>}
            </SectionHeader>
            <div className="space-y-1 mb-2">
              <button
                onClick={() => setTracingNerve((v) => !v)}
                className={`w-full text-[10px] py-1.5 rounded flex items-center justify-center gap-1.5 ${
                  tracingNerve ? 'bg-green-600 text-white' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                }`}
              >
                <GitBranch size={10} />
                {tracingNerve ? 'Tracing — Shift+click MPR' : 'Trace nerve canal'}
              </button>
              {nervePoints.length > 0 && (
                <>
                  <div className="flex items-center justify-between gap-2 text-[10px] text-gray-400">
                    <span>Safety zone</span>
                    <input
                      type="range"
                      min={1}
                      max={5}
                      step={0.5}
                      value={safetyZoneMM}
                      onChange={(e) => setSafetyZoneMM(Number(e.target.value))}
                      className="flex-1 accent-green-600"
                    />
                    <span className="font-mono text-green-400 w-7 text-right">{safetyZoneMM}mm</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[10px] text-gray-400">
                    <span title="How thick a slab to highlight bright on each MPR slice">Slab</span>
                    <input
                      type="range"
                      min={1}
                      max={20}
                      step={1}
                      value={nerveSlabMM}
                      onChange={(e) => setNerveSlabMM(Number(e.target.value))}
                      className="flex-1 accent-green-600"
                    />
                    <span className="font-mono text-green-400 w-7 text-right">{nerveSlabMM}mm</span>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setNervePoints((p) => p.slice(0, -1))}
                      className="flex-1 text-[10px] py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300"
                    >Undo</button>
                    <button
                      onClick={() => setNervePoints([])}
                      className="flex-1 text-[10px] py-1 rounded bg-gray-800 hover:bg-red-700 text-gray-300 hover:text-white"
                    >Clear</button>
                  </div>
                </>
              )}
            </div>

            {/* Section: AI (Phase 4 — surfaces architecture, real models later).
                Hidden in shared/read-only sessions: inference needs an authed
                Supabase JWT and writes results back to the study. */}
            {!readOnly && (
              <>
                <SectionHeader>AI · Phase 4</SectionHeader>
                <div className="grid grid-cols-1 gap-1 mb-2">
                  <button
                    onClick={() => setShowAiModal(true)}
                    className="text-[10px] py-1.5 rounded bg-gray-800 hover:bg-purple-700 text-gray-300 hover:text-white flex items-center justify-center gap-1.5"
                  >
                    <Sparkles size={10} /> AI segmentation
                  </button>
                </div>
              </>
            )}

            {/* Section: Help */}
            <SectionHeader>Shortcuts</SectionHeader>
            <p className="text-[10px] text-gray-500 leading-snug">
              <span className="text-gray-300">1-5</span> tools · <span className="text-gray-300">6/7</span> pan/zoom<br />
              <span className="text-gray-300">R</span> reset · <span className="text-gray-300">I</span> invert<br />
              <span className="text-gray-300">Right-drag</span> = W/L<br />
              <span className="text-gray-300">Wheel</span> = scroll slices
            </p>
          </div>
        )}

        {/* CENTER — 4-panel grid + loader overlay */}
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

        {/* Placeholder for unbuilt view modes */}
        {stage === 'ready' && !VIEW_MODES[viewMode]?.ready && (
          <div className="absolute inset-0 flex items-center justify-center z-20 bg-black/85">
            <div className="max-w-md text-center px-8">
              <div className="text-amber-500 text-xs uppercase tracking-wider mb-2">Coming next</div>
              <h2 className="text-lg font-semibold text-white mb-2">{VIEW_MODES[viewMode]?.name}</h2>
              <p className="text-sm text-gray-400 leading-relaxed">{VIEW_MODES[viewMode]?.description}</p>
              <button
                onClick={() => switchViewMode('mpr-3d')}
                className="mt-4 text-xs px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white"
              >
                Back to MPR + 3D
              </button>
            </div>
          </div>
        )}

        {/* Arch-curve Pano gets its own layout: axial-with-tracer (left)
            + custom rendered <canvas> for the reformatted pano (right).
            Falls through to the standard grid for other modes. */}
        {viewMode === 'pano' && VIEW_MODES.pano.ready && (
          <div className="grid grid-cols-2 gap-px h-full" style={{ backgroundColor: '#1d2128' }}>
            {/* Cell 1: axial Cornerstone viewport with arch-point overlay */}
            <div className="relative" style={{ backgroundColor: SHELL_BG }}>
              <div
                ref={axialRef}
                className="w-full h-full"
                onContextMenu={(e) => e.preventDefault()}
              />
              <div
                className="absolute top-2 left-2 text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded pointer-events-none"
                style={{ backgroundColor: 'rgba(11,13,16,0.6)', color: '#10b981', borderLeft: '2px solid #10b981' }}
              >
                Axial {tracingArch ? '· TRACING — click to add points' : '· enable Trace Arch (bottom-left)'}
              </div>
              {/* SVG overlay for arch points + spline preview */}
              <ArchOverlay
                viewportId="PANO_AXIAL"
                engine={enginRef.current}
                archPoints={archPoints}
              />
              {/* Floating tools card — arch controls */}
              <div
                className="absolute bottom-3 left-3 rounded-lg p-2.5 text-xs space-y-1.5 z-30"
                style={{ backgroundColor: PANEL_BG, border: '1px solid #1d2128', width: 240 }}
              >
                {/* Trace Arch tool toggle — primary action */}
                <button
                  onClick={() => setTracingArch((v) => !v)}
                  className={`w-full text-[11px] py-2 rounded font-semibold flex items-center justify-center gap-1.5 transition-colors ${
                    tracingArch
                      ? 'bg-amber-600 hover:bg-amber-500 text-white'
                      : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
                  }`}
                  title={tracingArch ? 'Click to stop arch tracing' : 'Click to enable arch tracing — then click on axial'}
                >
                  <Activity size={11} />
                  {tracingArch ? 'Tracing — click on axial' : 'Trace Arch'}
                </button>

                {/* AI auto-trace — needs an authed session; hidden on shares */}
                {!readOnly && (
                  <button
                    onClick={() => runAiInference('arch-curve')}
                    disabled={archAiRunning || !!aiRunning['arch-curve']}
                    className="w-full text-[10px] py-1.5 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white flex items-center justify-center gap-1.5"
                    title="AI auto-traces the dental arch"
                  >
                    <Sparkles size={10} />
                    {aiRunning['arch-curve'] ? 'AI running…' : 'AI auto-trace'}
                  </button>
                )}

                <div className="flex items-center justify-between pt-1 border-t border-gray-800">
                  <span className="text-gray-400">Arch points</span>
                  <span className="font-mono text-amber-300">{archPoints.length}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-gray-400 text-[10px]">Slab mm</span>
                  <input
                    type="range"
                    min={2}
                    max={20}
                    step={1}
                    value={archSlabMM}
                    onChange={(e) => setArchSlabMM(Number(e.target.value))}
                    className="flex-1 accent-amber-600"
                  />
                  <span className="font-mono text-[10px] text-amber-300 w-6 text-right">{archSlabMM}</span>
                </div>
                <div className="flex gap-1 pt-1">
                  <button
                    onClick={() => setArchPoints((p) => p.slice(0, -1))}
                    disabled={archPoints.length === 0}
                    className="flex-1 text-[10px] py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-300"
                  >
                    Undo last
                  </button>
                  <button
                    onClick={() => setArchPoints([])}
                    disabled={archPoints.length === 0}
                    className="flex-1 text-[10px] py-1 rounded bg-gray-800 hover:bg-red-700 disabled:opacity-40 text-gray-300 hover:text-white"
                  >
                    Reset
                  </button>
                </div>
                <p className="text-[10px] text-gray-500 leading-tight pt-1 border-t border-gray-800">
                  Click <b>Trace Arch</b> then click ≥3 points on axial.
                  Or <b>AI auto-trace</b> for a one-click suggestion (then refine).
                  Shift+Click also works without enabling tracing.
                </p>
              </div>
            </div>
            {/* Cell 2: pano canvas (custom render) */}
            <div className="relative flex items-center justify-center overflow-hidden" style={{ backgroundColor: SHELL_BG }}>
              {/*
                The canvas backing buffer is 900×400 (set by renderArchPano).
                Without an explicit display width/height, items-center +
                justify-center will collapse it because max-w-full picks
                its content-box width from a zero flex sibling and the
                image renders into a 1px-wide strip.
                width:100% + height:auto + object-fit:contain lets it
                scale up to the full half-column while preserving the
                pano's aspect ratio.
              */}
              <canvas
                ref={panoCanvasRef}
                className="w-full h-full"
                style={{ imageRendering: 'pixelated', objectFit: 'contain', maxWidth: '100%', maxHeight: '100%' }}
              />
              {archPoints.length < 3 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="text-center max-w-sm px-4">
                    <div className="text-amber-500 text-xs uppercase tracking-wider mb-2">Trace the arch</div>
                    <p className="text-gray-400 text-xs leading-relaxed">
                      Click <span className="text-amber-300 font-semibold">Trace Arch</span> (bottom-left)
                      then click at least 3 points along the midline of the dental arch on axial
                      (anterior → premolar → molar → posterior).
                    </p>
                    <div className="my-3 text-[10px] text-gray-500">— or —</div>
                    <p className="text-gray-400 text-xs leading-relaxed">
                      Click <span className="text-purple-300 font-semibold">AI auto-trace</span> for
                      a one-click suggestion. You can refine the points after.
                    </p>
                  </div>
                </div>
              )}
              {archPoints.length >= 3 && panoRenderError && (
                <div className="absolute inset-0 flex items-center justify-center p-4">
                  <div
                    className="max-w-md text-xs rounded p-3 border"
                    style={{ backgroundColor: 'rgba(127,29,29,0.25)', borderColor: '#7f1d1d', color: '#fecaca' }}
                  >
                    <div className="font-semibold uppercase tracking-wider mb-1 text-red-300">
                      Pano render failed
                    </div>
                    <div className="text-[11px] leading-relaxed">{panoRenderError}</div>
                    <div className="mt-2 text-[10px] text-gray-400">
                      Open the browser console — the line starting with <code>[pano] render attempt</code> shows
                      which volume access path returned null. Share that line so we can patch the right fallback.
                    </div>
                  </div>
                </div>
              )}
              <div
                className="absolute top-2 left-2 text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded pointer-events-none"
                style={{ backgroundColor: 'rgba(11,13,16,0.6)', color: '#f59e0b', borderLeft: '2px solid #f59e0b' }}
              >
                Pano (reformatted)
              </div>
            </div>
          </div>
        )}

        {/* Cross-sections layout: 4×4 grid of perpendicular slices */}
        {viewMode === 'crosssec' && VIEW_MODES.crosssec.ready && (
          <div className="h-full w-full overflow-auto p-2" style={{ backgroundColor: '#1d2128' }}>
            {archPoints.length < 3 ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center max-w-md px-4">
                  <div className="text-amber-500 text-xs uppercase tracking-wider mb-2">Trace the arch first</div>
                  <p className="text-gray-400 text-xs leading-relaxed">
                    Cross-sections sample perpendicular to the arch curve. Go to <b>Pano</b> view first
                    and Shift+Click ≥3 points along the dental arch, then come back here.
                  </p>
                  <button
                    onClick={() => switchViewMode('pano')}
                    className="mt-4 text-xs px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white"
                  >
                    Go to Pano view
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Floating settings card */}
                <div
                  className="absolute top-3 right-3 rounded-lg p-2.5 text-xs space-y-1.5 z-10"
                  style={{ backgroundColor: PANEL_BG, border: '1px solid #1d2128', width: 200 }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-gray-400 text-[10px]">XS width mm</span>
                    <input
                      type="range"
                      min={15}
                      max={50}
                      step={1}
                      value={xsWidthMM}
                      onChange={(e) => setXsWidthMM(Number(e.target.value))}
                      className="flex-1 accent-amber-600"
                    />
                    <span className="font-mono text-[10px] text-amber-300 w-6 text-right">{xsWidthMM}</span>
                  </div>
                  <p className="text-[10px] text-gray-500 leading-tight">
                    {CROSSSEC_COUNT} cross-sections evenly spaced along the arch curve.
                  </p>
                </div>
                {/* Grid */}
                <div className="grid grid-cols-4 gap-1.5">
                  {Array.from({ length: CROSSSEC_COUNT }).map((_, i) => (
                    <div
                      key={i}
                      className="relative rounded overflow-hidden"
                      style={{ backgroundColor: SHELL_BG, border: '1px solid #1d2128' }}
                    >
                      <canvas
                        ref={(el) => { xsCanvasRefs.current[i] = el; }}
                        className="w-full block"
                        style={{ imageRendering: 'pixelated', aspectRatio: '2 / 3' }}
                      />
                      <div
                        className="absolute top-1 left-1 text-[9px] font-mono px-1 py-0.5 rounded pointer-events-none"
                        style={{ backgroundColor: 'rgba(11,13,16,0.7)', color: '#f59e0b' }}
                      >
                        {i + 1}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Standard view layouts (everything except arch-pano and arch-crosssec) */}
        {(viewMode !== 'pano' && viewMode !== 'crosssec') && (
        <div
          className={
            VIEW_MODES[viewMode]?.layout === 'side-by-side'
              ? 'grid grid-cols-2 gap-px h-full'
              : 'grid grid-cols-2 grid-rows-2 gap-px h-full'
          }
          style={{ backgroundColor: '#1d2128' }}
        >
          {/* Render up to 4 cells. Each cell is bound to one of the 4
              persistent refs (axial / coronal / sagittal / vr). The
              CURRENT view mode's viewports[i] defines the label / color
              for cell i. Cells beyond viewports.length are hidden so
              modes with <4 panels (Ceph) get a clean side-by-side. */}
          {[axialRef, coronalRef, sagittalRef, vrRef].map((ref, idx) => {
            const cfg = VIEW_MODES[viewMode]?.viewports?.[idx];
            const hidden = !cfg && VIEW_MODES[viewMode]?.ready;
            const v = cfg || VIEWPORTS[idx];
            const hud = cfg ? sliceHud[cfg.id] : null;
            return (
              <div
                key={idx}
                className="relative"
                style={{
                  backgroundColor: SHELL_BG,
                  display: hidden ? 'none' : undefined,
                }}
              >
                <div
                  ref={ref}
                  className="w-full h-full"
                  onContextMenu={(e) => e.preventDefault()}
                />
                {cfg && (
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
                )}
                {hud && (
                  <div
                    className="absolute top-2 right-2 text-[10px] font-mono px-1.5 py-0.5 rounded pointer-events-none"
                    style={{
                      backgroundColor: 'rgba(11,13,16,0.7)',
                      color: '#cdd2d8',
                    }}
                  >
                    {hud.current} / {hud.total}
                  </div>
                )}
                {/* Nerve canal polyline + safety zone overlay
                    (only on MPR ortho viewports, hidden on 3D) */}
                {cfg && cfg.kind === 'orthographic' && nervePoints.length >= 2 && (
                  <NerveOverlay
                    viewportId={cfg.id}
                    engine={enginRef.current}
                    nervePoints={nervePoints}
                    safetyZoneMM={safetyZoneMM}
                    slabHalfMM={nerveSlabMM / 2}
                  />
                )}
                {/* Implant cylinder overlays */}
                {cfg && cfg.kind === 'orthographic' && implants.length > 0 && (
                  <ImplantOverlay
                    viewportId={cfg.id}
                    engine={enginRef.current}
                    implants={implants}
                    pendingApex={pendingApex}
                    nervePoints={nervePoints}
                    safetyZoneMM={safetyZoneMM}
                  />
                )}
              </div>
            );
          })}
        </div>
        )}

        </div>
      </div>

      {/* Phase 3.6.2 — Promote-to-Treatment-Plan modal */}
      {showPromoteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => !promotingPlan && setShowPromoteModal(false)}
        >
          <div
            className="rounded-lg p-5 max-w-md w-full mx-4 text-sm"
            style={{ backgroundColor: PANEL_BG, border: '1px solid #1d2128' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <Cylinder size={18} className="text-blue-400" />
              <h2 className="text-base font-semibold text-white">Promote to Treatment Plan</h2>
            </div>
            {!promoteResult ? (
              <>
                <p className="text-gray-400 text-xs leading-relaxed mb-3">
                  Creates a formal treatment plan in the EMR linked to this CBCT.
                  Plan can then be priced, sent to the patient for acceptance, and
                  flow into billing. You'll be able to refine in the EMR after creating.
                </p>
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">
                      Title
                    </label>
                    <input
                      type="text"
                      value={promoteTitle}
                      onChange={(e) => setPromoteTitle(e.target.value)}
                      className="w-full text-sm px-2 py-1.5 rounded bg-gray-900 text-gray-100 border border-gray-700 focus:border-blue-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 block mb-1">
                      Fee per implant (AED)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={promoteFeePerImplant}
                      onChange={(e) => setPromoteFeePerImplant(e.target.value)}
                      className="w-full text-sm px-2 py-1.5 rounded bg-gray-900 text-gray-100 border border-gray-700 focus:border-blue-500 outline-none font-mono"
                    />
                    <div className="text-[10px] text-gray-500 mt-1">
                      {implants.length} implant{implants.length > 1 ? 's' : ''} × {promoteFeePerImplant} = <span className="text-amber-300 font-mono">{(Number(promoteFeePerImplant) || 0) * implants.length} AED</span> total
                    </div>
                  </div>
                  <div className="rounded p-2 text-[11px] text-gray-300" style={{ backgroundColor: '#0b0d10', border: '1px solid #1d2128' }}>
                    <div className="font-semibold text-gray-200 mb-1">Plan will include:</div>
                    <ul className="space-y-0.5 text-gray-400">
                      {implants.map((imp, i) => (
                        <li key={imp.id}>· {imp.label}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="mt-4 flex gap-2 justify-end">
                  <button
                    onClick={() => setShowPromoteModal(false)}
                    disabled={promotingPlan}
                    className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 disabled:opacity-50"
                  >Cancel</button>
                  <button
                    onClick={handlePromoteToTreatmentPlan}
                    disabled={promotingPlan || implants.length === 0}
                    className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {promotingPlan && <Loader2 size={12} className="animate-spin" />}
                    {promotingPlan ? 'Creating…' : 'Create Plan'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-green-400 text-sm mb-2">✓ Plan created.</p>
                <p className="text-gray-300 text-xs leading-relaxed">
                  {promoteResult.count} implant{promoteResult.count > 1 ? 's' : ''} added · <span className="font-mono">{promoteResult.total} AED</span> total.
                </p>
                <p className="text-gray-400 text-xs mt-2">
                  Visible on the patient profile <span className="text-gray-200">Treatment Plans</span> tab
                  and on the <span className="text-gray-200">Imaging</span> tab card. You can refine pricing,
                  assign tooth numbers, and send to the patient from there.
                </p>
                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => setShowPromoteModal(false)}
                    className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200"
                  >Close</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* AI segmentation modal — Phase 4 roadmap stub */}
      {showAiModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setShowAiModal(false)}
        >
          <div
            className="rounded-lg p-5 max-w-lg w-full mx-4 text-sm"
            style={{ backgroundColor: PANEL_BG, border: '1px solid #1d2128' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <Sparkles size={18} className="text-purple-400" />
              <h2 className="text-base font-semibold text-white">AI Segmentation · Phase 4</h2>
            </div>
            <p className="text-gray-400 text-xs leading-relaxed mb-3">
              Server-side AI models for automated dental analysis. The viewer is wired
              to call these endpoints; the models themselves ship in Phase 4 once we deploy
              the inference service alongside the converter.
            </p>
            <div className="space-y-2 text-xs">
              <AiFeature
                label="Mandibular nerve canal"
                status="placeholder"
                desc="IAN trace with safety zone — placeholder returns synthetic polyline; real nnU-Net model lands v0.2."
                onRun={() => runAiInference('nerve-canal')}
                running={!!aiRunning['nerve-canal']}
                lastRun={aiLastRun['nerve-canal']}
              />
              <AiFeature
                label="Tooth segmentation"
                status="placeholder"
                desc="Per-tooth labels (FDI). Placeholder returns empty list; real model = ToothFairy3."
                onRun={() => runAiInference('teeth-segment')}
                running={!!aiRunning['teeth-segment']}
                lastRun={aiLastRun['teeth-segment']}
              />
              <AiFeature
                label="Cephalometric landmarks"
                status="placeholder"
                desc="19 standard landmarks (Sella, Nasion, etc.) on lateral MIP."
                onRun={() => runAiInference('landmarks-ceph')}
                running={!!aiRunning['landmarks-ceph']}
                lastRun={aiLastRun['landmarks-ceph']}
              />
              <AiFeature label="Sinus segmentation"          status="planned" desc="Maxillary sinus boundary for sinus-lift planning" />
              <AiFeature label="Caries detection"            status="planned" desc="Per-tooth caries flag with confidence score" />
              <AiFeature label="Periapical lesion detection" status="planned" desc="Auto-flagged radiolucent lesions" />
              <AiFeature label="Implant suggestion"          status="planned" desc="AI proposes implant positions with collision warnings" />
              <AiFeature label="IOS-CBCT registration"       status="planned" desc="Align intraoral scan to CBCT for unified planning" />
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setShowAiModal(false)}
                className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * SVG overlay drawn above the axial Pano viewport showing the user's
 * arch control points and the Catmull-Rom spline through them.
 * Re-renders on every archPoints change via cornerstone CAMERA_MODIFIED
 * (so pan/zoom on axial keep the overlay aligned).
 */
function ArchOverlay({ viewportId, engine, archPoints }) {
  const [, force] = useState(0);
  const svgRef = useRef(null);

  // Listen for camera modifications so we re-project world points to
  // canvas coords (zoom/pan/scroll keeps the overlay accurate).
  useEffect(() => {
    if (!engine) return;
    const handler = (e) => {
      if (e?.detail?.viewportId === viewportId) force((n) => n + 1);
    };
    cornerstone.eventTarget.addEventListener(
      cornerstone.Enums.Events.CAMERA_MODIFIED, handler
    );
    return () => {
      try {
        cornerstone.eventTarget.removeEventListener(
          cornerstone.Enums.Events.CAMERA_MODIFIED, handler
        );
      } catch {}
    };
  }, [engine, viewportId]);

  if (!engine || archPoints.length === 0) return null;
  const vp = engine.getViewport(viewportId);
  if (!vp || !vp.element) return null;
  const rect = vp.element.getBoundingClientRect();
  const containerRect = vp.element.parentElement?.getBoundingClientRect();
  if (!containerRect) return null;
  const offsetTop  = rect.top  - containerRect.top;
  const offsetLeft = rect.left - containerRect.left;

  // Arch points are stored as 2D [x, y] on the axial plane the user
  // clicked. We give them the CURRENT focal Z so projection works on
  // axial. The PANO_AXIAL viewport (where this overlay is mounted) is
  // always axial, so this gives the correct on-slice render.
  const project = (worldXY) => {
    try {
      const camera = vp.getCamera();
      const z = camera?.focalPoint?.[2] ?? 0;
      return vp.worldToCanvas([worldXY[0], worldXY[1], z]);
    } catch {
      return null;
    }
  };
  const projected = archPoints.map(project).filter(Boolean);
  if (projected.length === 0) return null;

  // Build a smooth Catmull-Rom path through projected points
  const splinePoints =
    archPoints.length >= 2
      ? densifyArch(archPoints, 120)
          .map((s) => project([s.x, s.y]))
          .filter(Boolean)
      : [];
  const pathD = splinePoints.length
    ? 'M ' + splinePoints.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ')
    : '';

  return (
    <svg
      ref={svgRef}
      className="absolute pointer-events-none"
      style={{
        top: offsetTop, left: offsetLeft,
        width: rect.width, height: rect.height,
      }}
    >
      {pathD && (
        <path
          d={pathD}
          fill="none"
          stroke="#f59e0b"
          strokeWidth={2}
          strokeDasharray="0"
          opacity={0.9}
        />
      )}
      {projected.map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r={5} fill="#f59e0b" stroke="#0b0d10" strokeWidth={1.5} />
          <text x={x + 8} y={y - 8} fill="#f59e0b" fontSize={10} fontFamily="monospace">
            {i + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}

/**
 * SVG overlay drawn above each MPR viewport showing the user-traced
 * mandibular nerve canal as a polyline + a safety-zone tube radius.
 * Re-projects on every CAMERA_MODIFIED event.
 *
 * Note: the nerve is a 3D polyline through patient space. On any given
 * MPR slice, we project ALL points to canvas coordinates. Points that
 * are far from the current slice plane are dimmed but still rendered
 * so the user has spatial context. A clinical-accuracy implementation
 * would also clip the polyline to a thin slab around the active slice;
 * for v1 we just dim by signed distance to the slice plane.
 */
function NerveOverlay({ viewportId, engine, nervePoints, safetyZoneMM, slabHalfMM = 2.5 }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!engine) return;
    const handler = (e) => {
      if (e?.detail?.viewportId === viewportId) force((n) => n + 1);
    };
    cornerstone.eventTarget.addEventListener(
      cornerstone.Enums.Events.CAMERA_MODIFIED, handler
    );
    return () => {
      try {
        cornerstone.eventTarget.removeEventListener(
          cornerstone.Enums.Events.CAMERA_MODIFIED, handler
        );
      } catch {}
    };
  }, [engine, viewportId]);

  if (!engine || nervePoints.length < 2) return null;
  const vp = engine.getViewport(viewportId);
  if (!vp || !vp.element) return null;
  const rect = vp.element.getBoundingClientRect();
  const containerRect = vp.element.parentElement?.getBoundingClientRect();
  if (!containerRect) return null;
  const top  = rect.top  - containerRect.top;
  const left = rect.left - containerRect.left;

  // CLINICAL VISIBILITY RULE: a 3D polyline (the nerve canal) should
  // only appear on slices that actually intersect it within a small
  // slab around the current slice plane. Showing all points always
  // produces a confusing horizontal line on coronal/sagittal because
  // points placed on a single axial slice all share the same Z.
  //
  // We compute signed distance from each point to the slice plane, and
  // only render points + connecting segments within ±slabHalfMM mm.
  let viewPlaneNormal = [0, 0, 1];
  let viewFocal = [0, 0, 0];
  try {
    const cam = vp.getCamera();
    viewPlaneNormal = cam?.viewPlaneNormal || viewPlaneNormal;
    viewFocal       = cam?.focalPoint     || viewFocal;
  } catch {}
  const signedDist = (p) =>
    (p[0] - viewFocal[0]) * viewPlaneNormal[0] +
    (p[1] - viewFocal[1]) * viewPlaneNormal[1] +
    (p[2] - viewFocal[2]) * viewPlaneNormal[2];

  // slabHalfMM comes in as a prop now — user-adjustable via the
  // "Nerve slab" slider in the left rail. Default 2.5mm covers the
  // typical canal diameter; wider is more forgiving for scrolling.

  // Always render the FULL polyline as a ghost (low-opacity dashed
  // line) so the clinician keeps spatial context even when scrolling
  // away from the canal. The in-slab portion gets layered bright over
  // top. This solves the previous UX problem where the nerve seemed
  // to vanish entirely on far slices.
  const ghostSegments = [];
  for (let i = 0; i < nervePoints.length - 1; i++) {
    try {
      const a = vp.worldToCanvas(nervePoints[i]);
      const b = vp.worldToCanvas(nervePoints[i + 1]);
      if (a && b) ghostSegments.push({ start: a, end: b });
    } catch {}
  }
  // Also project all control points for ghost rendering
  const ghostDots = [];
  for (let i = 0; i < nervePoints.length; i++) {
    try {
      const c = vp.worldToCanvas(nervePoints[i]);
      if (c) ghostDots.push({ canvas: c, idx: i });
    } catch {}
  }

  // For each polyline segment, geometrically clip it to the slab.
  // Returns array of {canvasStart, canvasEnd, fullyInside}.
  const segments = [];
  for (let i = 0; i < nervePoints.length - 1; i++) {
    const p1 = nervePoints[i];
    const p2 = nervePoints[i + 1];
    const d1 = signedDist(p1);
    const d2 = signedDist(p2);
    const in1 = Math.abs(d1) <= slabHalfMM;
    const in2 = Math.abs(d2) <= slabHalfMM;
    // Both outside on same side → skip
    if (!in1 && !in2 && Math.sign(d1) === Math.sign(d2) && Math.abs(d1) > slabHalfMM && Math.abs(d2) > slabHalfMM) {
      continue;
    }
    // Compute the t parameters where the segment crosses ±slabHalfMM
    let tStart = 0, tEnd = 1;
    if (!in1) {
      // p1 outside — find crossing into slab
      const target = d1 > 0 ? slabHalfMM : -slabHalfMM;
      tStart = (d1 - target) / (d1 - d2);
    }
    if (!in2) {
      const target = d2 > 0 ? slabHalfMM : -slabHalfMM;
      tEnd = (d1 - target) / (d1 - d2);
    }
    if (tEnd <= tStart) continue;
    const lerp = (t) => [
      p1[0] + (p2[0] - p1[0]) * t,
      p1[1] + (p2[1] - p1[1]) * t,
      p1[2] + (p2[2] - p1[2]) * t,
    ];
    const worldStart = lerp(tStart);
    const worldEnd   = lerp(tEnd);
    let cs, ce;
    try {
      cs = vp.worldToCanvas(worldStart);
      ce = vp.worldToCanvas(worldEnd);
    } catch {
      continue;
    }
    if (cs && ce) segments.push({ start: cs, end: ce });
  }

  // Project the control points that ARE inside the slab for the dots.
  const visibleDots = [];
  for (let i = 0; i < nervePoints.length; i++) {
    if (Math.abs(signedDist(nervePoints[i])) > slabHalfMM) continue;
    try {
      const c = vp.worldToCanvas(nervePoints[i]);
      if (c) visibleDots.push({ canvas: c, idx: i });
    } catch {}
  }

  // Estimate pixels-per-mm from the camera so we can render the safety
  // tube radius accurately on this viewport.
  let pxPerMM = 1;
  try {
    const parallelScale = vp.getCamera?.()?.parallelScale;
    if (parallelScale && rect.height) {
      pxPerMM = (rect.height / 2) / parallelScale;
    }
  } catch {}
  const safetyPx = Math.max(1, safetyZoneMM * pxPerMM);

  // Build path strings for the two layers.
  const ghostPathD = ghostSegments
    .map((s) => `M ${s.start[0].toFixed(1)} ${s.start[1].toFixed(1)} L ${s.end[0].toFixed(1)} ${s.end[1].toFixed(1)}`)
    .join(' ');
  const brightPathD = segments
    .map((s) => `M ${s.start[0].toFixed(1)} ${s.start[1].toFixed(1)} L ${s.end[0].toFixed(1)} ${s.end[1].toFixed(1)}`)
    .join(' ');

  // Find closest-off-plane indicator text (helps user scroll toward the
  // nerve when nothing is in-slab on this view).
  let offPlaneHint = null;
  if (segments.length === 0 && visibleDots.length === 0) {
    let closest = null;
    let closestDist = Infinity;
    for (const p of nervePoints) {
      const d = Math.abs(signedDist(p));
      if (d < closestDist) { closest = p; closestDist = d; }
    }
    if (closest) {
      try {
        const c = vp.worldToCanvas(closest);
        if (c) {
          const dir = signedDist(closest) > 0 ? '↑' : '↓';
          offPlaneHint = { x: c[0], y: c[1], dist: closestDist, dir };
        }
      } catch {}
    }
  }

  return (
    <svg
      className="absolute pointer-events-none"
      style={{ top, left, width: rect.width, height: rect.height }}
    >
      {/* Ghost polyline — always visible at low opacity so the user
          retains 3D spatial context for the nerve path even on slices
          that don't intersect the canal. Dashed to distinguish from
          in-slab. */}
      {ghostPathD && (
        <path
          d={ghostPathD}
          fill="none"
          stroke="#22c55e"
          strokeWidth={1.5}
          strokeDasharray="3 3"
          strokeLinecap="round"
          opacity={0.22}
        />
      )}
      {/* Ghost control point markers — small + faint */}
      {ghostDots.map(({ canvas: [x, y], idx }) => (
        <circle
          key={`g${idx}`}
          cx={x}
          cy={y}
          r={2}
          fill="#22c55e"
          opacity={0.35}
        />
      ))}
      {/* Bright safety-zone halo for the in-slab portion */}
      {brightPathD && (
        <path
          d={brightPathD}
          fill="none"
          stroke="#22c55e"
          strokeWidth={safetyPx * 2}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.22}
        />
      )}
      {/* Bright in-slab centerline */}
      {brightPathD && (
        <path
          d={brightPathD}
          fill="none"
          stroke="#22c55e"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.98}
        />
      )}
      {/* Bright in-slab control points */}
      {visibleDots.map(({ canvas: [x, y], idx }) => (
        <circle
          key={`b${idx}`}
          cx={x}
          cy={y}
          r={4}
          fill="#22c55e"
          stroke="#0b0d10"
          strokeWidth={1.5}
        />
      ))}
      {/* Off-plane hint label */}
      {offPlaneHint && (
        <text
          x={offPlaneHint.x}
          y={offPlaneHint.y - 8}
          fill="#22c55e"
          fontSize={10}
          fontFamily="monospace"
          opacity={0.85}
          textAnchor="middle"
        >
          nerve {offPlaneHint.dir} {offPlaneHint.dist.toFixed(0)}mm — scroll
        </text>
      )}
    </svg>
  );
}

/**
 * Implant cylinder overlays for a single MPR viewport. Each implant
 * has an apex (deep, in bone) and head (crestal, at the gum line);
 * we draw the axis as a thick blue line and a circle at each end.
 * Red if too close to the nerve safety zone, blue otherwise.
 */
function ImplantOverlay({ viewportId, engine, implants, pendingApex, nervePoints, safetyZoneMM }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!engine) return;
    const handler = (e) => {
      if (e?.detail?.viewportId === viewportId) force((n) => n + 1);
    };
    cornerstone.eventTarget.addEventListener(
      cornerstone.Enums.Events.CAMERA_MODIFIED, handler
    );
    return () => {
      try {
        cornerstone.eventTarget.removeEventListener(
          cornerstone.Enums.Events.CAMERA_MODIFIED, handler
        );
      } catch {}
    };
  }, [engine, viewportId]);

  if (!engine) return null;
  const vp = engine.getViewport(viewportId);
  if (!vp || !vp.element) return null;
  const rect = vp.element.getBoundingClientRect();
  const containerRect = vp.element.parentElement?.getBoundingClientRect();
  if (!containerRect) return null;
  const top = rect.top - containerRect.top;
  const left = rect.left - containerRect.left;

  // pixels-per-mm for diameter rendering
  let pxPerMM = 1;
  try {
    const parallelScale = vp.getCamera?.()?.parallelScale;
    if (parallelScale && rect.height) {
      pxPerMM = (rect.height / 2) / parallelScale;
    }
  } catch {}

  const project = (w) => {
    try { return vp.worldToCanvas(w); } catch { return null; }
  };

  return (
    <svg
      className="absolute pointer-events-none"
      style={{ top, left, width: rect.width, height: rect.height }}
    >
      {implants.map((imp) => {
        const a = project(imp.apex);
        const h = project(imp.head);
        if (!a || !h) return null;
        const tooClose = nervePoints.length >= 2 &&
          segmentToPolylineDistance(imp.apex, imp.head, nervePoints) < safetyZoneMM;
        const strokeColor = tooClose ? '#ef4444' : '#3b82f6';
        const widthPx = Math.max(2, imp.diameterMM * pxPerMM);
        return (
          <g key={imp.id} opacity={0.85}>
            {/* Cylinder body — thick translucent stroke at implant diameter */}
            <line
              x1={a[0]} y1={a[1]} x2={h[0]} y2={h[1]}
              stroke={strokeColor}
              strokeWidth={widthPx}
              strokeLinecap="round"
              opacity={0.25}
            />
            {/* Axis line */}
            <line
              x1={a[0]} y1={a[1]} x2={h[0]} y2={h[1]}
              stroke={strokeColor}
              strokeWidth={2}
            />
            {/* Apex (deep) — solid */}
            <circle cx={a[0]} cy={a[1]} r={4} fill={strokeColor} stroke="#0b0d10" strokeWidth={1.2} />
            {/* Head (crestal) — outlined */}
            <circle cx={h[0]} cy={h[1]} r={5} fill="#0b0d10" stroke={strokeColor} strokeWidth={2} />
            {/* Label */}
            <text
              x={(a[0] + h[0]) / 2 + 8}
              y={(a[1] + h[1]) / 2}
              fill={strokeColor}
              fontSize={9}
              fontFamily="monospace"
            >
              {imp.label}
            </text>
          </g>
        );
      })}
      {/* Pending apex marker (between click 1 and click 2) */}
      {pendingApex && (() => {
        const p = project(pendingApex);
        if (!p) return null;
        return (
          <g>
            <circle cx={p[0]} cy={p[1]} r={6} fill="none" stroke="#3b82f6" strokeWidth={2} strokeDasharray="3 2" />
            <text x={p[0] + 8} y={p[1]} fill="#3b82f6" fontSize={9} fontFamily="monospace">apex</text>
          </g>
        );
      })()}
    </svg>
  );
}

/**
 * Single row in the AI roadmap modal. Status pill colour-codes whether
 * the feature is planned, training, or live.
 */
function AiFeature({ label, status, desc, onRun, running, lastRun }) {
  const colors = {
    planned:     'bg-gray-800 text-gray-400',
    placeholder: 'bg-purple-900 text-purple-300',
    training:    'bg-amber-900 text-amber-300',
    live:        'bg-green-900 text-green-300',
  };
  const canRun = (status === 'placeholder' || status === 'live') && typeof onRun === 'function';
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1">
        <div className="text-gray-200">{label}</div>
        <div className="text-gray-500 text-[10px] mt-0.5">{desc}</div>
        {lastRun && (
          <div className="text-purple-300 text-[9px] mt-0.5 font-mono">
            ran {new Date(lastRun.ts).toLocaleTimeString()} · {lastRun.result?.model_state || 'placeholder'}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded ${colors[status] || colors.planned}`}>
          {status}
        </span>
        {canRun && (
          <button
            onClick={onRun}
            disabled={running}
            className="text-[10px] px-2 py-0.5 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white"
          >
            {running ? 'Running…' : 'Run'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Top-bar tab for the view modes (MPR + 3D, Pano, Ceph, Implant, TMJ).
 * Inactive tabs render as ghost buttons with a tooltip explaining what
 * phase they belong to so the user can see the roadmap inline.
 */
function ViewModeTab({ active = false, ready = true, label, tooltip, onClick }) {
  // Three states: active (selected), ready (clickable, not active), placeholder
  // (greyed, tooltip explains why it's coming later).
  if (!ready) {
    return (
      <button
        title={tooltip || label}
        disabled
        className="px-2.5 py-1 rounded text-[11px] tracking-wide bg-transparent text-gray-600 cursor-help"
      >
        {label}
      </button>
    );
  }
  return (
    <button
      title={tooltip || label}
      onClick={onClick}
      className={`px-2.5 py-1 rounded text-[11px] tracking-wide transition-colors ${
        active
          ? 'bg-amber-600 text-white cursor-default'
          : 'bg-transparent text-gray-300 hover:bg-gray-800'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Compact icon button used in the left toolbox. Highlights when its
 * tool is active. `danger=true` shifts the hover state to red for
 * destructive actions (e.g. clear measurements).
 */
/**
 * Tiny section header label used between groups in the left rail.
 * Keeps the panel scannable without dominating with bold dividers.
 */
function SectionHeader({ children }) {
  return (
    <div className="text-[9px] uppercase tracking-wider text-gray-500 mb-1 mt-2 first:mt-0">
      {children}
    </div>
  );
}

function ToolButton({ active, onClick, icon: Icon, label, danger = false }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex items-center justify-center w-8 h-8 rounded transition-colors ${
        active
          ? 'bg-amber-600 text-white'
          : danger
          ? 'bg-gray-800 hover:bg-red-700 text-gray-300 hover:text-white'
          : 'bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white'
      }`}
    >
      <Icon size={14} />
    </button>
  );
}
