/*
 * ShareInviteDialog — create a tokenized /viewer/share/<token> link from
 * inside a viewer (the DentalX "Invite" flow, built on imaging_share_invites).
 *
 * Two states: the form, then the generated-link view with copy buttons.
 */
import { useState } from 'react';
import { Loader2, X, Copy, Check, Share2, Link as LinkIcon } from 'lucide-react';
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md mx-4 rounded-lg shadow-2xl text-sm"
        style={{ backgroundColor: '#15181c', border: '1px solid #1d2128', color: '#cdd2d8' }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: '#1d2128' }}>
          <h2 className="font-semibold flex items-center gap-2">
            <Share2 size={15} className="text-amber-400" /> Share this study
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200"><X size={16} /></button>
        </div>

        {stage === 'done' && result ? (
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2 text-green-400 text-[12px]">
              <Check size={14} /> Link created — expires {new Date(result.expiresAt).toLocaleString('en-GB')}
            </div>
            <div
              className="flex items-center gap-2 rounded px-2 py-2 text-[11px] font-mono break-all"
              style={{ backgroundColor: '#0b0d10', border: '1px solid #1d2128' }}
            >
              <LinkIcon size={12} className="text-gray-500 shrink-0" />
              <span className="flex-1 min-w-0">{result.url}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => copy('link')}
                className="text-[11px] py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white flex items-center justify-center gap-1.5"
              >
                {copied === 'link' ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy link</>}
              </button>
              <button
                onClick={() => copy('all')}
                className="text-[11px] py-1.5 rounded bg-gray-800 hover:bg-gray-700 flex items-center justify-center gap-1.5"
              >
                {copied === 'all' ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy with details</>}
              </button>
            </div>
            <p className="text-[10px] text-gray-500 leading-snug">
              Anyone with this link can open the study read-only until it expires or the view limit is reached.
              You can revoke it from the study record.
            </p>
            <button onClick={onClose} className="w-full text-[11px] py-1.5 rounded bg-gray-800 hover:bg-gray-700">Done</button>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-gray-400">Recipient email</span>
              <input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@clinic.com" autoFocus
                className="w-full mt-1 px-2 py-1.5 rounded text-[12px] bg-gray-900 border border-gray-800 focus:border-amber-600 outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-gray-400">Recipient name (optional)</span>
              <input
                type="text" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Dr Jane Smith"
                className="w-full mt-1 px-2 py-1.5 rounded text-[12px] bg-gray-900 border border-gray-800 focus:border-amber-600 outline-none"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-[10px] uppercase tracking-wider text-gray-400">Valid for</span>
                <div className="flex gap-1 mt-1">
                  <input
                    type="number" min={1} value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-16 px-2 py-1.5 rounded text-[12px] bg-gray-900 border border-gray-800 focus:border-amber-600 outline-none"
                  />
                  <select
                    value={unit} onChange={(e) => setUnit(e.target.value)}
                    className="flex-1 px-1 py-1.5 rounded text-[12px] bg-gray-900 border border-gray-800 focus:border-amber-600 outline-none"
                  >
                    {VALIDITY_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </select>
                </div>
              </div>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-gray-400">Max views</span>
                <input
                  type="number" min={1} value={maxViews}
                  onChange={(e) => setMaxViews(e.target.value)}
                  className="w-full mt-1 px-2 py-1.5 rounded text-[12px] bg-gray-900 border border-gray-800 focus:border-amber-600 outline-none"
                />
              </label>
            </div>
            <div>
              <span className="text-[10px] uppercase tracking-wider text-gray-400">Permission</span>
              <div className="flex gap-1 mt-1">
                {PERMISSIONS.map((p) => (
                  <button
                    key={p.value} onClick={() => setPermission(p.value)}
                    className={`flex-1 text-[11px] py-1.5 rounded ${permission === p.value ? 'bg-amber-600 text-white' : 'bg-gray-800 hover:bg-gray-700'}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-gray-400">Note (optional)</span>
              <input
                type="text" value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Second opinion on 46"
                className="w-full mt-1 px-2 py-1.5 rounded text-[12px] bg-gray-900 border border-gray-800 focus:border-amber-600 outline-none"
              />
            </label>

            <p className="text-[10px] text-gray-500">Link will expire {new Date(expiryPreview).toLocaleString('en-GB')}.</p>
            {stage === 'error' && <p className="text-[11px] text-red-300">{error}</p>}

            <button
              onClick={submit}
              disabled={stage === 'creating' || !isValidEmail(email)}
              className="w-full text-[12px] py-2 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white flex items-center justify-center gap-2 font-medium"
            >
              {stage === 'creating' ? <><Loader2 size={13} className="animate-spin" /> Creating…</> : <><Share2 size={13} /> Create share link</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
