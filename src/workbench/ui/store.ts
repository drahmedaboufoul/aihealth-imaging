/*
 * IOS workbench session state (zustand). Plain, serialisable values only;
 * GPU objects live in sceneRegistry.ts.
 *
 * Frames:
 *   native  - a scan file's own coordinates (mm)
 *   case    - native transformed by the scan's pose `matrix` (alignment)
 *   view    - case transformed by `rootMatrix` (display-only orientation)
 */
import { create } from 'zustand';
import type { VersionRecord } from '../core/versions';
import type { DeviationStats } from '../core/deviation';
import type { ContactThresholds } from '../core/contact';
import type { IcpResult } from '../core/icp';
import type { MeasurementRecord, MeasurementKind } from '../core/measurements';
import type { Plane, Vec3 } from '../core/types';
import type { LoadStats } from '../engine/protocol';
import type { Profile2D, PlaneBasis } from '../core/section';
import { identity } from '../core/mat4';

export type Slot = 'A' | 'B' | 'C' | 'D';
export const SLOTS: Slot[] = ['A', 'B', 'C', 'D'];
export const SLOT_COLORS: Record<Slot, string> = { A: '#e2b48a', B: '#38bdf8', C: '#a78bfa', D: '#4ade80' };

export type Role = 'upper' | 'lower' | 'unknown';
export type Tool = 'none' | 'align' | 'deviation' | 'contact' | 'measure' | 'section' | 'edit' | 'versions' | 'export';
export type Layout = 'single' | 'side' | 'overlay';
export type MapView = 'none' | 'deviation' | 'contact';
export type MeasureMode = 'distance' | 'angle' | 'surface-path' | 'area';

export interface ScanState {
  slot: Slot;
  /** Original file name: shown locally only, never written to an export. */
  sourceName: string;
  status: 'loading' | 'ready' | 'error';
  stage: string;
  progress: number;
  error?: string;
  versions: VersionRecord[];
  activeVersionId: string | null;
  color: string;
  opacity: number;
  visible: boolean;
  role: Role;
  /** native -> case (column-major) */
  matrix: number[];
  loadStats?: LoadStats;
  hasTexture: boolean;
  hasColors: boolean;
}

export interface Acceptance { by: string; at: string }

export interface AlignStep {
  matrix: number[];
  method: 'start' | 'landmarks' | 'icp';
  summary: string;
}

export interface AlignmentState {
  fixed: Slot;
  moving: Slot;
  history: AlignStep[];
  status: 'none' | 'draft' | 'accepted';
  accepted?: Acceptance;
  picking: 'fixed' | 'moving' | null;
  landmarksFixed: Vec3[];
  landmarksMoving: Vec3[];
  landmarkRms?: number;
  lastIcp?: Pick<IcpResult, 'rms' | 'rmsPointToPoint' | 'iterations' | 'converged' | 'inlierFraction' | 'method' | 'reason' | 'elapsedMs' | 'samples'> & { history: number[] };
  running: boolean;
}

export interface DeviationState {
  ref: Slot;
  test: Slot;
  range: number;
  tolerance: number;
  maxDistance: number;
  bands: number[];
  values?: Float32Array;
  stats?: DeviationStats;
  /** versions + alignment status the map was computed with */
  basis?: { refVersion: string; testVersion: string; alignment: 'draft' | 'accepted' | 'none'; elapsedMs: number };
  running: boolean;
}

export interface ContactSideSummary {
  areaContact: number; areaNear: number; areaClose: number; contactPatches: number; deepest: number;
}

export interface ContactState {
  upper: Slot;
  lower: Slot;
  thresholds: ContactThresholds;
  upperValues?: Float32Array;
  lowerValues?: Float32Array;
  summary?: { upper: ContactSideSummary; lower: ContactSideSummary; warnings: string[]; elapsedMs: number; searchRadius: number };
  basis?: { upperVersion: string; lowerVersion: string };
  status: 'none' | 'draft' | 'accepted';
  accepted?: Acceptance;
  running: boolean;
}

export interface PendingPick { slot: Slot; versionId: string; native: Vec3; caseP: Vec3; face: number }

export interface SectionState {
  /** plane in the case frame */
  plane?: Plane;
  basis?: PlaneBasis;
  profiles?: { slot: Slot; profiles: Profile2D[]; polylinesCase: Vec3[][] }[];
  running: boolean;
}

export interface LassoState {
  purpose: 'area' | 'trim';
  /** polygon in CSS pixels relative to the pane */
  points: [number, number][];
  pane: 'left' | 'right';
}

export interface TrimPreview {
  slot: Slot;
  versionId: string;
  lasso: import('../core/edits/trim').LassoSpec;
  triangles: number;
  area: number;
  /** per display triangle: 1 = selected */
  mask?: Uint8Array;
}

