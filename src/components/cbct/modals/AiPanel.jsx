/*
 * AiPanel — "AI · CBCT" dialog: live Claude-vision reading on top,
 * segmentation roadmap below.
 *
 * Rebuilt on the repo's Radix ui/dialog (audit W1, finding #4).
 *
 * Safety (audit W3, finding #2): placeholder segmentation models return
 * SYNTHETIC output (model_state: 'placeholder') and are only listed when
 * the ENABLE_PLACEHOLDER_AI_MODELS dev flag is on. Synthetic results are
 * badged SIMULATED and are NEVER auto-applied to clinical overlays — a
 * real (non-simulated) result only lands on the viewer when the user
 * explicitly clicks "Apply to viewer".
 */
import { Loader2, Sparkles, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { severityColor, typeLabel } from '../../../lib/aiOverlay';
import { ENABLE_PLACEHOLDER_AI_MODELS } from '../../../lib/featureFlags';

export default function AiPanel({
  open,
  onOpenChange,
  canRunAi,
  aiReadStage,
  aiReadError,
  aiReadResult,
  onRunVision,
  placeholderFeatures,
  plannedFeatures,
  onApplyResult,
  onDismissResult,
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-lg gap-0 rounded-lg border-separator-s1 bg-background-secondary p-5 text-sm text-labels-primary max-h-[85vh] overflow-y-auto"
      >
        <DialogHeader className="mb-3 flex flex-row items-center gap-2 space-y-0 text-left">
          <Sparkles size={18} className="text-status-ai" />
          <DialogTitle className="text-base font-semibold text-white">AI · CBCT</DialogTitle>
        </DialogHeader>

        {/* Live Claude-vision reading — captures the panes on screen and
            returns ranked findings. Needs a real study id (the edge
            function RLS-checks + persists against the study row). */}
        {canRunAi && (
          <div className="rounded border border-separator-s1 p-3 mb-3 text-xs">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-labels-primary font-medium flex items-center gap-1.5">
                <Sparkles size={12} className="text-status-ai" /> AI read (vision)
              </span>
              <button
                onClick={onRunVision}
                disabled={aiReadStage === 'running'}
                className="text-xs px-2 py-0.5 rounded bg-status-ai hover:bg-status-ai-hover disabled:opacity-50 text-white flex items-center gap-1"
              >
                {aiReadStage === 'running'
                  ? <><Loader2 size={10} className="animate-spin" /> Analyzing…</>
                  : (aiReadResult ? 'Re-analyze' : 'Run')}
              </button>
            </div>
            <p className="text-labels-tertiary text-xs leading-snug">
              Captures the panes currently on screen and asks the CBCT reader for
              ranked findings. Switch view mode first to change what the AI sees.
            </p>

            {aiReadStage === 'error' && (
              <p role="alert" className="text-xs text-status-danger mt-2 leading-snug">{aiReadError}</p>
            )}

            {aiReadStage === 'done' && aiReadResult && (
              <>
                {(aiReadResult.findings || []).length === 0 ? (
                  <p className="text-xs text-labels-secondary mt-2 leading-snug">
                    No clearly abnormal findings flagged.{aiReadResult.summary ? ` ${aiReadResult.summary}` : ''}
                  </p>
                ) : (
                  <>
                    {aiReadResult.summary && (
                      <p className="text-xs text-labels-secondary mt-2 leading-snug">{aiReadResult.summary}</p>
                    )}
                    <div className="mt-2 space-y-1 max-h-56 overflow-y-auto">
                      {(aiReadResult.findings || []).map((f, i) => {
                        const color = severityColor(f.severity);
                        return (
                          <div key={i} className="rounded px-1.5 py-1 flex items-start gap-1.5 bg-background-tertiary">
                            <span
                              className="mt-0.5 text-xs font-bold w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                              style={{ backgroundColor: color, color: '#121212' }}
                            >
                              {i + 1}
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="flex items-center justify-between gap-1">
                                <span className="text-xs text-labels-primary font-medium truncate">
                                  {typeLabel(f.type)}{f.tooth ? ` · ${f.tooth}` : ''}{f.region ? ` · ${f.region}` : ''}
                                </span>
                                <span className="text-xs font-mono tabular-nums" style={{ color }}>
                                  {Math.round((f.confidence || 0) * 100)}%
                                </span>
                              </span>
                              <span className="block text-xs text-labels-tertiary leading-snug">{f.description}</span>
                              {Array.isArray(f.view_refs) && f.view_refs.length > 0 && (
                                <span className="block text-xs text-labels-tertiary font-mono mt-0.5">
                                  seen in: {f.view_refs.join(', ')}
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
                {aiReadResult.limitations && (
                  <p className="text-xs text-labels-tertiary mt-1.5 leading-snug">
                    Limitations: {aiReadResult.limitations}
                  </p>
                )}
                <p className="text-xs text-labels-tertiary mt-1.5 leading-tight">
                  {aiReadResult.disclaimer || 'AI-assisted · verify before use. Not a diagnosis.'}
                  {aiReadResult.model ? ` (${aiReadResult.model})` : ''}
                </p>
              </>
            )}
          </div>
        )}

        {/* Placeholder segmentation models — dev flag only. These return
            synthetic geometry; see featureFlags.js. */}
        {ENABLE_PLACEHOLDER_AI_MODELS && placeholderFeatures.length > 0 && (
          <>
            <div className="text-xs uppercase tracking-wider text-labels-tertiary mb-1.5">
              Segmentation models (dev placeholder service)
            </div>
            <div
              role="note"
              className="rounded border border-status-warning/40 bg-status-warning-soft text-status-warning text-xs leading-snug px-2 py-1.5 mb-2 flex items-start gap-1.5"
            >
              <AlertTriangle size={12} className="mt-px shrink-0" />
              <span>
                Dev only: these placeholder models return <b>SIMULATED</b> output
                (model_state: placeholder). Simulated results are never auto-applied
                to clinical overlays.
              </span>
            </div>
            <div className="space-y-2 text-xs mb-3">
              {placeholderFeatures.map((f) => (
                <AiFeature key={f.key} {...f} onApply={onApplyResult} onDismiss={onDismissResult} />
              ))}
            </div>
          </>
        )}

        <div className="text-xs uppercase tracking-wider text-labels-tertiary mb-1.5">
          Segmentation models (roadmap)
        </div>
        <p className="text-labels-secondary text-xs leading-relaxed mb-3">
          Server-side AI models for automated dental analysis. The viewer is wired
          to call these endpoints; the models themselves ship in Phase 4 once we deploy
          the inference service alongside the converter.
        </p>
        <div className="space-y-2 text-xs">
          {plannedFeatures.map((f) => (
            <AiFeature key={f.label} {...f} onApply={onApplyResult} onDismiss={onDismissResult} />
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={() => onOpenChange(false)}
            className="text-xs px-3 py-1.5 rounded bg-fills-f1 hover:bg-fills-f2 text-labels-primary"
          >
            Close
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Single row in the AI panel. Status pill colour-codes whether the feature
 * is planned, a dev placeholder, training, or live. Synthetic results get a
 * SIMULATED badge and no apply path; real results require an explicit
 * "Apply to viewer" click before they touch clinical overlays.
 */
function AiFeature({ featureKey, label, status, desc, onRun, running, lastRun, onApply, onDismiss }) {
  const colors = {
    planned:     'bg-fills-f1 text-labels-tertiary',
    placeholder: 'bg-status-ai-soft text-status-ai',
    training:    'bg-status-warning-soft text-status-warning',
    live:        'bg-status-success-soft text-status-success',
  };
  const canRun = (status === 'placeholder' || status === 'live') && typeof onRun === 'function';
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1">
        <div className="text-labels-primary">{label}</div>
        <div className="text-labels-tertiary text-xs mt-0.5">{desc}</div>
        {lastRun && (
          <div className="text-status-ai text-xs mt-0.5 font-mono">
            ran {new Date(lastRun.ts).toLocaleTimeString()} · {lastRun.result?.model_state || 'placeholder'}
          </div>
        )}
        {lastRun?.simulated && (
          <div className="mt-1 inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-status-warning-soft text-status-warning border border-status-warning/40">
            SIMULATED — not applied
          </div>
        )}
        {lastRun && !lastRun.simulated && lastRun.canApply && (
          <div className="mt-1 flex gap-1">
            <button
              onClick={() => onApply?.(featureKey)}
              className="text-xs px-2 py-0.5 rounded bg-status-success hover:bg-status-success-hover text-white"
            >
              Apply to viewer
            </button>
            <button
              onClick={() => onDismiss?.(featureKey)}
              className="text-xs px-2 py-0.5 rounded bg-fills-f1 hover:bg-fills-f2 text-labels-secondary"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className={`text-xs uppercase tracking-wider px-1.5 py-0.5 rounded ${colors[status] || colors.planned}`}>
          {status}
        </span>
        {canRun && (
          <button
            onClick={onRun}
            disabled={running}
            className="text-xs px-2 py-0.5 rounded bg-status-ai hover:bg-status-ai-hover disabled:opacity-50 text-white"
          >
            {running ? 'Running…' : 'Run'}
          </button>
        )}
      </div>
    </div>
  );
}
