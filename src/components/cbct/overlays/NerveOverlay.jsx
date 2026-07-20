/*
 * NerveOverlay — SVG overlay drawn above each MPR viewport showing the
 * user-traced mandibular nerve canal as a polyline + a safety-zone tube
 * radius. Re-projects on every CAMERA_MODIFIED event.
 *
 * Note: the nerve is a 3D polyline through patient space. On any given
 * MPR slice, we project ALL points to canvas coordinates. Points that
 * are far from the current slice plane are dimmed but still rendered
 * so the user has spatial context. A clinical-accuracy implementation
 * would also clip the polyline to a thin slab around the active slice;
 * for v1 we just dim by signed distance to the slice plane.
 *
 * Extracted from CBCTViewerPage.jsx during the A0 monolith split — pure
 * move, no behavior change.
 */
import { useEffect, useState } from 'react';
import { cornerstone } from '../../../lib/cornerstoneInit';
import { VIEWER_TOKENS } from '../../viewer/viewerTokens';

export default function NerveOverlay({ viewportId, engine, nervePoints, safetyZoneMM, slabHalfMM = 2.5 }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!engine) return;
    const handler = (e) => {
      if (e?.detail?.viewportId === viewportId) force((n) => n + 1);
    };
    cornerstone.eventTarget.addEventListener(
      cornerstone.Enums.Events.CAMERA_MODIFIED, handler
    );
    return () => {
      try {
        cornerstone.eventTarget.removeEventListener(
          cornerstone.Enums.Events.CAMERA_MODIFIED, handler
        );
      } catch {}
    };
  }, [engine, viewportId]);

  if (!engine || nervePoints.length < 2) return null;
  const vp = engine.getViewport(viewportId);
  if (!vp || !vp.element) return null;
  const rect = vp.element.getBoundingClientRect();
  const containerRect = vp.element.parentElement?.getBoundingClientRect();
  if (!containerRect) return null;
  const top  = rect.top  - containerRect.top;
  const left = rect.left - containerRect.left;

  // CLINICAL VISIBILITY RULE: a 3D polyline (the nerve canal) should
  // only appear on slices that actually intersect it within a small
  // slab around the current slice plane. Showing all points always
  // produces a confusing horizontal line on coronal/sagittal because
  // points placed on a single axial slice all share the same Z.
  //
  // We compute signed distance from each point to the slice plane, and
  // only render points + connecting segments within ±slabHalfMM mm.
  let viewPlaneNormal = [0, 0, 1];
  let viewFocal = [0, 0, 0];
  try {
    const cam = vp.getCamera();
    viewPlaneNormal = cam?.viewPlaneNormal || viewPlaneNormal;
    viewFocal       = cam?.focalPoint     || viewFocal;
  } catch {}
  const signedDist = (p) =>
    (p[0] - viewFocal[0]) * viewPlaneNormal[0] +
    (p[1] - viewFocal[1]) * viewPlaneNormal[1] +
    (p[2] - viewFocal[2]) * viewPlaneNormal[2];

  // slabHalfMM comes in as a prop now — user-adjustable via the
  // "Nerve slab" slider in the left rail. Default 2.5mm covers the
  // typical canal diameter; wider is more forgiving for scrolling.

  // Always render the FULL polyline as a ghost (low-opacity dashed
  // line) so the clinician keeps spatial context even when scrolling
  // away from the canal. The in-slab portion gets layered bright over
  // top. This solves the previous UX problem where the nerve seemed
  // to vanish entirely on far slices.
  const ghostSegments = [];
  for (let i = 0; i < nervePoints.length - 1; i++) {
    try {
      const a = vp.worldToCanvas(nervePoints[i]);
      const b = vp.worldToCanvas(nervePoints[i + 1]);
      if (a && b) ghostSegments.push({ start: a, end: b });
    } catch {}
  }
  // Also project all control points for ghost rendering
  const ghostDots = [];
  for (let i = 0; i < nervePoints.length; i++) {
    try {
      const c = vp.worldToCanvas(nervePoints[i]);
      if (c) ghostDots.push({ canvas: c, idx: i });
    } catch {}
  }

  // For each polyline segment, geometrically clip it to the slab.
  // Returns array of {canvasStart, canvasEnd, fullyInside}.
  const segments = [];
  for (let i = 0; i < nervePoints.length - 1; i++) {
    const p1 = nervePoints[i];
    const p2 = nervePoints[i + 1];
    const d1 = signedDist(p1);
    const d2 = signedDist(p2);
    const in1 = Math.abs(d1) <= slabHalfMM;
    const in2 = Math.abs(d2) <= slabHalfMM;
    // Both outside on same side → skip
    if (!in1 && !in2 && Math.sign(d1) === Math.sign(d2) && Math.abs(d1) > slabHalfMM && Math.abs(d2) > slabHalfMM) {
      continue;
    }
    // Compute the t parameters where the segment crosses ±slabHalfMM
    let tStart = 0, tEnd = 1;
    if (!in1) {
      // p1 outside — find crossing into slab
      const target = d1 > 0 ? slabHalfMM : -slabHalfMM;
      tStart = (d1 - target) / (d1 - d2);
    }
    if (!in2) {
      const target = d2 > 0 ? slabHalfMM : -slabHalfMM;
      tEnd = (d1 - target) / (d1 - d2);
    }
    if (tEnd <= tStart) continue;
    const lerp = (t) => [
      p1[0] + (p2[0] - p1[0]) * t,
      p1[1] + (p2[1] - p1[1]) * t,
      p1[2] + (p2[2] - p1[2]) * t,
    ];
    const worldStart = lerp(tStart);
    const worldEnd   = lerp(tEnd);
    let cs, ce;
    try {
      cs = vp.worldToCanvas(worldStart);
      ce = vp.worldToCanvas(worldEnd);
    } catch {
      continue;
    }
    if (cs && ce) segments.push({ start: cs, end: ce });
  }

  // Project the control points that ARE inside the slab for the dots.
  const visibleDots = [];
  for (let i = 0; i < nervePoints.length; i++) {
    if (Math.abs(signedDist(nervePoints[i])) > slabHalfMM) continue;
    try {
      const c = vp.worldToCanvas(nervePoints[i]);
      if (c) visibleDots.push({ canvas: c, idx: i });
    } catch {}
  }

  // Estimate pixels-per-mm from the camera so we can render the safety
  // tube radius accurately on this viewport.
  let pxPerMM = 1;
  try {
    const parallelScale = vp.getCamera?.()?.parallelScale;
    if (parallelScale && rect.height) {
      pxPerMM = (rect.height / 2) / parallelScale;
    }
  } catch {}
  const safetyPx = Math.max(1, safetyZoneMM * pxPerMM);

  // Build path strings for the two layers.
  const ghostPathD = ghostSegments
    .map((s) => `M ${s.start[0].toFixed(1)} ${s.start[1].toFixed(1)} L ${s.end[0].toFixed(1)} ${s.end[1].toFixed(1)}`)
    .join(' ');
  const brightPathD = segments
    .map((s) => `M ${s.start[0].toFixed(1)} ${s.start[1].toFixed(1)} L ${s.end[0].toFixed(1)} ${s.end[1].toFixed(1)}`)
    .join(' ');

  // Find closest-off-plane indicator text (helps user scroll toward the
  // nerve when nothing is in-slab on this view).
  let offPlaneHint = null;
  if (segments.length === 0 && visibleDots.length === 0) {
    let closest = null;
    let closestDist = Infinity;
    for (const p of nervePoints) {
      const d = Math.abs(signedDist(p));
      if (d < closestDist) { closest = p; closestDist = d; }
    }
    if (closest) {
      try {
        const c = vp.worldToCanvas(closest);
        if (c) {
          const dir = signedDist(closest) > 0 ? '↑' : '↓';
          offPlaneHint = { x: c[0], y: c[1], dist: closestDist, dir };
        }
      } catch {}
    }
  }

  return (
    <svg
      className="absolute pointer-events-none"
      style={{ top, left, width: rect.width, height: rect.height }}
    >
      {/* Ghost polyline — always visible at low opacity so the user
          retains 3D spatial context for the nerve path even on slices
          that don't intersect the canal. Dashed to distinguish from
          in-slab. */}
      {ghostPathD && (
        <path
          d={ghostPathD}
          fill="none"
          stroke={VIEWER_TOKENS.positive}
          strokeWidth={1.5}
          strokeDasharray="3 3"
          strokeLinecap="round"
          opacity={0.22}
        />
      )}
      {/* Ghost control point markers — small + faint */}
      {ghostDots.map(({ canvas: [x, y], idx }) => (
        <circle
          key={`g${idx}`}
          cx={x}
          cy={y}
          r={2}
          fill={VIEWER_TOKENS.positive}
          opacity={0.35}
        />
      ))}
      {/* Bright safety-zone halo for the in-slab portion */}
      {brightPathD && (
        <path
          d={brightPathD}
          fill="none"
          stroke={VIEWER_TOKENS.positive}
          strokeWidth={safetyPx * 2}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.22}
        />
      )}
      {/* Bright in-slab centerline */}
      {brightPathD && (
        <path
          d={brightPathD}
          fill="none"
          stroke={VIEWER_TOKENS.positive}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.98}
        />
      )}
      {/* Bright in-slab control points */}
      {visibleDots.map(({ canvas: [x, y], idx }) => (
        <circle
          key={`b${idx}`}
          cx={x}
          cy={y}
          r={4}
          fill={VIEWER_TOKENS.positive}
          stroke={VIEWER_TOKENS.bgPrimary}
          strokeWidth={1.5}
        />
      ))}
      {/* Off-plane hint label */}
      {offPlaneHint && (
        <text
          x={offPlaneHint.x}
          y={offPlaneHint.y - 8}
          fill={VIEWER_TOKENS.positive}
          fontSize={12}
          fontFamily="monospace"
          opacity={0.85}
          textAnchor="middle"
        >
          nerve {offPlaneHint.dir} {offPlaneHint.dist.toFixed(0)}mm — scroll
        </text>
      )}
    </svg>
  );
}
