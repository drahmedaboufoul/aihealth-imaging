/*
 * MultiMeshModel — load and render multiple STL/PLY/OBJ files together.
 *
 * Real intraoral scan cases ship as 3-5 files (upper, lower, occlusion x1-2).
 * This component:
 *   - Loads each file via the right loader (lazy-imported per format)
 *   - Detects role from filename (maxilla / mandible / occlusion / unknown)
 *   - Renders each mesh as its own <mesh> with role-specific material
 *   - Wires per-role visibility + opacity to the existing viewerSettings shape
 *   - Auto-frames the camera to fit all visible meshes after load
 *
 * Loading is parallel across files (Promise.all) but bounded by the browser's
 * fetch concurrency. For very large scans (50MB+ STL each), this keeps the
 * tab responsive vs. a single 200MB monolith.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { detectScanRole, ROLE_STYLE, ROLE_TO_SETTING } from './utils/roleDetection';
import { computeAutoOrient } from './utils/autoOrient';

export interface MeshFile {
  url: string;
  fileName: string;
  fileType?: string; // 'stl' | 'ply' | 'obj' (defaults to extension parse)
}

/** One row in the per-mesh layer panel. Caller (IOSViewerPage) maintains
 *  this array based on what MultiMeshModel reports via onMeshesReady. */
export interface MeshLayer {
  /** Stable key — derived from filename, e.g. "upperjaw.stl-0". */
  key: string;
  /** Display label, e.g. "Maxilla", "Bite 1", "Mandible". */
  label: string;
  role: 'maxilla' | 'mandible' | 'occlusion' | 'unknown';
  visible: boolean;
  opacity: number; // 0..100
}

export interface ViewerSettingsLite {
  maxillaVisible: boolean;
  maxillaOpacity: number;   // 0..100
  mandibleVisible: boolean;
  mandibleOpacity: number;
  occlusionVisible: boolean;
  occlusionOpacity: number;
  /** Optional — when set to a role, ONLY meshes of that role render. */
  isolatedRole?: 'maxilla' | 'mandible' | 'occlusion' | null;
  /** When false, skip the PCA auto-orient. Default true. */
  autoOrient?: boolean;
  /** Per-mesh layer state (multi-file mode). When present, supersedes the
   *  per-role flags above for visibility + opacity. */
  meshLayers?: MeshLayer[];
}

interface LoadedMesh {
  geometry: THREE.BufferGeometry;
  role: 'maxilla' | 'mandible' | 'occlusion' | 'unknown';
  fileName: string;
  hasVertexColors: boolean;
}

function getExt(fileName: string, fileType?: string): string {
  if (fileType) return fileType.toLowerCase();
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : 'stl';
}

