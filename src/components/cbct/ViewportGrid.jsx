/*
 * ViewportGrid — the CBCT viewer's center area: per-mode viewport layouts
 * (2×2 grid / side-by-side / arch-pano / cross-sections), SVG overlays,
 * label chips + slice HUD, and the loading / converting / error overlays.
 *
 * Extracted from CBCTViewerPage.jsx during the A0 monolith split.
 *
 * W2 (audit finding #16): loading, converting, and error are now typed
 * states — converting auto-polls with a retry CTA, errors render typed
 * guidance instead of a raw <pre> dump.
 *
 * W7: the floating arch-trace / cross-section settings cards moved into
 * the context panel's Plan tab — the viewport area carries no floating
 * control cards anymore.
 * W5/W8: semantic tokens, 12px HUD floor, image-rendering: auto on the
 * medical canvases, z-layer tokens.
 */
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import {
  VIEW_MODES,
  VIEWPORTS,
  VIEWPORT_COLORS,
  CROSSSEC_COUNT,
} from './cbctViewModes';
import { VIEWER_TOKENS } from '../viewer/viewerTokens';
import ArchOverlay from './overlays/ArchOverlay';
import NerveOverlay from './overlays/NerveOverlay';
import ImplantOverlay from './overlays/ImplantOverlay';

