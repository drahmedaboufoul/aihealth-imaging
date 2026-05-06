/**
 * IOS Viewer Pro - Zustand Store
 * Centralized state management for the professional IOS viewer
 */
import { create } from 'zustand';
import * as THREE from 'three';

// View Presets
export const DENTAL_VIEW_PRESETS = [
  { id: 'front', name: 'Front', position: [0, 0, 200], target: [0, 0, 0] },
  { id: 'back', name: 'Back', position: [0, 0, -200], target: [0, 0, 0] },
  { id: 'top', name: 'Occlusal', position: [0, 200, 0], target: [0, 0, 0] },
  { id: 'bottom', name: 'Incisal', position: [0, -200, 0], target: [0, 0, 0] },
  { id: 'left', name: 'Left', position: [-200, 0, 0], target: [0, 0, 0] },
  { id: 'right', name: 'Right', position: [200, 0, 0], target: [0, 0, 0] },
  { id: 'buccal-right', name: 'Buccal Right', position: [200, 50, 100], target: [20, 0, 0] },
  { id: 'buccal-left', name: 'Buccal Left', position: [-200, 50, 100], target: [-20, 0, 0] },
  { id: 'lingual-right', name: 'Lingual Right', position: [200, 50, -100], target: [20, 0, 0] },
  { id: 'lingual-left', name: 'Lingual Left', position: [-200, 50, -100], target: [-20, 0, 0] },
  { id: 'smile-line', name: 'Smile Line', position: [0, 80, 150], target: [0, 20, 0], fov: 35 },
  { id: 'occlusal-upper', name: 'Upper Arch', position: [0, 150, 0], target: [0, 30, 0] },
  { id: 'occlusal-lower', name: 'Lower Arch', position: [0, -150, 0], target: [0, -30, 0] },
];

// Helper function to determine if a color is dark
function isColorDark(color) {
  const hex = color.replace('#', '');
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness < 128;
}

// Helper function to create clipping plane
function createClippingPlane(config) {
  const plane = new THREE.Plane();

  switch (config.axis) {
    case 'x':
      plane.setFromNormalAndCoplanarPoint(
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3((config.position - 0.5) * 100, 0, 0)
      );
      break;
    case 'y':
      plane.setFromNormalAndCoplanarPoint(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, (config.position - 0.5) * 100, 0)
      );
      break;
    case 'z':
      plane.setFromNormalAndCoplanarPoint(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(0, 0, (config.position - 0.5) * 100)
      );
      break;
    default:
      plane.setFromNormalAndCoplanarPoint(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(0, 0, 0)
      );
  }

  return plane;
}

