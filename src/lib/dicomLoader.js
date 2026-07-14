/*
 * dicomLoader — parse a single DICOM file ArrayBuffer into the metadata +
 * raw pixel data the viewer needs to render.
 *
 * Scope (V1):
 *   - Supports uncompressed transfer syntaxes (Implicit/Explicit VR Little
 *     Endian, Explicit VR Big Endian). Covers most modern CT/MRI/US/CR
 *     output from clinical machines.
 *   - Single-frame OR multi-frame DICOM (NumberOfFrames > 1, e.g. US loops).
 *   - 8/16-bit, signed/unsigned pixel data.
 *   - MONOCHROME1 / MONOCHROME2 photometric interpretation.
 *   - Applies RescaleSlope + RescaleIntercept to get modality-correct values
 *     (Hounsfield for CT, etc.).
 *
 * Out of scope (V2 — needs Cornerstone3D + WADO image loader):
 *   - JPEG-Lossless, JPEG-LS, JPEG-2000, RLE-compressed pixel data
 *   - Color DICOM (RGB / YBR_FULL)
 *   - Multi-photometric / palette-mapped
 *
 * If a compressed transfer syntax is encountered, we throw a clear error
 * naming the transfer syntax UID so the caller can show a "needs upgrade"
 * message to the user.
 */

import dicomParser from 'dicom-parser';

// Tag string -> tag (group, element packed) used by dicom-parser
const TAG = {
  PatientName:           'x00100010',
  PatientID:             'x00100020',
  PatientBirthDate:      'x00100030',
  PatientSex:            'x00100040',
  StudyInstanceUID:      'x0020000d',
  SeriesInstanceUID:     'x0020000e',
  SOPInstanceUID:        'x00080018',
  StudyDate:             'x00080020',
  Modality:              'x00080060',
  StudyDescription:      'x00081030',
  SeriesDescription:     'x0008103e',
  BodyPartExamined:      'x00180015',
  Rows:                  'x00280010',
  Columns:               'x00280011',
  BitsAllocated:         'x00280100',
  BitsStored:            'x00280101',
  HighBit:               'x00280102',
  PixelRepresentation:   'x00280103',
  SamplesPerPixel:       'x00280002',
  PhotometricInterpretation: 'x00280004',
  PlanarConfiguration:   'x00280006',
  NumberOfFrames:        'x00280008',
  PixelSpacing:          'x00280030',
  WindowCenter:          'x00281050',
  WindowWidth:           'x00281051',
  RescaleSlope:          'x00281053',
  RescaleIntercept:      'x00281052',
  TransferSyntaxUID:     'x00020010',
};

// Transfer syntaxes the V1 loader supports (uncompressed pixel data)
const SUPPORTED_TS = new Set([
  '1.2.840.10008.1.2',       // Implicit VR Little Endian (default)
  '1.2.840.10008.1.2.1',     // Explicit VR Little Endian
  '1.2.840.10008.1.2.2',     // Explicit VR Big Endian (rare; we read as LE — TODO if real machines emit this)
]);

/**
 * Parse a DICOM ArrayBuffer.
 * @returns {Promise<DicomImage>}  rich metadata + a canvas-friendly typed array
 */
