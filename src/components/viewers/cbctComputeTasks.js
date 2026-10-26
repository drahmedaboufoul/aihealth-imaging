/*
 * cbctComputeTasks — the CBCT viewer's heavy voxel→2D compute, expressed as
 * task functions over a volume-like { dimensions, spacing, origin, direction,
 * scalarData } object. Imported by BOTH:
 *
 *   - cbctCompute.worker.js  (module Web Worker — the normal browser path), and
 *   - cbctComputeClient.js   (synchronous main-thread fallback for
 *     environments without Worker: vitest/jsdom, or a worker that failed to
 *     boot).
 *
 * This module contains NO algorithm code of its own — it only orchestrates
 * the existing unit-tested pure libs (curvedMpr / autoArch / cbctAiViews), so
 * moving the compute off the main thread cannot change a single output pixel.
 * Everything here must stay DOM-free (it runs inside a worker).
 */
import {
  generatePanoramic, generateCrossSections, computeImageWindow, unsharpMaskImage,
} from '@/lib/curvedMpr';
import { detectDentalArch } from '@/lib/autoArch';
import { buildAiViews } from '@/lib/cbctAiViews';

// Full-quality panoramic geometry (this module runs in the worker, so the
// extra sampling never blocks the UI). ~1600 columns across the arch with
// SQUARE pixels (rowSpacing follows colSpacing inside generatePanoramic), and
// a maxRows ceiling generous enough that the roots→sinus-floor band derived
// from the arch height (vertAboveMm/vertBelowMm defaults) is never squashed.
// The viewer's drag PREVIEW path overrides these with its cheap settings
// (columns 512 / maxRows 384 / maxSlabSamples 9) — see regeneratePanoInPlace.
const PANO_FULL_QUALITY = { columns: 1600, maxRows: 2048 };

// Unsharp radius for the panoramic: ~0.4mm expressed in strip pixels (the
// strip pitch is data-dependent), clamped to a small kernel.
const panoSharpenRadiusPx = (pano) =>
  Math.max(1, Math.min(6, Math.round(0.4 / (pano?.colSpacing || 1))));

/**
 * Run one compute task. `progress(note)` receives coarse human-readable stage
 * notes (the pure libs expose no finer granularity — adding it would mean
 * touching their algorithms, which this move deliberately does not).
 *
 * Tasks:
 *   'pano'     — curved-MPR panoramic along an arch (+ optional perpendicular
 *                cross-sections). params: { archPoints, verticalAxis,
 *                panoOptions, wantSections, sectionCount }
 *                → { pano, panoWin, sections|null, sectionsWin|null,
 *                    sectionsError|null }
 *                pano is lightly unsharp-masked; panoWin/sectionsWin are the
 *                robust data-derived display windows ({lower,upper,gamma}).
 *   'autoArch' — automatic dental-arch detection. → { pointsWorld }
 *   'aiViews'  — deterministic AI-input view set (Float32 images; PNG encoding
 *                stays on the main thread — it needs <canvas> and is cheap).
 *                params: { options } → { views, range, meta }
 */
export function executeCbctComputeTask(task, vol, params = {}, progress = () => {}) {
  switch (task) {
    case 'pano': {
      const {
        archPoints,
        verticalAxis = null,
        panoOptions = {},
        wantSections = true,
        sectionCount = 12,
      } = params;
      progress('sampling the curved MPR…');
      // Full-quality geometry by default; the caller's panoOptions (e.g. the
      // drag-preview cheap settings) win over it.
      const raw = generatePanoramic(vol, archPoints, {
        verticalAxis, ...PANO_FULL_QUALITY, ...panoOptions,
      });
      progress('sharpening the strip…');
      // Gentle unsharp mask on the float image BEFORE windowing — enamel/PDL
      // edges pop and the percentile window below absorbs the overshoot.
      const pano = unsharpMaskImage(raw, { radiusPx: panoSharpenRadiusPx(raw), amount: 0.6 });
      // Window the MIP strip to its OWN non-background value distribution
      // (robust percentiles + gentle gamma — CBCT values are not calibrated
      // HU, so the window must come from the data); null falls back to the
      // caller's full-volume range.
      const panoWin = computeImageWindow(pano) || null;
      let sections = null;
      let sectionsWin = null;
      let sectionsError = null;
      if (wantSections) {
        progress('building cross-sections…');
        try {
          sections = generateCrossSections(vol, archPoints, { count: sectionCount, verticalAxis }).sections;
          // One shared window across the whole strip of sections (pooled
          // pixels, same derivation as the panoramic) — consistent brightness
          // along the arch instead of the flat full-volume window.
          let total = 0;
          for (const s of sections) total += s.data.length;
          const pooled = new Float32Array(total);
          let at = 0;
          for (const s of sections) { pooled.set(s.data, at); at += s.data.length; }
          sectionsWin = computeImageWindow({ data: pooled }) || null;
        } catch (e) {
          // Sections failing must not sink the panoramic — same per-part
          // semantics as the old inline try/catch in the viewer.
          sectionsError = e?.message || 'cross-sections failed';
        }
      }
      return { pano, panoWin, sections, sectionsWin, sectionsError };
    }
    case 'autoArch': {
      progress('scanning the volume for the dentition…');
      const { pointsWorld } = detectDentalArch(vol);
      return { pointsWorld };
    }
    case 'aiViews': {
      progress('rendering panoramic + slab views…');
      const { views, range, meta } = buildAiViews(vol, params.options || {});
      return { views, range, meta };
    }
    default:
      throw new Error(`Unknown CBCT compute task: ${task}`);
  }
}

/**
 * Collect the transferable ArrayBuffers of a task result so the worker can
 * hand the produced images back to the main thread zero-copy. All these
 * buffers are freshly allocated inside the task (never views on the volume),
 * so transferring them detaches nothing the worker still needs.
 */
export function collectResultTransferables(result) {
  const buffers = [];
  const push = (arr) => {
    if (
      arr && ArrayBuffer.isView(arr) &&
      arr.buffer instanceof ArrayBuffer &&
      !buffers.includes(arr.buffer)
    ) buffers.push(arr.buffer);
  };
  if (result?.pano) push(result.pano.data);
  (result?.sections || []).forEach((s) => push(s?.data));
  (result?.views || []).forEach((v) => push(v?.data));
  return buffers;
}