// Create store
export const useIOSViewerStore = create((set, get) => ({
  // Initial State
  sidebarVisible: true,
  toolbarVisible: true,
  activePanel: 'info',
  activeTool: 'navigate',
  previousTool: null,
  viewPreset: DENTAL_VIEW_PRESETS[0],
  cameraInfo: {
    position: new THREE.Vector3(0, 100, 200),
    target: new THREE.Vector3(0, 0, 0),
    zoom: 1
  },
  showGrid: true,
  showAxes: false,
  showBoundingBox: false,
  showStatistics: false,
  background: {
    color: '#1a1a2e',
    isDark: true
  },
  lighting: {
    ambient: 0.5,
    directional: 1.0,
    shadows: true
  },
  materialSettings: {
    color: '#e8daca',
    metalness: 0.1,
    roughness: 0.5,
    wireframe: false,
    opacity: 1.0,
    transparent: false
  },
  colorPresets: [
    { name: 'Tooth', color: '#e8daca' },
    { name: 'White', color: '#ffffff' },
    { name: 'Gold', color: '#d4a574' },
    { name: 'Amber', color: '#f59e0b' },
    { name: 'Rose Gold', color: '#c4a77d' },
    { name: 'Silver', color: '#c0c0c0' },
    { name: 'Gray', color: '#888888' },
  ],
  meshStatistics: null,
  measurements: [],
  activeMeasurement: null,
  measurementSettings: {
    precision: 1,
    unit: 'mm',
    showLabels: true,
    labelSize: 12,
    color: '#ff0000'
  },
  annotations: [],
  selectedAnnotation: null,
  annotationCategories: [
    { id: 'finding', name: 'Finding', color: '#dc2626' },
    { id: 'note', name: 'Note', color: '#d97706' },
    { id: 'instruction', name: 'Instruction', color: '#059669' },
    { id: 'measurement', name: 'Measurement', color: '#b45309' },
  ],
  crossSection: {
    enabled: false,
    axis: 'z',
    position: 0.5,
    rotation: { x: 0, y: 0, z: 0 },
    clipIntersection: false,
    showPlane: true,
    showCap: true,
    capColor: '#ff0000',
    plane: null
  },
  comparison: {
    enabled: false,
    mode: 'side-by-side',
    secondaryMesh: null,
    opacity: 0.5,
    syncCameras: true
  },
  history: [],
  historyIndex: -1,
  maxHistorySize: 50,

  // Actions
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  toggleToolbar: () => set((state) => ({ toolbarVisible: !state.toolbarVisible })),
  setActivePanel: (panel) => set({ activePanel: panel }),

  setActiveTool: (tool) => set((state) => ({
    previousTool: state.activeTool,
    activeTool: tool
  })),

  setViewPreset: (preset) => set({ viewPreset: preset }),
  applyViewPreset: (preset) => set({ viewPreset: preset }),
  setCameraInfo: (info) => set({ cameraInfo: info }),

  resetView: () => set({
    viewPreset: DENTAL_VIEW_PRESETS[0],
    cameraInfo: {
      position: new THREE.Vector3(0, 100, 200),
      target: new THREE.Vector3(0, 0, 0),
      zoom: 1
    }
  }),

  toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),
  toggleAxes: () => set((state) => ({ showAxes: !state.showAxes })),
  toggleBoundingBox: () => set((state) => ({ showBoundingBox: !state.showBoundingBox })),
  toggleStatistics: () => set((state) => ({ showStatistics: !state.showStatistics })),

  setBackgroundColor: (color) => set({
    background: { color, isDark: isColorDark(color) }
  }),
  toggleTheme: () => set((state) => ({
    background: {
      isDark: !state.background.isDark,
      color: state.background.isDark ? '#f0f0f0' : '#1a1a2e'
    }
  })),

  setAmbientLight: (value) => set((state) => ({
    lighting: { ...state.lighting, ambient: value }
  })),
  setDirectionalLight: (value) => set((state) => ({
    lighting: { ...state.lighting, directional: value }
  })),
  toggleShadows: () => set((state) => ({
    lighting: { ...state.lighting, shadows: !state.lighting.shadows }
  })),

  setMaterialColor: (color) => set((state) => ({
    materialSettings: { ...state.materialSettings, color }
  })),
  setMetalness: (value) => set((state) => ({
    materialSettings: { ...state.materialSettings, metalness: value }
  })),
  setRoughness: (value) => set((state) => ({
    materialSettings: { ...state.materialSettings, roughness: value }
  })),
  toggleWireframe: () => set((state) => ({
    materialSettings: { ...state.materialSettings, wireframe: !state.materialSettings.wireframe }
  })),
  setOpacity: (value) => set((state) => ({
    materialSettings: {
      ...state.materialSettings,
      opacity: value,
      transparent: value < 1.0
    }
  })),

  setMeshStatistics: (stats) => set({ meshStatistics: stats }),

  addMeasurement: (measurement) => set((state) => {
    const newMeasurement = {
      ...measurement,
      id: measurement.id || `meas_${Date.now()}`,
      createdAt: new Date().toISOString()
    };
    const newMeasurements = [...state.measurements, newMeasurement];
    get().addHistoryState();
    return { measurements: newMeasurements };
  }),

  updateMeasurement: (id, updates) => set((state) => ({
    measurements: state.measurements.map(m =>
      m.id === id ? { ...m, ...updates } : m
    )
  })),

  removeMeasurement: (id) => set((state) => {
    get().addHistoryState();
    return {
      measurements: state.measurements.filter(m => m.id !== id)
    };
  }),

  setActiveMeasurement: (id) => set({ activeMeasurement: id }),
  clearMeasurements: () => set((state) => {
    get().addHistoryState();
    return { measurements: [] };
  }),

  addAnnotation: (annotation) => set((state) => {
    const newAnnotation = {
      ...annotation,
      id: annotation.id || `anno_${Date.now()}`,
      createdAt: new Date().toISOString()
    };
    get().addHistoryState();
    return {
      annotations: [...state.annotations, newAnnotation]
    };
  }),

  updateAnnotation: (id, updates) => set((state) => ({
    annotations: state.annotations.map(a =>
      a.id === id ? { ...a, ...updates } : a
    )
  })),

  removeAnnotation: (id) => set((state) => {
    get().addHistoryState();
    return {
      annotations: state.annotations.filter(a => a.id !== id)
    };
  }),

  setSelectedAnnotation: (id) => set({ selectedAnnotation: id }),

  toggleAnnotationVisibility: (id) => set((state) => ({
    annotations: state.annotations.map(a =>
      a.id === id ? { ...a, visible: a.visible !== false ? false : true } : a
    )
  })),

  toggleCrossSection: () => set((state) => {
    const enabled = !state.crossSection.enabled;
    return {
      crossSection: {
        ...state.crossSection,
        enabled,
        plane: enabled ? createClippingPlane(state.crossSection) : null
      }
    };
  }),

  setCrossSectionAxis: (axis) => set((state) => ({
    crossSection: {
      ...state.crossSection,
      axis,
      plane: createClippingPlane({ ...state.crossSection, axis })
    }
  })),

  setCrossSectionPosition: (position) => set((state) => ({
    crossSection: {
      ...state.crossSection,
      position,
      plane: createClippingPlane({ ...state.crossSection, position })
    }
  })),

  setCrossSectionRotation: (rotation) => set((state) => ({
    crossSection: {
      ...state.crossSection,
      rotation,
      plane: createClippingPlane({ ...state.crossSection, rotation })
    }
  })),

  toggleShowPlane: () => set((state) => ({
    crossSection: { ...state.crossSection, showPlane: !state.crossSection.showPlane }
  })),

  toggleClipIntersection: () => set((state) => ({
    crossSection: { ...state.crossSection, clipIntersection: !state.crossSection.clipIntersection }
  })),

  toggleComparison: () => set((state) => ({
    comparison: { ...state.comparison, enabled: !state.comparison.enabled }
  })),

  setComparisonMode: (mode) => set((state) => ({
    comparison: { ...state.comparison, mode }
  })),

  setSecondaryMesh: (mesh) => set((state) => ({
    comparison: { ...state.comparison, secondaryMesh: mesh }
  })),

  setComparisonOpacity: (opacity) => set((state) => ({
    comparison: { ...state.comparison, opacity }
  })),

  toggleSyncCameras: () => set((state) => ({
    comparison: { ...state.comparison, syncCameras: !state.comparison.syncCameras }
  })),

  addHistoryState: () => set((state) => {
    let newHistory = state.history;
    let newIndex = state.historyIndex;

    if (state.historyIndex < state.history.length - 1) {
      newHistory = state.history.slice(0, state.historyIndex + 1);
    }

    const historyState = {
      measurements: [...state.measurements],
      annotations: [...state.annotations],
      crossSection: { ...state.crossSection },
      timestamp: Date.now()
    };

    newHistory = [...newHistory, historyState];

    if (newHistory.length > state.maxHistorySize) {
      newHistory.shift();
    } else {
      newIndex++;
    }

    return { history: newHistory, historyIndex: newIndex };
  }),

  undo: () => set((state) => {
    if (state.historyIndex > 0) {
      const newIndex = state.historyIndex - 1;
      const historyState = state.history[newIndex];
      return {
        historyIndex: newIndex,
        measurements: [...historyState.measurements],
        annotations: [...historyState.annotations],
        crossSection: { ...historyState.crossSection }
      };
    }
    return state;
  }),

  redo: () => set((state) => {
    if (state.historyIndex < state.history.length - 1) {
      const newIndex = state.historyIndex + 1;
      const historyState = state.history[newIndex];
      return {
        historyIndex: newIndex,
        measurements: [...historyState.measurements],
        annotations: [...historyState.annotations],
        crossSection: { ...historyState.crossSection }
      };
    }
    return state;
  }),

  get canUndo() {
    return get().historyIndex > 0;
  },

  get canRedo() {
    return get().historyIndex < get().history.length - 1;
  },

  reset: () => set({
    sidebarVisible: true,
    toolbarVisible: true,
    activePanel: 'info',
    activeTool: 'navigate',
    previousTool: null,
    viewPreset: DENTAL_VIEW_PRESETS[0],
    cameraInfo: {
      position: new THREE.Vector3(0, 100, 200),
      target: new THREE.Vector3(0, 0, 0),
      zoom: 1
    },
    showGrid: true,
    showAxes: false,
    showBoundingBox: false,
    showStatistics: false,
    background: { color: '#1a1a2e', isDark: true },
    materialSettings: {
      color: '#e8daca',
      metalness: 0.1,
      roughness: 0.5,
      wireframe: false,
      opacity: 1.0,
      transparent: false
    },
    meshStatistics: null,
    measurements: [],
    activeMeasurement: null,
    annotations: [],
    selectedAnnotation: null,
    crossSection: {
      enabled: false,
      axis: 'z',
      position: 0.5,
      rotation: { x: 0, y: 0, z: 0 },
      clipIntersection: false,
      showPlane: true,
      showCap: true,
      capColor: '#ff0000',
      plane: null
    },
    comparison: {
      enabled: false,
      mode: 'side-by-side',
      secondaryMesh: null,
      opacity: 0.5,
      syncCameras: true
    },
    history: [],
    historyIndex: -1
  })
}));

export default useIOSViewerStore;