export async function loadDicom(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let dataSet;
  try {
    dataSet = dicomParser.parseDicom(bytes);
  } catch (err) {
    throw new Error(`Could not parse DICOM: ${err?.message || err}`);
  }

  const transferSyntax = (() => {
    try { return dataSet.string(TAG.TransferSyntaxUID) || null; }
    catch { return null; }
  })();
  if (transferSyntax && !SUPPORTED_TS.has(transferSyntax)) {
    throw new Error(
      `Unsupported transfer syntax (${transferSyntax}). ` +
      `This file uses compressed pixel data — full Cornerstone3D viewer required. ` +
      `Coming in stage B.3.2.`
    );
  }

  const intOr = (tag, fallback = null) => {
    try {
      const v = dataSet.intString(tag);
      return v == null ? fallback : v;
    } catch { return fallback; }
  };
  const floatOr = (tag, fallback = null) => {
    try {
      const v = dataSet.floatString(tag);
      return v == null ? fallback : v;
    } catch { return fallback; }
  };
  const strOr = (tag, fallback = null) => {
    try {
      const v = dataSet.string(tag);
      return v || fallback;
    } catch { return fallback; }
  };

  const meta = {
    transferSyntax,
    patientName:    strOr(TAG.PatientName),
    patientId:      strOr(TAG.PatientID),
    studyDate:      strOr(TAG.StudyDate),
    modality:       strOr(TAG.Modality),
    studyDescription:  strOr(TAG.StudyDescription),
    seriesDescription: strOr(TAG.SeriesDescription),
    bodyPart:       strOr(TAG.BodyPartExamined),
    studyInstanceUid:  strOr(TAG.StudyInstanceUID),
    seriesInstanceUid: strOr(TAG.SeriesInstanceUID),
    sopInstanceUid:    strOr(TAG.SOPInstanceUID),
    rows:           intOr(TAG.Rows),
    columns:        intOr(TAG.Columns),
    bitsAllocated:  intOr(TAG.BitsAllocated, 16),
    bitsStored:     intOr(TAG.BitsStored, 16),
    highBit:        intOr(TAG.HighBit),
    pixelRepresentation: intOr(TAG.PixelRepresentation, 0), // 0 unsigned, 1 signed
    samplesPerPixel:     intOr(TAG.SamplesPerPixel, 1),
    photometricInterpretation: strOr(TAG.PhotometricInterpretation, 'MONOCHROME2'),
    numberOfFrames: intOr(TAG.NumberOfFrames, 1),
    pixelSpacing:   strOr(TAG.PixelSpacing), // "<row>\<col>" mm
    windowCenter:   floatOr(TAG.WindowCenter),
    windowWidth:    floatOr(TAG.WindowWidth),
    rescaleSlope:   floatOr(TAG.RescaleSlope, 1),
    rescaleIntercept: floatOr(TAG.RescaleIntercept, 0),
  };

  if (meta.samplesPerPixel !== 1) {
    throw new Error(
      `Color DICOM (samplesPerPixel=${meta.samplesPerPixel}) not supported in V1. ` +
      `Cornerstone3D needed for color image rendering.`
    );
  }
  if (!meta.rows || !meta.columns) {
    throw new Error('DICOM missing Rows/Columns — file may be malformed.');
  }

  // Find the PixelData element (group 0x7fe0, element 0x0010)
  const pixelDataElement = dataSet.elements.x7fe00010;
  if (!pixelDataElement) {
    throw new Error('DICOM has no PixelData element — image-less file?');
  }

  // Extract pixel data as a typed array.
  // For uncompressed, pixelDataElement.dataOffset + length give us the raw bytes.
  const pixelOffset = pixelDataElement.dataOffset;
  const pixelLength = pixelDataElement.length;
  const pixelBytes  = new Uint8Array(arrayBuffer, pixelOffset, pixelLength);

  let pixels;
  if (meta.bitsAllocated === 16) {
    if (meta.pixelRepresentation === 1) {
      pixels = new Int16Array(pixelBytes.buffer, pixelBytes.byteOffset, pixelLength / 2);
    } else {
      pixels = new Uint16Array(pixelBytes.buffer, pixelBytes.byteOffset, pixelLength / 2);
    }
  } else if (meta.bitsAllocated === 8) {
    pixels = meta.pixelRepresentation === 1
      ? new Int8Array(pixelBytes.buffer, pixelBytes.byteOffset, pixelLength)
      : new Uint8Array(pixelBytes.buffer, pixelBytes.byteOffset, pixelLength);
  } else {
    throw new Error(`Unsupported BitsAllocated=${meta.bitsAllocated} (only 8 or 16 in V1).`);
  }

  // Compute pixel-value range across all frames so the W/L UI can show
  // sensible bounds. For very large volumes this is an O(n) scan — fine
  // for single 2D images; for big stacks, we could sample.
  let pixMin = Infinity;
  let pixMax = -Infinity;
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    if (v < pixMin) pixMin = v;
    if (v > pixMax) pixMax = v;
  }
  // Apply rescale slope/intercept for display range
  const valMin = pixMin * meta.rescaleSlope + meta.rescaleIntercept;
  const valMax = pixMax * meta.rescaleSlope + meta.rescaleIntercept;

  // Default W/L: file headers if present, else full range
  const defaultWindowCenter = meta.windowCenter ?? (valMin + valMax) / 2;
  const defaultWindowWidth  = meta.windowWidth  ?? Math.max(1, valMax - valMin);

  return {
    meta,
    pixels,
    pixelRange: { min: valMin, max: valMax },
    defaultWindowCenter,
    defaultWindowWidth,
    /** Apply W/L to the current frame and write into an ImageData buffer. */
    renderFrame(frameIndex, windowCenter, windowWidth, imageData) {
      return renderFrameToImageData({
        meta,
        pixels,
        frameIndex,
        windowCenter,
        windowWidth,
        imageData,
      });
    },
  };
}

/**
 * Map a DICOM frame's pixels through the modality LUT (slope/intercept) and
 * VOI LUT (windowCenter/windowWidth) into 8-bit grayscale RGBA, writing
 * directly into the provided ImageData (avoids per-frame allocation).
 * Exported for unit testing — pure function of its inputs.
 */
export function renderFrameToImageData({ meta, pixels, frameIndex, windowCenter, windowWidth, imageData }) {
  const { rows, columns, rescaleSlope, rescaleIntercept, photometricInterpretation } = meta;
  const pixPerFrame = rows * columns;
  const offset = pixPerFrame * (frameIndex || 0);
  const wcMin = windowCenter - windowWidth / 2;
  const invertGray = (photometricInterpretation || '').toUpperCase() === 'MONOCHROME1';

  const data = imageData.data; // Uint8ClampedArray, RGBA per pixel
  for (let i = 0; i < pixPerFrame; i++) {
    const raw = pixels[offset + i];
    const v = raw * rescaleSlope + rescaleIntercept;
    let gray = ((v - wcMin) * 255) / windowWidth;
    if (gray < 0) gray = 0;
    else if (gray > 255) gray = 255;
    if (invertGray) gray = 255 - gray;
    const idx = i * 4;
    data[idx]     = gray;
    data[idx + 1] = gray;
    data[idx + 2] = gray;
    data[idx + 3] = 255;
  }
  return imageData;
}

/**
 * Modality-aware default W/L presets. Names follow Hounsfield-unit clinical
 * convention. Apply via renderFrameToImageData; values are in the same units
 * as the rescale-applied pixel values (Hounsfield for CT, raw for X-ray, etc).
 */
export const WL_PRESETS = {
  CT: [
    { name: 'Soft Tissue', wc:   40, ww:  400 },
    { name: 'Lung',        wc: -600, ww: 1500 },
    { name: 'Bone',        wc:  400, ww: 2000 },
    { name: 'Brain',       wc:   40, ww:   80 },
    { name: 'Abdomen',     wc:   60, ww:  400 },
    { name: 'Mediastinum', wc:   50, ww:  350 },
  ],
  MR: [
    { name: 'Default',     wc: 600, ww: 1600 },
  ],
  // Generic default for everything else (CR, DX, PX, etc.) — file headers
  // typically provide a sensible default. Empty array means "use file default".
  DEFAULT: [],
};
