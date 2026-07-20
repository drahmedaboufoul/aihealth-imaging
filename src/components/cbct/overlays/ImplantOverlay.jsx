/*
 * ImplantOverlay — implant cylinder overlays for a single MPR viewport.
 * Each implant has an apex (deep, in bone) and head (crestal, at the gum
 * line); we draw the axis as a thick blue line and a circle at each end.
 * Red if too close to the nerve safety zone, blue otherwise.
 *
 * Extracted from CBCTViewerPage.jsx during the A0 monolith split — pure
 * move, no behavior change.
 */
import { useEffect, useState } from 'react';
import { cornerstone } from '../../../lib/cornerstoneInit';
import { segmentToPolylineDistance } from '../cbctMath';
import { VIEWER_TOKENS } from '../../viewer/viewerTokens';

export default function ImplantOverlay({ viewportId, engine, implants, pendingApex, nervePoints, safetyZoneMM }) {
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

  if (!engine) return null;
  const vp = engine.getViewport(viewportId);
  if (!vp || !vp.element) return null;
  const rect = vp.element.getBoundingClientRect();
  const containerRect = vp.element.parentElement?.getBoundingClientRect();
  if (!containerRect) return null;
  const top = rect.top - containerRect.top;
  const left = rect.left - containerRect.left;

  // pixels-per-mm for diameter rendering
  let pxPerMM = 1;
  try {
    const parallelScale = vp.getCamera?.()?.parallelScale;
    if (parallelScale && rect.height) {
      pxPerMM = (rect.height / 2) / parallelScale;
    }
  } catch {}

  const project = (w) => {
    try { return vp.worldToCanvas(w); } catch { return null; }
  };

  return (
    <svg
      className="absolute pointer-events-none"
      style={{ top, left, width: rect.width, height: rect.height }}
    >
      {implants.map((imp) => {
        const a = project(imp.apex);
        const h = project(imp.head);
        if (!a || !h) return null;
        const tooClose = nervePoints.length >= 2 &&
          segmentToPolylineDistance(imp.apex, imp.head, nervePoints) < safetyZoneMM;
        const strokeColor = tooClose ? VIEWER_TOKENS.danger : VIEWER_TOKENS.accent;
        const widthPx = Math.max(2, imp.diameterMM * pxPerMM);
        return (
          <g key={imp.id} opacity={0.85}>
            {/* Cylinder body — thick translucent stroke at implant diameter */}
            <line
              x1={a[0]} y1={a[1]} x2={h[0]} y2={h[1]}
              stroke={strokeColor}
              strokeWidth={widthPx}
              strokeLinecap="round"
              opacity={0.25}
            />
            {/* Axis line */}
            <line
              x1={a[0]} y1={a[1]} x2={h[0]} y2={h[1]}
              stroke={strokeColor}
              strokeWidth={2}
            />
            {/* Apex (deep) — solid */}
            <circle cx={a[0]} cy={a[1]} r={4} fill={strokeColor} stroke={VIEWER_TOKENS.bgPrimary} strokeWidth={1.2} />
            {/* Head (crestal) — outlined */}
            <circle cx={h[0]} cy={h[1]} r={5} fill={VIEWER_TOKENS.bgPrimary} stroke={strokeColor} strokeWidth={2} />
            {/* Label */}
            <text
              x={(a[0] + h[0]) / 2 + 8}
              y={(a[1] + h[1]) / 2}
              fill={strokeColor}
              fontSize={12}
              fontFamily="monospace"
            >
              {imp.label}
            </text>
          </g>
        );
      })}
      {/* Pending apex marker (between click 1 and click 2) */}
      {pendingApex && (() => {
        const p = project(pendingApex);
        if (!p) return null;
        return (
          <g>
            <circle cx={p[0]} cy={p[1]} r={6} fill="none" stroke={VIEWER_TOKENS.accent} strokeWidth={2} strokeDasharray="3 2" />
            <text x={p[0] + 8} y={p[1]} fill={VIEWER_TOKENS.accent} fontSize={12} fontFamily="monospace">apex</text>
          </g>
        );
      })()}
    </svg>
  );
}
