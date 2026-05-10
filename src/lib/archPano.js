/*
 * archPano — reformatted panoramic from a CBCT volume + a user-drawn arch curve.
 *
 * The classic dental panoramic radiograph is a single 2D image that
 * unwraps the curved dental arch into a flat strip. CBCT scanners can
 * produce this synthetically by sampling the volume along an arch curve
 * the user traces on an axial slice — every output column is one point
 * along the curve, every output row is one Z level, and (optionally) a
 * thick slab is collapsed via MIP perpendicular to the arch tangent.
 *
 * Inputs:
 *   - volume:        Cornerstone3D volume (has dimensions, spacing,
 *                    origin, getScalarData())
 *   - archPoints:    Array of [x, y] world-space points the user clicked
 *                    on axial. At least 3; we recommend 5–9.
 *   - z (optional):  Z-clip range in world mm (default: full volume).
 *   - slabMM:        Slab thickness perpendicular to the tangent (default 5mm)
 *   - voi:           { lower, upper } for greyscale mapping
 *   - panoWidth:     Output canvas width in pixels (default 800)
 *   - panoHeight:    Output canvas height (default = volume Z dim)
 *
 * Output:
 *   - canvas (OffscreenCanvas or HTMLCanvasElement) with the pano image.
 *
 * Math:
 *   1. Catmull-Rom spline through arch points → smooth curve.
 *   2. Densify to N uniformly spaced (by arc-length) samples; for each
 *      sample compute the tangent and its perpendicular (the slab axis).
 *   3. For each (column = sample, row = z, slabOffset) triple:
 *      - world (X, Y, Z) = sample.pos + slab * normal + (0, 0, z)
 *      - voxel index = round((world - origin) / spacing)
 *      - voxel value = scalarData[iz * (dx*dy) + iy * dx + ix]
 *   4. MIP across slab offsets → single value per (col, row).
 *   5. Apply VOI → 0..255 greyscale → ImageData.
 *
 * Performance: a 800×400 pano with 5mm slab over 0.25mm voxels = ~20
 * slab samples × 320k pixels = 6.4M voxel reads. Comfortably under
 * 100ms on modern hardware.
 */

/**
 * Catmull-Rom spline interpolation between two control points,
 * using neighbours p0 / p3 to set tangents. t is 0..1 within segment p1→p2.
 */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 * (
      2 * p1[0] +
      (-p0[0] + p2[0]) * t +
      (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
      (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
    ),
    0.5 * (
      2 * p1[1] +
      (-p0[1] + p2[1]) * t +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
    ),
  ];
}

/**
 * Densify control points into N spline samples plus tangents / normals.
 * Uses Catmull-Rom with endpoint duplication (mirror) so the curve
 * passes through the first and last points cleanly.
 */
export function densifyArch(controlPoints, sampleCount = 500) {
  if (controlPoints.length < 2) return [];
  // Duplicate first/last to drive the Catmull-Rom endpoints.
  const pts = [
    controlPoints[0],
    ...controlPoints,
    controlPoints[controlPoints.length - 1],
  ];
  const segments = pts.length - 3;
  if (segments < 1) return [];

  // First pass: sample uniformly in spline parameter (not arc-length).
  const samples = [];
  const samplesPerSegment = Math.max(2, Math.ceil(sampleCount / segments));
  for (let s = 0; s < segments; s++) {
    const p0 = pts[s];
    const p1 = pts[s + 1];
    const p2 = pts[s + 2];
    const p3 = pts[s + 3];
    for (let i = 0; i < samplesPerSegment; i++) {
      const t = i / samplesPerSegment;
      const pos = catmullRom(p0, p1, p2, p3, t);
      samples.push(pos);
    }
  }
  // Include the final point exactly
  samples.push(controlPoints[controlPoints.length - 1]);

  // Second pass: compute cumulative arc length, then resample at uniform
  // arc-length intervals so the pano has even spatial resolution.
  const cumLen = [0];
  for (let i = 1; i < samples.length; i++) {
    const dx = samples[i][0] - samples[i - 1][0];
    const dy = samples[i][1] - samples[i - 1][1];
    cumLen.push(cumLen[i - 1] + Math.hypot(dx, dy));
  }
  const totalLen = cumLen[cumLen.length - 1];
  const uniform = [];
  for (let i = 0; i < sampleCount; i++) {
    const targetLen = (i / (sampleCount - 1)) * totalLen;
    // Binary search for the segment containing targetLen
    let lo = 0;
    let hi = cumLen.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumLen[mid] < targetLen) lo = mid + 1;
      else hi = mid;
    }
    const segIdx = Math.max(1, lo);
    const segLen = cumLen[segIdx] - cumLen[segIdx - 1];
    const f = segLen > 0 ? (targetLen - cumLen[segIdx - 1]) / segLen : 0;
    const x = samples[segIdx - 1][0] * (1 - f) + samples[segIdx][0] * f;
    const y = samples[segIdx - 1][1] * (1 - f) + samples[segIdx][1] * f;
    uniform.push([x, y]);
  }

  // Compute tangent + unit normal at each uniform sample
  const out = [];
  for (let i = 0; i < uniform.length; i++) {
    const prev = uniform[Math.max(0, i - 1)];
    const next = uniform[Math.min(uniform.length - 1, i + 1)];
    const tx = next[0] - prev[0];
    const ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    const ux = tx / len;
    const uy = ty / len;
    // Normal = 90° rotation of tangent
    const nx = -uy;
    const ny = ux;
    out.push({ x: uniform[i][0], y: uniform[i][1], tx: ux, ty: uy, nx, ny });
  }
  return out;
}

