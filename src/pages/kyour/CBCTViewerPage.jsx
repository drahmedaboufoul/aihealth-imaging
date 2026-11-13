/**
 * CBCT/DICOM Viewer Page (Popup Window)
 * Opens in a separate window for dedicated CBCT viewing
 */
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import { ensureCornerstone } from '@/lib/cornerstoneInit';
import { prepareDicomStack } from '@/lib/dicomStack';

// Ask the server to convert a CBCT study's DICOM stack to a clean NIfTI volume
// (fire-and-forget). Carries the user's JWT so /api/convert-cbct can authorize.
async function triggerCbctConversion(studyId) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    await fetch('/api/convert-cbct', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ study_id: studyId }),
    }).catch(() => {});
  } catch (e) { /* non-fatal */ }
}

// Real cornerstone3D MPR + 3D volume viewer for studies (imaging_files).
const CBCTVolumeViewer = React.lazy(() => import('@/components/viewers/CBCTVolumeViewer'));
// Lightweight 2D slice scroller — used on memory-constrained devices (phones),
// where the full 3D volume reconstruction OOM-crashes the browser tab.
const DICOMStackViewer = React.lazy(() => import('@/components/viewers/DICOMStackViewer'));
// Server-rendered panoramic (OPG) — displays a PNG, so it works on any device.
const PanoramicViewer = React.lazy(() => import('@/components/viewers/PanoramicViewer'));

