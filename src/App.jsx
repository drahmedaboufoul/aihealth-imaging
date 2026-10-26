import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './pages/HomePage';
import HealthPage from './pages/HealthPage';
import NotFoundPage from './pages/NotFoundPage';
import LoginPage from './pages/LoginPage';
import { KYOUR_BACKEND } from './lib/deployment';

// IOS viewer is heavy (Three.js + react-three-fiber) — lazy-load it
const IOSViewerPage = lazy(() => import('./pages/IOSViewerPage'));
// DICOM viewer (Cornerstone3D + WASM codecs) — heavy, lazy
const DicomViewerPage = lazy(() => import('./pages/DicomViewerPage'));
// CBCT viewer (volume rendering + MPR) — heaviest, lazy. The kyour imaging cloud build
// (VITE_IMAGING_BACKEND=kyour) uses kyour's viewer; see lib/deployment.js.
const CBCTViewerPage = lazy(() => (KYOUR_BACKEND ? import('./pages/kyour/CBCTViewerPage') : import('./pages/CBCTViewerPage')));
// Shared viewer — tokenized public access for external collaborators
const SharedViewerPage = lazy(() => (KYOUR_BACKEND ? import('./pages/kyour/SharedViewerPage') : import('./pages/SharedViewerPage')));
// kyour imaging cloud: the signed-in clinic's studies
const KyourHomePage = lazy(() => import('./pages/kyour/HomePage'));
// Open a scan from disk — nothing uploaded
const LocalViewerPage = lazy(() => import('./pages/LocalViewerPage'));
// One-time sign-in from a partner app (Dental Lab OS), then on to the viewer
const LaunchPage = lazy(() => import('./pages/LaunchPage'));

function ViewerLoader() {
  return (
    <div className="h-screen w-screen bg-bg flex items-center justify-center text-muted text-[12px]">
      Loading viewer…
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={KYOUR_BACKEND ? <Suspense fallback={<ViewerLoader />}><KyourHomePage /></Suspense> : <HomePage />}
      />
      <Route path="/health" element={<HealthPage />} />

      {/* Partner launch link: exchanges a one-time token for a session */}
      <Route
        path="/launch"
        element={
          <Suspense fallback={<ViewerLoader />}>
            <LaunchPage />
          </Suspense>
        }
      />
      {/* Local files (folder / DICOM / ZIP / NIfTI) — no upload, no sign-in */}
      <Route
        path="/viewer/local"
        element={
          <Suspense fallback={<ViewerLoader />}>
            <LocalViewerPage />
          </Suspense>
        }
      />
      <Route path="/login" element={<LoginPage />} />

      {/* IOS viewer — real Three.js renderer (moved from EMR 2026-05-06) */}
      <Route
        path="/viewer/ios"
        element={
          <Suspense fallback={<ViewerLoader />}>
            <IOSViewerPage />
          </Suspense>
        }
      />

      {/* DICOM 2D viewer — handles uncompressed CR / DX / MG / US single-frame */}
      <Route
        path="/viewer/dicom"
        element={
          <Suspense fallback={<ViewerLoader />}>
            <DicomViewerPage />
          </Suspense>
        }
      />
      {/* CBCT volume viewer — Cornerstone3D MPR + volume rendering (heaviest, lazy) */}
      <Route
        path="/viewer/cbct"
        element={
          <Suspense fallback={<ViewerLoader />}>
            <CBCTViewerPage />
          </Suspense>
        }
      />

      {/* Shared viewer (tokenized public access). No auth header
          required — the token in the URL is the auth. */}
      <Route
        path="/viewer/share/:token"
        element={
          <Suspense fallback={<ViewerLoader />}>
            <SharedViewerPage />
          </Suspense>
        }
      />

      {/* Backwards-compat alias for the EMR's old /cbct-viewer URL */}
      <Route path="/cbct-viewer" element={<Navigate to="/viewer/cbct" replace />} />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
