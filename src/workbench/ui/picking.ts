/*
 * What a left-click on a scan means for the active tool: landmarks for
 * alignment, points for measurements, or the two ends of a section line.
 * Also turns a finished lasso into a deterministic LassoSpec.
 */
import * as THREE from 'three';
import { useWorkbench, activeVersion, type Slot } from './store';
import { addLandmark, nextMeasurementId, surfacePathMeasurement } from './actions';
import { getEngine, getPane, paneMesh } from './sceneRegistry';
import { angleDeg, distance } from '../core/measurements';
import { invertRigid, transformDirection } from '../core/mat4';
import { toProfile } from '../core/section';
import type { LassoSpec } from '../core/edits/trim';
import type { Vec3 } from '../core/types';

const get = () => useWorkbench.getState();

/** Camera view direction in the case frame (undoing the display-only root orientation). */
export function viewDirCase(pane: 'left' | 'right'): Vec3 | null {
  const h = getPane(pane);
  if (!h) return null;
  const dir = new THREE.Vector3();
  h.camera.getWorldDirection(dir);
  const inv = invertRigid(get().rootMatrix);
  const d = transformDirection(inv, [dir.x, dir.y, dir.z]);
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
}

export function onScanPick(slot: Slot, native: Vec3, casePoint: Vec3, face: number, pane: 'left' | 'right'): void {
  const s = get();
  const scan = s.scans[slot];
  const v = activeVersion(scan);
  if (!scan || !v) return;
  if (s.tool === 'align') {
    if (s.alignment.picking) addLandmark(slot, native);
    return;
  }
  if (s.tool === 'section') {
    const pending = [...s.pending, { slot, versionId: v.id, native, caseP: casePoint, face }].slice(-2);
    if (pending.length < 2) { s.set({ pending }); return; }
    s.set({ pending: [] });
    void runSection(pending[0].caseP, pending[1].caseP, pane);
    return;
  }
  if (s.tool !== 'measure' || s.measureMode === 'area') return;
  const need = s.measureMode === 'angle' ? 3 : 2;
  const prev = s.pending.filter((p) => s.measureMode !== 'surface-path' || p.slot === slot);
  const pending = [...prev, { slot, versionId: v.id, native, caseP: casePoint, face }];
  if (pending.length < need) { s.set({ pending }); return; }
  s.set({ pending: [] });
  const sameScan = pending.every((p) => p.slot === pending[0].slot);
  if (s.measureMode === 'surface-path') {
    void surfacePathMeasurement(slot, pending[0], pending[1]);
    return;
  }
  // Distances across two scans are measured in the case frame; within one scan, in its native frame.
  const pts = sameScan ? pending.map((p) => p.native) : pending.map((p) => p.caseP);
  const value = s.measureMode === 'distance' ? distance(pts[0], pts[1]) : angleDeg(pts[0], pts[1], pts[2]);
  const first = s.scans[pending[0].slot]!;
  const fv = activeVersion(first)!;
  s.addMeasurement({
    id: nextMeasurementId(),
    kind: s.measureMode,
    slot: pending[0].slot,
    versionId: fv.id,
    versionSha256: fv.outputSha256,
    points: sameScan ? pts : pending.map((p) => p.native),
    value,
    unit: s.measureMode === 'distance' ? 'mm' : 'deg',
    method: sameScan ? 'euclidean' : 'euclidean-across-scans (case frame)',
    createdAt: new Date().toISOString(),
    meta: sameScan ? undefined : { slots: pending.map((p) => p.slot), caseFramePoints: pending.map((p) => p.caseP) },
  });
}

export async function runSection(a: Vec3, b: Vec3, pane: 'left' | 'right'): Promise<void> {
  const s = get();
  const view = viewDirCase(pane);
  if (!view) return;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  // remove any component along the view direction so the line is "as drawn on screen"
  const dv = u[0] * view[0] + u[1] * view[1] + u[2] * view[2];
  for (let k = 0; k < 3; k++) u[k] -= dv * view[k];
  const ul = Math.hypot(u[0], u[1], u[2]);
  if (!(ul > 1e-6)) { s.notify('error', 'Pick two different points for the section line.'); return; }
  const uu: Vec3 = [u[0] / ul, u[1] / ul, u[2] / ul];
  const n: Vec3 = [uu[1] * view[2] - uu[2] * view[1], uu[2] * view[0] - uu[0] * view[2], uu[0] * view[1] - uu[1] * view[0]];
  const nl = Math.hypot(n[0], n[1], n[2]);
  const normal: Vec3 = [n[0] / nl, n[1] / nl, n[2] / nl];
  // profile "up" = towards the camera
  const v: Vec3 = [-view[0], -view[1], -view[2]];
  const origin: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const plane = { origin, normal };
  const basis = { origin, u: uu, v, normal };
  const ready = Object.values(s.scans).filter((sc) => sc && sc.status === 'ready' && sc.visible);
  s.patchSection({ running: true, plane, basis });
  try {
    const res = await getEngine().request({ kind: 'section', items: ready.map((sc) => ({ key: sc!.activeVersionId!, matrix: sc!.matrix })), plane });
    const profiles = res.items.map((it) => {
      const slot = it.key.split('.')[0] as Slot;
      return { slot, profiles: toProfile(it.polylines, basis), polylinesCase: it.polylines.map((pl) => pl.points) };
    });
    get().patchSection({ profiles });
  } catch {
    get().notify('error', 'The cross-section failed.');
  } finally {
    get().patchSection({ running: false });
  }
}

/** Convert a lasso drawn in pane pixels into a deterministic, scan-local LassoSpec. */
export function lassoSpecFor(pane: 'left' | 'right', slot: Slot, points: [number, number][], width: number, height: number, visibleOnly: boolean): LassoSpec | null {
  const h = getPane(pane);
  const mesh = paneMesh(pane, slot);
  if (!h || !mesh) return null;
  mesh.updateMatrixWorld(true);
  h.camera.updateMatrixWorld(true);
  const mvp = new THREE.Matrix4().multiplyMatrices(h.camera.projectionMatrix, h.camera.matrixWorldInverse).multiply(mesh.matrixWorld);
  const dir = new THREE.Vector3();
  h.camera.getWorldDirection(dir);
  const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const local = dir.clone().transformDirection(inv);
  return {
    polygon: points.map(([x, y]) => [+(2 * (x / width) - 1).toFixed(5), +(1 - 2 * (y / height)).toFixed(5)] as [number, number]),
    mvp: mvp.elements.map((e) => +e.toPrecision(10)),
    viewDir: [+local.x.toFixed(8), +local.y.toFixed(8), +local.z.toFixed(8)],
    frontOnly: true,
    visibleOnly,
  };
}

export { toProfile };