// Error Boundary Component
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('CBCT Viewer Error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-black flex items-center justify-center">
          <div className="text-center p-8">
            <p className="text-red-400 text-lg mb-2">{this.props.labels?.wrong || 'Something went wrong'}</p>
            <p className="text-gray-400 text-sm mb-4 max-w-md">
              {this.state.error?.message || (this.props.labels?.unknown || 'Unknown error')}
            </p>
            <Button 
              onClick={this.props.onClose} 
              className="bg-amber-500 text-black hover:bg-amber-600 mr-2"
            >
              {this.props.labels?.close || 'Close Window'}
            </Button>
            <Button 
              onClick={() => window.location.reload()} 
              variant="outline"
              className="border-gray-600 text-white hover:bg-gray-800"
            >
              {this.props.labels?.retry || 'Retry'}
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function CBCTViewerPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [imageIds, setImageIds] = useState(null);
  const [fallbackImageIds, setFallbackImageIds] = useState(null);
  const [dicomImageIds, setDicomImageIds] = useState(null);
  const [isCbct, setIsCbct] = useState(false);
  const [showPanoramic, setShowPanoramic] = useState(false);
  const [fileName, setFileName] = useState('CBCT Scan');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const studyId = searchParams.get('study');

  // Phones can't hold a full CBCT volume in a browser tab — iOS Safari OOM-crashes
  // the tab, desktop just renders black under memory pressure. On mobile, render
  // the lightweight 2D slice scroller (StackViewport, one frame at a time) instead
  // of the 3D MPR volume. Override with ?viewer=2d / ?viewer=3d.
  const viewerMode = searchParams.get('viewer');
  const isMobileDevice = typeof navigator !== 'undefined' && /iphone|ipad|ipod|android/i.test(navigator.userAgent || '');
  const preferStack = viewerMode === '2d' || (viewerMode !== '3d' && isMobileDevice);

  useEffect(() => {
    document.title = `${fileName} - CBCT Viewer`;
    
    async function loadFile() {
      try {
        setLoading(true);

        // New imaging pipeline: a study in imaging_studies/imaging_files.
        // Reconstruct a cornerstone volume from every DICOM instance.
        if (studyId) {
          const { data: study } = await supabase
            .from('imaging_studies')
            .select('description, study_type, nifti_status, nifti_storage_path')
            .eq('id', studyId)
            .single();
          if (study?.description) setFileName(study.description);
          setIsCbct(study?.study_type === 'cbct');

          // Prefer the server-converted NIfTI volume — it bakes in correct
          // geometry, so the MPR is clean (raw dental DICOM often has
          // vendor-inconsistent slice positions that stripe the reformats).
          let niftiIds = null;
          if (study?.nifti_status === 'ready' && study?.nifti_storage_path) {
            try {
              const { data: nsigned, error: nerr } = await supabase.storage
                .from('imaging-derived')
                .createSignedUrl(study.nifti_storage_path, 3600);
              if (nerr || !nsigned?.signedUrl) throw nerr || new Error('Could not sign NIfTI URL');
              const cs = await ensureCornerstone();
              if (!cs.niftiLoader?.createNiftiImageIdsAndCacheMetadata) throw new Error('NIfTI loader unavailable');
              // The .nii.gz can be large (100s of MB); cap the download/parse so a
              // stall can't hang the viewer on the spinner — we drop to DICOM instead.
              const niftiResult = await Promise.race([
                cs.niftiLoader.createNiftiImageIdsAndCacheMetadata({ url: nsigned.signedUrl }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('NIfTI load timed out after 90s')), 90000)),
              ]);
              if (niftiResult && niftiResult.length) niftiIds = niftiResult;
            } catch (e) {
              console.warn('[CBCT] NIfTI prepare failed, will use DICOM fallback:', e?.message || e);
            }
          }

          // Always prepare the raw DICOM stack too — it is the reliable fallback
          // if the NIfTI volume fails to prepare OR fails to render in the viewer.
          // If this is an unconverted CBCT, kick off conversion (fire-and-forget).
          let dicomIds = null;
          if (study?.study_type === 'cbct' && !niftiIds && !['ready', 'converting', 'queued'].includes(study?.nifti_status)) {
            triggerCbctConversion(studyId);
          }
          {
            const { data: files, error: filesError } = await supabase
              .from('imaging_files')
              .select('storage_path')
              .eq('study_id', studyId)
              .eq('file_kind', 'dicom');
            if (filesError) throw filesError;
            if (files && files.length) {
              const paths = files.map((f) => f.storage_path);
              const { data: signed, error: signErr } = await supabase.storage
                .from('imaging')
                .createSignedUrls(paths, 3600);
              if (signErr) throw signErr;
              dicomIds = (signed || [])
                .filter((s) => s && s.signedUrl && !s.error)
                .map((s) => `wadouri:${s.signedUrl}`);
            }
          }

          // Raw DICOM as the primary source: parse every slice first so the volume is
          // built from one series in true slice order (unconverted CBCTs otherwise
          // stripe or scramble — the streaming loader can't sort what it hasn't read).
          if (!(niftiIds && niftiIds.length) && dicomIds && dicomIds.length) {
            const prepared = await prepareDicomStack(dicomIds);
            console.log('[CBCT] DICOM stack prepared', prepared.info);
            dicomIds = prepared.imageIds;
          }

          const primary = (niftiIds && niftiIds.length) ? niftiIds : (dicomIds || []);
          if (!primary.length) throw new Error('No DICOM images found for this study');
          setImageIds(primary);
          // Hand the viewer a DICOM fallback only when NIfTI is primary, so a
          // NIfTI render failure can recover instead of dead-ending on black panes.
          setFallbackImageIds(
            (niftiIds && niftiIds.length && dicomIds && dicomIds.length) ? dicomIds : null
          );
          // Keep the DICOM stack on hand for the lightweight mobile viewer.
          setDicomImageIds(dicomIds && dicomIds.length ? dicomIds : null);

          setLoading(false);
          return;
        }

        // The legacy patient_files (?id=) single-file path was removed along
        // with the legacy single-file viewer — studies are the only source.
        throw new Error('No study specified');
      } catch (err) {
        console.error('Error loading CBCT:', err);
        setError(err.message);
        toast.error(t('pagesMain.cbct.toast_fail', 'Failed to load CBCT file'));
        setLoading(false);
      }
    }
    
    loadFile();
  }, [studyId]);

  // Inside a partner app's iframe (?embed=1) the host page decides what closing means.
  const embedded = searchParams.get('embed') === '1';
  const handleClose = () => {
    if (embedded && window.parent !== window) window.parent.postMessage({ type: 'aih-imaging:close' }, '*');
    else window.close();
  };

  if (loading) {
    return (
      <div className="h-screen w-screen bg-black flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-12 w-12 animate-spin text-amber-500" />
          <p className="text-white text-lg">{t('pagesMain.cbct.loading', 'Loading CBCT Data...')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen w-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 text-lg mb-4">{t('pagesMain.common.error_label', 'Error:')} {error}</p>
          <Button onClick={handleClose} className="bg-amber-500 text-black hover:bg-amber-600">
            {t('pagesMain.common.close_window', 'Close Window')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-black">
      <React.Suspense fallback={
        <div className="h-full w-full bg-black flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="h-12 w-12 animate-spin text-amber-500" />
            <p className="text-white text-lg">{t('pagesMain.cbct.initializing', 'Initializing CBCT Viewer...')}</p>
          </div>
        </div>
      }>
        <ErrorBoundary onClose={handleClose} labels={{ wrong: t('pagesMain.cbct.wrong', 'Something went wrong'), unknown: t('pagesMain.cbct.unknown', 'Unknown error'), close: t('pagesMain.common.close_window', 'Close Window'), retry: t('pagesMain.cbct.retry', 'Retry') }}>
          {showPanoramic ? (
            <PanoramicViewer studyId={studyId} fileName={fileName} onClose={() => setShowPanoramic(false)} />
          ) : (
            <>
              {imageIds && imageIds.length > 0 ? (
                preferStack && dicomImageIds && dicomImageIds.length > 0 ? (
                  <DICOMStackViewer imageIds={dicomImageIds} fileName={fileName} onClose={handleClose} />
                ) : (
                  <CBCTVolumeViewer imageIds={imageIds} fallbackImageIds={fallbackImageIds} fileName={fileName} studyId={studyId} onClose={handleClose} />
                )
              ) : null}
              {/* Server-rendered panoramic (PNG) — only the lightweight mobile
                  stack viewer needs it. The full CBCTVolumeViewer now has its
                  own client-side OPG (the "3D Pano" tab / "Auto OPG" button),
                  which reconstructs locally and does not depend on the Cloud Run
                  renderer (that path could leave the strip stuck "queued"). */}
              {studyId && isCbct && preferStack && (
                <button
                  type="button"
                  onClick={() => setShowPanoramic(true)}
                  className="fixed bottom-3 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-amber-500 text-black text-xs font-semibold shadow-lg hover:bg-amber-400"
                >
                  Panoramic (OPG)
                </button>
              )}
            </>
          )}
        </ErrorBoundary>
      </React.Suspense>
    </div>
  );
}
