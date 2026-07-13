/*
 * aiOverlay — pure geometry + presentation helpers for the 2D AI diagnosis
 * overlay. Kept framework-free so the coordinate math is unit-testable
 * without a browser or Cornerstone.
 *
 * The AI returns each finding's box normalized to the image it saw (0..1,
 * origin top-left). The viewer captured that image from the Cornerstone
 * canvas at a known display size, so a normalized box maps to canvas (CSS)
 * pixels by multiplying by the capture-time canvas size. We then anchor each
 * box to WORLD coordinates (via the viewport's canvasToWorld at capture time)
 * so the boxes track the anatomy through later zoom / pan / rotate — the box
 * is re-projected with worldToCanvas on every camera change.
 */

// Severity → accent color. Deep pink reserved for the highest-severity flags.
export const SEVERITY_COLORS = {
  high: '#EF4444',
  moderate: '#F59E0B',
  low: '#3B82F6',
};

export function severityColor(severity) {
  return SEVERITY_COLORS[severity] || SEVERITY_COLORS.low;
}

// Human-readable label for a finding type slug.
const TYPE_LABELS = {
  caries: 'Caries',
  periapical_radiolucency: 'Periapical radiolucency',
  bone_loss: 'Bone loss',
  calculus: 'Calculus',
  defective_restoration: 'Defective restoration',
  impaction: 'Impaction',
  retained_root: 'Retained root',
  widened_pdl: 'Widened PDL',
  furcation_involvement: 'Furcation involvement',
  root_resorption: 'Root resorption',
  // CBCT-reader vocabulary (ai-read-cbct) — the overlapping slugs above
  // (impaction, periapical_radiolucency, retained_root, bone_loss) are shared.
  caries_suspect: 'Caries (suspect)',
  sinus_involvement: 'Sinus involvement',
  missing_tooth: 'Missing tooth',
  supernumerary: 'Supernumerary tooth',
  other: 'Finding',
};

export function typeLabel(type) {
  return TYPE_LABELS[type] || 'Finding';
}

/**
 * Convert a normalized box {x,y,w,h} (0..1) to the four corner points in
 * canvas (CSS) pixels, given the capture-time canvas display size.
 * Returns [tl, tr, br, bl] as [x,y] pairs.
 */
export function boxToCanvasCorners(box, canvasWidth, canvasHeight) {
  const x0 = box.x * canvasWidth;
  const y0 = box.y * canvasHeight;
  const x1 = (box.x + box.w) * canvasWidth;
  const y1 = (box.y + box.h) * canvasHeight;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/**
 * Anchor a finding's normalized box to world coordinates using the viewport's
 * canvasToWorld at capture time. Must be called synchronously right after the
 * findings arrive, before the camera can change. Returns the finding with a
 * `worldCorners` array ([[x,y,z]×4]) added.
 *
 * `viewport` needs a canvasToWorld([x,y]) → [x,y,z] method (Cornerstone3D).
 * `canvasWidth/Height` are the CSS-pixel display size used at capture.
 */
export function anchorFindingToWorld(finding, viewport, canvasWidth, canvasHeight) {
  const corners = boxToCanvasCorners(finding.box, canvasWidth, canvasHeight);
  const worldCorners = corners.map((c) => viewport.canvasToWorld(c));
  return { ...finding, worldCorners };
}

/**
 * Re-project world-anchored corners to the current canvas via worldToCanvas,
 * and return an axis-aligned screen rect { left, top, width, height } plus the
 * raw projected corners (for drawing a rotated quad if desired).
 *
 * Returns null if the projection is unusable (non-finite).
 */
export function projectAnchoredBox(worldCorners, viewport) {
  if (!Array.isArray(worldCorners) || worldCorners.length < 4) return null;
  const pts = worldCorners.map((w) => viewport.worldToCanvas(w));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if (xs.some((v) => !Number.isFinite(v)) || ys.some((v) => !Number.isFinite(v))) return null;
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { left, top, width: right - left, height: bottom - top, points: pts };
}