export interface WorkbenchState {
  scans: Partial<Record<Slot, ScanState>>;
  layout: Layout;
  linkCameras: boolean;
  panes: { left: Slot[]; right: Slot[] };
  tool: Tool;
  mapView: MapView;
  rootMatrix: number[];
  alignment: AlignmentState;
  deviation: DeviationState;
  contact: ContactState;
  section: SectionState;
  measureMode: MeasureMode;
  pending: PendingPick[];
  measurements: MeasurementRecord[];
  lasso: LassoState | null;
  trimPreview: TrimPreview | null;
  editTarget: Slot;
  lassoVisibleOnly: boolean;
  reviewerName: string;
  busy: string | null;
  notice: { tone: 'info' | 'error' | 'success'; text: string } | null;
  showHelp: boolean;
  frameRequest: number;

  set: (patch: Partial<WorkbenchState>) => void;
  patchScan: (slot: Slot, patch: Partial<ScanState>) => void;
  patchAlignment: (patch: Partial<AlignmentState>) => void;
  patchDeviation: (patch: Partial<DeviationState>) => void;
  patchContact: (patch: Partial<ContactState>) => void;
  patchSection: (patch: Partial<SectionState>) => void;
  notify: (tone: 'info' | 'error' | 'success', text: string) => void;
  addMeasurement: (m: MeasurementRecord) => void;
  removeMeasurement: (id: string) => void;
  requestFrame: () => void;
}

export const DEFAULT_THRESHOLDS: ContactThresholds = { contact: 0, near: 0.1, close: 0.3 };

type DataKeys = Exclude<keyof WorkbenchState, 'set' | 'patchScan' | 'patchAlignment' | 'patchDeviation' | 'patchContact' | 'patchSection' | 'notify' | 'addMeasurement' | 'removeMeasurement' | 'requestFrame'>;

/** Fresh session values (also used to reset when the page closes). */
export function initialWorkbenchState(): Pick<WorkbenchState, DataKeys> {
  return {
    scans: {},
    layout: 'single',
    linkCameras: true,
    panes: { left: ['A'], right: ['B'] },
    tool: 'none',
    mapView: 'none',
    rootMatrix: identity(),
    alignment: { fixed: 'A', moving: 'B', history: [], status: 'none', picking: null, landmarksFixed: [], landmarksMoving: [], running: false },
    deviation: { ref: 'A', test: 'B', range: 0.3, tolerance: 0.05, maxDistance: 1, bands: [0.05, 0.1, 0.2], running: false },
    contact: { upper: 'A', lower: 'B', thresholds: { ...DEFAULT_THRESHOLDS }, status: 'none', running: false },
    section: { running: false },
    measureMode: 'distance',
    pending: [],
    measurements: [],
    lasso: null,
    trimPreview: null,
    editTarget: 'A',
    lassoVisibleOnly: true,
    reviewerName: '',
    busy: null,
    notice: null,
    showHelp: false,
    frameRequest: 0,
  };
}

export const useWorkbench = create<WorkbenchState>((set) => ({
  ...initialWorkbenchState(),

  set: (patch) => set(patch),
  patchScan: (slot, patch) => set((s) => {
    const cur = s.scans[slot];
    if (!cur) return {};
    return { scans: { ...s.scans, [slot]: { ...cur, ...patch } } };
  }),
  patchAlignment: (patch) => set((s) => ({ alignment: { ...s.alignment, ...patch } })),
  patchDeviation: (patch) => set((s) => ({ deviation: { ...s.deviation, ...patch } })),
  patchContact: (patch) => set((s) => ({ contact: { ...s.contact, ...patch } })),
  patchSection: (patch) => set((s) => ({ section: { ...s.section, ...patch } })),
  notify: (tone, text) => set({ notice: { tone, text } }),
  addMeasurement: (m) => set((s) => ({ measurements: [...s.measurements, m] })),
  removeMeasurement: (id) => set((s) => ({ measurements: s.measurements.filter((m) => m.id !== id) })),
  requestFrame: () => set((s) => ({ frameRequest: s.frameRequest + 1 })),
}));

export function readyScans(state: Pick<WorkbenchState, 'scans'>): ScanState[] {
  return SLOTS.map((s) => state.scans[s]).filter((s): s is ScanState => !!s && s.status === 'ready');
}

export function activeVersion(scan: ScanState | undefined): VersionRecord | undefined {
  return scan?.versions.find((v) => v.id === scan.activeVersionId);
}

export function measurementKindLabel(k: MeasurementKind): string {
  return ({
    distance: 'Distance', angle: 'Angle', 'surface-path': 'Surface path', area: 'Area',
    'section-distance': 'Section distance', 'section-width': 'Section width', 'section-height': 'Section height',
  } as Record<MeasurementKind, string>)[k];
}
