import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './pages/HomePage';
import HealthPage from './pages/HealthPage';
import NotFoundPage from './pages/NotFoundPage';
import LoginPage from './pages/LoginPage';
import ViewerStub from './components/ViewerStub';

// IOS viewer is heavy (Three.js + react-three-fiber) — lazy-load it
const IOSViewerPage = lazy(() => import('./pages/IOSViewerPage'));
// DICOM viewer (Cornerstone3D + WASM codecs) — heavy, lazy
const DicomViewerPage = lazy(() => import('./pages/DicomViewerPage'));
// CBCT viewer (volume rendering + MPR) — heaviest, lazy
const CBCTViewerPage = lazy(() => import('./pages/CBCTViewerPage'));

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
      <Route path="/" element={<HomePage />} />
      <Route path="/health" element={<HealthPage />} />
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
      {/* CBCT volume — still stub, needs Cornerstone3D + volume rendering */}
      <Route
        path="/viewer/cbct"
        element={
          <Suspense fallback={<ViewerLoader />}>
            <CBCTViewerPage />
          </Suspense>
        }
      />

      {/* Backwards-compat alias for the EMR's old /cbct-viewer URL */}
      <Route path="/cbct-viewer" element={<Navigate to="/viewer/cbct" replace />} />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
