/*
 * LaunchPage — one-time sign-in from a partner app (Dental Lab OS), then straight on to
 * the viewer.
 *
 * URL: /launch?th=<token_hash>&next=<path>
 *
 * The partner's server asks kyour's imaging-partner function for a launch link; that
 * function maps the partner user to a kyour account scoped to their lab's clinic and mints
 * a one-time magic-link token. Here we exchange it for a session, so the viewer runs with
 * normal clinic-scoped access (AI read with tokens, annotations, every viewer mode).
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';

// A token works once; React StrictMode runs effects twice in dev.
const exchanged = new Map();

export default function LaunchPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    const th = params.get('th');
    const next = params.get('next') || '/';
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    if (!th) { setError('This link is missing its sign-in token.'); return; }

    if (!exchanged.has(th)) exchanged.set(th, supabase.auth.verifyOtp({ type: 'magiclink', token_hash: th }));
    let alive = true;
    exchanged.get(th).then(({ error: err }) => {
      if (!alive) return;
      if (err) {
        setError(/expired|invalid/i.test(err.message)
          ? 'This viewer link has expired or was already used. Open the case again for a fresh one.'
          : err.message);
        return;
      }
      navigate(safeNext, { replace: true });
    });
    return () => { alive = false; };
  }, [params, navigate]);

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-black p-6 text-center">
      {error ? (
        <div className="max-w-sm">
          <AlertCircle className="mx-auto mb-3 h-8 w-8 text-amber-500" />
          <p className="text-[13px] text-neutral-200">{error}</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-neutral-300">
          <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
          <p className="text-[13px]">Opening the viewer…</p>
        </div>
      )}
    </div>
  );
}
