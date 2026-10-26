/*
 * HomePage — the standalone imaging app's front door: the signed-in tenant's
 * studies (imaging_studies, scoped by RLS) and a way to open a scan from disk.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Box, HardDrive, Layers, Loader2, LogIn, LogOut, ScanLine } from 'lucide-react';
import Shell from '@/components/Shell';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

const TYPE_LABEL = { cbct: 'CBCT', ios: 'Intraoral scan', pano: 'Panoramic', ceph: 'Ceph', periapical: 'Periapical', other: 'Imaging' };
const TYPE_ICON = { cbct: Layers, ios: Box };

function viewerHref(s) {
  if (s.study_type === 'cbct') return `/viewer/cbct?study=${s.id}`;
  if (s.study_type === 'ios') return `/viewer/ios?study=${s.id}`;
  return `/viewer/dicom?study=${s.id}`;
}

export default function HomePage() {
  const { user, loading } = useAuth();
  const [studies, setStudies] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user) return;
    supabase
      .from('imaging_studies')
      .select('id, study_type, study_date, description, status, nifti_status, image_count, created_at')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data, error: err }) => {
        if (err) setError(err.message);
        setStudies(data || []);
      });
  }, [user]);

  return (
    <Shell>
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <h1 className="mr-auto text-[22px] font-semibold tracking-tight">Studies</h1>
          <Link to="/viewer/local" className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12px] hover:bg-panel2">
            <HardDrive size={14} /> Open from this computer
          </Link>
          {user ? (
            <button type="button" onClick={() => supabase.auth.signOut()} className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] text-muted hover:text-text">
              <LogOut size={14} /> Sign out
            </button>
          ) : (
            <Link to="/login" className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:bg-accent-hover">
              <LogIn size={14} /> Sign in
            </Link>
          )}
        </div>

        {loading || (user && studies === null) ? (
          <div className="flex items-center gap-2 text-[13px] text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : !user ? (
          <div className="rounded-lg border border-border bg-panel p-6 text-[13px] leading-relaxed text-muted">
            Sign in to see your clinic's CBCT, DICOM and intraoral studies, run AI reads and write reports.
            You can also open a scan from this computer without signing in.
          </div>
        ) : error ? (
          <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-[12px]">{error}</div>
        ) : !studies.length ? (
          <div className="rounded-lg border border-border bg-panel p-6 text-[13px] text-muted">No studies yet. Studies uploaded from kyour, Dental Lab OS or a scanner appear here.</div>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel">
            {studies.map((s) => {
              const Icon = TYPE_ICON[s.study_type] || ScanLine;
              return (
                <Link key={s.id} to={viewerHref(s)} className="flex items-center gap-3 px-4 py-3 hover:bg-panel2">
                  <Icon size={16} className="shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{s.description || TYPE_LABEL[s.study_type] || 'Study'}</div>
                    <div className="truncate text-[11px] text-muted">
                      {[TYPE_LABEL[s.study_type] || s.study_type, s.study_date || s.created_at?.slice(0, 10), s.image_count ? `${s.image_count} images` : null].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {s.study_type === 'cbct' && s.nifti_status && (
                    <span className="rounded bg-panel2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{s.nifti_status === 'ready' ? 'Volume ready' : s.nifti_status}</span>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </Shell>
  );
}
