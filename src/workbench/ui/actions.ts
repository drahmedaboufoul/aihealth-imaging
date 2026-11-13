/*
 * Workbench actions: bridge between the UI state, the geometry worker and
 * the in-memory version stores. Nothing here makes a network request;
 * study files are fetched by the page from the clinic's own signed URLs
 * exactly as the existing viewer does.
 */
import { useWorkbench, SLOTS, SLOT_COLORS, activeVersion, initialWorkbenchState, type Slot, type Role, type AlignStep } from './store';
import { getEngine, registerGfx, versionStore, persistence, clearSlot, getGfx, attachTexture } from './sceneRegistry';
import { fitRigid, nearlyCollinear } from '../core/rigid';
import { identity, invertRigid, multiply, isRigid, transformPoint } from '../core/mat4';
import type { EditRequest } from '../core/edits';
import type { IcpOptions } from '../core/icp';
import { meshExportName, measurementsExportName, isNeutralExportName } from '../core/naming';
import { buildMeasurementsFile, parseMeasurementsFile, type MeasurementRecord } from '../core/measurements';
import { detectScanRole } from '../../components/ios-viewer/utils/roleDetection';
import type { Vec3 } from '../core/types';

const get = () => useWorkbench.getState();

export interface IncomingFile {
  name: string;
  /** A local file: read inside the worker, never on the main thread. */
  file?: File;
  /** Otherwise: fetch the bytes (study files from the clinic's signed URLs). */
  read?: () => Promise<ArrayBuffer>;
  textureUrl?: string;
  /** native -> case pose (column-major), e.g. a saved bite registration */
  matrix?: number[];
}

function roleFromName(name: string): Role {
  const r = detectScanRole(name);
  return r === 'maxilla' ? 'upper' : r === 'mandible' ? 'lower' : 'unknown';
}

function shortError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : '';
  // never echo URLs or long backend text into the UI
  if (!msg || /https?:\/\//.test(msg) || msg.length > 200) return fallback;
  return msg;
}

