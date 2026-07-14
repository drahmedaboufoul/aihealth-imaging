import { describe, it, expect, vi } from 'vitest';
import { densifyArch, renderArchPano, getVolumeScalarData } from '../src/lib/archPano';

describe('densifyArch — Catmull-Rom arch densification', () => {
  it('returns [] for fewer than 2 control points', () => {
    expect(densifyArch([])).toEqual([]);
    expect(densifyArch([[0, 0]])).toEqual([]);
  });

  it('passes exactly through the first and last control points', () => {
    const samples = densifyArch([[0, 0], [10, 5], [20, 0]], 50);
    expect(samples).toHaveLength(50);
    expect(samples[0].x).toBeCloseTo(0, 6);
    expect(samples[0].y).toBeCloseTo(0, 6);
    expect(samples[49].x).toBeCloseTo(20, 6);
    expect(samples[49].y).toBeCloseTo(0, 6);
  });

  it('samples a straight segment at uniform arc-length spacing', () => {
    const samples = densifyArch([[0, 0], [10, 0]], 11);
    expect(samples).toHaveLength(11);
    for (let i = 0; i < 11; i++) {
      expect(samples[i].x).toBeCloseTo(i, 4); // 1 unit apart
      expect(samples[i].y).toBeCloseTo(0, 6);
    }
  });

  it('spaces samples uniformly by arc length on a curved arch', () => {
    // A parabolic-ish dental arch
    const ctrl = [[-30, 0], [-20, 18], [0, 26], [20, 18], [30, 0]];
    const samples = densifyArch(ctrl, 200);
    const dists = [];
    for (let i = 1; i < samples.length; i++) {
      dists.push(Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
    }
    const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
    for (const d of dists) {
      // Each step within 10% of the mean step length
      expect(Math.abs(d - mean) / mean).toBeLessThan(0.1);
    }
  });

  it('produces unit tangents with perpendicular unit normals', () => {
    const ctrl = [[-30, 0], [0, 25], [30, 0]];
    const samples = densifyArch(ctrl, 100);
    for (const s of samples) {
      expect(Math.hypot(s.tx, s.ty)).toBeCloseTo(1, 6);
      expect(Math.hypot(s.nx, s.ny)).toBeCloseTo(1, 6);
      // normal ⊥ tangent
      expect(s.tx * s.nx + s.ty * s.ny).toBeCloseTo(0, 6);
    }
  });

  it('orients the tangent along the direction of travel', () => {
    const samples = densifyArch([[0, 0], [10, 0]], 11);
    for (const s of samples) {
      expect(s.tx).toBeCloseTo(1, 6);
      expect(s.ty).toBeCloseTo(0, 6);
      // 90° CCW rotation of (1,0) is (0,1)
      expect(s.nx).toBeCloseTo(0, 6);
      expect(s.ny).toBeCloseTo(1, 6);
    }
  });
});

/** Minimal stand-in for an HTMLCanvasElement + 2d context. */
function makeFakeCanvas() {
  const ctx = {
    fillStyle: null,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: vi.fn(),
    fillRect: vi.fn(),
  };
  return { width: 0, height: 0, getContext: () => ctx, ctx };
}

describe('renderArchPano — MIP + VOI mapping (fake canvas)', () => {
  const dims = [10, 10, 4];
  const baseOpts = {
    dimensions: dims,
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    slabMM: 2,
    panoWidth: 8,
    panoHeight: 4,
  };

  it('maps a uniform volume through the VOI to the expected gray', () => {
    const scalarData = new Float32Array(dims[0] * dims[1] * dims[2]).fill(1000);
    const canvas = makeFakeCanvas();
    renderArchPano(canvas, {
      ...baseOpts,
      scalarData,
      archPoints: [[2, 5], [7, 5]],
      voi: { lower: 0, upper: 2550 }, // gray = 1000/2550*255 = 100 exactly
    });
    expect(canvas.ctx.putImageData).toHaveBeenCalledTimes(1);
    const img = canvas.ctx.putImageData.mock.calls[0][0];
    expect(img.width).toBe(8);
    expect(img.height).toBe(4);
    for (let i = 0; i < img.data.length; i += 4) {
      expect(img.data[i]).toBe(100);
      expect(img.data[i + 1]).toBe(100);
      expect(img.data[i + 2]).toBe(100);
      expect(img.data[i + 3]).toBe(255);
    }
  });

  it('clamps values outside the VOI to 0 / 255', () => {
    const n = dims[0] * dims[1] * dims[2];
    const low = new Float32Array(n).fill(-2000);  // below VOI lower
    const high = new Float32Array(n).fill(9000);  // above VOI upper
    const voi = { lower: -1000, upper: 3000 };

    const cLow = makeFakeCanvas();
    renderArchPano(cLow, { ...baseOpts, scalarData: low, archPoints: [[2, 5], [7, 5]], voi });
    const imgLow = cLow.ctx.putImageData.mock.calls[0][0];
    expect(imgLow.data[0]).toBe(0);

    const cHigh = makeFakeCanvas();
    renderArchPano(cHigh, { ...baseOpts, scalarData: high, archPoints: [[2, 5], [7, 5]], voi });
    const imgHigh = cHigh.ctx.putImageData.mock.calls[0][0];
    expect(imgHigh.data[0]).toBe(255);
  });

  it('takes the maximum across the slab (MIP)', () => {
    // Volume is 0 everywhere except one bright Y-line at y=6 (1mm from the
    // arch at y=5) — inside the 2mm slab, so MIP must pick it up.
    const scalarData = new Float32Array(dims[0] * dims[1] * dims[2]).fill(0);
    for (let z = 0; z < dims[2]; z++) {
      for (let x = 0; x < dims[0]; x++) {
        scalarData[z * dims[0] * dims[1] + 6 * dims[0] + x] = 2550;
      }
    }
    const canvas = makeFakeCanvas();
    renderArchPano(canvas, {
      ...baseOpts,
      scalarData,
      archPoints: [[2, 5], [7, 5]],
      voi: { lower: 0, upper: 2550 },
    });
    const img = canvas.ctx.putImageData.mock.calls[0][0];
    expect(img.data[0]).toBe(255); // saw the bright line, not the 0 at the arch
  });

  it('renders black when the arch lies entirely outside the volume', () => {
    const scalarData = new Float32Array(dims[0] * dims[1] * dims[2]).fill(2550);
    const canvas = makeFakeCanvas();
    renderArchPano(canvas, {
      ...baseOpts,
      scalarData,
      archPoints: [[500, 500], [600, 500]],
      voi: { lower: 0, upper: 2550 },
    });
    const img = canvas.ctx.putImageData.mock.calls[0][0];
    for (let i = 0; i < img.data.length; i += 4) {
      expect(img.data[i]).toBe(0);
      expect(img.data[i + 3]).toBe(255);
    }
  });

  it('paints a black rect and skips sampling when the arch is degenerate', () => {
    const canvas = makeFakeCanvas();
    renderArchPano(canvas, {
      ...baseOpts,
      scalarData: new Float32Array(dims[0] * dims[1] * dims[2]),
      archPoints: [[5, 5]], // single point -> densifyArch returns []
      voi: { lower: 0, upper: 2550 },
    });
    expect(canvas.ctx.fillRect).toHaveBeenCalled();
    expect(canvas.ctx.putImageData).not.toHaveBeenCalled();
  });

  it('sizes the canvas to the requested pano dimensions', () => {
    const canvas = makeFakeCanvas();
    renderArchPano(canvas, {
      ...baseOpts,
      scalarData: new Float32Array(dims[0] * dims[1] * dims[2]),
      archPoints: [[2, 5], [7, 5]],
      voi: { lower: 0, upper: 2550 },
      panoWidth: 16,
      panoHeight: 9,
    });
    expect(canvas.width).toBe(16);
    expect(canvas.height).toBe(9);
  });
});

describe('getVolumeScalarData — Cornerstone version-tolerant access', () => {
  const data = new Float32Array([1, 2, 3]);

  it('returns null for a missing volume', () => {
    expect(getVolumeScalarData(null)).toBeNull();
    expect(getVolumeScalarData(undefined)).toBeNull();
  });

  it('uses getScalarData() when available (classic 4.x volumes)', () => {
    expect(getVolumeScalarData({ getScalarData: () => data })).toBe(data);
  });

  it('falls back to the scalarData property', () => {
    expect(getVolumeScalarData({ scalarData: data })).toBe(data);
  });

  it('falls back to voxelManager.getCompleteScalarDataArray (CS3D 4.5+)', () => {
    const volume = { voxelManager: { getCompleteScalarDataArray: () => data } };
    expect(getVolumeScalarData(volume)).toBe(data);
  });

  it('falls back to voxelManager.scalarData', () => {
    expect(getVolumeScalarData({ voxelManager: { scalarData: data } })).toBe(data);
  });

  it('falls back to the vtkImageData scalar buffer', () => {
    const volume = {
      imageData: {
        getPointData: () => ({ getScalars: () => ({ getData: () => data }) }),
      },
    };
    expect(getVolumeScalarData(volume)).toBe(data);
  });

  it('prefers getScalarData() over later fallbacks', () => {
    const other = new Float32Array([9]);
    const volume = { getScalarData: () => data, scalarData: other };
    expect(getVolumeScalarData(volume)).toBe(data);
  });

  it('skips accessors that throw and keeps probing', () => {
    const volume = {
      getScalarData: () => { throw new Error('detached'); },
      voxelManager: { scalarData: data },
    };
    expect(getVolumeScalarData(volume)).toBe(data);
  });

  it('ignores empty buffers and returns null when nothing has data', () => {
    const volume = { getScalarData: () => new Float32Array(0), scalarData: [] };
    expect(getVolumeScalarData(volume)).toBeNull();
  });
});