async function loadOneFile(file: MeshFile): Promise<LoadedMesh> {
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${file.fileName}`);
  const buffer = await res.arrayBuffer();
  const ext = getExt(file.fileName, file.fileType);

  let geometry: THREE.BufferGeometry | null = null;
  let hasVertexColors = false;

  if (ext === 'stl') {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader');
    geometry = new STLLoader().parse(buffer);
  } else if (ext === 'ply') {
    const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader');
    geometry = new PLYLoader().parse(buffer);
    if (geometry.hasAttribute('color')) hasVertexColors = true;
  } else if (ext === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader');
    const text = new TextDecoder().decode(buffer);
    const obj = new OBJLoader().parse(text);
    obj.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh && !geometry) {
        geometry = (child as THREE.Mesh).geometry as THREE.BufferGeometry;
      }
    });
  } else {
    throw new Error(`Unsupported 3D scan format: ${ext}`);
  }

  if (!geometry) throw new Error(`No mesh found in ${file.fileName}`);

  // Smooth normals from triangle normals (STL ships per-triangle normals
  // which produce a faceted look when shaded). computeVertexNormals
  // averages them across shared vertices for a smoother surface.
  geometry.computeVertexNormals();

  return {
    geometry,
    role: detectScanRole(file.fileName),
    fileName: file.fileName,
    hasVertexColors,
  };
}

interface MultiMeshModelProps {
  files: MeshFile[];
  viewerSettings: ViewerSettingsLite;
  onLoaded?: (info: { count: number; bounds: THREE.Box3 }) => void;
  /** Reports the per-mesh layer metadata once all files have loaded so the
   *  parent can render a per-file panel. Each call replaces the previous list. */
  onMeshesReady?: (layers: MeshLayer[]) => void;
  onError?: (err: Error) => void;
}

/** Build human-friendly labels — "Maxilla", "Mandible", "Bite 1", "Bite 2",
 *  "Scan 1" for unknowns — numbering only when there are multiple of a role. */
function buildLayerLabels(meshes: LoadedMesh[]): MeshLayer[] {
  const counts: Record<string, number> = {};
  for (const m of meshes) counts[m.role] = (counts[m.role] || 0) + 1;

  const seen: Record<string, number> = {};
  const baseFor = (role: LoadedMesh['role']): string => {
    if (role === 'maxilla')   return 'Maxilla';
    if (role === 'mandible')  return 'Mandible';
    if (role === 'occlusion') return 'Bite';
    return 'Scan';
  };

  return meshes.map((m, idx) => {
    const base = baseFor(m.role);
    seen[m.role] = (seen[m.role] || 0) + 1;
    const label = counts[m.role] > 1 ? `${base} ${seen[m.role]}` : base;
    return {
      key: `${m.fileName}-${idx}`,
      label,
      role: m.role,
      visible: true,
      opacity: 100,
    };
  });
}

export function MultiMeshModel({ files, viewerSettings, onLoaded, onMeshesReady, onError }: MultiMeshModelProps) {
  const [meshes, setMeshes] = useState<LoadedMesh[]>([]);
  const groupRef = useRef<THREE.Group>(null);
  const { camera } = useThree();

  // Load all files in parallel
  useEffect(() => {
    let cancelled = false;
    if (!files || files.length === 0) {
      setMeshes([]);
      return;
    }
    setMeshes([]); // clear while loading

    Promise.all(files.map((f) => loadOneFile(f).catch((err) => {
      console.error('[MultiMeshModel] failed to load', f.fileName, err);
      onError?.(err as Error);
      return null;
    })))
      .then((results) => {
        if (cancelled) return;
        const loaded = results.filter(Boolean) as LoadedMesh[];

        // Auto-orient via PCA on the combined point cloud, applied uniformly
        // to all meshes so upper + lower stay registered. Skip if explicitly
        // disabled. Geometry is mutated in place — fine because each load
        // produces fresh BufferGeometry instances.
        if ((viewerSettings.autoOrient ?? true) && loaded.length > 0) {
          const { transform, confident } = computeAutoOrient(loaded.map((m) => m.geometry));
          if (confident) {
            for (const m of loaded) {
              m.geometry.applyMatrix4(transform);
              m.geometry.computeVertexNormals();
              m.geometry.computeBoundingBox();
            }
          }
        }

        setMeshes(loaded);
        // Tell the parent which layers are loaded so it can render a
        // per-file controls panel.
        onMeshesReady?.(buildLayerLabels(loaded));
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, onError]);

  // Compute centered, aggregate bounds across all loaded meshes; recenter the
  // group so the camera frames the whole case rather than just one arch.
  const groupBounds = useMemo(() => {
    if (meshes.length === 0) return null;
    const box = new THREE.Box3();
    meshes.forEach((m) => {
      m.geometry.computeBoundingBox();
      if (m.geometry.boundingBox) box.union(m.geometry.boundingBox);
    });
    return box;
  }, [meshes]);

  // Auto-frame camera once everything is loaded.
  //
  // Frame the IN-PLANE size (X = mesial-distal, Z = buccal-lingual after
  // PCA orient) rather than the max dimension across all axes. The arch
  // height (Y after orient) is small relative to the arch length, and
  // including it pulls the camera too close.
  //
  // Distance formula: tan(fov/2) * dist = halfWidth -> dist = halfWidth / tan(fov/2)
  // We add a 1.6× padding so there's breathing room.
  useEffect(() => {
    if (!groupBounds || meshes.length === 0) return;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    groupBounds.getCenter(center);
    groupBounds.getSize(size);

    if (camera instanceof THREE.PerspectiveCamera) {
      const fovRad = (camera.fov * Math.PI) / 180;
      const halfTan = Math.tan(fovRad / 2);
      // The dimensions actually visible after the orient: X (length) and
      // Z (depth). Y is the small "thickness". Use the larger of X, Z.
      const inPlaneMax = Math.max(size.x, size.z, 1e-3);
      const fitDist = (inPlaneMax / 2) / halfTan;
      const dist = fitDist * 1.6 + size.y; // small Y offset so camera clears the arch top

      camera.position.set(center.x, center.y + size.y * 0.6, center.z + dist);
      camera.lookAt(center);
      // Near/far set very generously so user can zoom in to a tooth or way out.
      const radius = Math.max(size.length() / 2, 1);
      camera.near = Math.max(0.01, radius * 0.001);
      camera.far  = radius * 200;
      camera.updateProjectionMatrix();
    }
    onLoaded?.({ count: meshes.length, bounds: groupBounds });
  }, [groupBounds, meshes.length, camera, onLoaded]);

  // Group-level offset so meshes render around origin.
  // IMPORTANT: this useMemo MUST run before the early-return below so the
  // hook order is identical on every render. Calling a hook conditionally
  // throws React error #310 ("rendered more hooks than during the previous
  // render"), which then trips THREE.WebGLRenderer context loss when the
  // tree unmounts mid-render.
  const groupOffset = useMemo(() => {
    if (!groupBounds) return new THREE.Vector3();
    const c = new THREE.Vector3();
    groupBounds.getCenter(c);
    return c.negate();
  }, [groupBounds]);

  if (meshes.length === 0) return null;

  return (
    <group ref={groupRef} position={groupOffset}>
      {meshes.map((m, idx) => {
        const meshKey = `${m.fileName}-${idx}`;
        const layer = viewerSettings.meshLayers?.find((l) => l.key === meshKey);

        // Prefer per-mesh layer state when the parent provides it; fall
        // back to per-role flags otherwise (legacy single-file mode).
        const setting = ROLE_TO_SETTING[m.role];
        const baseVisible = layer
          ? layer.visible
          : ((viewerSettings as any)[setting.visible] ?? true);
        const opacityPct = layer
          ? layer.opacity
          : ((viewerSettings as any)[setting.opacity] ?? 100);
        const style = ROLE_STYLE[m.role];

        // Per-role isolate (the All / Up / Low / Bite chips). When active,
        // hide everything that doesn't match regardless of layer state.
        const isolated = viewerSettings.isolatedRole;
        const visible = isolated ? (m.role === isolated) : baseVisible;

        return (
          <mesh
            key={meshKey}
            geometry={m.geometry}
            visible={visible}
            castShadow
            receiveShadow
          >
            <meshPhysicalMaterial
              color={m.hasVertexColors ? 0xffffff : style.color}
              vertexColors={m.hasVertexColors}
              roughness={style.roughness}
              metalness={0.05}
              clearcoat={0.15}              // subtle wet look (saliva-like)
              clearcoatRoughness={0.4}
              sheen={0.1}                   // soft surface
              sheenColor={0xffffff}
              side={THREE.DoubleSide}
              // Always transparent so opacity slider responds smoothly.
              // Toggling .transparent forces three.js to rebuild the
              // material program — change wasn't applying mid-session.
              transparent
              opacity={Math.max(0, Math.min(1, opacityPct / 100))}
              depthWrite={opacityPct >= 99}
              emissive={0x000000}
              emissiveIntensity={style.emissiveIntensity}
            />
          </mesh>
        );
      })}
    </group>
  );
}

export default MultiMeshModel;