export function download(buffer: ArrayBuffer | Blob, name: string, type: string): void {
  if (!isNeutralExportName(name)) throw new Error('Refusing a non-neutral export file name.');
  const blob = buffer instanceof Blob ? buffer : new Blob([buffer], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Pair local OBJ files with their texture images (same stem, or Fussen TextureMeshN_M <-> FussenTextureN_M). */
export function pairLocalFiles(files: File[]): IncomingFile[] {
  const stem = (n: string) => n.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '').toLowerCase();
  const images = files.filter((f) => /\.(jpe?g|png)$/i.test(f.name));
  const meshes = files.filter((f) => /\.(stl|ply|obj)$/i.test(f.name));
  return meshes.map((f) => {
    const base = stem(f.name);
    const fussen = /^texturemesh(\d+_\d+)$/.exec(base);
    const matches = images.filter((img) => {
      const b = stem(img.name);
      return b === base || (fussen && b === `fussentexture${fussen[1]}`);
    });
    const textureUrl = /\.obj$/i.test(f.name) && matches.length === 1 ? URL.createObjectURL(matches[0]) : undefined;
    return { name: f.name, file: f, textureUrl };
  });
}

function freeSlots(): Slot[] {
  const { scans } = get();
  return SLOTS.filter((s) => !scans[s]);
}

export async function loadFiles(files: IncomingFile[]): Promise<void> {
  const slots = freeSlots();
  if (files.length > slots.length) {
    get().notify('error', `The workbench holds four scans; ${files.length - slots.length} file(s) were not opened.`);
  }
  const jobs = files.slice(0, slots.length).map((file, i) => loadOne(slots[i], file));
  await Promise.all(jobs);
  assignDefaults();
}

async function loadOne(slot: Slot, file: IncomingFile): Promise<void> {
  const st = get();
  st.set({
    scans: {
      ...st.scans,
      [slot]: {
        slot, sourceName: file.name, status: 'loading', stage: 'reading file', progress: 0, versions: [], activeVersionId: null,
        color: SLOT_COLORS[slot], opacity: 1, visible: true, role: roleFromName(file.name),
        matrix: file.matrix && isRigid(file.matrix) ? file.matrix.slice() : identity(), hasTexture: false, hasColors: false,
      },
    },
  });
  try {
    const key = `${slot}.v0`;
    const onProgress = (stage: string, fraction: number) => get().patchScan(slot, { stage, progress: fraction });
    let fileReadMs: number | undefined;
    let res;
    if (file.file) {
      res = await getEngine().request({ kind: 'load', key, name: file.name, file: file.file }, { onProgress });
      fileReadMs = res.stats.fileReadMs;
    } else if (file.read) {
      const t0 = performance.now();
      const buffer = await file.read();
      fileReadMs = performance.now() - t0;
      res = await getEngine().request({ kind: 'load', key, name: file.name, buffer }, { transfer: [buffer], onProgress });
    } else {
      throw new Error('No scan data.');
    }
    performance.mark(`iosw:${key}:received`);
    registerGfx(key, res.mesh);
    performance.mark(`iosw:${key}:registered`);
    const store = versionStore(slot);
    const v0 = await store.addOriginal({
      outputSha256: res.outputSha256, sourceFileSha256: res.sourceSha256,
      vertices: res.stats.vertices, triangles: res.stats.triangles,
      params: { format: file.name.split('.').pop()?.toLowerCase(), sourceTriangles: res.stats.sourceTriangles, degenerateDropped: res.stats.degenerateDropped },
    });
    await persistence.saveVersion({ kind: 'local', id: null }, v0);
    if (file.textureUrl) attachTexture(key, file.textureUrl, () => get().patchScan(slot, { hasTexture: true }));
    const s = get();
    if (!SLOTS.some((o) => o !== slot && s.scans[o]?.status === 'ready') && res.autoOrient && !file.matrix) {
      s.set({ rootMatrix: res.autoOrient });
    }
    get().patchScan(slot, {
      status: 'ready', stage: 'ready', progress: 1, versions: [...store.list], activeVersionId: v0.id,
      loadStats: { ...res.stats, fileReadMs }, hasColors: !!res.mesh.colors,
    });
    get().requestFrame();
  } catch (err) {
    get().patchScan(slot, { status: 'error', stage: 'error', error: shortError(err, 'The scan could not be read.') });
  }
}

export function removeScan(slot: Slot): void {
  const s = get();
  const scan = s.scans[slot];
  if (!scan) return;
  for (const v of scan.versions) void getEngine().request({ kind: 'dispose', key: v.id }).catch(() => {});
  clearSlot(slot);
  const scans = { ...s.scans };
  delete scans[slot];
  s.set({
    scans,
    measurements: s.measurements.filter((m) => m.slot !== slot),
    pending: s.pending.filter((p) => p.slot !== slot),
  });
  invalidateMaps(slot);
}

/** Sensible defaults for which scan plays which part. */
function assignDefaults(): void {
  const s = get();
  const ready = SLOTS.filter((x) => s.scans[x]);
  if (ready.length === 0) return;
  const first = ready[0];
  const second = ready[1] ?? ready[0];
  const upper = ready.find((x) => s.scans[x]?.role === 'upper');
  const lower = ready.find((x) => s.scans[x]?.role === 'lower');
  s.set({
    panes: { left: [first], right: [second] },
    alignment: { ...s.alignment, fixed: first, moving: second },
    deviation: { ...s.deviation, ref: first, test: second },
    contact: { ...s.contact, upper: upper ?? first, lower: lower ?? (upper === second ? first : second) },
  });
}

/** Forget everything (called when the workbench page unmounts). */
export function resetWorkbench(): void {
  for (const slot of SLOTS) clearSlot(slot);
  useWorkbench.setState(initialWorkbenchState(), false);
}

export function setRole(slot: Slot, role: Role): void {
  get().patchScan(slot, { role });
}

/* ---------------- alignment ---------------- */

function scan(slot: Slot) {
  const sc = get().scans[slot];
  if (!sc || sc.status !== 'ready') throw new Error(`Scan ${slot} is not loaded.`);
  return sc;
}

function pushAlignStep(step: AlignStep): void {
  const s = get();
  const a = s.alignment;
  const moving = scan(a.moving);
  const history = a.history.length ? a.history : [{ matrix: moving.matrix.slice(), method: 'start' as const, summary: 'Starting position' }];
  s.patchScan(a.moving, { matrix: step.matrix });
  s.patchAlignment({ history: [...history, step], status: 'draft', accepted: undefined });
  invalidateMaps(a.moving);
}

export function startLandmarkPicking(which: 'fixed' | 'moving'): void {
  const a = get().alignment;
  get().patchAlignment({
    picking: which,
    ...(which === 'fixed' ? { landmarksFixed: [] } : { landmarksMoving: [] }),
    landmarkRms: which === 'fixed' ? undefined : a.landmarkRms,
  });
}

export function addLandmark(slot: Slot, native: Vec3): void {
  const a = get().alignment;
  if (!a.picking) return;
  const want = a.picking === 'fixed' ? a.fixed : a.moving;
  if (slot !== want) { get().notify('info', `Pick on scan ${want} (the ${a.picking} scan).`); return; }
  const list = a.picking === 'fixed' ? [...a.landmarksFixed, native] : [...a.landmarksMoving, native];
  const done = list.length >= 3;
  get().patchAlignment({
    ...(a.picking === 'fixed' ? { landmarksFixed: list.slice(0, 3) } : { landmarksMoving: list.slice(0, 3) }),
    picking: done ? (a.picking === 'fixed' && a.landmarksMoving.length < 3 ? 'moving' : null) : a.picking,
  });
}

export function applyLandmarks(): void {
  try {
    applyLandmarksUnsafe();
  } catch (err) {
    get().notify('error', shortError(err, 'Landmark alignment failed.'));
  }
}

function applyLandmarksUnsafe(): void {
  const s = get();
  const a = s.alignment;
  if (a.landmarksFixed.length < 3 || a.landmarksMoving.length < 3) { s.notify('error', 'Pick three points on each scan first.'); return; }
  if (nearlyCollinear(a.landmarksFixed) || nearlyCollinear(a.landmarksMoving)) {
    s.notify('error', 'The three points are almost in a line. Pick points spread across the arch (e.g. both molars and an incisor).');
    return;
  }
  const fit = fitRigid(a.landmarksMoving, a.landmarksFixed);
  const fixed = scan(a.fixed);
  pushAlignStep({ matrix: multiply(fixed.matrix, fit.matrix), method: 'landmarks', summary: `3-point landmarks, residual RMS ${fit.rms.toFixed(2)} mm` });
  s.patchAlignment({ landmarkRms: fit.rms });
}

export async function runIcp(options: IcpOptions = {}): Promise<void> {
  const s = get();
  const a = s.alignment;
  if (a.fixed === a.moving) { s.notify('error', 'Choose two different scans to align.'); return; }
  s.patchAlignment({ running: true });
  try {
    const fixed = scan(a.fixed), moving = scan(a.moving);
    const initial = multiply(invertRigid(fixed.matrix), moving.matrix);
    const res = await getEngine().request({
      kind: 'icp', fixedKey: fixed.activeVersionId!, movingKey: moving.activeVersionId!, initial, options,
    });
    if (res.iterations === 0 || !Number.isFinite(res.rms)) {
      s.notify('error', `ICP could not start: ${res.reason}.`);
      return;
    }
    pushAlignStep({
      matrix: multiply(fixed.matrix, res.matrix), method: 'icp',
      summary: `ICP ${res.method}, RMS ${res.rms.toFixed(3)} mm, ${res.iterations} iterations${res.converged ? '' : ' (not converged)'}`,
    });
    get().patchAlignment({
      lastIcp: {
        rms: res.rms, rmsPointToPoint: res.rmsPointToPoint, iterations: res.iterations, converged: res.converged,
        inlierFraction: res.inlierFraction, method: res.method, reason: res.reason, elapsedMs: res.elapsedMs, samples: res.samples,
        history: res.history.map((h) => h.rms),
      },
    });
  } catch (err) {
    s.notify('error', shortError(err, 'Alignment failed.'));
  } finally {
    get().patchAlignment({ running: false });
  }
}

export function undoAlignment(): void {
  const s = get();
  const a = s.alignment;
  if (a.history.length < 2) return;
  const history = a.history.slice(0, -1);
  const prev = history[history.length - 1];
  s.patchScan(a.moving, { matrix: prev.matrix.slice() });
  s.patchAlignment({ history: history.length > 1 ? history : [], status: history.length > 1 ? 'draft' : 'none', accepted: undefined });
  invalidateMaps(a.moving);
}

export async function acceptAlignment(name: string): Promise<void> {
  const s = get();
  const a = s.alignment;
  const by = name.trim();
  if (by.length < 2) { s.notify('error', 'Type the name of the person accepting the alignment.'); return; }
  if (a.status !== 'draft') return;
  const at = new Date().toISOString();
  const fixed = s.scans[a.fixed], moving = s.scans[a.moving];
  if (!fixed || !moving) { s.notify('error', 'Both scans must still be open to accept the alignment.'); return; }
  s.set({ reviewerName: by });
  s.patchAlignment({ status: 'accepted', accepted: { by, at } });
  const last = a.history[a.history.length - 1];
  await persistence.saveAlignment({ kind: 'local', id: null }, {
    movingSlot: a.moving, fixedSlot: a.fixed,
    matrix: multiply(invertRigid(fixed.matrix), moving.matrix),
    method: a.history.some((h) => h.method === 'landmarks') && a.history.some((h) => h.method === 'icp') ? 'landmarks+icp' : last.method === 'landmarks' ? 'landmarks' : 'icp',
    report: { rms: a.lastIcp?.rms ?? a.landmarkRms ?? NaN, iterations: a.lastIcp?.iterations, converged: a.lastIcp?.converged, landmarkRms: a.landmarkRms },
    status: 'accepted', accepted: { acceptedBy: by, acceptedAt: at },
    movingVersionSha256: activeVersion(moving)!.outputSha256, fixedVersionSha256: activeVersion(fixed)!.outputSha256,
  });
  s.notify('success', `Alignment accepted by ${by}.`);
}

/** Bake the ACCEPTED alignment into a new version of the moving scan. */
export async function bakeAlignment(): Promise<void> {
  const s = get();
  const a = s.alignment;
  if (a.status !== 'accepted' || !a.accepted) { s.notify('error', 'Accept the alignment first.'); return; }
  const fixed = s.scans[a.fixed], moving = s.scans[a.moving];
  if (!fixed || !moving) { s.notify('error', 'Both scans must still be open.'); return; }
  const T = multiply(invertRigid(fixed.matrix), moving.matrix);
  await applyEditTo(a.moving, { op: 'apply-transform', params: { matrix: T, acceptedBy: a.accepted.by, acceptedAt: a.accepted.at } });
  // geometry now lives in the fixed scan's frame
  get().patchScan(a.moving, { matrix: fixed.matrix.slice() });
  get().patchAlignment({ history: [], status: 'none', accepted: undefined });
}

/* ---------------- maps ---------------- */

export function invalidateMaps(slot: Slot): void {
  const s = get();
  if (s.deviation.values && (s.deviation.ref === slot || s.deviation.test === slot)) {
    s.patchDeviation({ values: undefined, stats: undefined, basis: undefined });
    if (s.mapView === 'deviation') s.set({ mapView: 'none' });
  }
  if (s.contact.upperValues && (s.contact.upper === slot || s.contact.lower === slot)) {
    s.patchContact({ upperValues: undefined, lowerValues: undefined, summary: undefined, basis: undefined, status: 'none', accepted: undefined });
    if (s.mapView === 'contact') s.set({ mapView: 'none' });
  }
}

export async function computeDeviationMap(): Promise<void> {
  const s = get();
  const d = s.deviation;
  if (d.ref === d.test) { s.notify('error', 'Choose two different scans.'); return; }
  s.patchDeviation({ running: true });
  try {
    const ref = scan(d.ref), test = scan(d.test);
    const res = await getEngine().request({
      kind: 'deviation', refKey: ref.activeVersionId!, testKey: test.activeVersionId!,
      testToRef: multiply(invertRigid(ref.matrix), test.matrix), maxDistance: d.maxDistance, bands: d.bands,
    });
    const a = get().alignment;
    const involved = (a.fixed === d.ref && a.moving === d.test) || (a.fixed === d.test && a.moving === d.ref);
    get().patchDeviation({
      values: res.values, stats: res.stats,
      basis: { refVersion: ref.activeVersionId!, testVersion: test.activeVersionId!, alignment: involved && a.status !== 'none' ? (a.status as 'draft' | 'accepted') : 'none', elapsedMs: res.elapsedMs },
    });
    get().set({ mapView: 'deviation' });
  } catch (err) {
    s.notify('error', shortError(err, 'Deviation map failed.'));
  } finally {
    get().patchDeviation({ running: false });
  }
}

export async function computeContactMap(): Promise<void> {
  const s = get();
  const c = s.contact;
  if (c.upper === c.lower) { s.notify('error', 'Choose different scans for upper and lower.'); return; }
  s.patchContact({ running: true });
  try {
    const up = scan(c.upper), low = scan(c.lower);
    const res = await getEngine().request({
      kind: 'contact', upper: { key: up.activeVersionId!, matrix: up.matrix }, lower: { key: low.activeVersionId!, matrix: low.matrix },
      thresholds: c.thresholds,
    });
    const pick = (x: typeof res.upper) => ({ areaContact: x.areaContact, areaNear: x.areaNear, areaClose: x.areaClose, contactPatches: x.contactPatches, deepest: x.deepest });
    get().patchContact({
      upperValues: res.upper.values, lowerValues: res.lower.values,
      summary: { upper: pick(res.upper), lower: pick(res.lower), warnings: res.warnings, elapsedMs: res.elapsedMs, searchRadius: res.searchRadius },
      basis: { upperVersion: up.activeVersionId!, lowerVersion: low.activeVersionId! },
      status: 'draft', accepted: undefined,
    });
    get().set({ mapView: 'contact' });
    showContactView();
  } catch (err) {
    s.notify('error', shortError(err, 'Contact map failed.'));
  } finally {
    get().patchContact({ running: false });
  }
}

/**
 * Side-by-side occlusal views for a contact map: the upper arch seen from
 * the lower one and vice versa (cameras unlinked, they look in opposite directions).
 */
export function showContactView(): void {
  const s = get();
  const c = s.contact;
  const up = s.scans[c.upper], low = s.scans[c.lower];
  const gu = getGfx(up?.activeVersionId), gl = getGfx(low?.activeVersionId);
  if (!up || !low || !gu?.natural.boundingBox || !gl?.natural.boundingBox) return;
  const centre = (box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }, m: number[]) =>
    transformPoint(multiply(s.rootMatrix, m), [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2]);
  const cu = centre(gu.natural.boundingBox, up.matrix), cl = centre(gl.natural.boundingBox, low.matrix);
  let d: Vec3 = [cu[0] - cl[0], cu[1] - cl[1], cu[2] - cl[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  d = l > 1e-6 ? [d[0] / l, d[1] / l, d[2] / l] : [0, 1, 0.0001];
  s.set({ layout: 'side', linkCameras: false, panes: { left: [c.upper], right: [c.lower] } });
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('iosw-view', { detail: { pane: 'left', view: 'dir', dir: [-d[0], -d[1], -d[2]] } }));
    window.dispatchEvent(new CustomEvent('iosw-view', { detail: { pane: 'right', view: 'dir', dir: d } }));
  }, 150);
}

