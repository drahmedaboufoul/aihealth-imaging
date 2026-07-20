/*
 * ShareInviteDialog — create a tokenized /viewer/share/<token> link from
 * inside a viewer (the DentalX "Invite" flow, built on imaging_share_invites).
 *
 * Two states: the form, then the generated-link view with copy buttons.
 * Rebuilt on the repo's Radix ui/dialog (audit W8): focus trap, Escape
 * handling, aria wiring; styled on the shared semantic token set.
 */
import { useState } from 'react';
import { Loader2, Copy, Check, Share2, Link as LinkIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  createShareInvite, PERMISSIONS, VALIDITY_UNITS, computeExpiry, isValidEmail,
} from '../lib/shareInvite';

export default function ShareInviteDialog({ studyId, patientName, onClose }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState(7);
  const [unit, setUnit] = useState('days');
  const [maxViews, setMaxViews] = useState(50);
  const [permission, setPermission] = useState('view');
  const [note, setNote] = useState('');
  const [stage, setStage] = useState('form'); // form | creating | done | error
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { token, url, expiresAt }
  const [copied, setCopied] = useState(null); // 'link' | 'all'

  const expiryPreview = computeExpiry(amount, unit);

  const submit = async () => {
    setStage('creating');
    setError(null);
    try {
      const r = await createShareInvite({
        studyId, invitedEmail: email, invitedName: name,
        validityAmount: amount, validityUnit: unit, maxViews, permission, note,
      });
      setResult(r);
      setStage('done');
    } catch (e) {
      setError(e?.message || String(e));
      setStage('error');
    }
  };

  const copy = async (which) => {
    const text = which === 'all'
      ? `${patientName ? patientName + ' — ' : ''}imaging share link\n${result.url}\nExpires ${new Date(result.expiresAt).toLocaleString('en-GB')}`
      : result.url;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* clipboard blocked — user can select manually */ }
  };

  const inputCls =
    'w-full mt-1 px-2 py-1.5 rounded text-sm bg-background-tertiary text-labels-primary border border-separator-s1 focus:border-accent';
  const labelCls = 'text-xs uppercase tracking-wider text-labels-tertiary';

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-md gap-0 rounded-lg border-separator-s1 bg-background-secondary p-0 text-sm text-labels-primary"
      >
        <DialogHeader className="px-4 py-3 border-b border-separator-s1 flex-row items-center space-y-0 text-left">
          <DialogTitle className="text-sm font-semibold flex items-center gap-2">
            <Share2 size={15} className="text-accent" /> Share this study
          </DialogTitle>
        </DialogHeader>

        {stage === 'done' && result ? (
          <div className="p-4 space-y-3">
            <DialogDescription className="flex items-center gap-2 text-status-success text-xs">
              <Check size={14} /> Link created — expires {new Date(result.expiresAt).toLocaleString('en-GB')}
            </DialogDescription>
            <div className="flex items-center gap-2 rounded px-2 py-2 text-xs font-mono break-all bg-background-tertiary border border-separator-s1">
              <LinkIcon size={12} className="text-labels-tertiary shrink-0" />
              <span className="flex-1 min-w-0">{result.url}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => copy('link')}
                className="text-xs py-1.5 rounded bg-accent hover:bg-accent-hover text-white flex items-center justify-center gap-1.5"
              >
                {copied === 'link' ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy link</>}
              </button>
              <button
                onClick={() => copy('all')}
                className="text-xs py-1.5 rounded bg-fills-f1 hover:bg-fills-f2 text-labels-primary flex items-center justify-center gap-1.5"
              >
                {copied === 'all' ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy with details</>}
              </button>
            </div>
            <p className="text-xs text-labels-tertiary leading-snug">
              Anyone with this link can open the study read-only until it expires or the view limit is reached.
              You can revoke it from the study record.
            </p>
            <button onClick={onClose} className="w-full text-xs py-1.5 rounded bg-fills-f1 hover:bg-fills-f2 text-labels-primary">Done</button>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            <label className="block">
              <span className={labelCls}>Recipient email</span>
              <input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@clinic.com" autoFocus
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className={labelCls}>Recipient name (optional)</span>
              <input
                type="text" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Dr Jane Smith"
                className={inputCls}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className={labelCls}>Valid for</span>
                <div className="flex gap-1 mt-1">
                  <input
                    type="number" min={1} value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className={`w-16 !mt-0 ${inputCls}`}
                  />
                  <select
                    value={unit} onChange={(e) => setUnit(e.target.value)}
                    className={`flex-1 !mt-0 ${inputCls}`}
                  >
                    {VALIDITY_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </select>
                </div>
              </div>
              <label className="block">
                <span className={labelCls}>Max views</span>
                <input
                  type="number" min={1} value={maxViews}
                  onChange={(e) => setMaxViews(e.target.value)}
                  className={inputCls}
                />
              </label>
            </div>
            <div>
              <span className={labelCls}>Permission</span>
              <div className="flex gap-1 mt-1">
                {PERMISSIONS.map((p) => (
                  <button
                    key={p.value} onClick={() => setPermission(p.value)}
                    className={`flex-1 text-xs py-1.5 rounded ${permission === p.value ? 'bg-accent text-white' : 'bg-fills-f1 hover:bg-fills-f2 text-labels-primary'}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="block">
              <span className={labelCls}>Note (optional)</span>
              <input
                type="text" value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Second opinion on 46"
                className={inputCls}
              />
            </label>

            <p className="text-xs text-labels-tertiary">Link will expire {new Date(expiryPreview).toLocaleString('en-GB')}.</p>
            {stage === 'error' && <p role="alert" className="text-xs text-status-danger">{error}</p>}

            <button
              onClick={submit}
              disabled={stage === 'creating' || !isValidEmail(email)}
              className="w-full text-sm py-2 rounded bg-accent hover:bg-accent-hover disabled:opacity-50 text-white flex items-center justify-center gap-2 font-medium"
            >
              {stage === 'creating' ? <><Loader2 size={13} className="animate-spin" /> Creating…</> : <><Share2 size={13} /> Create share link</>}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
