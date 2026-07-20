/*
 * useCbctTools — wires the CBCT viewer's interaction layer:
 *   tool selection, W/L presets, slice HUD, display toggles (invert /
 *   reference lines / slab MIP), keyboard shortcuts, implant placement,
 *   nerve + arch click capture, pano / cross-section canvas rendering,
 *   the measurements list, and annotation save / restore.
 *
 * Extracted from CBCTViewerPage.jsx during the A0 monolith split — every
 * effect keeps its original dependency list so behavior is unchanged.
 */
import { useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { supabase } from '../lib/supabase';
import { cornerstone, cornerstoneTools } from '../lib/cornerstoneInit';
import {
  renderCrossSection,
  renderArchPano,
  getVolumeScalarData,
  densifyArch,
} from '../lib/archPano';
import {
  safeVolumeAttr,
  getPrimaryTools,
  setActivePrimaryTool,
  resetAllViewports,
  clearAllAnnotations,
  setupCbctToolGroupsForMode,
} from '../components/cbct/cbctEngine';
import {
  VIEW_MODES,
  MPR_VIEWPORT_IDS,
  TOOL_GROUP_MPR_ID,
  TOOL_GROUP_3D_ID,
  CROSSSEC_COUNT,
} from '../components/cbct/cbctViewModes';
import {
  CBCT_HOTKEY_MAP, SHARED_HOTKEYS,
} from '../components/viewer/viewerToolConfig';

export function useCbctTools({
  // volume
  stage,
  enginRef,
  cachedVolumeRef,
  cachedVolumeIdRef,
  axialRef,
  coronalRef,
  sagittalRef,
  vrRef,
  // view
  viewMode,
  setViewMode,
  invert,
  setInvert,
  showRefLines,
  slabThickness,
  // tools / presets
  activeTool,
  setActiveTool,
  presetTable,
  activePreset,
  setActivePreset,
  // hud / annotations
  setSliceHud,
  setAnnotations,
  // arch
  archPoints,
  setArchPoints,
  archSlabMM,
  setArchSlabMM,
  tracingArch,
  // cross-sections / pano
  xsWidthMM,
  xsCanvasRefs,
  panoCanvasRef,
  setPanoRenderError,
  // nerve
  nervePoints,
  setNervePoints,
  safetyZoneMM,
  setSafetyZoneMM,
  tracingNerve,
  // implants
  implants,
  setImplants,
  placingImplant,
  setPlacingImplant,
  pendingApex,
  setPendingApex,
  // persistence
  studyId,
  readOnly,
  sharePayload,
}) {
  const applyPreset = useCallback((preset) => {
    const engine = enginRef.current;
    if (!engine) return;
    for (const id of MPR_VIEWPORT_IDS) {
      // Non-MPR view modes (ceph/pano/crosssec/tmj) tear these viewports
      // down — applying a preset there must not throw.
      const vp = engine.getViewport(id);
      if (!vp) continue;
      vp.setProperties({ voiRange: { lower: preset.wc - preset.ww / 2, upper: preset.wc + preset.ww / 2 } });
    }
    engine.render();
    setActivePreset(preset.name);
  }, [enginRef, setActivePreset]);

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
    const toolName = getPrimaryTools()[toolKey];
    if (!toolName) return;
    setActiveTool(toolKey);
    setActivePrimaryTool(toolName);
  }, [setActiveTool]);

  const handleResetViews = useCallback(() => {
    resetAllViewports(enginRef.current);
  }, [enginRef]);

  const handleClearMeasurements = useCallback(() => {
    clearAllAnnotations();
    setAnnotations([]);
  }, [setAnnotations]);

  // ── Persist annotations ─────────────────────────────────────────────
  // Save the current Cornerstone annotation state as JSON on the
  // imaging_studies row. The shape is whatever cornerstoneTools.annotation
  // .state.getAllAnnotations() returns — we don't transform it, so a
  // future viewer can rehydrate exactly. RLS is already in place on
  // imaging_studies so this respects clinic scoping.
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
      toast.success(`Saved ${serialized.length} measurement${serialized.length === 1 ? '' : 's'} + plan data`);
    } catch (e) {
      console.warn('[cbct] save annotations failed:', e?.message);
      toast.error(`Save failed: ${e?.message || e}`);
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
  // viewport set (using the cached volume — no reload).
  const switchViewMode = useCallback(async (modeKey) => {
    // W7 (audit #9): the fake Implant mode was merged into MPR + 3D.
    // Alias legacy mode keys (saved frames from a live co-viewing
    // operator on an older build) so they land on the merged mode.
    const key = modeKey === 'implant' ? 'mpr-3d' : modeKey;
    const cfg = VIEW_MODES[key];
    if (!cfg) return;
    const engine = enginRef.current;
    const volume = cachedVolumeRef.current;
    const volumeId = cachedVolumeIdRef.current;
    if (!engine || !volume || !volumeId) return;
    setViewMode(key);
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
  // Tool hotkeys come from the shared viewerToolConfig (W9) so the CBCT
  // and DICOM viewers can't drift.
  useEffect(() => {
    if (stage !== 'ready') return;
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const toolKey = CBCT_HOTKEY_MAP[e.key];
      if (toolKey) { selectTool(toolKey); e.preventDefault(); return; }
      if (e.key.toLowerCase() === SHARED_HOTKEYS.reset) { handleResetViews(); e.preventDefault(); return; }
      if (e.key.toLowerCase() === SHARED_HOTKEYS.invert) { setInvert((v) => !v); e.preventDefault(); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage]);

  // ── Phase 3.4 Implant placement ────────────────────────────────────
  // When placingImplant is set (catalog entry chosen / tool-strip toggle
  // armed), the next two clicks on an MPR viewport define apex then head.
  // W7 (audit #9): plain LEFT-CLICK places while armed (mirrors arch
  // tracing); Shift+Click still works as a quick-add. After head, the
  // implant is committed to `implants[]` and placingImplant resets.
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
        if (e.button !== 0) return;
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
  // Nerve click capture mirrors arch tracing (W7, audit #9): while the
  // "Trace nerve" toggle is armed, plain LEFT-CLICK on ANY MPR viewport
  // captures a 3D world point and appends to nervePoints; Shift+Click
  // quick-adds regardless of the toggle. Renders as a green polyline +
  // safety zone in each MPR overlay.
  useEffect(() => {
    if (stage !== 'ready') return;
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
        if (e.button !== 0) return;
        if (!tracingNerve && !e.shiftKey) return;
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

  return {
    selectTool,
    applyPreset,
    switchViewMode,
    handleResetViews,
    handleClearMeasurements,
    handleSaveMeasurements,
  };
}