/**
 * Render the pano image onto the supplied canvas.
 *
 * @param {HTMLCanvasElement} canvas - Output canvas (sized to panoWidth × panoHeight).
 * @param {object} opts
 *   @param {Float32Array} opts.scalarData - Flat (x-major) voxel buffer.
 *   @param {[number,number,number]} opts.dimensions - [dx, dy, dz]
 *   @param {[number,number,number]} opts.spacing - [sx, sy, sz]
 *   @param {[number,number,number]} opts.origin - [ox, oy, oz]
 *   @param {Array<[number,number]>} opts.archPoints - World-space arch control points (x, y at fixed z)
 *   @param {number} opts.slabMM - Slab thickness perpendicular to tangent
 *   @param {{lower:number,upper:number}} opts.voi
 *   @param {number} opts.panoWidth
 *   @param {number} opts.panoHeight
 *   @param {boolean} opts.flipZ - Flip Z so superior (head top) is on top
 */
export function renderArchPano(canvas, opts) {
  const {
    scalarData,
    dimensions,
    spacing,
    origin,
    archPoints,
    slabMM = 5,
    voi,
    panoWidth = 800,
    panoHeight,
    flipZ = true,
  } = opts;
  const [dx, dy, dz] = dimensions;
  const [sx, sy, sz] = spacing;
  const [ox, oy, oz] = origin;
  const outW = panoWidth;
  const outH = panoHeight || dz;

  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(outW, outH);
  const buf = imageData.data;

  // Densify arch to outW samples (one per pano column)
  const samples = densifyArch(archPoints, outW);
  if (samples.length === 0) {
    // No arch — just leave canvas black
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, outW, outH);
    return;
  }

  const voiLo = voi?.lower ?? -1000;
  const voiHi = voi?.upper ?? 3000;
  const voiSpan = Math.max(1, voiHi - voiLo);

  // Slab stepping in voxels (sample at every voxel-spacing step)
  const slabStepMM = Math.max(sx, sy);
  const slabHalfMM = slabMM / 2;
  const slabSteps = Math.max(1, Math.round(slabMM / slabStepMM));
  const slabOffsets = [];
  for (let s = 0; s < slabSteps; s++) {
    const offsetMM = -slabHalfMM + (s + 0.5) * (slabMM / slabSteps);
    slabOffsets.push(offsetMM);
  }

  // For each output column (= one arch sample)
  for (let col = 0; col < outW; col++) {
    const samp = samples[col];
    // For each output row (= one Z level)
    for (let row = 0; row < outH; row++) {
      // flipZ: row 0 = top of head (= max Z in patient space)
      const zFrac = flipZ ? 1 - row / (outH - 1) : row / (outH - 1);
      const iz = Math.round(zFrac * (dz - 1));
      if (iz < 0 || iz >= dz) continue;

      // MIP across the slab perpendicular to tangent
      let maxVal = -Infinity;
      for (let k = 0; k < slabOffsets.length; k++) {
        const offsetMM = slabOffsets[k];
        const wx = samp.x + samp.nx * offsetMM;
        const wy = samp.y + samp.ny * offsetMM;
        const ix = Math.round((wx - ox) / sx);
        const iy = Math.round((wy - oy) / sy);
        if (ix < 0 || ix >= dx || iy < 0 || iy >= dy) continue;
        const idx = iz * dx * dy + iy * dx + ix;
        const v = scalarData[idx];
        if (v > maxVal) maxVal = v;
      }

      let gray;
      if (maxVal === -Infinity) gray = 0;
      else {
        gray = ((maxVal - voiLo) / voiSpan) * 255;
        gray = Math.max(0, Math.min(255, gray));
      }
      const idx4 = (row * outW + col) * 4;
      buf[idx4] = gray;
      buf[idx4 + 1] = gray;
      buf[idx4 + 2] = gray;
      buf[idx4 + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Convenience: pull the scalar buffer from a Cornerstone3D volume in a
 * version-tolerant way. v4 has several access paths depending on whether
 * the volume was streamed or created locally.
 */
export function getVolumeScalarData(volume) {
  if (typeof volume?.getScalarData === 'function') return volume.getScalarData();
  if (volume?.scalarData) return volume.scalarData;
  if (volume?.imageData?.getPointData) {
    return volume.imageData.getPointData().getScalars().getData();
  }
  return null;
}
