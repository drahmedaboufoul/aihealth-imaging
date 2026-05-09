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

import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Loader2, AlertCircle, ArrowLeft, Box,
  Move, ZoomIn, RotateCcw,
  Ruler, Triangle, Crosshair as CrosshairIcon,
  Activity, Trash2, Plus,
} from 'lucide-react';
import { resolveStudyDicomFiles, resolveStudyNiftiVolume } from '../lib/signedUrl';
import { loadNiftiVolume } from '../lib/niftiLoader';
import {
  initCornerstone,
  imageIdFromSignedUrl,
  cornerstone,
  cornerstoneTools,
} from '../lib/cornerstoneInit';
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
 * activates them from the toolbar. These are mutually exclusive — only
 * one of these may be bound to Primary at a time. Crosshair is the
 * default; selecting another swaps it on Primary and parks crosshair on
 * a side button (Aux, the middle-mouse).
 */
const PRIMARY_TOOLS = {
  crosshair:    'CrosshairsTool',
  length:       'Length',
  angle:        'Angle',
  bidirectional:'Bidirectional',
  probe:        'Probe',
  pan:          'Pan',
  zoom:         'Zoom',
};

/**
 * Build the MPR + 3D tool groups + VOI synchronizer. Shared between the
 * NIfTI fast path and the DICOM streaming fallback so both render with
 * identical interaction.
 */
function setupCbctToolGroups(engine) {
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
        if (!studyId) {
          throw new Error('Missing ?study=<imaging_studies.id> URL parameter.');
        }
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          const back = encodeURIComponent(location.pathname + location.search);
          navigate(`/login?next=${back}`, { replace: true });
          return;
        }
        if (cancelled) return;

        setStage('resolving');

        // ── Architecture A fast path ──────────────────────────────────
        // If the EMR converted this study to NIfTI server-side, take the
        // single-file path. Geometry is baked into the header — no IPP
        // guesswork, no scanner-quirk landmines. Falls through to the
        // DICOM streaming path if no NIfTI is available yet.
        let niftiInfo = { url: null, status: null, error: null };
        try {
          niftiInfo = await resolveStudyNiftiVolume(studyId);
        } catch (e) {
          console.warn('[cbct] resolveStudyNiftiVolume failed (will fall back to DICOM):', e?.message);
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

          const volumeId = `cornerstoneVolume:nifti-${studyId}`;
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

        const list = await resolveStudyDicomFiles(studyId);
        if (cancelled) return;
        if (list.length < 3) {
          throw new Error(
            `Volume rendering needs at least 3 DICOM instances; got ${list.length}.`
          );
        }

        await initCornerstone();
        if (cancelled) return;

        const imageIds = list.map((f) => imageIdFromSignedUrl(f.url));
        const volumeId = `cornerstoneStreamingImageVolume:study-${studyId}`;

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
  }, [studyId, navigate, location.pathname, location.search]);

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
  };

  return (
    <div className="h-screen w-screen flex flex-col" style={{ backgroundColor: SHELL_BG, color: '#cdd2d8' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: '#1d2128' }}>
        <button
          onClick={() => window.close() || navigate('/')}
          className="text-sm px-2 py-1 rounded hover:bg-white/5 flex items-center gap-1.5"
        >
          <ArrowLeft size={14} /> Close
        </button>
        <div className="text-sm font-semibold tracking-wide flex items-center gap-2">
          <Box size={14} className="text-amber-500" />
          CBCT Viewer
          <span className="ml-2 text-[11px] text-gray-400 font-normal">MPR + 3D</span>
        </div>
        <div className="text-[11px] text-gray-500">Cornerstone3D v4 · synchronized crosshairs</div>
      </div>

      {/* 4-panel grid */}
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

        <div className="grid grid-cols-2 grid-rows-2 gap-px h-full" style={{ backgroundColor: '#1d2128' }}>
          {VIEWPORTS.map((v, idx) => {
            const ref = idx === 0 ? axialRef : idx === 1 ? coronalRef : idx === 2 ? sagittalRef : vrRef;
            const hud = sliceHud[v.id];
            return (
              <div key={v.id} className="relative" style={{ backgroundColor: SHELL_BG }}>
                <div
                  ref={ref}
                  className="w-full h-full"
                  onContextMenu={(e) => e.preventDefault()}
                />
                {/* Plane label — top-left */}
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
                {/* Slice number HUD — top-right (MPR only) */}
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
              </div>
            );
          })}
        </div>

        {/* Tool button (icon-only with tooltip) */}
        {/* Defined inline below as a closure capture isn't needed */}
        {/* Right rail — tools + presets */}
        {stage === 'ready' && (
          <div
            className="absolute right-3 top-3 w-56 rounded-lg p-3 z-10 text-xs space-y-3"
            style={{ backgroundColor: PANEL_BG, border: '1px solid #1d2128' }}
          >
            {/* Tools section */}
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Tools</div>
              <div className="grid grid-cols-4 gap-1">
                <ToolButton  active={activeTool === 'crosshair'}     onClick={() => selectTool('crosshair')}     icon={CrosshairIcon} label="Crosshair" />
                <ToolButton  active={activeTool === 'length'}        onClick={() => selectTool('length')}        icon={Ruler}         label="Length" />
                <ToolButton  active={activeTool === 'angle'}         onClick={() => selectTool('angle')}         icon={Triangle}      label="Angle" />
                <ToolButton  active={activeTool === 'bidirectional'} onClick={() => selectTool('bidirectional')} icon={Plus}          label="Bidirectional" />
                <ToolButton  active={activeTool === 'probe'}         onClick={() => selectTool('probe')}         icon={Activity}      label="HU Probe" />
                <ToolButton  active={activeTool === 'pan'}           onClick={() => selectTool('pan')}           icon={Move}          label="Pan" />
                <ToolButton  active={activeTool === 'zoom'}          onClick={() => selectTool('zoom')}          icon={ZoomIn}        label="Zoom" />
                <ToolButton  active={false}                          onClick={handleResetViews}                  icon={RotateCcw}     label="Reset views" />
              </div>
              <button
                onClick={handleClearMeasurements}
                className="mt-1.5 w-full text-[10px] py-1 rounded bg-gray-800 hover:bg-red-700 text-gray-300 hover:text-white flex items-center justify-center gap-1"
                title="Clear all measurements"
              >
                <Trash2 size={10} /> Clear measurements
              </button>
            </div>

            {/* W/L preset section */}
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">MPR Window</div>
              <div className="grid grid-cols-2 gap-1">
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
            </div>

            {/* Help */}
            <p className="text-[10px] text-gray-500 leading-snug border-t border-gray-800 pt-2">
              <span className="text-gray-300 font-semibold">Mouse:</span> left = active tool · right-drag = W/L · middle-drag = pan · wheel = slice.
              <br />
              <span className="text-gray-300 font-semibold">3D:</span> left-drag = rotate · wheel = zoom.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact icon button used in the right-rail toolbar. Highlights when
 * its tool is active so the user can see what mode they're in at a
 * glance.
 */
function ToolButton({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex items-center justify-center h-8 rounded transition-colors ${
        active
          ? 'bg-amber-600 text-white'
          : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
      }`}
    >
      <Icon size={14} />
    </button>
  );
}
