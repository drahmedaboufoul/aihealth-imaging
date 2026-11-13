/*
 * CompareMode — the real cross-study Compare tab of the CBCT viewer.
 *
 * Three layouts, picked from what the user selects:
 *   self  — no second study selected: the CURRENT volume in two side-by-side
 *           cornerstone viewports (synced W/L + slice), useful on its own and
 *           the natural empty state.
 *   cbct  — second CBCT study: its NIfTI (DICOM fallback) is loaded as a
 *           SECOND cornerstone volume next to the current one. Window/level
 *           and slice position sync across the two viewports BY PATIENT-SPACE
 *           COORDINATES (same patient ⇒ same world frame).
 *   mesh  — intraoral-scan study (STL/PLY/OBJ):
 *             side    — CBCT 3D render beside a three.js mesh pane with
 *                       LINKED orientation presets (front/left/right/top).
 *             overlay — registration groundwork: the mesh rendered INSIDE the
 *                       CBCT's patient/world space over textured CBCT planes,
 *                       with manual alignment (steps + drag gizmo), opacity,
 *                       and "Auto-align (beta)" (PCA init + trimmed ICP against
 *                       bone/enamel surface points around the dental arch).
 *                       The transform persists per (cbct study, mesh study) in
 *                       imaging_studies.viewer_annotations.mesh_registrations.
 *
 * All cornerstone resources live in a DEDICATED rendering engine + tool group
 * (separate ids from the main MPR engine) so mounting/unmounting Compare can
 * never disturb the MPR panes — the flash-then-black protections in the parent
 * stay intact.
 */
import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense } from 'react';
import {
  Loader2, Columns2, Layers, Wand2, Save, Camera, Lock, Unlock, RotateCcw,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { ComparePicker, EmptyState } from '@/components/viewers/cbctViewModes';
import { fetchMeshStudyFiles } from '@/lib/meshStudyFiles';
import {
  sampleDentitionSurfacePoints, extractAxialMipPlane, extractMidSlicePlane,
  windowImageToRgba, computeScalarRangeFromData, getVolumeScalarData,
} from '@/lib/volumeMeshSampling';
import {
  createIcpSession, mat4Compose, mat4Decompose, mat4Multiply, mat4Translation,
  quatMultiply, quatFromAxisAngle, makeRegistrationEntry, upsertMeshRegistration,
  getMeshRegistration,
} from '@/lib/meshRegistration';

// three.js panes load lazily — only when a mesh study is actually selected.
const MeshSidePane = React.lazy(() =>
  import('./compareMeshPanes').then((m) => ({ default: m.MeshSidePane })));
const MeshOverlayPane = React.lazy(() =>
  import('./compareMeshPanes').then((m) => ({ default: m.MeshOverlayPane })));

const COMPARE_ENGINE_ID = 'cbctCompareEngine';
const COMPARE_TOOLGROUP_ID = 'cbctCompareTools';
const CVP = { LEFT: 'CMP_LEFT', RIGHT: 'CMP_RIGHT', VOL3D: 'CMP_VOL3D' };

// Orientation presets in the LPS world frame (duplicated in compareMeshPanes
// for the three.js side — both small, both documented).
const PRESETS = {
  front: { dir: [0, -1, 0], up: [0, 0, 1], label: 'Front' },
  left: { dir: [1, 0, 0], up: [0, 0, 1], label: 'Left' },
  right: { dir: [-1, 0, 0], up: [0, 0, 1], label: 'Right' },
  top: { dir: [0, 0, 1], up: [0, -1, 0], label: 'Top' },
};

const volCenterWorld = (vol) => {
  const [nx, ny, nz] = vol.dimensions;
  const d = vol.direction;
  const s = vol.spacing;
  const o = vol.origin;
  const ix = ((nx - 1) / 2) * s[0];
  const iy = ((ny - 1) / 2) * s[1];
  const iz = ((nz - 1) / 2) * s[2];
  return [
    o[0] + d[0] * ix + d[3] * iy + d[6] * iz,
    o[1] + d[1] * ix + d[4] * iy + d[7] * iz,
    o[2] + d[2] * ix + d[5] * iy + d[8] * iz,
  ];
};
const volDiagMm = (vol) =>
  Math.hypot(vol.dimensions[0] * vol.spacing[0], vol.dimensions[1] * vol.spacing[1], vol.dimensions[2] * vol.spacing[2]);

const STUDY_TYPE_LABELS = { cbct: 'CBCT', intraoral_scan: '3D scan', panoramic: 'Panoramic' };

// Resolve a study's imageIds the same way the viewer page does: prefer the
// server-converted NIfTI, fall back to the signed wadouri DICOM stack.
async function prepareStudyImageIds(cs, study) {
  if (study.nifti_status === 'ready' && study.nifti_storage_path && cs.niftiLoader?.createNiftiImageIdsAndCacheMetadata) {
    try {
      const { data: signed, error } = await supabase.storage
        .from('imaging-derived').createSignedUrl(study.nifti_storage_path, 3600);
      if (error || !signed?.signedUrl) throw error || new Error('Could not sign NIfTI URL');
      const ids = await Promise.race([
        cs.niftiLoader.createNiftiImageIdsAndCacheMetadata({ url: signed.signedUrl }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('NIfTI load timed out after 90s')), 90000)),
      ]);
      if (ids && ids.length) return ids;
    } catch (e) {
      console.warn('[CompareMode] NIfTI prepare failed, using DICOM fallback:', e?.message || e);
    }
  }
  const { data: files, error: fErr } = await supabase
    .from('imaging_files').select('storage_path').eq('study_id', study.id).eq('file_kind', 'dicom');
  if (fErr) throw fErr;
  if (!files?.length) throw new Error('No volume images found for the selected study');
  const { data: signed, error: sErr } = await supabase.storage
    .from('imaging').createSignedUrls(files.map((f) => f.storage_path), 3600);
  if (sErr) throw sErr;
  const ids = (signed || []).filter((s) => s && s.signedUrl && !s.error).map((s) => `wadouri:${s.signedUrl}`);
  if (!ids.length) throw new Error('Could not sign the selected study files');
  return ids;
}

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

const ControlRow = ({ label, children }) => (
  <div className="flex items-center gap-1">
    <span className="w-4 text-[10px] text-neutral-400">{label}</span>
    <div className="flex items-center gap-1 flex-wrap">{children}</div>
  </div>
);

