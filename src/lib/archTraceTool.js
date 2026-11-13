/*
 * archTraceTool — an OPEN-curve arch tracer for the CBCT panoramic, built on
 * cornerstone3D's SplineROITool (Catmull-Rom, same control-point editing) but
 * with the trace-end semantics the OPG needs:
 *
 *   - LEFT-click adds points along the dental arch;
 *   - RIGHT-click ENDS the trace as an OPEN curve (no point added);
 *   - double-click ALSO ends it — but, unlike the stock tool, it neither adds
 *     a point at the click position nor CLOSES the contour (the stock
 *     SplineROITool turns a double-click into a closed loop: last point
 *     connected back to the first, which wrecks the panoramic — the curved
 *     MPR needs an open Catmull-Rom curve, never a loop);
 *   - clicking back on the FIRST point (stock "close" gesture) also finishes
 *     the trace open instead of closing it;
 *   - Escape cancels the in-progress trace.
 *
 * On finish, the control points are deduplicated/un-closed (sanitizeArchPoints)
 * and configuration.onTraceFinished(points, annotation) is invoked so the
 * viewer can rebuild the panoramic immediately. After finishing, the curve
 * stays a normal SplineROI annotation: control points remain draggable.
 *
 * LIVE ARCH EDITING — the OPG must not be a frozen image. The tool reports
 * every edit of an EXISTING arch through configuration.onArchEdited(points,
 * { final, annotation }):
 *   - while a control point (or the whole curve) is dragged, fired with
 *     final:false on every drag tick (the viewer debounces + regenerates a
 *     preview panoramic);
 *   - on drag end / control-point add (Shift+Click on the curve, stock
 *     SplineROITool action) / control-point delete (Ctrl+Click on a point),
 *     fired with final:true (the viewer rebuilds full quality and persists).
 * Control points are also rendered ALWAYS (not only while hovered/selected)
 * so the arch is visibly editable; disable with
 * configuration.alwaysShowControlPoints = false.
 *
 * Implemented as a factory because @cornerstonejs/tools is loaded dynamically
 * (see cornerstoneInit.js) — the subclass is created from the loaded module.
 */
import { sanitizeArchPoints } from './curvedMpr';

export const ARCH_TRACE_TOOL_NAME = 'ArchTrace';

const toolCache = new WeakMap();

/**
 * @param {Object} tools  the loaded @cornerstonejs/tools module (or a
 *                        compatible stub providing SplineROITool + Enums)
 * @returns {Function} ArchTraceTool class (cached per module)
 */
