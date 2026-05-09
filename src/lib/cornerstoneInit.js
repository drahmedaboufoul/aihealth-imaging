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
import { init as toolsInit, addTool, ToolGroupManager, WindowLevelTool, PanTool, ZoomTool, StackScrollTool, TrackballRotateTool, CrosshairsTool, Enums as toolsEnums, utilities as toolsUtilities } from '@cornerstonejs/tools';
import { init as dicomImageLoaderInit, wadouri, wadors } from '@cornerstonejs/dicom-image-loader';

let initialized = false;

export async function initCornerstone() {
  if (initialized) return;

  // Core init — registers the default streaming-image volume loader, sets up
  // GPU detection, allocates the rendering engine cache.
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
  Enums: toolsEnums,
  utilities: toolsUtilities,
};
