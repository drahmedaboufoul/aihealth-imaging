/*
 * LocalViewerPage — open a CBCT / DICOM series straight from the user's computer,
 * with nothing uploaded. Accepts a scanner export folder, loose .dcm files, a .zip,
 * or a .nii / .nii.gz volume, and renders it in the same viewer as cloud studies.
 *
 * URL: /viewer/local      (?viewer=2d forces the light slice scroller)
 *
 * AI reads, reports and saved annotations need a cloud study, so those controls
 * explain that instead of running.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { unzipSync } from 'fflate';
import { ArrowLeft, FolderOpen, Files, Loader2, AlertCircle, HardDrive } from 'lucide-react';
import { ensureCornerstone } from '@/lib/cornerstoneInit';
import { prepareDicomStack } from '@/lib/dicomStack';

const CBCTVolumeViewer = React.lazy(() => import('@/components/viewers/CBCTVolumeViewer'));
const DICOMStackViewer = React.lazy(() => import('@/components/viewers/DICOMStackViewer'));

const NIFTI = /\.nii(\.gz)?$/i;
const SKIP = /(^|\/)(__MACOSX|\.DS_Store|thumbs\.db|DICOMDIR$)|\.(txt|pdf|html?|xml|ini|exe|dll|jpg|jpeg|png|bmp)$/i;

// Folders dropped from Explorer/Finder arrive as entries; walk them for files.
async function filesFromEntry(entry, path = '') {
  if (entry.isFile) return [await new Promise((res, rej) => entry.file(res, rej))];
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const out = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) out.push(...(await filesFromEntry(e, `${path}${entry.name}/`)));
  }
  return out;
}

// Expand zips in place; keep everything else that could be an image.
async function expand(files) {
  const out = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const entries = unzipSync(new Uint8Array(await f.arrayBuffer()), { filter: (e) => !e.name.endsWith('/') && !SKIP.test(e.name) });
      for (const [name, bytes] of Object.entries(entries)) out.push(new File([bytes], name.split('/').pop()));
    } else if (!SKIP.test(f.webkitRelativePath || f.name)) {
      out.push(f);
    }
  }
  return out;
}

export default function LocalViewerPage() {
  const [params] = useSearchParams();
  const [state, setState] = useState({ stage: 'pick' });
  const folderRef = useRef(null);
  const urlRef = useRef(null);

  useEffect(() => {
    document.title = 'Open local scan — aiHealth Imaging';
    return () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); };
  }, []);

  const open = useCallback(async (picked) => {
    if (!picked.length) return;
    try {
      setState({ stage: 'reading', note: `Reading ${picked.length} file${picked.length === 1 ? '' : 's'}…`, progress: 0 });
      const files = await expand(picked);
      const cs = await ensureCornerstone();

      const nifti = files.find((f) => NIFTI.test(f.name));
      if (nifti) {
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = URL.createObjectURL(nifti);
        if (!cs.niftiLoader?.createNiftiImageIdsAndCacheMetadata) throw new Error('The NIfTI loader is unavailable in this browser.');
        const ids = await cs.niftiLoader.createNiftiImageIdsAndCacheMetadata({ url: urlRef.current });
        setState({ stage: 'view', imageIds: ids, name: nifti.name, info: { slices: ids.length, source: 'NIfTI' } });
        return;
      }

      const raw = files.map((f) => cs.dicomImageLoader.wadouri.fileManager.add(f));
      const prepared = await prepareDicomStack(raw, {
        onProgress: (p) => setState((s) => ({ ...s, note: 'Checking slices and series…', progress: Math.round(p * 100) })),
      });
      const top = picked[0]?.webkitRelativePath?.split('/')[0];
      setState({ stage: 'view', imageIds: prepared.imageIds, name: top || (picked.length === 1 ? picked[0].name : 'Local CBCT'), info: prepared.info });
    } catch (e) {
      setState({ stage: 'error', error: e?.message || String(e) });
    }
  }, []);

  // Synthetic phantom shipped with the app (scripts/make-sample-cbct.mjs) — for demos and testing.
  // ?demo=1 opens the DICOM export, ?demo=nifti the same volume as a converted NIfTI.
  const openDemo = useCallback(async (kind = 'dicom') => {
    setState({ stage: 'reading', note: 'Downloading the demo CBCT…', progress: 0 });
    try {
      const [url, name] = kind === 'nifti' ? ['/samples/demo-cbct.nii.gz', 'Demo CBCT phantom.nii.gz'] : ['/samples/demo-cbct-dicom.zip', 'Demo CBCT phantom.zip'];
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Demo CBCT missing (${res.status})`);
      await open([new File([await res.blob()], name)]);
    } catch (e) {
      setState({ stage: 'error', error: e?.message || String(e) });
    }
  }, [open]);

  useEffect(() => {
    const demo = params.get('demo');
    if (demo) openDemo(demo === 'nifti' ? 'nifti' : 'dicom');
  }, [params, openDemo]);

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    const items = [...(e.dataTransfer.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const files = items.length ? (await Promise.all(items.map((it) => filesFromEntry(it)))).flat() : [...e.dataTransfer.files];
    open(files);
  }, [open]);

  if (state.stage === 'view') {
    const stack = params.get('viewer') === '2d';
    // Inside a partner app's iframe (?embed=1) closing is the host page's call.
    const close = params.get('embed') === '1' && window.parent !== window
      ? () => window.parent.postMessage({ type: 'aih-imaging:close' }, '*')
      : () => setState({ stage: 'pick' });
    return (
      <div className="h-screen w-screen overflow-hidden bg-black">
        <React.Suspense fallback={<Centered><Loader2 className="h-10 w-10 animate-spin text-accent" /></Centered>}>
          {stack
            ? <DICOMStackViewer imageIds={state.imageIds} fileName={state.name} onClose={close} />
            : <CBCTVolumeViewer imageIds={state.imageIds} fileName={state.name} onClose={close} />}
        </React.Suspense>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Link to="/" className="mb-6 inline-flex items-center gap-1 text-[12px] text-muted hover:text-text"><ArrowLeft size={13} /> Studies</Link>
        <h1 className="mb-1 flex items-center gap-2 text-[20px] font-semibold"><HardDrive size={18} className="text-accent" /> Open a scan from this computer</h1>
        <p className="mb-6 text-[13px] leading-relaxed text-muted">
          CBCT or CT export folder, loose DICOM files, a ZIP, or a NIfTI volume. Files stay on this computer: nothing is uploaded.
          AI reads, reports and saved measurements need the scan uploaded as a cloud study.
        </p>

        {state.stage === 'reading' ? (
          <div className="rounded-lg border border-border bg-panel p-8 text-center">
            <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-accent" />
            <div className="text-[13px]">{state.note}</div>
            {state.progress > 0 && <div className="mt-1 text-[11px] text-muted">{state.progress}%</div>}
          </div>
        ) : (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="rounded-lg border-2 border-dashed border-border bg-panel p-10 text-center"
          >
            <FolderOpen className="mx-auto mb-3 h-9 w-9 text-accent" />
            <div className="mb-4 text-[14px] font-medium">Drop the scanner export folder here</div>
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => folderRef.current?.click()} className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:bg-accent-hover">
                <FolderOpen size={14} /> Choose folder
              </button>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12px] hover:bg-panel2">
                <Files size={14} /> Choose files or ZIP
                <input type="file" multiple className="hidden" onChange={(e) => open([...e.target.files])} />
              </label>
            </div>
            <input ref={folderRef} type="file" className="hidden" webkitdirectory="" directory="" multiple onChange={(e) => open([...e.target.files])} />
            <button type="button" onClick={() => openDemo()} className="mt-5 text-[11px] text-muted underline-offset-2 hover:text-text hover:underline">
              No scan to hand? Open the demo CBCT phantom
            </button>
          </div>
        )}

        {state.stage === 'error' && (
          <div className="mt-4 flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 p-3 text-[12px]">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-destructive" /> {state.error}
          </div>
        )}
      </div>
    </div>
  );
}

function Centered({ children }) {
  return <div className="flex h-full w-full items-center justify-center">{children}</div>;
}
