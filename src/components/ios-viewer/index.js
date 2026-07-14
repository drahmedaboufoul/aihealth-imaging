/**
 * IOS Viewer Pro - Main Export File
 * Professional Intraoral Scan Viewer
 */

// Main Component
export { default as IOSViewerPro } from './IOSViewerPro.jsx';

// Store
export { useIOSViewerStore, DENTAL_VIEW_PRESETS } from './store/iosViewerStore.js';

// Components
export { Toolbar } from './components/Toolbar.jsx';
export { Sidebar } from './components/Sidebar.jsx';
export { ViewPresets } from './components/ViewPresets.jsx';
export { MaterialControls } from './components/MaterialControls.jsx';
export { CrossSectionControls } from './components/CrossSectionControls.jsx';
export { MeasurementOverlay } from './components/MeasurementOverlay.jsx';
export { AnnotationMarkers } from './components/AnnotationMarkers.jsx';

// Hooks
export { useMeasurements } from './hooks/useMeasurements.js';
export { useAnnotations } from './hooks/useAnnotations.js';
export { useCrossSection } from './hooks/useCrossSection.js';

// Utils
export {
  loadModel,
  detectFileType,
  getFileInfo,
  calculateMeshStatistics
} from './utils/modelLoader.js';

// Default export
export { default } from './IOSViewerPro.jsx';
