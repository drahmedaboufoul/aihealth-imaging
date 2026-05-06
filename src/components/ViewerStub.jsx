/*
 * Placeholder viewer — phase 1 scaffolding. Resolves the signed URL,
 * shows file metadata, but does not yet render the imaging payload.
 *
 * Will be replaced in phase 2 with:
 *   IOS  → Three.js ModelViewer (moved from EMR)
 *   DICOM/CBCT → Cornerstone3D / OHIF Viewer
 */

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { resolveSignedUrl } from '../lib/signedUrl';
import { Loader2, AlertCircle, FileImage, ExternalLink } from 'lucide-react';

export default function ViewerStub({ kind }) {
  const [params] = useSearchParams();
  const id = params.get('id');
  const path = params.get('path');
  const nameQuery = params.get('name');

  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await resolveSignedUrl({ id, path });
        if (cancelled) return;
        setState({ loading: false, url: r.url, fileName: r.fileName || nameQuery, bucket: r.bucket, key: r.key });
      } catch (err) {
        if (cancelled) return;
        setState({ loading: false, error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, [id, path, nameQuery]);

  return (
    <div className="h-full grid grid-cols-12 gap-0">
      {/* Left rail — placeholder for tools */}
      <aside className="col-span-1 border-r border-border bg-panel flex flex-col items-center pt-3 gap-2">
        <div className="w-8 h-8 rounded bg-panel2 flex items-center justify-center text-muted">
          <FileImage size={14} />
        </div>
      </aside>

      {/* Main canvas */}
      <section className="col-span-9 bg-bg flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          {state.loading && (
            <div className="flex flex-col items-center gap-3 text-muted">
              <Loader2 size={20} className="animate-spin" />
              <div className="text-[12px]">Resolving file…</div>
            </div>
          )}
          {state.error && (
            <div className="flex flex-col items-center gap-3 max-w-sm text-center">
              <AlertCircle size={20} className="text-danger" />
              <div className="text-[13px] font-medium">Could not resolve file</div>
              <div className="text-[11px] text-muted font-mono break-all">{state.error}</div>
            </div>
          )}
          {!state.loading && !state.error && (
            <div className="flex flex-col items-center gap-4 max-w-md text-center">
              <FileImage size={40} className="text-accentMuted" />
              <div>
                <div className="text-[14px] font-medium">{state.fileName || 'Imaging file'}</div>
                <div className="text-[11px] text-muted mt-1 font-mono">{kind.toUpperCase()} viewer</div>
              </div>
              <div className="text-[11px] text-muted leading-relaxed">
                Phase 1 scaffold. The {kind.toUpperCase()} renderer hasn't moved over from the EMR yet.
                <br />
                The signed URL resolves correctly — that's the contract this app needs to satisfy.
              </div>
              <a
                href={state.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-border text-[12px] hover:border-accent transition-colors"
              >
                <ExternalLink size={12} /> Open raw file
              </a>
              <details className="text-left text-[10.5px] text-muted font-mono w-full">
                <summary className="cursor-pointer hover:text-text">Debug</summary>
                <div className="mt-2 space-y-1 break-all">
                  <div>id: {id || '—'}</div>
                  <div>path: {path || '—'}</div>
                  <div>bucket: {state.bucket}</div>
                  <div>key: {state.key}</div>
                </div>
              </details>
            </div>
          )}
        </div>
      </section>

      {/* Right rail — placeholder for measurements/annotations */}
      <aside className="col-span-2 border-l border-border bg-panel">
        <div className="px-3 py-2.5 border-b border-border">
          <div className="text-[9.5px] uppercase tracking-[0.08em] text-muted">Tools</div>
        </div>
        <div className="px-3 py-3 text-[11px] text-muted">
          Measurements, annotations, and hanging-protocol selection land here in phase 2.
        </div>
      </aside>
    </div>
  );
}
