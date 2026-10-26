/*
 * cornerstoneInit — one-time Cornerstone3D 4.x bootstrap.
 *
 * Cornerstone3D 4.x ships the streaming volume loader inside @cornerstonejs/core
 * (no separate package), and @cornerstonejs/dicom-image-loader 4.x has its own
 * `init()` that handles WASM codec setup automatically. Net result vs 1.x:
 * less boilerplate, no more SAB/transfer races on the volume path.
 *
 * Call this once at the top of any page that uses a RenderingEngine. Repeat
 * calls are no-ops thanks to the `initialized` guard.
 */

import { init as csInit, imageLoader, volumeLoader, Enums, RenderingEngine, getRenderingEngine, metaData, eventTarget, cache, utilities as csUtilities, setVolumesForViewports } from '@cornerstonejs/core';
import {
  init as toolsInit,
  addTool,
  ToolGroupManager,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  TrackballRotateTool,
  CrosshairsTool,
  // Phase 1 measurement tools — Cornerstone3D ships these natively
  LengthTool,
  AngleTool,
  BidirectionalTool,
  ProbeTool,
  // Phase 2 region-of-interest tools (mean/min/max/stddev HU readout)
  RectangleROITool,
  CircleROITool,
  EllipticalROITool,
  Enums as toolsEnums,
  utilities as toolsUtilities,
  synchronizers as toolsSynchronizers,
  SynchronizerManager,
  annotation as toolsAnnotation,
} from '@cornerstonejs/tools';
import { init as dicomImageLoaderInit, wadouri, wadors } from '@cornerstonejs/dicom-image-loader';

import { installDicomInflater } from './dicomInflation';

let initialized = false;

export async function initCornerstone() {
  if (initialized) return;

  // Core init — registers the default streaming-image volume loader, sets up
  // GPU detection, allocates the rendering engine cache.
  installDicomInflater();
  await csInit();
  // Tools init — required before adding any tools to a tool group.
  await toolsInit();
  // dicom-image-loader init — sets up the WASM codec workers (libjpeg-turbo,
  // charls/JPEG-LS, openjpeg/JPEG-2000) and registers them with cornerstone.
  // In 4.x this also handles SAB / non-SAB modes transparently.
  await dicomImageLoaderInit();

  // Register the wadouri / wadors schemes so cornerstone can dispatch
  // to dicom-image-loader for our pre-signed Supabase storage URLs.
  imageLoader.registerImageLoader('wadouri', wadouri.loadImage);
  imageLoader.registerImageLoader('wadors', wadors.loadImage);

  initialized = true;
}

/**
 * Build a wadouri: imageId from a signed Supabase storage URL. Cornerstone's
 * dicom-image-loader prefixes the URL with the scheme to dispatch to the
 * right loader.
 */
export function imageIdFromSignedUrl(signedUrl) {
  return `wadouri:${signedUrl}`;
}

// Re-export the bits the viewer pages need so they don't have to know about
// the underlying package layout (or worry about the v1 -> v4 migration).
export const cornerstone = {
  Enums,
  RenderingEngine,
  getRenderingEngine,
  imageLoader,
  volumeLoader,
  metaData,
  eventTarget,
  cache,
  utilities: csUtilities,
  setVolumesForViewports,
};

export const cornerstoneTools = {
  addTool,
  ToolGroupManager,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,           // v4 rename: was StackScrollMouseWheelTool
  TrackballRotateTool,
  CrosshairsTool,             // v4 ships synchronized MPR crosshairs
  // Phase 1 measurement tools
  LengthTool,
  AngleTool,
  BidirectionalTool,
  ProbeTool,
  // Phase 2 ROI tools
  RectangleROITool,
  CircleROITool,
  EllipticalROITool,
  Enums: toolsEnums,
  utilities: toolsUtilities,
  synchronizers: toolsSynchronizers,  // VOI / camera / image-slice sync
  SynchronizerManager,
  annotation: toolsAnnotation,        // annotation manager (read/write/clear)
};

// ── kyour viewer stack ───────────────────────────────────────────────────────
// kyour's CBCT viewer (src/components/viewers, shared with kyour-ai) initialises
// cornerstone through ensureCornerstone(), which also registers the NIfTI loader and the
// streaming volume loader. Only one of the two inits runs on a page.
let _modules = null;
let _initPromise = null;

export async function ensureCornerstone() {
  if (_modules) return _modules;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const core = await import('@cornerstonejs/core');
    const tools = await import('@cornerstonejs/tools');
    const dicomImageLoader = await import('@cornerstonejs/dicom-image-loader');

    await core.init();
    tools.init();
    // v4 loader init: configures web workers + registers wadouri loader and
    // the metadata provider with core. Default worker count is fine.
    dicomImageLoader.init();

    // NIfTI volume loader — lets the CBCT viewer load the server-converted
    // .nii.gz (clean baked geometry, no DICOM slice-stripe artifacts) instead
    // of streaming the raw DICOM stack. Optional: on failure the viewer falls
    // back to wadouri DICOM. createNiftiImageIdsAndCacheMetadata({ url })
    // returns imageIds that feed the SAME streaming volume loader below.
    let niftiLoader = null;
    try {
      niftiLoader = await import('@cornerstonejs/nifti-volume-loader');
      if (typeof niftiLoader.init === 'function') niftiLoader.init();
      // The package's init() only stashes options — it does NOT register any
      // loader. createNiftiImageIdsAndCacheMetadata() mints imageIds with the
      // `nifti:` scheme (`nifti:<url>?frame=N`); without an image loader bound
      // to that scheme the streaming volume errors with
      // "No image loader found for scheme 'nifti'". Register the package's
      // per-frame image loader so the volume can fetch its slices.
      if (niftiLoader.cornerstoneNiftiImageLoader) {
        core.imageLoader.registerImageLoader('nifti', niftiLoader.cornerstoneNiftiImageLoader);
      }
    } catch (e) {
      console.warn('[cornerstoneInit] NIfTI loader unavailable:', e?.message);
    }

    // Register the streaming volume loader so createAndCacheVolume can build
    // a volume from a wadouri image stack (CBCT MPR).
    try {
      core.volumeLoader.registerVolumeLoader(
        'cornerstoneStreamingImageVolume',
        core.cornerstoneStreamingImageVolumeLoader
      );
      core.volumeLoader.registerUnknownVolumeLoader(
        core.cornerstoneStreamingImageVolumeLoader
      );
    } catch (_) {
      /* already registered */
    }

    // Register the tools we use across viewers (idempotent — wrapped).
    const {
      addTool, CrosshairsTool, WindowLevelTool, ZoomTool, PanTool,
      StackScrollTool, LengthTool, TrackballRotateTool, SplineROITool,
    } = tools;
    [CrosshairsTool, WindowLevelTool, ZoomTool, PanTool, StackScrollTool, LengthTool, TrackballRotateTool, SplineROITool]
      .forEach((Tool) => { try { if (Tool) addTool(Tool); } catch (_) { /* already added */ } });

    _modules = { core, tools, dicomImageLoader, niftiLoader };
    return _modules;
  })();

  return _initPromise;
}
