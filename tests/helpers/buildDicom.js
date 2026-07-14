/*
 * buildDicom — construct a minimal but valid DICOM Part 10 file in memory
 * (Explicit VR Little Endian) so dicomLoader can be tested without any
 * fixture binaries checked into the repo.
 */

const LONG_VRS = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);

function encodeElement(group, element, vr, valueBytes) {
  const headLen = LONG_VRS.has(vr) ? 12 : 8;
  const out = new Uint8Array(headLen + valueBytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, group, true);
  dv.setUint16(2, element, true);
  out[4] = vr.charCodeAt(0);
  out[5] = vr.charCodeAt(1);
  if (LONG_VRS.has(vr)) {
    dv.setUint16(6, 0, true);                    // reserved
    dv.setUint32(8, valueBytes.length, true);    // 4-byte length
  } else {
    dv.setUint16(6, valueBytes.length, true);    // 2-byte length
  }
  out.set(valueBytes, headLen);
  return out;
}

function strBytes(value, padChar = ' ') {
  let s = String(value);
  if (s.length % 2 === 1) s += padChar;
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function us(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

/**
 * Build a single-series DICOM file.
 *
 * @param {object} opts
 *   @param {string} opts.transferSyntax  default Explicit VR Little Endian
 *   @param {object} opts.tags            string overrides (patientName etc.)
 *   @param {number} opts.rows / opts.columns
 *   @param {number} opts.bitsAllocated   8 or 16 (or other, for error tests)
 *   @param {number} opts.pixelRepresentation  0 unsigned / 1 signed
 *   @param {number} opts.samplesPerPixel
 *   @param {number|null} opts.numberOfFrames
 *   @param {Int16Array|Uint16Array|Int8Array|Uint8Array|null} opts.pixels
 *   @param {boolean} opts.omitPixelData
 * @returns {ArrayBuffer}
 */
export function buildDicom(opts = {}) {
  const {
    transferSyntax = '1.2.840.10008.1.2.1',
    rows = 2,
    columns = 2,
    bitsAllocated = 16,
    pixelRepresentation = 0,
    samplesPerPixel = 1,
    numberOfFrames = null,
    photometricInterpretation = 'MONOCHROME2',
    windowCenter = null,
    windowWidth = null,
    rescaleSlope = null,
    rescaleIntercept = null,
    pixels = null,
    omitPixelData = false,
    tags = {},
  } = opts;

  const meta = [
    encodeElement(0x0002, 0x0010, 'UI', strBytes(transferSyntax, '\0')),
  ];

  const dataset = [
    encodeElement(0x0008, 0x0018, 'UI', strBytes(tags.sopInstanceUid ?? '1.2.3.4.5', '\0')),
    encodeElement(0x0008, 0x0020, 'DA', strBytes(tags.studyDate ?? '20240131')),
    encodeElement(0x0008, 0x0060, 'CS', strBytes(tags.modality ?? 'CT')),
    encodeElement(0x0008, 0x1030, 'LO', strBytes(tags.studyDescription ?? 'CT HEAD')),
    encodeElement(0x0008, 0x103e, 'LO', strBytes(tags.seriesDescription ?? 'AXIAL')),
    encodeElement(0x0010, 0x0010, 'PN', strBytes(tags.patientName ?? 'Doe^Jane')),
    encodeElement(0x0010, 0x0020, 'LO', strBytes(tags.patientId ?? 'PID-001')),
    encodeElement(0x0028, 0x0002, 'US', us(samplesPerPixel)),
    encodeElement(0x0028, 0x0004, 'CS', strBytes(photometricInterpretation)),
  ];
  if (numberOfFrames != null) {
    dataset.push(encodeElement(0x0028, 0x0008, 'IS', strBytes(String(numberOfFrames))));
  }
  dataset.push(
    encodeElement(0x0028, 0x0010, 'US', us(rows)),
    encodeElement(0x0028, 0x0011, 'US', us(columns)),
    encodeElement(0x0028, 0x0030, 'DS', strBytes(tags.pixelSpacing ?? '0.5\\0.5')),
    encodeElement(0x0028, 0x0100, 'US', us(bitsAllocated)),
    encodeElement(0x0028, 0x0101, 'US', us(bitsAllocated)),
    encodeElement(0x0028, 0x0102, 'US', us(bitsAllocated - 1)),
    encodeElement(0x0028, 0x0103, 'US', us(pixelRepresentation)),
  );
  if (windowCenter != null) dataset.push(encodeElement(0x0028, 0x1050, 'DS', strBytes(String(windowCenter))));
  if (windowWidth != null) dataset.push(encodeElement(0x0028, 0x1051, 'DS', strBytes(String(windowWidth))));
  if (rescaleIntercept != null) dataset.push(encodeElement(0x0028, 0x1052, 'DS', strBytes(String(rescaleIntercept))));
  if (rescaleSlope != null) dataset.push(encodeElement(0x0028, 0x1053, 'DS', strBytes(String(rescaleSlope))));

  if (!omitPixelData) {
    const frames = numberOfFrames ?? 1;
    const nPix = rows * columns * frames;
    let pix = pixels;
    if (!pix) {
      pix = bitsAllocated === 8 ? new Uint8Array(nPix) : new Uint16Array(nPix);
    }
    const pixBytes = new Uint8Array(pix.buffer, pix.byteOffset, pix.byteLength);
    dataset.push(encodeElement(0x7fe0, 0x0010, 'OW', pixBytes));
  }

  const parts = [...meta, ...dataset];
  const bodyLen = parts.reduce((sum, p) => sum + p.length, 0);
  const file = new Uint8Array(132 + bodyLen);
  // 128-byte preamble (zeros) + "DICM"
  file[128] = 0x44; file[129] = 0x49; file[130] = 0x43; file[131] = 0x4d;
  let offset = 132;
  for (const p of parts) {
    file.set(p, offset);
    offset += p.length;
  }
  return file.buffer;
}
