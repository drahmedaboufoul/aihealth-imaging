/*
 * niftiLoader — fetch a server-converted .nii.gz, parse it, and return
 * the bits Cornerstone3D needs to register a local volume.
 *
 * Architecture A path. When a CBCT study has nifti_storage_path set, the
 * EMR has already preprocessed the DICOM stack (server-side, with pydicom
 * + dicom2nifti) into a single NIfTI file with explicit geometry baked
 * into the header. We just download, parse, and hand the voxel buffer to
 * Cornerstone — no IPP guesswork, no scanner-quirk landmines.
 *
 * The browser-side DICOM streaming path stays as a fallback for studies
 * that haven't been converted yet (or for which conversion failed).
 */

import * as nifti from 'nifti-reader-js';
import { inflate } from 'pako';

/**
 * Download a .nii.gz from a signed Supabase URL, ungzip it, and parse the
 * NIfTI structure. Returns { typedArray, dimensions, spacing, origin,
 * direction, voxelType }.
 *
 * @param {string} signedUrl — pre-signed Supabase storage URL
 * @returns {Promise<{
 *   scalarData: Float32Array | Int16Array | Uint16Array | Uint8Array,
 *   dimensions: [number, number, number],
 *   spacing: [number, number, number],
 *   origin: [number, number, number],
 *   direction: number[],            // 9-element row-major (vtk convention)
 *   metadata: object,                // raw header for debugging
 * }>}
 */
export async function loadNiftiVolume(signedUrl) {
  const resp = await fetch(signedUrl);
  if (!resp.ok) {
    throw new Error(`NIfTI fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const compressed = new Uint8Array(await resp.arrayBuffer());

  // .nii.gz is gzipped; .nii is raw. Detect by gzip magic bytes.
  const isGz = compressed.length >= 2 && compressed[0] === 0x1f && compressed[1] === 0x8b;
  const raw = isGz ? inflate(compressed) : compressed;
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

  if (!nifti.isNIFTI(buf)) {
    throw new Error('Downloaded file is not a NIfTI volume');
  }

  const header = nifti.readHeader(buf);
  const imageBuf = nifti.readImage(header, buf);
  const typedArray = decodePixelData(header, imageBuf);

  // dims[0] is the number of dimensions; dims[1..3] are X, Y, Z.
  const [, dimX, dimY, dimZ] = header.dims;
  // pixDims[1..3] are voxel size in mm.
  const [, pxX, pxY, pxZ] = header.pixDims;

  // NIfTI's qform/sform encodes orientation as a 4×4 affine. We extract
  // the 3×3 rotation/scale block. vtk wants direction as a 9-element
  // column-major matrix, but cornerstone v4 createLocalVolume takes
  // row-major. We flatten in row-major.
  const direction = directionFromAffine(header);
  const origin = [
    header.affine?.[0]?.[3] ?? 0,
    header.affine?.[1]?.[3] ?? 0,
    header.affine?.[2]?.[3] ?? 0,
  ];

  return {
    scalarData: typedArray,
    dimensions: [dimX, dimY, dimZ],
    spacing: [Math.abs(pxX), Math.abs(pxY), Math.abs(pxZ)],
    origin,
    direction,
    metadata: {
      datatypeCode: header.datatypeCode,
      bitsPerVoxel: header.numBitsPerVoxel,
      sliceCount: dimZ,
      qformCode: header.qform_code,
      sformCode: header.sform_code,
      cal_min: header.cal_min,
      cal_max: header.cal_max,
      // Many CBCT scanners ship without rescale slope/intercept — NIfTI
      // preserves the raw integer values, no HU conversion. Tell the
      // caller so it can pick the right W/L preset.
      scl_slope: header.scl_slope,
      scl_inter: header.scl_inter,
    },
  };
}

/**
 * Convert the raw image buffer to a typed array matching the NIfTI
 * datatype code. We standardise to Float32 for the streaming volume
 * loader's sake (handles signed/unsigned/scaled uniformly downstream).
 */
function decodePixelData(header, imageBuf) {
  const code = header.datatypeCode;
  const slope = header.scl_slope || 1;
  const inter = header.scl_inter || 0;
  // nifti-reader-js datatype constants
  const NIFTI = nifti.NIFTI1;

  let view;
  switch (code) {
    case NIFTI.TYPE_UINT8:
      view = new Uint8Array(imageBuf);
      break;
    case NIFTI.TYPE_INT16:
      view = new Int16Array(imageBuf);
      break;
    case NIFTI.TYPE_INT32:
      view = new Int32Array(imageBuf);
      break;
    case NIFTI.TYPE_FLOAT32:
      view = new Float32Array(imageBuf);
      break;
    case NIFTI.TYPE_FLOAT64:
      view = new Float64Array(imageBuf);
      break;
    case NIFTI.TYPE_INT8:
      view = new Int8Array(imageBuf);
      break;
    case NIFTI.TYPE_UINT16:
      view = new Uint16Array(imageBuf);
      break;
    case NIFTI.TYPE_UINT32:
      view = new Uint32Array(imageBuf);
      break;
    default:
      throw new Error(`Unsupported NIfTI datatype: ${code}`);
  }

  // If there's a rescale slope/intercept, apply it to land in HU-ish
  // values where applicable. Otherwise return the underlying typed
  // array as-is (Cornerstone handles non-HU just fine via voiRange).
  if (slope !== 1 || inter !== 0) {
    const out = new Float32Array(view.length);
    for (let i = 0; i < view.length; i++) {
      out[i] = view[i] * slope + inter;
    }
    return out;
  }
  // Cornerstone's volume loader prefers Int16 / Uint16 / Float32 — for
  // Int32/Uint32/Float64 we down-convert. Otherwise pass through.
  if (code === NIFTI.TYPE_INT32 || code === NIFTI.TYPE_UINT32 || code === NIFTI.TYPE_FLOAT64) {
    const out = new Float32Array(view.length);
    for (let i = 0; i < view.length; i++) out[i] = view[i];
    return out;
  }
  return view;
}

/**
 * Extract a 9-element row-major direction matrix from the NIfTI header.
 * Prefer the sform (more general); fall back to qform; fall back to
 * identity if neither is set (headerless raw NIfTI).
 */
function directionFromAffine(header) {
  // header.affine is set by nifti-reader-js when sform/qform is valid.
  const A = header.affine;
  if (Array.isArray(A) && A.length >= 3) {
    // affine is 4×4. The rotation/scale block is the upper-left 3×3.
    // Normalise each column by its voxel size to get unit direction
    // vectors.
    const sx = Math.hypot(A[0][0], A[1][0], A[2][0]) || 1;
    const sy = Math.hypot(A[0][1], A[1][1], A[2][1]) || 1;
    const sz = Math.hypot(A[0][2], A[1][2], A[2][2]) || 1;
    return [
      A[0][0] / sx, A[0][1] / sy, A[0][2] / sz,
      A[1][0] / sx, A[1][1] / sy, A[1][2] / sz,
      A[2][0] / sx, A[2][1] / sy, A[2][2] / sz,
    ];
  }
  // Identity as last resort.
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}
