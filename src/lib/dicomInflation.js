import { Inflate } from 'pako';

export const MAX_INFLATED_DICOM_BYTES = 256 * 1024 * 1024;

export function inflateDicomRaw(bytes, maxBytes = MAX_INFLATED_DICOM_BYTES) {
  const inflater = new Inflate({ raw: true, chunkSize: 64 * 1024 });
  const chunks = [];
  let length = 0;
  inflater.onData = chunk => {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Deflated DICOM exceeds the 256 MiB decoded dataset limit.');
    chunks.push(chunk);
  };
  inflater.push(bytes, true);
  if (inflater.err || !inflater.ended) throw new Error('Invalid or incomplete deflated DICOM dataset.');
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

// dicom-parser's documented inflater callback returns the original Part 10
// header followed by the inflated dataset. The stored source stays untouched.
export function inflateDicomDataSet(bytes, offset) {
  const inflated = inflateDicomRaw(bytes.subarray(offset));
  const result = new Uint8Array(offset + inflated.length);
  result.set(bytes.subarray(0, offset));
  result.set(inflated, offset);
  return result;
}

export function installDicomInflater() {
  // Cornerstone 4's wadouri cache calls parseDicom without parser options.
  // dicom-parser 1.8.21 therefore requires its documented browser pako global.
  // Keep an existing host-provided inflater intact; do not replace the parser.
  if (typeof globalThis.pako === 'undefined') globalThis.pako = { inflateRaw: inflateDicomRaw };
}
