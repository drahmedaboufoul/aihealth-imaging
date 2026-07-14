import { describe, it, expect, afterEach, vi } from 'vitest';
import { gzip } from 'pako';
import { loadNiftiVolume } from '../src/lib/niftiLoader';

/*
 * Builds a minimal-but-valid NIfTI-1 file in memory (348-byte header +
 * 4 bytes padding + voxel data, little endian) so the loader can be tested
 * without fixtures or network.
 */
const DT = { UINT8: 2, INT16: 4, INT32: 8, FLOAT32: 16, FLOAT64: 64, UINT16: 512 };
const BITPIX = { 2: 8, 4: 16, 8: 32, 16: 32, 64: 64, 512: 16 };

function buildNifti({
  dims = [4, 3, 2],
  pixdim = [0.5, 0.5, 0.3],
  datatype = DT.INT16,
  sclSlope = 0,
  sclInter = 0,
  srows = null, // 3x4 sform rows; null -> sform_code 0
  data,
}) {
  const header = new ArrayBuffer(352);
  const dv = new DataView(header);
  dv.setInt32(0, 348, true);                  // sizeof_hdr
  dv.setInt16(40, 3, true);                   // dim[0] = 3 spatial dims
  dv.setInt16(42, dims[0], true);
  dv.setInt16(44, dims[1], true);
  dv.setInt16(46, dims[2], true);
  for (let i = 4; i < 8; i++) dv.setInt16(40 + i * 2, 1, true);
  dv.setInt16(70, datatype, true);            // datatype
  dv.setInt16(72, BITPIX[datatype], true);    // bitpix
  dv.setFloat32(76, 1, true);                 // pixdim[0] (qfac)
  dv.setFloat32(80, pixdim[0], true);
  dv.setFloat32(84, pixdim[1], true);
  dv.setFloat32(88, pixdim[2], true);
  dv.setFloat32(108, 352, true);              // vox_offset
  dv.setFloat32(112, sclSlope, true);         // scl_slope
  dv.setFloat32(116, sclInter, true);         // scl_inter
  dv.setInt16(252, 0, true);                  // qform_code
  dv.setInt16(254, srows ? 1 : 0, true);      // sform_code
  if (srows) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) dv.setFloat32(280 + r * 16 + c * 4, srows[r][c], true);
    }
  }
  // magic "n+1\0"
  dv.setUint8(344, 0x6e); dv.setUint8(345, 0x2b); dv.setUint8(346, 0x31); dv.setUint8(347, 0);

  const out = new Uint8Array(352 + data.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 352);
  return out;
}

function stubFetch(bytes, { ok = true, status = 200, statusText = 'OK' } = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status,
    statusText,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })));
}

const VOXELS = new Int16Array([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
]); // 4 x 3 x 2

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadNiftiVolume', () => {
  it('parses an uncompressed .nii: dims, spacing, origin, direction, raw voxels', async () => {
    const file = buildNifti({
      srows: [
        [0.5, 0, 0, -50],
        [0, 0.5, 0, -60],
        [0, 0, 0.3, -70],
      ],
      data: VOXELS,
    });
    stubFetch(file);

    const vol = await loadNiftiVolume('https://example.test/vol.nii');
    expect(vol.dimensions).toEqual([4, 3, 2]);
    expect(vol.spacing[0]).toBeCloseTo(0.5, 5);
    expect(vol.spacing[1]).toBeCloseTo(0.5, 5);
    expect(vol.spacing[2]).toBeCloseTo(0.3, 5);
    expect(vol.origin).toEqual([-50, -60, -70]);
    // sform is axis-aligned: direction normalises to identity
    const ident = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    vol.direction.forEach((v, i) => expect(v).toBeCloseTo(ident[i], 5));
    // No scaling -> typed array passed through unchanged
    expect(vol.scalarData).toBeInstanceOf(Int16Array);
    expect(Array.from(vol.scalarData)).toEqual(Array.from(VOXELS));
    expect(vol.metadata.datatypeCode).toBe(DT.INT16);
    expect(vol.metadata.sliceCount).toBe(2);
  });

  it('detects and inflates gzipped .nii.gz via magic bytes', async () => {
    const file = buildNifti({ data: VOXELS });
    stubFetch(gzip(file));

    const vol = await loadNiftiVolume('https://example.test/vol.nii.gz');
    expect(vol.dimensions).toEqual([4, 3, 2]);
    expect(Array.from(vol.scalarData)).toEqual(Array.from(VOXELS));
  });

  it('falls back to identity direction and zero origin without an sform', async () => {
    const file = buildNifti({ data: VOXELS, srows: null });
    stubFetch(file);

    const vol = await loadNiftiVolume('https://example.test/vol.nii');
    expect(vol.direction).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(vol.origin).toEqual([0, 0, 0]);
  });

  it('applies scl_slope / scl_inter and returns Float32', async () => {
    const file = buildNifti({ data: VOXELS, sclSlope: 2, sclInter: 10 });
    stubFetch(file);

    const vol = await loadNiftiVolume('https://example.test/vol.nii');
    expect(vol.scalarData).toBeInstanceOf(Float32Array);
    expect(vol.scalarData[0]).toBe(1 * 2 + 10);
    expect(vol.scalarData[23]).toBe(24 * 2 + 10);
    expect(vol.metadata.scl_slope).toBe(2);
    expect(vol.metadata.scl_inter).toBe(10);
  });

  it('down-converts Float64 voxel data to Float32 for Cornerstone', async () => {
    const f64 = new Float64Array([0.5, -1.25, 3.75, 100, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const file = buildNifti({ data: f64, datatype: DT.FLOAT64 });
    stubFetch(file);

    const vol = await loadNiftiVolume('https://example.test/vol.nii');
    expect(vol.scalarData).toBeInstanceOf(Float32Array);
    expect(vol.scalarData[0]).toBeCloseTo(0.5, 6);
    expect(vol.scalarData[1]).toBeCloseTo(-1.25, 6);
  });

  it('passes Uint16 voxel data through untouched (CBCT without HU rescale)', async () => {
    const u16 = new Uint16Array(24).fill(4095);
    const file = buildNifti({ data: u16, datatype: DT.UINT16 });
    stubFetch(file);

    const vol = await loadNiftiVolume('https://example.test/vol.nii');
    expect(vol.scalarData).toBeInstanceOf(Uint16Array);
    expect(vol.scalarData[0]).toBe(4095);
  });

  it('reports absolute spacing for negative pixdims', async () => {
    const file = buildNifti({ data: VOXELS, pixdim: [-0.5, 0.5, -0.3] });
    stubFetch(file);

    const vol = await loadNiftiVolume('https://example.test/vol.nii');
    expect(vol.spacing[0]).toBeCloseTo(0.5, 5);
    expect(vol.spacing[2]).toBeCloseTo(0.3, 5);
  });

  it('throws a clear error on HTTP failure', async () => {
    stubFetch(new Uint8Array(0), { ok: false, status: 404, statusText: 'Not Found' });
    await expect(loadNiftiVolume('https://example.test/missing.nii'))
      .rejects.toThrow('NIfTI fetch failed: 404 Not Found');
  });

  it('rejects downloads that are not NIfTI', async () => {
    stubFetch(new Uint8Array(512).fill(7));
    await expect(loadNiftiVolume('https://example.test/not-nifti.bin'))
      .rejects.toThrow('not a NIfTI volume');
  });
});
