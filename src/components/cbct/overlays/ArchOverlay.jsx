/*
 * ArchOverlay — SVG overlay drawn above the axial Pano viewport showing
 * the user's arch control points and the Catmull-Rom spline through them.
 * Re-renders on every archPoints change via cornerstone CAMERA_MODIFIED
 * (so pan/zoom on axial keep the overlay aligned).
 *
 * Extracted from CBCTViewerPage.jsx during the A0 monolith split — pure
 * move, no behavior change.
 */
import { useEffect, useRef, useState } from 'react';
import { cornerstone } from '../../../lib/cornerstoneInit';
import { densifyArch } from '../../../lib/archPano';
import { VIEWER_TOKENS } from '../../viewer/viewerTokens';

export default function ArchOverlay({ viewportId, engine, archPoints }) {
  const [, force] = useState(0);
  const svgRef = useRef(null);

  // Listen for camera modifications so we re-project world points to
  // canvas coords (zoom/pan/scroll keeps the overlay accurate).
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

  if (!engine || archPoints.length === 0) return null;
  const vp = engine.getViewport(viewportId);
  if (!vp || !vp.element) return null;
  const rect = vp.element.getBoundingClientRect();
  const containerRect = vp.element.parentElement?.getBoundingClientRect();
  if (!containerRect) return null;
  const offsetTop  = rect.top  - containerRect.top;
  const offsetLeft = rect.left - containerRect.left;

  // Arch points are stored as 2D [x, y] on the axial plane the user
  // clicked. We give them the CURRENT focal Z so projection works on
  // axial. The PANO_AXIAL viewport (where this overlay is mounted) is
  // always axial, so this gives the correct on-slice render.
  const project = (worldXY) => {
    try {
      const camera = vp.getCamera();
      const z = camera?.focalPoint?.[2] ?? 0;
      return vp.worldToCanvas([worldXY[0], worldXY[1], z]);
    } catch {
      return null;
    }
  };
  const projected = archPoints.map(project).filter(Boolean);
  if (projected.length === 0) return null;

  // Build a smooth Catmull-Rom path through projected points
  const splinePoints =
    archPoints.length >= 2
      ? densifyArch(archPoints, 120)
          .map((s) => project([s.x, s.y]))
          .filter(Boolean)
      : [];
  const pathD = splinePoints.length
    ? 'M ' + splinePoints.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ')
    : '';

  return (
    <svg
      ref={svgRef}
      className="absolute pointer-events-none"
      style={{
        top: offsetTop, left: offsetLeft,
        width: rect.width, height: rect.height,
      }}
    >
      {pathD && (
        <path
          d={pathD}
          fill="none"
          stroke={VIEWER_TOKENS.accent}
          strokeWidth={2}
          strokeDasharray="0"
          opacity={0.9}
        />
      )}
      {projected.map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r={5} fill={VIEWER_TOKENS.accent} stroke={VIEWER_TOKENS.bgPrimary} strokeWidth={1.5} />
          <text x={x + 8} y={y - 8} fill={VIEWER_TOKENS.accent} fontSize={12} fontFamily="monospace">
            {i + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}