export async function acceptContactMap(name: string): Promise<void> {
  const s = get();
  const c = s.contact;
  const by = name.trim();
  if (by.length < 2) { s.notify('error', 'Type the name of the person accepting the contact map.'); return; }
  if (c.status !== 'draft' || !c.summary) return;
  const at = new Date().toISOString();
  const up = s.scans[c.upper], low = s.scans[c.lower];
  if (!up || !low) { s.notify('error', 'Both scans must still be open to accept the contact map.'); return; }
  s.set({ reviewerName: by });
  s.patchContact({ status: 'accepted', accepted: { by, at } });
  await persistence.saveContactMap({ kind: 'local', id: null }, {
    upperSlot: c.upper, lowerSlot: c.lower, thresholds: c.thresholds,
    summary: {
      upperContactMm2: c.summary.upper.areaContact, upperNearMm2: c.summary.upper.areaNear, upperCloseMm2: c.summary.upper.areaClose,
      lowerContactMm2: c.summary.lower.areaContact, lowerNearMm2: c.summary.lower.areaNear, lowerCloseMm2: c.summary.lower.areaClose,
    },
    status: 'accepted', accepted: { acceptedBy: by, acceptedAt: at },
    upperVersionSha256: activeVersion(up)!.outputSha256, lowerVersionSha256: activeVersion(low)!.outputSha256,
  });
  s.notify('success', `Contact map accepted by ${by}.`);
}

