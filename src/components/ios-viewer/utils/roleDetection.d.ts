/** Filename-based scan role detection (see roleDetection.js). */
export type ScanRole = 'maxilla' | 'mandible' | 'occlusion' | 'unknown';
export function detectScanRole(filename: string): ScanRole;
export const ROLE_STYLE: Record<ScanRole, { color: string; emissiveIntensity: number; roughness: number; label: string }>;
export const UNKNOWN_PALETTE: string[];
export const ROLE_TO_SETTING: Record<ScanRole, { visible: string; opacity: string }>;
