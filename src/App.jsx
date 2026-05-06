import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './pages/HomePage';
import HealthPage from './pages/HealthPage';
import NotFoundPage from './pages/NotFoundPage';
import ViewerStub from './components/ViewerStub';

// IOS viewer is heavy (Three.js + react-three-fiber) — lazy-load it
const IOSViewerPage = lazy(() => import('./pages/IOSViewerPage'));

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

      {/* IOS viewer — real Three.js renderer (moved from EMR 2026-05-06) */}
      <Route
        path="/viewer/ios"
        element={
          <Suspense fallback={<ViewerLoader />}>
            <IOSViewerPage />
          </Suspense>
        }
      />

      {/* DICOM + CBCT — still stubs, renderers move in phase 2 */}
      <Route path="/viewer/dicom" element={<ViewerStub kind="dicom" />} />
      <Route path="/viewer/cbct" element={<ViewerStub kind="cbct" />} />

      {/* Backwards-compat alias for the EMR's old /cbct-viewer URL */}
      <Route path="/cbct-viewer" element={<Navigate to="/viewer/cbct" replace />} />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