/* ---------------- edits & versions ---------------- */

export async function applyEditTo(slot: Slot, request: EditRequest): Promise<boolean> {
  const s = get();
  const sc = s.scans[slot];
  if (!sc || sc.status !== 'ready') { s.notify('error', `Scan ${slot} is not loaded.`); return false; }
  const store = versionStore(slot);
  const parentId = sc.activeVersionId!;
  const key = `${slot}.v${store.list.length}`;
  s.set({ busy: `${request.op} on scan ${slot}…` });
  try {
    const res = await getEngine().request({ kind: 'edit', parentKey: parentId, key, request }, {
      onProgress: (stage, f) => get().set({ busy: `${stage} ${Math.round(f * 100)}%` }),
    });
    registerGfx(key, res.mesh);
    const rec = await store.addDerived({
      parentId, op: request.op, params: request.params as unknown as Record<string, unknown>,
      outputSha256: res.outputSha256, vertices: res.stats.vertices, triangles: res.stats.triangles, stats: res.stats,
    });
    if (rec.id !== key) throw new Error('Version numbering out of step.');
    await persistence.saveVersion({ kind: 'local', id: null }, rec);
    get().patchScan(slot, { versions: [...store.list], activeVersionId: rec.id });
    invalidateMaps(slot);
    get().notify('success', `Created ${rec.id} (${request.op}) · SHA-256 ${rec.outputSha256.slice(0, 12)}…`);
    return true;
  } catch (err) {
    get().notify('error', shortError(err, 'The edit failed.'));
    return false;
  } finally {
    get().set({ busy: null });
  }
}

