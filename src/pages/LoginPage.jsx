/*
 * LoginPage — minimal sign-in for the imaging app.
 *
 * Why this exists separately from the EMR's /auth: the imaging app and
 * the EMR are on different Vercel preview origins right now, so the
 * EMR's localStorage session doesn't propagate. This page lets a user
 * sign in here directly with the same Supabase credentials, which
 * persists a session in this origin's localStorage. After that, the
 * imaging viewer's RLS-gated queries (resolveStudyFiles, etc.) work.
 *
 * Phase 3 plan — when imaging.aihealth.app goes behind the same parent
 * domain as the EMR, drop this page and rely on shared cookies. For now
 * it's the simplest unblocker.
 *
 * Honors a `?next=<path>` redirect target so navigating to a viewer URL
 * unauthenticated bounces here and back.
 */

import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Loader2, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { supabase } from '../lib/supabase';

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = searchParams.get('next') || '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // If already signed in, send them straight to the next destination.
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) navigate(next, { replace: true });
    });
    return () => { cancelled = true; };
  }, [navigate, next]);

  const submit = async (e) => {
    e.preventDefault();
    if (!email || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (err) throw err;
      navigate(next, { replace: true });
    } catch (err) {
      setError(err?.message || 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-bg p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl p-6 space-y-4"
        style={{
          backgroundColor: 'var(--surface, #fff)',
          border: '1px solid var(--border, #e5dccb)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
        }}
      >
        <div className="text-center mb-2">
          <div className="text-[11px] font-bold uppercase tracking-widest text-accent">aiHealth</div>
          <h1 className="text-lg font-semibold text-text mt-1">Imaging — Sign in</h1>
          <p className="text-[11px] text-muted mt-1">Use your aiHealth EMR credentials.</p>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-900 text-[12px]">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div>
          <label className="text-[11px] font-medium text-muted uppercase tracking-wide" htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full h-10 px-3 mt-1 rounded-md border text-sm text-text"
            style={{ borderColor: 'var(--border, #e5dccb)' }}
          />
        </div>

        <div>
          <label className="text-[11px] font-medium text-muted uppercase tracking-wide" htmlFor="password">Password</label>
          <div className="relative mt-1">
            <input
              id="password"
              type={showPwd ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-10 px-3 pr-9 rounded-md border text-sm text-text"
              style={{ borderColor: 'var(--border, #e5dccb)' }}
            />
            <button
              type="button"
              onClick={() => setShowPwd((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text"
              tabIndex={-1}
              aria-label={showPwd ? 'Hide password' : 'Show password'}
            >
              {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={busy || !email || !password}
          className="w-full h-10 rounded-md font-semibold text-[13px] flex items-center justify-center gap-2 disabled:opacity-50"
          style={{ backgroundColor: 'var(--accent, #c8a951)', color: 'var(--bg, #fff)' }}
        >
          {busy ? (<><Loader2 size={14} className="animate-spin" /> Signing in…</>) : 'Sign in'}
        </button>

        <div className="text-center pt-2">
          <Link to="/" className="text-[11px] text-muted hover:text-text">Back to home</Link>
        </div>

        {next !== '/' && (
          <p className="text-[10px] text-muted text-center pt-1">
            You'll be returned to <code className="font-mono">{next}</code> after signing in.
          </p>
        )}
      </form>
    </div>
  );
}
