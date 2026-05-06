import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './pages/HomePage';
import HealthPage from './pages/HealthPage';
import NotFoundPage from './pages/NotFoundPage';
import ViewerStub from './components/ViewerStub';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/health" element={<HealthPage />} />

      {/* Viewer routes — query-string contract per IMAGING_SPLIT.md */}
      <Route path="/viewer/dicom" element={<ViewerStub kind="dicom" />} />
      <Route path="/viewer/cbct" element={<ViewerStub kind="cbct" />} />
      <Route path="/viewer/ios" element={<ViewerStub kind="ios" />} />

      {/* Backwards-compat aliases (mirrors the EMR's old paths) */}
      <Route path="/cbct-viewer" element={<Navigate to="/viewer/cbct" replace />} />

      {/* Future: /study/:studyId */}

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
