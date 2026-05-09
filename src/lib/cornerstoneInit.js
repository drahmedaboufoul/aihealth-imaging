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
import * as streamingVolumeLoader from '@cornerstonejs/streaming-image-volume-loader';
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
  //
  // useWebWorkers: false — main-thread decode. The web-worker decode path
  // in @cornerstonejs/dicom-image-loader 1.77 has a known race when paired
  // with the streaming volume loader + SAB: the worker transfers its
  // decoded ArrayBuffer back to main, then the volume loader tries to
  // re-transfer it to a second worker, hitting:
  //   DataCloneError: An ArrayBuffer is detached and could not be cloned
  // Disabling workers does mean a 400-slice CBCT decode runs on the main
  // thread (~5-10s of UI jank). Acceptable for clinical use; the proper
  // fix is upstream in cornerstone — track in the dicom-image-loader 2.x
  // upgrade path.
  dicomImageLoader.configure({
    useWebWorkers: false,
    decodeConfig: {
      convertFloatPixelDataToInt: false,
      use16BitDataType: true,
    },
    beforeSend: (xhr) => {
      // Signed Supabase URLs are pre-authenticated; nothing extra to add.
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

  // Register the streaming image volume loader for CBCT/CT volume rendering.
  // This wraps the regular image loader, decoding slices into a 3D voxel
  // buffer that Cornerstone's volume viewports can sample for MPR + VR.
  cornerstone.volumeLoader.registerVolumeLoader(
    'cornerstoneStreamingImageVolume',
    streamingVolumeLoader.cornerstoneStreamingImageVolumeLoader,
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
