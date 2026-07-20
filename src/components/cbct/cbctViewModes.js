/*
 * cbctViewModes — view-mode configuration + shared constants for the CBCT
 * viewer.
 *
 * Extracted from CBCTViewerPage.jsx during the A0 monolith split.
 *
 * W7 (audit #9): the fake "Implant" view mode was merged into MPR + 3D —
 * its viewport config was byte-identical, so switching to it rebuilt the
 * same viewports for zero visual change. Implant tools now live in the
 * Plan tab of the context panel; 'implant' mode keys are aliased back to
 * 'mpr-3d' in useCbctTools.switchViewMode.
 *
 * W5 (audit #6): the SHELL_BG/PANEL_BG hard-coded hexes are gone — shell
 * surfaces come from the semantic token set (index.css vars /
 * tailwind background.* classes; components/viewer/viewerTokens.js for
 * JS/SVG consumers).
 */

export const RENDERING_ENGINE_ID = 'aihCbctRenderingEngine';
export const TOOL_GROUP_MPR_ID   = 'aihCbctMprToolGroup';
export const TOOL_GROUP_3D_ID    = 'aihCbct3dToolGroup';
export const VOI_SYNC_ID         = 'aihCbctVoiSync';

/**
 * Single source of truth for per-viewport accent colors. These were
 * previously duplicated across six view-mode config blocks (and the
 * crosshair fallback), which made drift inevitable.
 */
export const VIEWPORT_COLORS = {
  axial:    '#10b981',
  coronal:  '#3b82f6',
  sagittal: '#f59e0b',
  volume3d: '#ef4444',
};
// Fallback reference-line color when a viewport id isn't in the config.
export const DEFAULT_REF_LINE_COLOR = VIEWPORT_COLORS.sagittal;

// Two preset tables — one for HU-scaled CT, one for raw 12-bit CBCT data
// (most cone-beam scanners ship without rescale slope/intercept). We pick
// which table to use based on the volume's actual data range after load.
export const VOLUME_PRESETS_HU = [
  { name: 'Bone',        wc:  400, ww: 2000 },
  { name: 'Soft Tissue', wc:   40, ww:  400 },
  { name: 'Lung',        wc: -600, ww: 1500 },
  { name: 'Brain',       wc:   40, ww:   80 },
  { name: 'Air',         wc: -400, ww: 1000 },
];
// Raw-pixel presets are computed from the volume's [min, max] range — see
// rawPresetsForRange() in cbctEngine. The names mirror the HU presets so the
// UI is consistent regardless of the underlying scale.
export const PRESET_NAMES = ['Bone', 'Soft Tissue', 'Lung', 'Brain', 'Air'];

export const VIEWPORTS = [
  { id: 'CBCT_AXIAL',    label: 'Axial',     orientationKey: 'AXIAL',    color: VIEWPORT_COLORS.axial },
  { id: 'CBCT_CORONAL',  label: 'Coronal',   orientationKey: 'CORONAL',  color: VIEWPORT_COLORS.coronal },
  { id: 'CBCT_SAGITTAL', label: 'Sagittal',  orientationKey: 'SAGITTAL', color: VIEWPORT_COLORS.sagittal },
  { id: 'CBCT_3D',       label: '3D',        orientationKey: 'CORONAL',  color: VIEWPORT_COLORS.volume3d },
];

// MPR viewport IDs in render order — used by the crosshairs tool to know
// which viewports are MPR (so it doesn't try to draw crosshairs on the 3D
// panel).
export const MPR_VIEWPORT_IDS = ['CBCT_AXIAL', 'CBCT_CORONAL', 'CBCT_SAGITTAL'];

// Stable lowercase view labels for the ai-read-cbct reader — findings
// reference the views they were seen in via `view_refs`, so these must be
// deterministic per viewport id.
export const AI_VIEW_LABELS = {
  CBCT_AXIAL: 'axial',
  CBCT_CORONAL: 'coronal',
  CBCT_SAGITTAL: 'sagittal',
  CBCT_3D: '3d',
  CEPH_LAT: 'ceph_lateral',
  CEPH_PA: 'ceph_pa',
  PANO_AXIAL: 'axial',
  TMJ_AX_R: 'tmj_axial_right',
  TMJ_AX_L: 'tmj_axial_left',
  TMJ_COR_R: 'tmj_coronal_right',
  TMJ_COR_L: 'tmj_coronal_left',
};

