/*
 * viewerToolConfig — shared tool identity for the DICOM (2D) and CBCT
 * (volume) viewers (audit #11, W9).
 *
 * Both viewers render their tool buttons / hotkeys / defaults from this
 * one module so the two siblings can't drift: same icons, same label
 * style, same shared hotkeys (R = reset, I = invert). Viewer-specific
 * orderings and default tools stay explicit per viewer — CBCT defaults
 * to Crosshair (crosshair navigation is the primary 3D gesture), DICOM
 * defaults to Zoom (radiology stack convention).
 */
import {
  Crosshair, Ruler, Triangle, Plus, Activity,
  Square, Circle as CircleIcon, Hexagon,
  Move, ZoomIn, Contrast,
} from 'lucide-react';

// Hotkeys shared by both viewers (single-key, no modifier).
export const SHARED_HOTKEYS = {
  reset: 'r',
  invert: 'i',
};

// ── CBCT (volume viewer) ───────────────────────────────────────────────
// Primary mouse-button tools selectable from the tool strip. `hotkey`
// selects the tool when the viewer has focus.
export const CBCT_MEASURE_TOOLS = [
  { key: 'crosshair',     icon: Crosshair,   label: 'Crosshair (1)',     hotkey: '1' },
  { key: 'length',        icon: Ruler,       label: 'Length (2)',        hotkey: '2' },
  { key: 'angle',         icon: Triangle,    label: 'Angle (3)',         hotkey: '3' },
  { key: 'bidirectional', icon: Plus,        label: 'Bidirectional (4)', hotkey: '4' },
  { key: 'probe',         icon: Activity,    label: 'HU Probe (5)',      hotkey: '5' },
];

export const CBCT_ROI_TOOLS = [
  { key: 'rectROI',    icon: Square,     label: 'Rectangle ROI' },
  { key: 'circleROI',  icon: CircleIcon, label: 'Circle ROI' },
  { key: 'ellipseROI', icon: Hexagon,    label: 'Ellipse ROI' },
];

export const CBCT_NAV_TOOLS = [
  { key: 'pan',  icon: Move,   label: 'Pan (6)',  hotkey: '6' },
  { key: 'zoom', icon: ZoomIn, label: 'Zoom (7)', hotkey: '7' },
];

export const CBCT_DEFAULT_TOOL = 'crosshair';

/** hotkey → tool key map for the CBCT keyboard handler. */
export const CBCT_HOTKEY_MAP = Object.fromEntries(
  [...CBCT_MEASURE_TOOLS, ...CBCT_ROI_TOOLS, ...CBCT_NAV_TOOLS]
    .filter((t) => t.hotkey)
    .map((t) => [t.hotkey, t.key]),
);

// ── DICOM (2D stack viewer) ────────────────────────────────────────────
// Left-click tool palette. WindowLevel/Pan keep their radiology-convention
// secondary bindings (right-drag / middle-drag) even while another tool
// owns left-click.
export const DICOM_LEFT_TOOLS = [
  { key: 'zoom',          icon: ZoomIn,     label: 'Zoom (1)',            hotkey: '1' },
  { key: 'wl',            icon: Contrast,   label: 'Window/Level (2)',    hotkey: '2' },
  { key: 'pan',           icon: Move,       label: 'Pan (3)',             hotkey: '3' },
  { key: 'length',        icon: Ruler,      label: 'Length (4)',          hotkey: '4' },
  { key: 'angle',         icon: Triangle,   label: 'Angle (5)',           hotkey: '5' },
  { key: 'bidirectional', icon: Plus,       label: 'Bidirectional (6)',   hotkey: '6' },
  { key: 'probe',         icon: Activity,   label: 'Pixel probe (7)',     hotkey: '7' },
  { key: 'ellipseROI',    icon: CircleIcon, label: 'Ellipse ROI (8)',     hotkey: '8' },
  { key: 'rectROI',       icon: Square,     label: 'Rectangle ROI (9)',   hotkey: '9' },
];

export const DICOM_DEFAULT_TOOL = 'zoom';