export function createArchTraceTool(tools) {
  if (toolCache.has(tools)) return toolCache.get(tools);

  const { SplineROITool } = tools;
  if (!SplineROITool) throw new Error('SplineROITool unavailable — cannot create ArchTraceTool');
  const Events = tools.Enums?.Events || {};
  const MOUSE_DOUBLE_CLICK = Events.MOUSE_DOUBLE_CLICK || 'CORNERSTONE_TOOLS_MOUSE_DOUBLE_CLICK';

  class ArchTraceTool extends SplineROITool {
    static toolName = ARCH_TRACE_TOOL_NAME;

    constructor(toolProps = {}) {
      super(toolProps);

      const baseMouseDown = this._mouseDownCallback;
      const baseEnd = this._endCallback;
      const baseKeyDown = this._keyDownCallback;
      const baseDrag = this._dragCallback;
      const baseAddControlPoint = this.addControlPointCallback;
      const baseDeleteControlPoint = this.deleteControlPointCallback;

      // End of any interaction: force the contour OPEN and, when a NEW trace
      // just finished drawing, sanitize the points and notify the viewer.
      // When an EXISTING arch was edited (control point dragged / whole curve
      // moved), notify onArchEdited with final:true so the viewer rebuilds the
      // panoramic at full quality and persists the edit.
      this._endCallback = (evt) => {
        const editData = this.editData;
        const annotation = editData?.annotation;
        const finishedNewTrace = !!editData?.newAnnotation;
        const editedExisting = !finishedNewTrace && !!editData?.hasMoved;
        baseEnd(evt);
        if (!annotation) return;
        this._forceOpenContour(annotation);
        if (finishedNewTrace) {
          const points = sanitizeArchPoints(annotation.data?.handles?.points || []);
          if (points.length) {
            annotation.data.handles.points = points;
            annotation.invalidated = true;
          }
          try {
            this.configuration?.onTraceFinished?.(points, annotation);
          } catch (e) {
            console.warn('[ArchTraceTool] onTraceFinished failed:', e?.message);
          }
        } else if (editedExisting) {
          this._notifyArchEdited(annotation, true); // drag end — final quality
        }
      };

      // Live preview while dragging a control point (or the whole curve) of an
      // EXISTING arch. Drawing a brand-new trace must NOT spam regenerations —
      // onTraceFinished covers that once the trace ends.
      this._dragCallback = (evt) => {
        baseDrag?.(evt);
        const editData = this.editData;
        const annotation = editData?.annotation;
        if (!annotation || editData.newAnnotation) return;
        this._notifyArchEdited(annotation, false);
      };

      // Stock SplineROITool actions: Shift+Click on the curve adds a control
      // point, Ctrl+Click on a point removes it. Wrap both so the panoramic
      // follows immediately (final quality — these are discrete edits).
      this.addControlPointCallback = (evt, annotation) => {
        const before = annotation?.data?.handles?.points?.length ?? 0;
        baseAddControlPoint?.call(this, evt, annotation);
        const after = annotation?.data?.handles?.points?.length ?? 0;
        if (after > before) this._notifyArchEdited(annotation, true);
      };
      this.deleteControlPointCallback = (evt, annotation) => {
        const before = annotation?.data?.handles?.points?.length ?? 0;
        baseDeleteControlPoint?.call(this, evt, annotation);
        const after = annotation?.data?.handles?.points?.length ?? 0;
        if (after < before) this._notifyArchEdited(annotation, true);
      };

      this._mouseDownCallback = (evt) => {
        const detail = evt?.detail || {};
        const isDoubleClick = evt?.type === MOUSE_DOUBLE_CLICK;
        // cornerstone eventDetail.mouseButton mirrors MouseEvent.buttons
        // (bitmask: 2 = secondary/right button).
        const isRightClick = (detail.mouseButton & 2) === 2 ||
          (detail.event?.buttons & 2) === 2 || detail.event?.button === 2;
        if (isRightClick || isDoubleClick) {
          // END the trace as an open curve — never add a point, never close.
          this.finishOpenTrace(evt);
          evt.preventDefault?.();
          detail.event?.preventDefault?.();
          return;
        }
        baseMouseDown(evt);
        // The stock tool closes the loop when the click lands on the first
        // control point; if that happened, the wrapped _endCallback above has
        // already reopened it — this is just belt-and-braces for paths that
        // set `closed` without ending.
        const annotation = this.editData?.annotation;
        if (annotation) this._forceOpenContour(annotation);
      };

      this._keyDownCallback = (evt) => {
        const key = evt?.detail?.key ?? '';
        if (key === 'Escape' || key === 'Esc') {
          this.cancel(evt.detail.element);
          evt.preventDefault?.();
          return;
        }
        baseKeyDown(evt);
      };
    }

    // Notify the viewer that an EXISTING arch changed (drag tick, drag end,
    // point added/removed). Points are passed as a sanitized COPY — the live
    // handles array is never replaced mid-drag (the drag references it by
    // index).
    _notifyArchEdited(annotation, final) {
      const cb = this.configuration?.onArchEdited;
      if (typeof cb !== 'function') return;
      const points = sanitizeArchPoints(annotation?.data?.handles?.points || []);
      if (points.length < 3) return;
      try {
        cb(points, { final: !!final, annotation });
      } catch (e) {
        console.warn('[ArchTraceTool] onArchEdited failed:', e?.message);
      }
    }

    // The stock SplineROITool only draws control points while the annotation
    // is highlighted/being drawn. The arch must LOOK editable after the trace
    // (the owner refines it live), so render its points always.
    renderAnnotationInstance(renderContext) {
      const annotation = renderContext?.annotation;
      const show = this.configuration?.alwaysShowControlPoints !== false;
      if (!annotation || !show || annotation.highlighted) {
        return super.renderAnnotationInstance(renderContext);
      }
      annotation.highlighted = true; // handle-draw condition only; style was already resolved
      try {
        return super.renderAnnotationInstance(renderContext);
      } finally {
        annotation.highlighted = false;
      }
    }

    /**
     * Materialize an arch (e.g. the auto-detected one) as a real ArchTrace
     * annotation on a viewport so its control points are visible and
     * DRAGGABLE — the auto OPG must be refinable exactly like a manual trace.
     * Reuses the stock SplineROITool.hydrate, then re-opens the contour (the
     * stock hydrate closes it; the arch must stay an OPEN curve).
     *
     * @param {string} viewportId  target viewport (the axial pane)
     * @param {number[][]} pointsWorld  >= 3 world control points
     * @param {Object} [options]  { toolInstance, annotationUID, ... }
     * @returns {Object|null} the created annotation, or null
     */
    static hydrateArch(viewportId, pointsWorld, options = {}) {
      const points = sanitizeArchPoints(pointsWorld || []);
      if (points.length < 3) return null;
      const annotationUID = options.annotationUID ||
        `arch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const hydrate = this.hydrate;
      if (typeof hydrate !== 'function') return null;
      try {
        hydrate(viewportId, points.map((p) => [...p]), {
          ...options,
          annotationUID,
          toolInstance: options.toolInstance || new this(),
        });
      } catch (e) {
        console.warn('[ArchTraceTool] hydrateArch failed:', e?.message);
        return null;
      }
      const annotation = tools.annotation?.state?.getAnnotation?.(annotationUID);
      if (!annotation) return null;
      // Stock hydrate closes the contour — the arch is OPEN by definition.
      if (annotation.data?.contour) annotation.data.contour.closed = false;
      if (annotation.data?.handles) annotation.data.handles.activeHandleIndex = null;
      annotation.invalidated = true;
      return annotation;
    }

    // The arch is an open curve by definition — undo any closure.
    _forceOpenContour(annotation) {
      const contour = annotation?.data?.contour;
      if (contour && contour.closed) {
        contour.closed = false;
        annotation.invalidated = true;
      }
      const spline = annotation?.data?.spline?.instance;
      if (spline && spline.closed) {
        try { spline.closed = false; } catch (_) { /* readonly impl */ }
      }
    }

    /**
     * Finish the in-progress trace as an OPEN curve (right-click / dblclick).
     * With fewer than 3 points there is no usable arch — cancel instead.
     */
    finishOpenTrace(evt) {
      const editData = this.editData;
      const annotation = editData?.annotation;
      if (!annotation) return;
      const element = evt?.detail?.element;
      const points = sanitizeArchPoints(annotation.data?.handles?.points || []);
      if (points.length < 3) {
        if (element) this.cancel(element);
        return;
      }
      annotation.data.handles.points = points;
      this._forceOpenContour(annotation);
      annotation.invalidated = true;
      this._endCallback(evt); // wrapped: keeps it open + fires onTraceFinished
    }
  }

  toolCache.set(tools, ArchTraceTool);
  return ArchTraceTool;
}