/**
 * Implant catalog — generic mainstream sizes across major brands.
 * Real product-specific catalogs (Straumann BLT, Nobel Replace, MIS V3,
 * etc.) come in Phase 3.4.1 as a per-clinic settings table. For now we
 * use a generic set covering the standard diameter × length matrix.
 */
export const IMPLANT_CATALOG = [
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

// Cross-section mode: N thin slices perpendicular to the arch curve at
// uniform arc-length spacing, each rendered into its own <canvas>.
export const CROSSSEC_COUNT = 16;

/**
 * View modes — each maps to a different layout + viewport configuration
 * over the SAME underlying volume. Switching modes doesn't reload the
 * volume; it rebuilds viewports + tool group bindings.
 */
export const VIEW_MODES = {
  'mpr-3d': {
    name: 'MPR + 3D',
    layout: 'grid-2x2',
    description: 'Multiplanar reconstruction + 3D volume. Implant planning + nerve trace tools live in the Plan tab.',
    viewports: [
      { id: 'CBCT_AXIAL',    label: 'Axial',    orientationKey: 'AXIAL',    color: VIEWPORT_COLORS.axial,    kind: 'orthographic' },
      { id: 'CBCT_CORONAL',  label: 'Coronal',  orientationKey: 'CORONAL',  color: VIEWPORT_COLORS.coronal,  kind: 'orthographic' },
      { id: 'CBCT_SAGITTAL', label: 'Sagittal', orientationKey: 'SAGITTAL', color: VIEWPORT_COLORS.sagittal, kind: 'orthographic' },
      { id: 'CBCT_3D',       label: '3D',       orientationKey: 'CORONAL',  color: VIEWPORT_COLORS.volume3d, kind: 'volume_3d' },
    ],
  },
  'ceph': {
    name: 'Ceph',
    layout: 'side-by-side',
    description: 'Synthetic cephalometric: thick-slab MIP through the full skull. Lateral (left) + PA (right).',
    viewports: [
      { id: 'CEPH_LAT', label: 'Lateral',     orientationKey: 'SAGITTAL', color: VIEWPORT_COLORS.axial,   kind: 'orthographic', slabMM: 200, blendMode: 'MIP' },
      { id: 'CEPH_PA',  label: 'Postero-Ant', orientationKey: 'CORONAL',  color: VIEWPORT_COLORS.coronal, kind: 'orthographic', slabMM: 200, blendMode: 'MIP' },
    ],
  },
  'pano': {
    name: 'Pano',
    layout: 'arch-pano',
    description: 'True reformatted panoramic. Click points on the axial inset to define the dental arch; pano regenerates from the curve.',
    viewports: [
      { id: 'PANO_AXIAL', label: 'Axial — click to trace arch', orientationKey: 'AXIAL', color: VIEWPORT_COLORS.axial, kind: 'orthographic' },
    ],
  },
  'crosssec': {
    name: 'Cross-sections',
    layout: 'arch-crosssec',
    description: 'Perpendicular cross-sections sampled along the arch curve. Trace the arch in Pano view first; this generates 16 thin slices at uniform spacing along the curve.',
    viewports: [], // no Cornerstone viewports — pure canvas grid
  },
  'tmj': {
    name: 'TMJ',
    layout: 'grid-2x2',
    description: 'TMJ workspace. 4 axial slices through condyles + corrected sagittals coming Phase 3.',
    viewports: [
      { id: 'TMJ_AX_R', label: 'Right Condyle (Ax)', orientationKey: 'AXIAL',   color: VIEWPORT_COLORS.axial,    kind: 'orthographic' },
      { id: 'TMJ_AX_L', label: 'Left Condyle (Ax)',  orientationKey: 'AXIAL',   color: VIEWPORT_COLORS.coronal,  kind: 'orthographic' },
      { id: 'TMJ_COR_R', label: 'Right Condyle (Cor)', orientationKey: 'CORONAL', color: VIEWPORT_COLORS.sagittal, kind: 'orthographic' },
      { id: 'TMJ_COR_L', label: 'Left Condyle (Cor)',  orientationKey: 'CORONAL', color: VIEWPORT_COLORS.volume3d, kind: 'orthographic' },
    ],
  },
};
