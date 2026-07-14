// Patient Types
export interface Patient {
  id: string;
  name: string;
  gender: 'male' | 'female';
  age: number;
  avatar?: string;
}

// Scan Types
export type ScanType = 'IOS' | 'CT' | 'Face Scan' | 'Panoramic' | 'Cephalometric' | 'CR';

export interface Scan {
  id: string;
  patientId: string;
  type: ScanType;
  name: string;
  thumbnail?: string;
  createdAt: string;
  hasModel: boolean;
}

// 3D Viewer Types
export type IsolatedRole = 'maxilla' | 'mandible' | 'occlusion' | null;

export interface ViewerSettings {
  maxillaVisible: boolean;
  maxillaOpacity: number;
  mandibleVisible: boolean;
  mandibleOpacity: number;
  occlusionVisible: boolean;
  occlusionOpacity: number;
  showGrid: boolean;
  /** When non-null, ONLY meshes of this role render (used by Isolate buttons). */
  isolatedRole?: IsolatedRole;
  /** When false, skip PCA auto-orient on load. Defaults to true. */
  autoOrient?: boolean;
}

export type ToolType = 'none' | 'measure' | 'occlusal' | 'analysis' | 'tooth-label' | 'margin';

export interface MouseSettings {
  leftRotation: boolean; // true = left rotates, false = right rotates
}
