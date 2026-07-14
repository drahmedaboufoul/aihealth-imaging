import { describe, it, expect } from 'vitest';
import { loadDicom, renderFrameToImageData, WL_PRESETS } from '../src/lib/dicomLoader';
import { buildDicom } from './helpers/buildDicom';

/*
 * NOTE on scope: loadDicom reads integer header attributes (Rows, Columns,
 * SamplesPerPixel, ...) via dicom-parser's dataSet.intString(), which parses
 * the element bytes as ASCII. Conformant DICOM encodes those attributes as
 * binary US values, so intString returns NaN and loadDicom rejects every
 * standard file before reaching the pixel pipeline (latent V1 bug; the module
 * is no longer imported by the app — viewer pages render via Cornerstone3D).
 * We therefore test the reachable validation paths of loadDicom plus the
 * exported pure window/level math (renderFrameToImageData) directly.
 */

function makeImageData(rows, columns) {
  return { data: new Uint8ClampedArray(rows * columns * 4) };
}

const BASE_META = {
  rows: 2,
  columns: 2,
  rescaleSlope: 1,
  rescaleIntercept: 0,
  photometricInterpretation: 'MONOCHROME2',
};

describe('loadDicom — validation paths', () => {
  it('rejects compressed transfer syntaxes, naming the UID', async () => {
    const jpeg2000 = '1.2.840.10008.1.2.4.90';
    await expect(loadDicom(buildDicom({ transferSyntax: jpeg2000 })))
      .rejects.toThrow(jpeg2000);
  });

  it('rejects JPEG-LS as well (anything outside the uncompressed set)', async () => {
    await expect(loadDicom(buildDicom({ transferSyntax: '1.2.840.10008.1.2.4.80' })))
      .rejects.toThrow(/Unsupported transfer syntax/);
  });

  it('rejects garbage buffers with a parse error', async () => {
    const garbage = new Uint8Array(256).fill(0xab).buffer;
    await expect(loadDicom(garbage)).rejects.toThrow(/Could not parse DICOM/);
  });

  it('rejects an empty buffer', async () => {
    await expect(loadDicom(new ArrayBuffer(0))).rejects.toThrow(/Could not parse DICOM/);
  });
});

describe('renderFrameToImageData — window/level math', () => {
  it('maps pixel values through the VOI LUT into clamped 8-bit grayscale RGBA', () => {
    const imageData = makeImageData(2, 2);
    // wc=150 ww=100 -> window spans [100, 200]; gray = (v - 100) * 255 / 100
    renderFrameToImageData({
      meta: BASE_META,
      pixels: new Int16Array([0, 100, 200, 300]),
      frameIndex: 0,
      windowCenter: 150,
      windowWidth: 100,
      imageData,
    });
    const grays = [0, 4, 8, 12].map((i) => imageData.data[i]);
    expect(grays).toEqual([0, 0, 255, 255]); // below floor / floor / ceiling / above
    // RGB channels equal, alpha fully opaque
    for (let i = 0; i < 16; i += 4) {
      expect(imageData.data[i + 1]).toBe(imageData.data[i]);
      expect(imageData.data[i + 2]).toBe(imageData.data[i]);
      expect(imageData.data[i + 3]).toBe(255);
    }
  });

  it('is linear inside the window', () => {
    const imageData = makeImageData(1, 2);
    renderFrameToImageData({
      meta: { ...BASE_META, rows: 1, columns: 2 },
      pixels: new Int16Array([125, 175]),
      frameIndex: 0,
      windowCenter: 150,
      windowWidth: 100,
      imageData,
    });
    expect(imageData.data[0]).toBe(Math.round((125 - 100) * 255 / 100)); // 64
    expect(imageData.data[4]).toBe(Math.round((175 - 100) * 255 / 100)); // 191
  });

  it('applies the modality LUT (rescale slope/intercept) before windowing', () => {
    const imageData = makeImageData(1, 1);
    // Raw 1024 with CT rescale (slope 1, intercept -1024) = 0 HU.
    // Window 0±50 puts it dead center -> mid gray.
    renderFrameToImageData({
      meta: { ...BASE_META, rows: 1, columns: 1, rescaleIntercept: -1024 },
      pixels: new Uint16Array([1024]),
      frameIndex: 0,
      windowCenter: 0,
      windowWidth: 100,
      imageData,
    });
    expect(imageData.data[0]).toBe(Math.round(50 * 255 / 100)); // 128
  });

  it('honours a non-unit rescale slope (e.g. PET-style scaling)', () => {
    const imageData = makeImageData(1, 1);
    // raw 100 * slope 2 + intercept 0 = 200 -> top of window [100, 200]
    renderFrameToImageData({
      meta: { ...BASE_META, rows: 1, columns: 1, rescaleSlope: 2 },
      pixels: new Uint16Array([100]),
      frameIndex: 0,
      windowCenter: 150,
      windowWidth: 100,
      imageData,
    });
    expect(imageData.data[0]).toBe(255);
  });

  it('inverts grayscale for MONOCHROME1 (case-insensitive)', () => {
    const pixels = new Int16Array([0, 100, 200, 300]);
    const m2 = makeImageData(2, 2);
    const m1 = makeImageData(2, 2);
    renderFrameToImageData({
      meta: BASE_META, pixels, frameIndex: 0,
      windowCenter: 150, windowWidth: 100, imageData: m2,
    });
    renderFrameToImageData({
      meta: { ...BASE_META, photometricInterpretation: 'monochrome1' }, pixels, frameIndex: 0,
      windowCenter: 150, windowWidth: 100, imageData: m1,
    });
    for (const i of [0, 4, 8, 12]) {
      expect(m1.data[i]).toBe(255 - m2.data[i]);
    }
  });

  it('offsets into the pixel buffer for multi-frame data', () => {
    // 2 frames of 1x2: frame 0 = [0, 0] (below window), frame 1 = [300, 300] (above)
    const pixels = new Int16Array([0, 0, 300, 300]);
    const meta = { ...BASE_META, rows: 1, columns: 2 };
    const f0 = makeImageData(1, 2);
    const f1 = makeImageData(1, 2);
    renderFrameToImageData({ meta, pixels, frameIndex: 0, windowCenter: 150, windowWidth: 100, imageData: f0 });
    renderFrameToImageData({ meta, pixels, frameIndex: 1, windowCenter: 150, windowWidth: 100, imageData: f1 });
    expect(Array.from(f0.data)).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
    expect(Array.from(f1.data)).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
  });

  it('treats a missing frameIndex as frame 0', () => {
    const pixels = new Int16Array([300, 300, 0, 0]);
    const meta = { ...BASE_META, rows: 1, columns: 2 };
    const out = makeImageData(1, 2);
    renderFrameToImageData({ meta, pixels, frameIndex: undefined, windowCenter: 150, windowWidth: 100, imageData: out });
    expect(out.data[0]).toBe(255);
  });
});

describe('WL_PRESETS', () => {
  it('ships the standard CT presets in Hounsfield units', () => {
    const names = WL_PRESETS.CT.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(['Soft Tissue', 'Lung', 'Bone', 'Brain']),
    );
    const lung = WL_PRESETS.CT.find((p) => p.name === 'Lung');
    expect(lung.wc).toBeLessThan(0);       // air-dominated window center
    expect(lung.ww).toBeGreaterThan(1000); // wide window
    for (const p of WL_PRESETS.CT) expect(p.ww).toBeGreaterThan(0);
  });

  it('uses an empty DEFAULT so file-header W/L wins for plain radiographs', () => {
    expect(WL_PRESETS.DEFAULT).toEqual([]);
  });
});
