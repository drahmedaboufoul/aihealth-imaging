/*
 * PromotePlanModal — Phase 3.6.2 "Promote to Treatment Plan" dialog.
 *
 * Rebuilt on the repo's Radix ui/dialog (audit W1, findings #3/#4): focus
 * trap, Escape handling, aria wiring, and a safe backdrop — the original
 * hand-rolled overlay had no dialog semantics and dismissed a financial
 * form mid-entry on backdrop click. Mutation failures now render in an
 * inline error slot instead of a native alert().
 */
import { Loader2, Cylinder } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export default function PromotePlanModal({
  open,
  onOpenChange,
  promoting,
  error,
  result,
  title,
  onTitleChange,
  feePerImplant,
  onFeeChange,
  implants,
  onCreate,
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!promoting) onOpenChange(v); }}>
      <DialogContent
        hideClose={promoting}
        onPointerDownOutside={(e) => { if (promoting) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (promoting) e.preventDefault(); }}
        className="max-w-md gap-0 rounded-lg border-separator-s1 bg-background-secondary p-5 text-sm text-labels-primary"
      >
        <DialogHeader className="mb-3 flex flex-row items-center gap-2 space-y-0 text-left">
          <Cylinder size={18} className="text-accent" />
          <DialogTitle className="text-base font-semibold text-white">Promote to Treatment Plan</DialogTitle>
        </DialogHeader>
        {!result ? (
          <>
            <DialogDescription className="text-labels-secondary text-xs leading-relaxed mb-3">
              Creates a formal treatment plan in the EMR linked to this CBCT.
              Plan can then be priced, sent to the patient for acceptance, and
              flow into billing. You'll be able to refine in the EMR after creating.
            </DialogDescription>
            <div className="space-y-3">
              <div>
                <label className="text-xs uppercase tracking-wider text-labels-tertiary block mb-1">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => onTitleChange(e.target.value)}
                  className="w-full text-sm px-2 py-1.5 rounded bg-background-tertiary text-labels-primary border border-separator-s1 focus:border-accent"
                />
              </div>
              <div>
                <label className="text-xs uppercase tracking-wider text-labels-tertiary block mb-1">
                  Fee per implant (AED)
                </label>
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={feePerImplant}
                  onChange={(e) => onFeeChange(e.target.value)}
                  className="w-full text-sm px-2 py-1.5 rounded bg-background-tertiary text-labels-primary border border-separator-s1 focus:border-accent font-mono"
                />
                <div className="text-xs text-labels-tertiary mt-1">
                  {implants.length} implant{implants.length > 1 ? 's' : ''} × {feePerImplant} = <span className="text-accent font-mono">{(Number(feePerImplant) || 0) * implants.length} AED</span> total
                </div>
              </div>
              <div className="rounded p-2 text-xs text-labels-secondary bg-background-tertiary border border-separator-s1">
                <div className="font-semibold text-labels-primary mb-1">Plan will include:</div>
                <ul className="space-y-0.5 text-labels-tertiary">
                  {implants.map((imp) => (
                    <li key={imp.id}>· {imp.label}</li>
                  ))}
                </ul>
              </div>
            </div>
            {/* Inline mutation error — the dialog stays open so the user
                can retry instead of losing the form (was a native alert). */}
            {error && (
              <p role="alert" className="mt-3 text-xs text-status-danger leading-snug">
                {error}
              </p>
            )}
            <div className="mt-4 flex gap-2 justify-end">
              <button
                onClick={() => onOpenChange(false)}
                disabled={promoting}
                className="text-xs px-3 py-1.5 rounded bg-fills-f1 hover:bg-fills-f2 text-labels-primary disabled:opacity-50"
              >Cancel</button>
              <button
                onClick={onCreate}
                disabled={promoting || implants.length === 0}
                className="text-xs px-3 py-1.5 rounded bg-accent hover:bg-accent-hover text-white disabled:opacity-50 flex items-center gap-1.5"
              >
                {promoting && <Loader2 size={12} className="animate-spin" />}
                {promoting ? 'Creating…' : 'Create Plan'}
              </button>
            </div>
          </>
        ) : (
          <>
            <DialogDescription className="text-status-success text-sm mb-2">
              ✓ Plan created.
            </DialogDescription>
            <p className="text-labels-secondary text-xs leading-relaxed">
              {result.count} implant{result.count > 1 ? 's' : ''} added · <span className="font-mono">{result.total} AED</span> total.
            </p>
            <p className="text-labels-tertiary text-xs mt-2">
              Visible on the patient profile <span className="text-labels-primary">Treatment Plans</span> tab
              and on the <span className="text-labels-primary">Imaging</span> tab card. You can refine pricing,
              assign tooth numbers, and send to the patient from there.
            </p>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => onOpenChange(false)}
                className="text-xs px-3 py-1.5 rounded bg-fills-f1 hover:bg-fills-f2 text-labels-primary"
              >Close</button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