export function setActiveVersion(slot: Slot, versionId: string): void {
  const sc = get().scans[slot];
  if (!sc || !sc.versions.some((v) => v.id === versionId)) return;
  get().patchScan(slot, { activeVersionId: versionId });
  invalidateMaps(slot);
}

export async function exportMesh(slot: Slot, versionId: string, format: 'stl' | 'ply'): Promise<void> {
  const sc = get().scans[slot];
  const v = sc?.versions.find((x) => x.id === versionId);
  if (!sc || !v) return;
  try {
    const res = await getEngine().request({ kind: 'export', key: versionId, format });
    const name = meshExportName(slot, v.index, format);
    download(res.buffer, name, format === 'stl' ? 'model/stl' : 'application/octet-stream');
    get().notify('success', `Exported ${name} · file SHA-256 ${res.sha256.slice(0, 12)}…`);
  } catch (err) {
    get().notify('error', shortError(err, 'Export failed.'));
  }
}

/* ---------------- measurements ---------------- */

let measureCounter = 0;
export function nextMeasurementId(): string {
  measureCounter += 1;
  return `m-${Date.now().toString(36)}-${measureCounter}`;
}

export function exportMeasurements(): void {
  const file = buildMeasurementsFile(get().measurements);
  const name = measurementsExportName();
  download(new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' }), name, 'application/json');
  void persistence.saveMeasurements({ kind: 'local', id: null }, get().measurements);
}

export async function importMeasurements(file: File): Promise<void> {
  try {
    const parsed = parseMeasurementsFile(await file.text());
    const s = get();
    const known = new Set(s.measurements.map((m) => m.id));
    const added: MeasurementRecord[] = parsed.measurements.filter((m) => !known.has(m.id));
    s.set({ measurements: [...s.measurements, ...added] });
    const matched = added.filter((m) => s.scans[m.slot as Slot]?.versions.some((v) => v.outputSha256 === m.versionSha256)).length;
    s.notify('success', `Imported ${added.length} measurement(s); ${matched} match a loaded scan version.`);
    void persistence.saveMeasurements({ kind: 'local', id: null }, get().measurements);
  } catch (err) {
    get().notify('error', shortError(err, 'That file could not be imported.'));
  }
}

export async function surfacePathMeasurement(slot: Slot, a: { native: Vec3; face: number }, b: { native: Vec3; face: number }): Promise<void> {
  const v = activeVersion(get().scans[slot]);
  if (!v) return;
  // display face == topology face (the parser keeps triangles in lock-step)
  const res = await getEngine().request({ kind: 'surfacePath', key: v.id, a: a.native, b: b.native, faceA: a.face, faceB: b.face }).catch(() => null);
  if (!res) { get().notify('error', 'No surface path between those points (different pieces of surface?).'); return; }
  get().addMeasurement({
    id: nextMeasurementId(), kind: 'surface-path', slot, versionId: v.id, versionSha256: v.outputSha256,
    points: [a.native, b.native], value: res.length, unit: 'mm', method: res.method === 'graph+shortening' ? 'surface-path-shortened' : 'surface-path-graph',
    createdAt: new Date().toISOString(), meta: { path: res.points.map((p) => p.map((x) => +x.toFixed(4))), graphLength: +res.graphLength.toFixed(4) },
  });
}
