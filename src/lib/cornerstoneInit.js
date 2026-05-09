/*
 * cornerstoneInit — one-time Cornerstone3D + dicom-image-loader bootstrap.
 *
 * Cornerstone3D's `init` is global state. Call this once at the top of any
 * page that uses a RenderingEngine + StackViewport. Repeat calls are no-ops
 * thanks to the `initialized` guard.
 *
 * Why we need it: the V1 dicom-parser-based viewer can't decode compressed
 * pixel data (JPEG 2000 Lossless = transfer syntax 1.2.840.10008.1.2.4.90,
 * which is what our CBCT machine emits). Cornerstone's dicom-image-loader
 * bundles WASM codecs for libjpeg-turbo, charls (JPEG-LS), openjpeg
 * (JPEG-2000), and CharLS — that handles every transfer syntax we'll see
 * in clinical practice.
 */

import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import dicomParser from 'dicom-parser';

let initialized = false;

export async function initCornerstone() {
  if (initialized) return;

  await cornerstone.init();
  await cornerstoneTools.init();

  // Wire dicom-image-loader's externals.
  dicomImageLoader.external.cornerstone = cornerstone;
  dicomImageLoader.external.dicomParser = dicomParser;

  // Configure image loader. The WASM decoders are bundled with the loader
  // and lazy-loaded on first use of a compressed transfer syntax.
  dicomImageLoader.configure({
    useWebWorkers: true,
    decodeConfig: {
      convertFloatPixelDataToInt: false,
      use16BitDataType: true,
    },
    beforeSend: (xhr) => {
      // Signed Supabase URLs are pre-authenticated; nothing extra to add.
    },
  });

  // Web worker pool — keep it small to avoid spawning more than the browser
  // can handle on lower-end machines.
  const maxWebWorkers = Math.max(1, Math.min(navigator.hardwareConcurrency || 1, 4));
  dicomImageLoader.webWorkerManager.initialize({
    maxWebWorkers,
    startWebWorkersOnDemand: true,
    taskConfiguration: {
      decodeTask: {
        initializeCodecsOnStartup: false,
        strict: false,
      },
    },
  });

  // Register image loader scheme. dicom-image-loader handles wadouri: and
  // wadors: schemes; we'll use wadouri: with our pre-signed Supabase URLs.
  cornerstone.imageLoader.registerImageLoader(
    'wadouri',
    dicomImageLoader.wadouri.loadImage,
  );
  cornerstone.imageLoader.registerImageLoader(
    'wadors',
    dicomImageLoader.wadors.loadImage,
  );

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

export { cornerstone, cornerstoneTools, dicomImageLoader };
