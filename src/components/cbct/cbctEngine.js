/*
 * cbctEngine — pure Cornerstone3D engine helpers for the CBCT viewer:
 * volume loading (NIfTI fast path + DICOM streaming fallback), tool-group
 * setup, window/level presets, and viewport utilities.
 *
 * Extracted from CBCTViewerPage.jsx during the A0 monolith split — pure
 * move, no behavior change. No React imports here; the hooks layer
 * (hooks/useCbctVolume.js) drives these from component lifecycle.
 *
 * W9 (audit finding #28, FIXED): the DICOM streaming path previously set
 * up its tool groups inline (a SUBSET of the tools the NIfTI path
 * registered) and never populated cachedVolumeRef — so view-mode
 * switching and the pano/cross-section renderers silently no-oped on
 * that path. It now caches the volume exactly like the NIfTI path and
 * both paths share setupCbctToolGroups() (which registers the full tool
 * set, including the Phase-2 ROI tools).
 */

import { loadNiftiVolume } from '../../lib/niftiLoader';
import { cornerstone, cornerstoneTools, imageIdFromSignedUrl } from '../../lib/cornerstoneInit';
import {
  RENDERING_ENGINE_ID,
  TOOL_GROUP_MPR_ID,
  TOOL_GROUP_3D_ID,
  VOI_SYNC_ID,
  VOLUME_PRESETS_HU,
  VIEWPORTS,
  MPR_VIEWPORT_IDS,
  DEFAULT_REF_LINE_COLOR,
} from './cbctViewModes';

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
export function safeVolumeAttr(volume, key) {
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
export function readVolumeDataRange(volume) {
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
export function rawPresetsForRange(range) {
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
export async function renderFromNifti({
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
 * DICOM streaming fallback renderer. Pre-loads every instance (mandatory
 * for correct slice ordering), groups imageIds into coherent series,
 * sorts by ImagePositionPatient projected onto the scan axis, builds one
 * volume from the winning series, then wires engine + viewports + tools.
 *
 * Extracted verbatim from the CBCTViewerPage init effect — see the KNOWN
 * DRIFT note at the top of this file.
 */
export async function renderFromDicomStack({
  dicomFiles,
  volumeId,
  elements,
  setProgress,
  setPresetTable,
  cancelledRef,
  engineRef,
  cachedVolumeRef,
  cachedVolumeIdRef,
}) {
  const imageIds = dicomFiles.map((f) => imageIdFromSignedUrl(f.url));

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
  if (cancelledRef()) return;

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
  if (cancelledRef()) return;
  // W9 bugfix: cache for view-mode rebuilds — without this, switching
  // view modes (and the pano/cross-section canvas renderers) silently
  // no-oped on the DICOM streaming path while working on the NIfTI path.
  if (cachedVolumeRef) cachedVolumeRef.current = volume;
  if (cachedVolumeIdRef) cachedVolumeIdRef.current = volumeId;

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
  if (cancelledRef()) return;

  // Inspect the volume's actual data range so we can pick the correct
  // window. CBCT scanners often skip the modality LUT, so pixel values
  // arrive as raw 12-bit (0–4095ish) rather than HU (-1000–3000). The
  // wrong default makes everything blow out white.
  const dataRange = readVolumeDataRange(volume);
  const isHU = dataRange ? (dataRange.min < -200) : true;
  const presets = isHU ? VOLUME_PRESETS_HU : rawPresetsForRange(dataRange);
  if (!cancelledRef()) setPresetTable(presets);
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

  // Tool groups — shared with the NIfTI path (W9): registers the FULL
  // tool set (W/L, pan, zoom, scroll, crosshairs, Length/Angle/
  // Bidirectional/Probe, ROI tools) + the VOI synchronizer, binds
  // Crosshairs to Primary, W/L to Secondary, Pan to middle, scroll to
  // wheel — identical interaction on both load paths.
  setupCbctToolGroups(engine);

  engine.render();
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
export function initPrimaryToolMap() {
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

/** Read the current primary-tool map (key → Cornerstone toolName). */
export function getPrimaryTools() {
  return PRIMARY_TOOLS;
}

/**
 * Build the MPR + 3D tool groups + VOI synchronizer. Shared between the
 * NIfTI fast path and the DICOM streaming fallback so both render with
 * identical interaction.
 */
export function setupCbctToolGroups(engine) {
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
    // Phase 2 region tools — density readout (HU stats over a region).
    // Registered here too so the INITIAL load (either path) has the same
    // tool set a mode switch installs via setupCbctToolGroupsForMode.
    cornerstoneTools.RectangleROITool,
    cornerstoneTools.CircleROITool,
    cornerstoneTools.EllipticalROITool,
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
      return v?.color || DEFAULT_REF_LINE_COLOR;
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
export function setupCbctToolGroupsForMode(engine, modeCfg) {
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
      return v?.color || DEFAULT_REF_LINE_COLOR;
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
export function setActivePrimaryTool(toolName) {
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
export function resetAllViewports(engine) {
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
export function clearAllAnnotations() {
  try {
    cornerstoneTools.annotation?.state?.removeAllAnnotations?.();
  } catch (e) {
    console.warn('[cbct] clearAllAnnotations failed:', e?.message);
  }
  // Trigger a re-render so the cleared annotations actually disappear
  const engine = cornerstone.getRenderingEngine(RENDERING_ENGINE_ID);
  engine?.render();
}