export default function CompareMode({
  csRef, studyId, getCurrentVolumeId, getCurrentVolume, currentLabel = 'Current study',
  selectedId, onSelect, onCapture,
}) {
  // ── sibling studies of the same patient ───────────────────────────────────
  const [siblings, setSiblings] = useState([]);
  const [siblingLoading, setSiblingLoading] = useState(false);
  const selected = useMemo(() => siblings.find((s) => s.id === selectedId) || null, [siblings, selectedId]);
  const selKind = !selectedId ? 'self' : selected ? (selected.study_type === 'cbct' ? 'cbct' : 'mesh') : 'pending';

  // ── CBCT-vs-CBCT state ─────────────────────────────────────────────────────
  const [secondVol, setSecondVol] = useState({ status: 'idle', volumeId: null, error: null, progress: 0 });
  const volCacheRef = useRef(new Map()); // studyId -> COMPARE_ volumeId this mount cached

  // Release the COMPARE_-prefixed second volumes this mount cached
  // (cornerstone3D v4: cache.removeVolumeLoadObject), optionally keeping one
  // that is still on screen. Mirrors the decache-on-unmount fix in
  // CBCTVolumeViewer — without it every compared study leaked its full voxel
  // buffer (hundreds of MB per CBCT) in cornerstone's cache until the tab
  // died. The CURRENT study's volume is never in this map, so it's never
  // touched here.
  const decacheCompareVolumes = useCallback((exceptVolumeId = null) => {
    const cache = csRef.current?.core?.cache;
    volCacheRef.current.forEach((volumeId, sid) => {
      if (exceptVolumeId && volumeId === exceptVolumeId) return;
      try { cache?.removeVolumeLoadObject?.(volumeId); } catch (_) { /* already gone */ }
      volCacheRef.current.delete(sid);
    });
  }, [csRef]);
  const [syncWL, setSyncWL] = useState(true);
  const [syncSlice, setSyncSlice] = useState(true);
  const [orientation, setOrientation] = useState('axial');
  const syncWLRef = useRef(syncWL);
  const syncSliceRef = useRef(syncSlice);
  useEffect(() => { syncWLRef.current = syncWL; }, [syncWL]);
  useEffect(() => { syncSliceRef.current = syncSlice; }, [syncSlice]);
  const syncGuardRef = useRef(false);

  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const left3dRef = useRef(null);
  const engineRef = useRef(null);

  // ── mesh state ─────────────────────────────────────────────────────────────
  const [meshFiles, setMeshFiles] = useState({ status: 'idle', files: [], error: null });
  const [meshSub, setMeshSub] = useState('side'); // 'side' | 'overlay'
  const [preset, setPreset] = useState({ id: 'front', seq: 0 });
  const [visibleSet, setVisibleSet] = useState(null); // null = all components
  const [meshInfo, setMeshInfo] = useState(null);     // { centroid, componentPoints, ... }
  const [planesState, setPlanesState] = useState({ status: 'idle', list: null, error: null });
  const [planeVis, setPlaneVis] = useState({ axial: true, coronal: true, sagittal: true });
  const [xform, setXform] = useState(null);           // { position, quaternion, scale } of the pivot group
  const xformInitRef = useRef(null);                  // mesh study id the xform was initialized for
  const [savedMatrix, setSavedMatrix] = useState(undefined); // undefined = loading, null = none
  const [meshOpacity, setMeshOpacity] = useState(0.85);
  const [gizmo, setGizmo] = useState({ enabled: false, mode: 'translate' });
  const [scaleLocked, setScaleLocked] = useState(true);
  const [reg, setReg] = useState({ busy: false, msg: '', rms: null, method: null, dirty: false, savedAt: null });
  const manualTouchedRef = useRef(false);
  const captureRef = useRef(null);

  // ── effect: fetch the patient's other studies ──────────────────────────────
  useEffect(() => {
    if (!studyId) return undefined;
    let off = false;
    (async () => {
      setSiblingLoading(true);
      try {
        const { data: cur } = await supabase
          .from('imaging_studies').select('patient_id').eq('id', studyId).single();
        const pid = cur?.patient_id;
        if (!pid || off) return;
        const { data: rows } = await supabase
          .from('imaging_studies')
          .select('id, description, study_type, created_at, nifti_status, nifti_storage_path')
          .eq('patient_id', pid)
          .order('created_at', { ascending: false });
        if (off || !rows) return;
        setSiblings(rows.map((r) => {
          const type = STUDY_TYPE_LABELS[r.study_type] || r.study_type || 'Study';
          const date = r.created_at ? new Date(r.created_at).toLocaleDateString() : '';
          return { ...r, label: `${type}${r.description ? ` · ${r.description}` : ''}${date ? ` · ${date}` : ''}` };
        }));
      } catch (_) { /* picker stays empty */ } finally {
        if (!off) setSiblingLoading(false);
      }
    })();
    return () => { off = true; };
  }, [studyId]);

  // ── effect: load the second CBCT volume (NIfTI preferred, DICOM fallback) ─
  useEffect(() => {
    if (selKind !== 'cbct' || !selected) return undefined;
    const cs = csRef.current;
    if (!cs) return undefined;
    let off = false;
    const cached = volCacheRef.current.get(selected.id);
    const cachedLive = cached && cs.core?.cache?.getVolume?.(cached) ? cached : null;
    // The selection changed: any OTHER compared study's second volume is no
    // longer displayed anywhere — release it now instead of holding every
    // compared study's voxels until unmount.
    decacheCompareVolumes(cachedLive);
    if (cachedLive) {
      setSecondVol({ status: 'ready', volumeId: cachedLive, error: null, progress: 100 });
      return undefined;
    }
    setSecondVol({ status: 'loading', volumeId: null, error: null, progress: 0 });
    (async () => {
      try {
        const ids = await prepareStudyImageIds(cs, selected);
        if (off) return;
        const volumeId = `cornerstoneStreamingImageVolume:COMPARE_${selected.id}`;
        let volume = cs.core?.cache?.getVolume?.(volumeId);
        if (!volume) volume = await cs.core.volumeLoader.createAndCacheVolume(volumeId, { imageIds: ids });
        if (off) return;
        volCacheRef.current.set(selected.id, volumeId);
        // Show the viewport immediately (progressive streaming), window from
        // real data once the frames are in (NIfTI has no DICOM VOI metadata).
        setSecondVol({ status: 'ready', volumeId, error: null, progress: 0 });
        const loadDone = new Promise((resolve) => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
          const timer = setTimeout(finish, 120000);
          volume.load((evt) => {
            const total = evt?.totalNumFrames ?? evt?.total ?? ids.length;
            const done = evt?.framesProcessed ?? evt?.numFrames ?? 0;
            if (!off && total) {
              setSecondVol((v) => (v.volumeId === volumeId ? { ...v, progress: Math.min(100, Math.round((done / total) * 100)) } : v));
            }
            if (total && done >= total) finish();
          });
        });
        loadDone.then(() => {
          if (off) return;
          setSecondVol((v) => (v.volumeId === volumeId ? { ...v, progress: 100 } : v));
          try {
            const range = computeScalarRangeFromData(getVolumeScalarData(cs.core?.cache?.getVolume?.(volumeId)));
            if (range) {
              const vp = engineRef.current?.getViewport(CVP.RIGHT);
              vp?.setProperties({ voiRange: range });
              vp?.render?.();
            }
          } catch (_) { /* viewport may have been torn down */ }
        });
      } catch (e) {
        console.error('[CompareMode] second volume failed:', e);
        if (!off) setSecondVol({ status: 'error', volumeId: null, error: e?.message || 'Failed to load study', progress: 0 });
      }
    })();
    return () => { off = true; };
  }, [selKind, selected, csRef, decacheCompareVolumes]);

  // ── compare tool group ─────────────────────────────────────────────────────
  const setupCompareTools = useCallback((cs, viewportIds, kind) => {
    const { tools } = cs;
    const { ToolGroupManager, WindowLevelTool, ZoomTool, PanTool, StackScrollTool, TrackballRotateTool } = tools;
    const { MouseBindings } = tools.Enums;
    try { ToolGroupManager.destroyToolGroup(COMPARE_TOOLGROUP_ID); } catch (_) { /* none */ }
    const group = ToolGroupManager.createToolGroup(COMPARE_TOOLGROUP_ID);
    viewportIds.forEach((v) => group.addViewport(v, COMPARE_ENGINE_ID));
    if (kind === '2d') {
      group.addTool(WindowLevelTool.toolName);
      group.addTool(ZoomTool.toolName);
      group.addTool(PanTool.toolName);
      group.addTool(StackScrollTool.toolName);
      group.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
      group.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
      group.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
      try {
        group.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
      } catch (_) { group.setToolActive(StackScrollTool.toolName); }
    } else {
      if (TrackballRotateTool) {
        group.addTool(TrackballRotateTool.toolName);
        group.setToolActive(TrackballRotateTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
      }
      group.addTool(ZoomTool.toolName);
      group.addTool(PanTool.toolName);
      group.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
      group.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
    }
  }, []);

  // W/L + slice-position sync across the two viewports, BY PATIENT-SPACE
  // coordinates: the target's slice plane is moved along its own normal until
  // it contains the source's focal point (same patient ⇒ same world frame).
  const attachSyncListeners = useCallback((cleanupFns) => {
    const cs = csRef.current;
    const Events = cs?.core?.Enums?.Events;
    if (!Events) return;
    const pairs = [
      [leftRef.current, CVP.LEFT, CVP.RIGHT],
      [rightRef.current, CVP.RIGHT, CVP.LEFT],
    ];
    pairs.forEach(([el, srcId, dstId]) => {
      if (!el) return;
      const onVoi = () => {
        if (!syncWLRef.current || syncGuardRef.current) return;
        syncGuardRef.current = true;
        try {
          const engine = engineRef.current;
          const src = engine?.getViewport(srcId);
          const dst = engine?.getViewport(dstId);
          const voi = src?.getProperties?.()?.voiRange;
          if (voi && dst) { dst.setProperties({ voiRange: voi }); dst.render?.(); }
        } catch (_) { /* ignore */ } finally { syncGuardRef.current = false; }
      };
      const onCamera = () => {
        if (!syncSliceRef.current || syncGuardRef.current) return;
        syncGuardRef.current = true;
        try {
          const engine = engineRef.current;
          const src = engine?.getViewport(srcId);
          const dst = engine?.getViewport(dstId);
          const sc = src?.getCamera?.();
          const dc = dst?.getCamera?.();
          if (sc?.focalPoint && dc?.focalPoint && dc?.viewPlaneNormal) {
            const n = dc.viewPlaneNormal;
            const d =
              (sc.focalPoint[0] - dc.focalPoint[0]) * n[0] +
              (sc.focalPoint[1] - dc.focalPoint[1]) * n[1] +
              (sc.focalPoint[2] - dc.focalPoint[2]) * n[2];
            if (Math.abs(d) > 0.01) {
              dst.setCamera({
                focalPoint: [dc.focalPoint[0] + n[0] * d, dc.focalPoint[1] + n[1] * d, dc.focalPoint[2] + n[2] * d],
                position: [dc.position[0] + n[0] * d, dc.position[1] + n[1] * d, dc.position[2] + n[2] * d],
              });
              dst.render?.();
            }
          }
        } catch (_) { /* ignore */ } finally { syncGuardRef.current = false; }
      };
      if (Events.VOI_MODIFIED) {
        el.addEventListener(Events.VOI_MODIFIED, onVoi);
        cleanupFns.push(() => el.removeEventListener(Events.VOI_MODIFIED, onVoi));
      }
      if (Events.CAMERA_MODIFIED) {
        el.addEventListener(Events.CAMERA_MODIFIED, onCamera);
        cleanupFns.push(() => el.removeEventListener(Events.CAMERA_MODIFIED, onCamera));
      }
    });
  }, [csRef]);

  const applyPresetToVol3d = useCallback((p) => {
    try {
      const vp = engineRef.current?.getViewport(CVP.VOL3D);
      if (!vp) return;
      const pre = PRESETS[p?.id] || PRESETS.front;
      const vol = getCurrentVolume?.();
      const center = vol ? volCenterWorld(vol) : (vp.getCamera()?.focalPoint || [0, 0, 0]);
      const dist = Math.max(150, (vol ? volDiagMm(vol) : 300) * 1.2);
      vp.setCamera({
        position: [center[0] + pre.dir[0] * dist, center[1] + pre.dir[1] * dist, center[2] + pre.dir[2] * dist],
        focalPoint: center,
        viewUp: pre.up,
      });
      vp.render?.();
    } catch (_) { /* ignore */ }
  }, [getCurrentVolume]);

  // ── effect: (re)build the compare rendering engine for the active layout ──
  useEffect(() => {
    const cs = csRef.current;
    if (!cs) return undefined;
    const wantDual = selKind === 'self' || selKind === 'cbct';
    const want3d = selKind === 'mesh' && meshSub === 'side';
    if (!wantDual && !want3d) return undefined;
    const currentVolumeId = getCurrentVolumeId?.();
    if (!currentVolumeId) return undefined;

    let disposed = false;
    const cleanupFns = [];
    const { core } = cs;

    (async () => {
      try {
        try { cs.tools?.ToolGroupManager?.destroyToolGroup(COMPARE_TOOLGROUP_ID); } catch (_) { /* none */ }
        try { engineRef.current?.destroy(); } catch (_) { /* none */ }
        const engine = new core.RenderingEngine(COMPARE_ENGINE_ID);
        engineRef.current = engine;
        const { ViewportType, OrientationAxis } = core.Enums;
        const orientationAxis = OrientationAxis?.[orientation.toUpperCase()] ?? OrientationAxis?.AXIAL;

        if (wantDual) {
          if (!leftRef.current || !rightRef.current) return;
          engine.setViewports([
            { viewportId: CVP.LEFT, type: ViewportType.ORTHOGRAPHIC, element: leftRef.current,
              defaultOptions: { orientation: orientationAxis, background: [0, 0, 0] } },
            { viewportId: CVP.RIGHT, type: ViewportType.ORTHOGRAPHIC, element: rightRef.current,
              defaultOptions: { orientation: orientationAxis, background: [0, 0, 0] } },
          ]);
          const rightVolumeId = selKind === 'self' ? currentVolumeId : secondVol.volumeId;
          await core.setVolumesForViewports(engine, [{ volumeId: currentVolumeId }], [CVP.LEFT]);
          if (rightVolumeId) await core.setVolumesForViewports(engine, [{ volumeId: rightVolumeId }], [CVP.RIGHT]);
          if (disposed) return;
          [[CVP.LEFT, currentVolumeId], [CVP.RIGHT, rightVolumeId]].forEach(([vpId, volId]) => {
            if (!volId) return;
            try {
              const range = computeScalarRangeFromData(getVolumeScalarData(core.cache?.getVolume?.(volId)));
              if (range) engine.getViewport(vpId)?.setProperties({ voiRange: range });
            } catch (_) { /* keep defaults */ }
          });
          setupCompareTools(cs, [CVP.LEFT, CVP.RIGHT], '2d');
          attachSyncListeners(cleanupFns);
          engine.renderViewports([CVP.LEFT, CVP.RIGHT]);
        } else if (want3d) {
          if (!left3dRef.current) return;
          engine.setViewports([
            { viewportId: CVP.VOL3D, type: ViewportType.VOLUME_3D, element: left3dRef.current,
              defaultOptions: { orientation: OrientationAxis?.CORONAL, background: [0, 0, 0] } },
          ]);
          await core.setVolumesForViewports(engine, [{ volumeId: currentVolumeId }], [CVP.VOL3D]);
          if (disposed) return;
          try { engine.getViewport(CVP.VOL3D)?.setProperties({ preset: 'CT-Bone' }); } catch (_) { /* MPR-style default */ }
          setupCompareTools(cs, [CVP.VOL3D], '3d');
          engine.renderViewports([CVP.VOL3D]);
          applyPresetToVol3d(preset);
        }
      } catch (e) {
        console.error('[CompareMode] viewport setup failed:', e);
      }
    })();

    const onResize = () => { try { engineRef.current?.resize(true, true); } catch (_) { /* ignore */ } };
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      cleanupFns.forEach((fn) => { try { fn(); } catch (_) { /* ignore */ } });
      try { cs.tools?.ToolGroupManager?.destroyToolGroup(COMPARE_TOOLGROUP_ID); } catch (_) { /* ignore */ }
      try { engineRef.current?.destroy(); } catch (_) { /* ignore */ }
      engineRef.current = null;
    };
    // applyPresetToVol3d/preset intentionally excluded — presets apply via
    // their own effect; rebuilding the engine on every preset click would
    // discard the user's zoom/pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKind, meshSub, secondVol.volumeId, orientation, csRef, getCurrentVolumeId, setupCompareTools, attachSyncListeners]);

  // Apply orientation presets to the cornerstone 3D pane when clicked.
  useEffect(() => {
    if (selKind === 'mesh' && meshSub === 'side') applyPresetToVol3d(preset);
  }, [preset, selKind, meshSub, applyPresetToVol3d]);

  // Leaving CBCT-vs-CBCT (back to self, or to a mesh study) removes the second
  // viewport — release the compared volume(s) now rather than holding them
  // until unmount. Runs AFTER the engine effect above rebuilt/tore down the
  // viewports for the new layout (effect bodies run once all cleanups have).
  useEffect(() => {
    if (selKind === 'cbct') return;
    decacheCompareVolumes();
  }, [selKind, decacheCompareVolumes]);

  // Unmount: release every COMPARE_ volume this mount cached. Declared after
  // the engine effect so this cleanup runs after the engine is destroyed —
  // same teardown order (disable viewports → decache) as CBCTVolumeViewer.
  useEffect(() => () => { decacheCompareVolumes(); }, [decacheCompareVolumes]);

  // ── effect: mesh files of the selected intraoral-scan study ───────────────
  useEffect(() => {
    if (selKind !== 'mesh' || !selectedId) return undefined;
    let off = false;
    setMeshFiles({ status: 'loading', files: [], error: null });
    setMeshInfo(null);
    setXform(null);
    xformInitRef.current = null;
    setVisibleSet(null);
    manualTouchedRef.current = false;
    setReg({ busy: false, msg: '', rms: null, method: null, dirty: false, savedAt: null });
    (async () => {
      try {
        const files = await fetchMeshStudyFiles(supabase, selectedId);
        if (off) return;
        setMeshFiles({ status: files.length ? 'ready' : 'empty', files, error: null });
      } catch (e) {
        if (!off) setMeshFiles({ status: 'error', files: [], error: e?.message || 'Failed to load scan files' });
      }
    })();
    return () => { off = true; };
  }, [selKind, selectedId]);

  // ── effect: load a previously saved registration for this pair ────────────
  useEffect(() => {
    if (selKind !== 'mesh' || !studyId || !selectedId) return undefined;
    let off = false;
    setSavedMatrix(undefined);
    (async () => {
      try {
        const { data } = await supabase
          .from('imaging_studies').select('viewer_annotations').eq('id', studyId).single();
        if (off) return;
        const entry = getMeshRegistration(data?.viewer_annotations, selectedId);
        setSavedMatrix(entry ? entry.matrix : null);
        if (entry) {
          setReg((r) => ({ ...r, savedAt: entry.updated_at, method: entry.method || null, rms: entry.rms_mm ?? null }));
        }
      } catch (_) { if (!off) setSavedMatrix(null); }
    })();
    return () => { off = true; };
  }, [selKind, studyId, selectedId]);

  // ── effect: build the overlay's CBCT backdrop planes (once per mount) ─────
  // NOTE: must not depend on planesState itself (setting 'building' would
  // cancel the in-flight build). Guarded by a ref + the component-level
  // mounted flag instead.
  const planesRequestedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => {
    if (selKind !== 'mesh' || meshSub !== 'overlay' || planesRequestedRef.current) return;
    planesRequestedRef.current = true;
    setPlanesState({ status: 'building', list: null, error: null });
    (async () => {
      await new Promise((r) => setTimeout(r, 30)); // let the busy state paint
      if (!mountedRef.current) return;
      try {
        const vol = getCurrentVolume?.();
        if (!vol) throw new Error('CBCT volume not loaded yet');
        const range = computeScalarRangeFromData(vol.scalarData) || { lower: 0, upper: 1 };
        const mk = (id, label, img) => ({
          id, label, width: img.width, height: img.height, corners: img.corners,
          rgba: windowImageToRgba(img, range.lower, range.upper),
        });
        const list = [
          mk('axial', 'Axial MIP (dentition)', extractAxialMipPlane(vol)),
          mk('coronal', 'Coronal', extractMidSlicePlane(vol, 'coronal')),
          mk('sagittal', 'Sagittal', extractMidSlicePlane(vol, 'sagittal')),
        ];
        if (mountedRef.current) setPlanesState({ status: 'ready', list, error: null });
      } catch (e) {
        // Allow a retry on the next overlay activation (e.g. volume not loaded yet).
        planesRequestedRef.current = false;
        if (mountedRef.current) setPlanesState({ status: 'error', list: null, error: e?.message || 'Could not build CBCT backdrop' });
      }
    })();
  }, [selKind, meshSub, getCurrentVolume]);

  // World-space framing of the overlay scene.
  const overlay = useMemo(() => {
    const vol = getCurrentVolume?.();
    if (!vol) return { center: [0, 0, 0], diag: 250 };
    const axial = planesState.list?.find((p) => p.id === 'axial');
    if (axial) {
      const c = axial.corners;
      return {
        center: [
          (c[0][0] + c[2][0]) / 2,
          (c[0][1] + c[2][1]) / 2,
          (c[0][2] + c[2][2]) / 2,
        ],
        diag: volDiagMm(vol),
      };
    }
    return { center: volCenterWorld(vol), diag: volDiagMm(vol) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planesState.list]);

  // Initial transform for the current pair: the saved registration when one
  // exists, otherwise drop the mesh at the CBCT centre (identity rotation,
  // unit scale). Shared by the init effect and the Reset control.
  const computeInitialXform = useCallback(() => {
    if (!meshInfo) return null;
    const c = meshInfo.centroid;
    if (savedMatrix) {
      // saved matrix maps RAW mesh coords → world; the controlled group pivots
      // at the mesh centroid: outer = M · T(+centroid).
      return mat4Decompose(mat4Multiply(savedMatrix, mat4Translation(c)));
    }
    return { position: overlay.center.slice(), quaternion: [0, 0, 0, 1], scale: 1 };
  }, [meshInfo, savedMatrix, overlay.center]);

  // ── effect: initialize the mesh transform (saved matrix > centroid drop) ──
  useEffect(() => {
    if (selKind !== 'mesh' || !meshInfo || savedMatrix === undefined) return;
    if (xformInitRef.current === selectedId) return;
    setXform(computeInitialXform());
    xformInitRef.current = selectedId;
  }, [selKind, meshInfo, savedMatrix, selectedId, computeInitialXform]);

  // ── manual alignment controls ──────────────────────────────────────────────
  const markDirty = useCallback(() => {
    manualTouchedRef.current = true;
    setReg((r) => (r.dirty ? r : { ...r, dirty: true }));
  }, []);

  const nudge = useCallback((axisIdx, deltaMm) => {
    setXform((x) => {
      if (!x) return x;
      const position = x.position.slice();
      position[axisIdx] += deltaMm;
      return { ...x, position };
    });
    markDirty();
  }, [markDirty]);

  const rotateBy = useCallback((axisVec, deg) => {
    setXform((x) => {
      if (!x) return x;
      return { ...x, quaternion: quatMultiply(quatFromAxisAngle(axisVec, (deg * Math.PI) / 180), x.quaternion) };
    });
    markDirty();
  }, [markDirty]);

  const scaleBy = useCallback((factor) => {
    if (scaleLocked) return;
    setXform((x) => (x ? { ...x, scale: Math.max(0.5, Math.min(2, x.scale * factor)) } : x));
    markDirty();
  }, [scaleLocked, markDirty]);

  const onGizmoXform = useCallback((next) => {
    setXform((x) => ({
      ...next,
      // Uniform-scale lock: the gizmo only runs translate/rotate, but guard anyway.
      scale: scaleLocked ? (x?.scale ?? 1) : next.scale,
    }));
    markDirty();
  }, [scaleLocked, markDirty]);

  const resetXform = useCallback(() => {
    // Recompute the initial transform DIRECTLY. The old implementation nulled
    // xformInitRef and set xform to null, expecting the init effect to re-run —
    // but a ref mutation doesn't re-trigger an effect whose deps are unchanged,
    // so Reset stranded the overlay on a null transform instead of restoring
    // the saved registration / initial drop.
    const next = savedMatrix !== undefined ? computeInitialXform() : null;
    if (next) {
      setXform(next);
      xformInitRef.current = selectedId;
    } else {
      // Mesh info / saved matrix still loading — let the init effect place it.
      xformInitRef.current = null;
      setXform(null);
    }
    setReg((r) => ({ ...r, dirty: false, msg: 'Alignment reset.' }));
    manualTouchedRef.current = false;
  }, [computeInitialXform, savedMatrix, selectedId]);

  // ── Auto-align (beta): PCA init + trimmed ICP, chunked between frames ─────
  // Deliberately NOT routed through cbctCompute.worker: the ICP session
  // already yields to the event loop between iterations (the clouds are
  // downsampled + grid-matched, each step is a few ms), the one-shot CBCT
  // surface sampling is bounded (~6k points), and the mesh vertices live as
  // plain JS number[][] whose structured-clone cost into a worker would rival
  // the compute itself — not the clean, low-risk move the worker refactor
  // requires. Revisit if the ICP budget grows (flatten points to Float32Array
  // first).
  const autoAlign = useCallback(async () => {
    if (reg.busy || !meshInfo) return;
    setReg((r) => ({ ...r, busy: true, msg: 'Sampling CBCT bone/enamel surface near the arch…' }));
    await new Promise((r) => setTimeout(r, 30));
    try {
      const vol = getCurrentVolume?.();
      if (!vol) throw new Error('CBCT volume not loaded yet');
      const { points: volPts } = sampleDentitionSurfacePoints(vol, { maxPoints: 6000 });
      const names = (meshInfo.componentNames || []).filter((n) => !visibleSet || visibleSet.has(n));
      const meshPts = names.flatMap((n) => meshInfo.componentPoints?.[n] || []);
      if (meshPts.length < 50) throw new Error('Not enough mesh points (are all components hidden?)');
      const session = createIcpSession(meshPts, volPts, { maxIterations: 30, sampleSize: 2500, dstSampleSize: 6000 });
      let s = session.step();
      while (!s.done) {
        setReg((r) => ({ ...r, msg: `ICP (beta) — iteration ${s.iteration}, RMS ${s.rms.toFixed(2)} mm…` }));
        // Yield between iterations so the UI stays responsive (clouds are
        // downsampled + grid-matched, so each step is a few ms).
        await new Promise((r) => setTimeout(r, 0));
        s = session.step();
      }
      const res = session.result();
      setXform(mat4Decompose(mat4Multiply(res.matrix, mat4Translation(meshInfo.centroid))));
      manualTouchedRef.current = false;
      setReg((r) => ({
        ...r, busy: false, dirty: true, method: 'auto_icp_beta', rms: res.rms,
        msg: `Auto-align (beta) done — RMS ${res.rms.toFixed(2)} mm over ${res.srcCount} pts. Verify visually and fine-tune manually.`,
      }));
    } catch (e) {
      console.error('[CompareMode] auto-align failed:', e);
      setReg((r) => ({ ...r, busy: false, msg: 'Auto-align failed: ' + (e?.message || 'error') }));
    }
  }, [reg.busy, meshInfo, visibleSet, getCurrentVolume]);

  // ── persist the registration on the CBCT study row ────────────────────────
  const saveRegistration = useCallback(async () => {
    if (!studyId || !selectedId || !xform || !meshInfo) return;
    try {
      const c = meshInfo.centroid;
      const outer = mat4Compose(xform.position, xform.quaternion, xform.scale);
      // Stored matrix maps RAW mesh-local coords → patient world:
      // M = outer · T(−centroid).
      const matrix = mat4Multiply(outer, mat4Translation([-c[0], -c[1], -c[2]]));
      const method = reg.method === 'auto_icp_beta'
        ? (manualTouchedRef.current ? 'auto_icp_beta+manual' : 'auto_icp_beta')
        : 'manual';
      const entry = makeRegistrationEntry({
        matrix, method, rmsMm: reg.rms,
        source: { mesh_study_id: selectedId, mesh_points: Object.values(meshInfo.componentPoints || {}).reduce((a, p) => a + p.length, 0) },
      });
      const { data: row } = await supabase
        .from('imaging_studies').select('viewer_annotations').eq('id', studyId).single();
      const merged = upsertMeshRegistration(row?.viewer_annotations, selectedId, entry);
      const { error } = await supabase
        .from('imaging_studies')
        .update({ viewer_annotations: merged, viewer_annotations_updated_at: new Date().toISOString() })
        .eq('id', studyId);
      if (error) throw error;
      setSavedMatrix(entry.matrix);
      setReg((r) => ({ ...r, dirty: false, savedAt: entry.updated_at, msg: 'Alignment saved to the study.' }));
    } catch (e) {
      setReg((r) => ({ ...r, msg: 'Save failed: ' + (e?.message || 'error') }));
    }
  }, [studyId, selectedId, xform, meshInfo, reg.method, reg.rms]);

  const captureOverlay = useCallback(() => {
    try {
      const url = captureRef.current?.();
      if (url) onCapture?.(url, 'CBCT_mesh_overlay');
    } catch (_) { /* ignore */ }
  }, [onCapture]);

  const toggleComponent = useCallback((name) => {
    setVisibleSet((prev) => {
      const all = new Set(meshInfo?.componentNames || []);
      const next = new Set(prev || all);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, [meshInfo]);

  const applyPreset = useCallback((id) => setPreset((p) => ({ id, seq: (p?.seq || 0) + 1 })), []);

  const Spinner = ({ note }) => (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10">
      <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
      {note && <span className="mt-2 text-xs text-neutral-300">{note}</span>}
    </div>
  );

  const presetButtons = (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-neutral-500 mr-0.5">View:</span>
      {Object.entries(PRESETS).map(([id, p]) => (
        <SmallBtn key={id} title={`${p.label} view (both panes)`} active={preset.id === id} onClick={() => applyPreset(id)}>
          {p.label}
        </SmallBtn>
      ))}
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-neutral-950">
      <ComparePicker
        studies={siblings}
        currentStudyId={studyId}
        selectedId={selectedId}
        onSelect={onSelect}
        loading={siblingLoading}
      >
        {(selKind === 'self' || selKind === 'cbct') && (
          <div className="flex items-center gap-2 ml-auto">
            <select
              value={orientation}
              onChange={(e) => setOrientation(e.target.value)}
              aria-label="Slice orientation"
              className="text-[11px] bg-neutral-800 text-neutral-200 rounded px-1.5 py-1 border border-neutral-700"
              title="Slice orientation (both panes)"
            >
              <option value="axial">Axial</option>
              <option value="coronal">Coronal</option>
              <option value="sagittal">Sagittal</option>
            </select>
            <label className="flex items-center gap-1 text-[11px] text-neutral-300 cursor-pointer">
              <input type="checkbox" checked={syncWL} onChange={(e) => setSyncWL(e.target.checked)} /> Sync W/L
            </label>
            <label className="flex items-center gap-1 text-[11px] text-neutral-300 cursor-pointer">
              <input type="checkbox" checked={syncSlice} onChange={(e) => setSyncSlice(e.target.checked)} /> Sync slice
            </label>
          </div>
        )}
        {selKind === 'mesh' && (
          <div className="flex items-center gap-2 ml-auto">
            <div className="flex items-center rounded-md overflow-hidden border border-neutral-700">
              <button
                type="button"
                onClick={() => setMeshSub('side')}
                className={`px-2 py-1 text-[11px] flex items-center gap-1 ${meshSub === 'side' ? 'bg-amber-500 text-black' : 'bg-neutral-800 text-neutral-300'}`}
              >
                <Columns2 className="h-3 w-3" /> Side by side
              </button>
              <button
                type="button"
                onClick={() => setMeshSub('overlay')}
                className={`px-2 py-1 text-[11px] flex items-center gap-1 ${meshSub === 'overlay' ? 'bg-amber-500 text-black' : 'bg-neutral-800 text-neutral-300'}`}
              >
                <Layers className="h-3 w-3" /> Overlay
              </button>
            </div>
            {presetButtons}
          </div>
        )}
      </ComparePicker>

      <div className="flex-1 min-h-0 relative">
        {selKind === 'pending' && <Spinner note="Loading study list…" />}

        {/* ── CBCT vs CBCT (or same-study dual viewport) ── */}
        {(selKind === 'self' || selKind === 'cbct') && (
          <div className="absolute inset-0 grid grid-cols-2 gap-px bg-neutral-800">
            <div className="relative bg-black overflow-hidden">
              <div ref={leftRef} className="w-full h-full" onContextMenu={(e) => e.preventDefault()} />
              <span className="absolute top-2 left-3 text-xs font-semibold text-amber-400 pointer-events-none">
                CURRENT · {currentLabel}
              </span>
            </div>
            <div className="relative bg-black overflow-hidden">
              <div ref={rightRef} className="w-full h-full" onContextMenu={(e) => e.preventDefault()} />
              <span className="absolute top-2 left-3 text-xs font-semibold text-sky-300 pointer-events-none">
                {selKind === 'self' ? 'SAME STUDY' : (selected?.label || 'SELECTED STUDY')}
              </span>
              {selKind === 'cbct' && secondVol.status === 'loading' && <Spinner note="Preparing second study…" />}
              {selKind === 'cbct' && secondVol.status === 'ready' && secondVol.progress < 100 && (
                <span className="absolute bottom-2 right-3 text-[10px] text-amber-300 bg-black/70 rounded px-1.5 py-0.5">
                  streaming… {secondVol.progress}%
                </span>
              )}
              {selKind === 'cbct' && secondVol.status === 'error' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10 px-6 text-center">
                  <span className="text-xs text-red-300">Could not load the selected study: {secondVol.error}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── CBCT vs mesh — side by side ── */}
        {selKind === 'mesh' && meshSub === 'side' && (
          <div className="absolute inset-0 grid grid-cols-2 gap-px bg-neutral-800">
            <div className="relative bg-black overflow-hidden">
              <div ref={left3dRef} className="w-full h-full" onContextMenu={(e) => e.preventDefault()} />
              <span className="absolute top-2 left-3 text-xs font-semibold text-amber-400 pointer-events-none">
                CBCT 3D · {currentLabel}
              </span>
            </div>
            <div className="relative bg-black overflow-hidden">
              {meshFiles.status === 'ready' && (
                <Suspense fallback={<Spinner note="Loading 3D viewer…" />}>
                  <MeshSidePane
                    files={meshFiles.files}
                    preset={preset}
                    visibleSet={visibleSet}
                    onInfo={setMeshInfo}
                    onToggleComponent={toggleComponent}
                  />
                </Suspense>
              )}
              {meshFiles.status === 'loading' && <Spinner note="Loading scan files…" />}
              {meshFiles.status === 'empty' && (
                <EmptyState title="No mesh files" body="This study has no STL/PLY/OBJ files to display." />
              )}
              {meshFiles.status === 'error' && (
                <EmptyState title="Scan failed to load" body={meshFiles.error} />
              )}
              <span className="absolute top-2 left-3 text-xs font-semibold text-sky-300 pointer-events-none">
                3D SCAN · {selected?.label || ''}
              </span>
            </div>
          </div>
        )}

        {/* ── CBCT + mesh — overlay / registration ── */}
        {selKind === 'mesh' && meshSub === 'overlay' && (
          <div className="absolute inset-0 flex">
            <div className="flex-1 relative min-w-0 bg-black">
              {planesState.status === 'ready' && meshFiles.status === 'ready' ? (
                <Suspense fallback={<Spinner note="Loading overlay…" />}>
                  <MeshOverlayPane
                    files={meshFiles.files}
                    planes={planesState.list}
                    planeVis={planeVis}
                    xform={xform}
                    onXformChange={onGizmoXform}
                    meshOpacity={meshOpacity}
                    gizmo={gizmo}
                    visibleSet={visibleSet}
                    onInfo={setMeshInfo}
                    captureRef={captureRef}
                    preset={preset}
                    volumeCenter={overlay.center}
                    volumeDiag={overlay.diag}
                  />
                </Suspense>
              ) : planesState.status === 'error' ? (
                <EmptyState title="Overlay unavailable" body={planesState.error} />
              ) : meshFiles.status === 'error' ? (
                <EmptyState title="Scan failed to load" body={meshFiles.error} />
              ) : meshFiles.status === 'empty' ? (
                <EmptyState title="No mesh files" body="This study has no STL/PLY/OBJ files to overlay." />
              ) : (
                <Spinner note="Building CBCT backdrop…" />
              )}
              <span className="absolute top-2 left-3 text-[10px] uppercase tracking-wider text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-2 py-0.5 pointer-events-none">
                Overlay · registration beta — verify alignment before clinical use
              </span>
            </div>

            {/* Alignment controls */}
            <aside className="w-72 shrink-0 bg-neutral-900 border-l border-neutral-800 overflow-y-auto p-3 space-y-4 text-neutral-200">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">Auto-align</div>
                <button
                  type="button"
                  onClick={autoAlign}
                  disabled={reg.busy || !meshInfo || planesState.status !== 'ready'}
                  className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md bg-amber-500 text-black text-xs font-semibold disabled:opacity-40 hover:bg-amber-400"
                >
                  {reg.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                  Auto-align (beta)
                </button>
                <p className="text-[10px] text-neutral-500 mt-1">
                  Coarse PCA init + ICP against bone/enamel surface points near the dental arch. Always verify and fine-tune.
                </p>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">Translate (mm)</div>
                <div className="space-y-1">
                  {[['X', 0], ['Y', 1], ['Z', 2]].map(([label, axis]) => (
                    <ControlRow key={label} label={label}>
                      <SmallBtn onClick={() => nudge(axis, -5)}>−5</SmallBtn>
                      <SmallBtn onClick={() => nudge(axis, -0.5)}>−0.5</SmallBtn>
                      <SmallBtn onClick={() => nudge(axis, 0.5)}>+0.5</SmallBtn>
                      <SmallBtn onClick={() => nudge(axis, 5)}>+5</SmallBtn>
                    </ControlRow>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">Rotate (°, about mesh centre)</div>
                <div className="space-y-1">
                  {[['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]]].map(([label, axisVec]) => (
                    <ControlRow key={label} label={label}>
                      <SmallBtn onClick={() => rotateBy(axisVec, -10)}>−10</SmallBtn>
                      <SmallBtn onClick={() => rotateBy(axisVec, -1)}>−1</SmallBtn>
                      <SmallBtn onClick={() => rotateBy(axisVec, 1)}>+1</SmallBtn>
                      <SmallBtn onClick={() => rotateBy(axisVec, 10)}>+10</SmallBtn>
                    </ControlRow>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">Drag gizmo</div>
                <div className="flex items-center gap-1">
                  <SmallBtn active={gizmo.enabled && gizmo.mode === 'translate'} onClick={() => setGizmo((g) => ({ enabled: !(g.enabled && g.mode === 'translate'), mode: 'translate' }))}>
                    Move
                  </SmallBtn>
                  <SmallBtn active={gizmo.enabled && gizmo.mode === 'rotate'} onClick={() => setGizmo((g) => ({ enabled: !(g.enabled && g.mode === 'rotate'), mode: 'rotate' }))}>
                    Rotate
                  </SmallBtn>
                  {gizmo.enabled && <span className="text-[10px] text-neutral-500">drag the gizmo in the scene</span>}
                </div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">Scale (uniform)</div>
                <div className="flex items-center gap-1.5">
                  <SmallBtn title={scaleLocked ? 'Unlock uniform scale (intraoral scans are true-scale; leave locked unless the export is off)' : 'Lock scale at current value'} onClick={() => setScaleLocked((v) => !v)}>
                    {scaleLocked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                  </SmallBtn>
                  <SmallBtn disabled={scaleLocked} onClick={() => scaleBy(1 / 1.01)}>−1%</SmallBtn>
                  <SmallBtn disabled={scaleLocked} onClick={() => scaleBy(1.01)}>+1%</SmallBtn>
                  <span className="text-[11px] text-neutral-400">×{(xform?.scale ?? 1).toFixed(3)}</span>
                </div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">Mesh opacity</div>
                <input
                  type="range" min="10" max="100" step="5"
                  value={Math.round(meshOpacity * 100)}
                  onChange={(e) => setMeshOpacity(Number(e.target.value) / 100)}
                  className="w-full accent-amber-500"
                  aria-label="Mesh opacity"
                />
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">CBCT planes</div>
                <div className="space-y-1">
                  {(planesState.list || []).map((p) => (
                    <label key={p.id} className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={planeVis[p.id] !== false}
                        onChange={() => setPlaneVis((v) => ({ ...v, [p.id]: !(v[p.id] !== false) }))}
                      />
                      {p.label}
                    </label>
                  ))}
                </div>
              </div>

              {meshInfo?.componentNames?.length > 1 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">Scan components</div>
                  <div className="space-y-1">
                    {meshInfo.componentNames.map((name) => (
                      <label key={name} className="flex items-center gap-1.5 text-[11px] text-neutral-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!visibleSet || visibleSet.has(name)}
                          onChange={() => toggleComponent(name)}
                        />
                        {meshInfo.componentLabels?.[name] || name}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-1.5 pt-1 border-t border-neutral-800">
                <button
                  type="button"
                  onClick={saveRegistration}
                  disabled={!xform || !meshInfo || reg.busy}
                  className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold disabled:opacity-40 hover:bg-emerald-500"
                >
                  <Save className="h-3.5 w-3.5" /> Save alignment{reg.dirty ? ' *' : ''}
                </button>
                <div className="flex items-center gap-1.5">
                  <SmallBtn title="Reset to the saved alignment (or the initial drop)" onClick={resetXform}>
                    <RotateCcw className="h-3 w-3" />
                  </SmallBtn>
                  <SmallBtn title="Capture the fused view into the Gallery" onClick={captureOverlay}>
                    <Camera className="h-3 w-3" />
                  </SmallBtn>
                  {reg.savedAt && (
                    <span className="text-[10px] text-neutral-500 truncate">
                      saved {new Date(reg.savedAt).toLocaleString()}
                    </span>
                  )}
                </div>
                {reg.msg && <p className="text-[10px] text-amber-300 leading-snug">{reg.msg}</p>}
                {Number.isFinite(reg.rms) && (
                  <p className="text-[10px] text-neutral-400">Last ICP RMS: {Number(reg.rms).toFixed(2)} mm ({reg.method || 'manual'})</p>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