export default function ViewportGrid({
  stage,
  error,
  progress,
  onRetry,
  onOpen2D,
  onGoHome,
  viewMode,
  onSwitchMode,
  engine,
  viewportRefs,
  panoCanvasRef,
  xsCanvasRefs,
  sliceHud,
  nervePoints,
  safetyZoneMM,
  nerveSlabMM,
  implants,
  pendingApex,
  archPoints,
  tracingArch,
  readOnly,
  panoRenderError,
  studyId,
}) {
  return (
    <div className="flex-1 relative">
      {stage !== 'ready' && (
        <div className="absolute inset-0 flex items-center justify-center z-header" style={{ backgroundColor: VIEWER_TOKENS.scrim }}>
          {stage === 'error' ? (
            <ErrorState
              error={error}
              studyId={studyId}
              onRetry={onRetry}
              onOpen2D={onOpen2D}
              onGoHome={onGoHome}
            />
          ) : stage === 'converting' ? (
            <ConvertingState studyId={studyId} onRetry={onRetry} onOpen2D={onOpen2D} />
          ) : (
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={28} className="animate-spin text-accent" />
              <p className="text-sm text-labels-secondary">
                {stage === 'resolving' && 'Resolving CBCT instances…'}
                {stage === 'loading-volume' && (progress > 0 ? `Loading volume (${progress}%)…` : 'Streaming volume…')}
                {stage === 'init' && 'Initialising…'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Arch-curve Pano gets its own layout: axial-with-tracer (left)
          + custom rendered <canvas> for the reformatted pano (right).
          Falls through to the standard grid for other modes. */}
      {viewMode === 'pano' && (
        <div className="grid grid-cols-2 gap-px h-full bg-separator-s1">
          {/* Cell 1: axial Cornerstone viewport with arch-point overlay */}
          <div className="relative bg-background-primary">
            <div
              ref={viewportRefs[0]}
              className="w-full h-full"
              onContextMenu={(e) => e.preventDefault()}
            />
            <div
              className="absolute top-2 left-2 text-xs font-mono uppercase tracking-wider px-1.5 py-0.5 rounded pointer-events-none"
              style={{ backgroundColor: VIEWER_TOKENS.hudChip, color: VIEWPORT_COLORS.axial, borderLeft: `2px solid ${VIEWPORT_COLORS.axial}` }}
            >
              Axial {tracingArch ? '· TRACING — click to add points' : '· enable Trace Arch (tool strip)'}
            </div>
            {/* SVG overlay for arch points + spline preview */}
            <ArchOverlay
              viewportId="PANO_AXIAL"
              engine={engine}
              archPoints={archPoints}
            />
          </div>
          {/* Cell 2: pano canvas (custom render) */}
          <div className="relative flex items-center justify-center overflow-hidden bg-background-primary">
            {/*
              The canvas backing buffer is 900×400 (set by renderArchPano).
              Without an explicit display width/height, items-center +
              justify-center will collapse it because max-w-full picks
              its content-box width from a zero flex sibling and the
              image renders into a 1px-wide strip.
              width:100% + height:auto + object-fit:contain lets it
              scale up to the full half-column while preserving the
              pano's aspect ratio.
            */}
            <canvas
              ref={panoCanvasRef}
              className="w-full h-full"
              style={{ imageRendering: 'auto', objectFit: 'contain', maxWidth: '100%', maxHeight: '100%' }}
            />
            {archPoints.length < 3 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center max-w-sm px-4">
                  <div className="text-accent text-xs uppercase tracking-wider mb-2">Trace the arch</div>
                  <p className="text-labels-secondary text-sm leading-relaxed">
                    Click <span className="text-accent font-semibold">Trace Arch</span> in the
                    tool strip (or the Plan tab), then click at least 3 points along the
                    midline of the dental arch on axial
                    (anterior → premolar → molar → posterior).
                  </p>
                </div>
              </div>
            )}
            {archPoints.length >= 3 && panoRenderError && (
              <div className="absolute inset-0 flex items-center justify-center p-4">
                <div className="max-w-md text-sm rounded-lg p-3 bg-status-danger-soft text-labels-primary">
                  <div className="font-semibold uppercase tracking-wider mb-1 text-status-danger">
                    Pano render failed
                  </div>
                  <div className="text-xs leading-relaxed">{panoRenderError}</div>
                  <div className="mt-2 text-xs text-labels-secondary">
                    Open the browser console — the line starting with <code>[pano] render attempt</code> shows
                    which volume access path returned null. Share that line so we can patch the right fallback.
                  </div>
                </div>
              </div>
            )}
            <div
              className="absolute top-2 left-2 text-xs font-mono uppercase tracking-wider px-1.5 py-0.5 rounded pointer-events-none"
              style={{ backgroundColor: VIEWER_TOKENS.hudChip, color: VIEWPORT_COLORS.sagittal, borderLeft: `2px solid ${VIEWPORT_COLORS.sagittal}` }}
            >
              Pano (reformatted)
            </div>
          </div>
        </div>
      )}

      {/* Cross-sections layout: 4×4 grid of perpendicular slices */}
      {viewMode === 'crosssec' && (
        <div className="h-full w-full overflow-auto p-2 bg-background-tertiary">
          {archPoints.length < 3 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center max-w-md px-4">
                <div className="text-accent text-xs uppercase tracking-wider mb-2">Trace the arch first</div>
                <p className="text-labels-secondary text-sm leading-relaxed">
                  Cross-sections sample perpendicular to the arch curve. Go to <b>Pano</b> view first
                  and click ≥3 points along the dental arch with Trace Arch enabled, then come back here.
                </p>
                <button
                  onClick={() => onSwitchMode('pano')}
                  className="mt-4 text-sm px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white transition-[background-color] duration-150"
                >
                  Go to Pano view
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-1.5">
              {Array.from({ length: CROSSSEC_COUNT }).map((_, i) => (
                <div
                  key={i}
                  className="relative rounded-lg overflow-hidden bg-background-primary"
                >
                  <canvas
                    ref={(el) => { xsCanvasRefs.current[i] = el; }}
                    className="w-full block"
                    style={{ imageRendering: 'auto', aspectRatio: '2 / 3' }}
                  />
                  <div
                    className="absolute top-1 left-1 text-xs font-mono px-1 py-0.5 rounded pointer-events-none"
                    style={{ backgroundColor: VIEWER_TOKENS.hudChipStrong, color: VIEWPORT_COLORS.sagittal }}
                  >
                    {i + 1}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Standard view layouts (everything except arch-pano and arch-crosssec) */}
      {(viewMode !== 'pano' && viewMode !== 'crosssec') && (
        <div
          className={
            VIEW_MODES[viewMode]?.layout === 'side-by-side'
              ? 'grid grid-cols-2 gap-px h-full bg-separator-s1'
              : 'grid grid-cols-2 grid-rows-2 gap-px h-full bg-separator-s1'
          }
        >
          {/* Render up to 4 cells. Each cell is bound to one of the 4
              persistent refs (axial / coronal / sagittal / vr). The
              CURRENT view mode's viewports[i] defines the label / color
              for cell i. Cells beyond viewports.length are hidden so
              modes with <4 panels (Ceph) get a clean side-by-side. */}
          {viewportRefs.map((ref, idx) => {
            const cfg = VIEW_MODES[viewMode]?.viewports?.[idx];
            const hidden = !cfg;
            const v = cfg || VIEWPORTS[idx];
            const hud = cfg ? sliceHud[cfg.id] : null;
            return (
              <div
                key={idx}
                className="relative bg-background-primary"
                style={{ display: hidden ? 'none' : undefined }}
              >
                <div
                  ref={ref}
                  className="w-full h-full"
                  onContextMenu={(e) => e.preventDefault()}
                />
                {cfg && (
                  <div
                    className="absolute top-2 left-2 text-xs font-mono uppercase tracking-wider px-1.5 py-0.5 rounded pointer-events-none"
                    style={{
                      backgroundColor: VIEWER_TOKENS.hudChip,
                      color: v.color,
                      borderLeft: `2px solid ${v.color}`,
                    }}
                  >
                    {v.label}
                  </div>
                )}
                {hud && (
                  <div
                    className="absolute top-2 right-2 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded pointer-events-none"
                    style={{
                      backgroundColor: VIEWER_TOKENS.hudChipStrong,
                      color: VIEWER_TOKENS.labelPrimary,
                    }}
                  >
                    {hud.current} / {hud.total}
                  </div>
                )}
                {/* Nerve canal polyline + safety zone overlay
                    (only on MPR ortho viewports, hidden on 3D) */}
                {cfg && cfg.kind === 'orthographic' && nervePoints.length >= 2 && (
                  <NerveOverlay
                    viewportId={cfg.id}
                    engine={engine}
                    nervePoints={nervePoints}
                    safetyZoneMM={safetyZoneMM}
                    slabHalfMM={nerveSlabMM / 2}
                  />
                )}
                {/* Implant cylinder overlays */}
                {cfg && cfg.kind === 'orthographic' && implants.length > 0 && (
                  <ImplantOverlay
                    viewportId={cfg.id}
                    engine={engine}
                    implants={implants}
                    pendingApex={pendingApex}
                    nervePoints={nervePoints}
                    safetyZoneMM={safetyZoneMM}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Converting state (W2) — the study's NIfTI conversion is queued or in
 * progress. The volume hook auto-polls; the user can also retry manually
 * or fall back to the 2D stack viewer.
 */
function ConvertingState({ studyId, onRetry, onOpen2D }) {
  return (
    <div className="max-w-md text-center px-6">
      <Loader2 size={28} className="mx-auto animate-spin text-accent mb-3" />
      <h2 className="text-sm font-semibold text-labels-primary mb-2">Converting volume for 3D…</h2>
      <p className="text-sm text-labels-secondary leading-relaxed">
        The server is preparing this CBCT for volume rendering — this usually takes a few
        minutes. This page checks again automatically; you can also retry now or open the
        2D stack in the meantime.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <button
          onClick={onRetry}
          className="text-sm px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white flex items-center gap-1.5 transition-[background-color] duration-150"
        >
          <RefreshCw size={12} /> Retry now
        </button>
        {studyId && (
          <button
            onClick={onOpen2D}
            className="text-sm px-3 py-1.5 rounded-lg bg-fills-f2 hover:bg-fills-f3 text-labels-primary transition-[background-color] duration-150"
          >
            Open as 2D stack instead
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Typed error state (W2) — replaces the raw <pre> error dump. Each kind
 * gets a human title + recovery guidance; the technical message stays
 * available in a subdued block for support.
 */
function ErrorState({ error, studyId, onRetry, onOpen2D, onGoHome }) {
  const kind = error?.kind || 'generic';
  const copy = {
    'missing-study': {
      title: 'No study specified',
      guidance: 'This viewer opens from an imaging study. Launch it from the imaging worklist, or append ?study=<id> to the URL.',
    },
    'share-expired': {
      title: 'Shared session unavailable',
      guidance: 'This share link has expired, was revoked, or its view limit was reached. Ask the sender to create a new link.',
    },
    'not-found': {
      title: 'Study not found',
      guidance: 'The study may have been removed, or the link is incomplete. Check the imaging worklist and try again.',
    },
    generic: {
      title: 'Could not load CBCT',
      guidance: 'Something went wrong while loading the volume. You can retry, or open the study as a 2D stack instead.',
    },
  }[kind];

  return (
    <div className="max-w-md text-center px-6">
      <AlertCircle size={28} className="mx-auto text-status-danger mb-3" />
      <h2 className="text-sm font-semibold text-labels-primary mb-2">{copy.title}</h2>
      <p className="text-sm text-labels-secondary leading-relaxed mb-3">{copy.guidance}</p>
      {error?.message && (
        <div className="text-xs text-labels-tertiary font-mono whitespace-pre-wrap break-words text-left px-3 py-2 rounded-lg bg-background-tertiary">
          {error.message}
        </div>
      )}
      <div className="mt-4 flex items-center justify-center gap-2">
        {kind === 'generic' && (
          <button
            onClick={onRetry}
            className="text-sm px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-white flex items-center gap-1.5 transition-[background-color] duration-150"
          >
            <RefreshCw size={12} /> Retry
          </button>
        )}
        {(kind === 'generic') && studyId && (
          <button
            onClick={onOpen2D}
            className="text-sm px-3 py-1.5 rounded-lg bg-fills-f2 hover:bg-fills-f3 text-labels-primary transition-[background-color] duration-150"
          >
            Open as 2D stack instead
          </button>
        )}
        {(kind === 'missing-study' || kind === 'not-found') && (
          <button
            onClick={onGoHome}
            className="text-sm px-3 py-1.5 rounded-lg bg-fills-f2 hover:bg-fills-f3 text-labels-primary transition-[background-color] duration-150"
          >
            Back to home
          </button>
        )}
      </div>
    </div>
  );
}
