/*
 * SharedViewerPage — read-only viewer for a share link.
 * URL: /viewer/share/:token      (?embed=1 when shown inside a partner app)
 *
 * The token is the auth: kyour's imaging-partner function (resolve_share) checks it hasn't
 * expired and returns short-lived signed URLs for the study's DICOM slices (or its converted
 * NIfTI volume). The study opens in the full CBCT viewer without a study id, so saving,
 * AI reads and reports stay off — those need the lab's own sign-in.
 */
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Loader2, Lock } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { ensureCornerstone } from '@/lib/cornerstoneInit';
import { prepareDicomStack } from '@/lib/dicomStack';
import { functionErrorMessage } from '@/lib/aiTokens';

const CBCTVolumeViewer = React.lazy(() => import('@/components/viewers/CBCTVolumeViewer'));

export default function SharedViewerPage() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const embed = params.get('embed') === '1';
  const [state, setState] = useState({ stage: 'loading', note: 'Checking the link…' });

  useEffect(() => {
    if (!token) return undefined;
    let alive = true;
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('imaging-partner', { body: { action: 'resolve_share', token } });
        if (error) throw new Error(await functionErrorMessage(error, 'This link could not be opened.'));
        if (!alive) return;
        document.title = `${data.study?.description || 'CBCT'} — shared view`;

        let imageIds = [];
        if (data.nifti_url) {
          const cs = await ensureCornerstone();
          imageIds = await cs.niftiLoader.createNiftiImageIdsAndCacheMetadata({ url: data.nifti_url });
        } else if (data.dicom_urls?.length) {
          setState({ stage: 'loading', note: `Loading ${data.dicom_urls.length} slices…` });
          const prepared = await prepareDicomStack(data.dicom_urls.map((u) => `wadouri:${u}`), {
            onProgress: (p) => alive && setState({ stage: 'loading', note: `Loading slices… ${Math.round(p * 100)}%` }),
          });
          imageIds = prepared.imageIds;
        }
        if (!imageIds.length) throw new Error('This study has no images yet.');
        if (alive) setState({ stage: 'ready', study: data.study, imageIds });
      } catch (e) {
        if (alive) setState({ stage: 'error', error: e?.message || String(e) });
      }
    })();
    return () => { alive = false; };
  }, [token]);

  if (state.stage !== 'ready') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black p-6 text-center">
        {state.stage === 'error' ? (
          <div className="max-w-sm">
            <Lock className="mx-auto mb-3 h-8 w-8 text-amber-500" />
            <p className="text-[13px] text-neutral-200">{state.error}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 text-neutral-300">
            <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
            <p className="text-[13px]">{state.note}</p>
          </div>
        )}
      </div>
    );
  }

  const close = () => (embed ? window.parent.postMessage({ type: 'aih-imaging:close' }, '*') : window.close());
  return (
    <div className="flex h-screen w-screen flex-col bg-black">
      <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-1 text-[11px] text-neutral-400">
        <Lock size={11} className="text-amber-500" /> Read-only view shared by the lab. Measurements aren't saved; AI reads run in the lab's own view.
      </div>
      <div className="min-h-0 flex-1">
        <React.Suspense fallback={null}>
          <CBCTVolumeViewer imageIds={state.imageIds} fileName={state.study?.description || 'CBCT'} onClose={close} />
        </React.Suspense>
      </div>
    </div>
  );
}
