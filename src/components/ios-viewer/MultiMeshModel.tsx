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

export interface MeshFile {
  url: string;
  fileName: string;
  fileType?: string; // 'stl' | 'ply' | 'obj' (defaults to extension parse)
}

export interface ViewerSettingsLite {
  maxillaVisible: boolean;
  maxillaOpacity: number;   // 0..100
  mandibleVisible: boolean;
  mandibleOpacity: number;
  occlusionVisible: boolean;
  occlusionOpacity: number;
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
  onError?: (err: Error) => void;
}

export function MultiMeshModel({ files, viewerSettings, onLoaded, onError }: MultiMeshModelProps) {
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
        setMeshes(loaded);
      });

    return () => { cancelled = true; };
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

  // Auto-frame camera once everything is loaded
  useEffect(() => {
    if (!groupBounds || meshes.length === 0) return;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    groupBounds.getCenter(center);
    groupBounds.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim === 0) return;

    // Position camera so the case fits with comfortable padding.
    const dist = maxDim * 1.6;
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.position.set(center.x, center.y + maxDim * 0.3, center.z + dist);
      camera.lookAt(center);
      camera.near = Math.max(0.1, maxDim * 0.01);
      camera.far  = maxDim * 50;
      camera.updateProjectionMatrix();
    }
    onLoaded?.({ count: meshes.length, bounds: groupBounds });
  }, [groupBounds, meshes.length, camera, onLoaded]);

  if (meshes.length === 0) return null;

  // Group-level offset so meshes render around origin
  const groupOffset = useMemo(() => {
    if (!groupBounds) return new THREE.Vector3();
    const c = new THREE.Vector3();
    groupBounds.getCenter(c);
    return c.negate();
  }, [groupBounds]);

  return (
    <group ref={groupRef} position={groupOffset}>
      {meshes.map((m, idx) => {
        const setting = ROLE_TO_SETTING[m.role];
        const visible = (viewerSettings as any)[setting.visible] ?? true;
        const opacityPct = (viewerSettings as any)[setting.opacity] ?? 100;
        const style = ROLE_STYLE[m.role];

        return (
          <mesh
            key={`${m.fileName}-${idx}`}
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
              transparent={opacityPct < 100}
              opacity={opacityPct / 100}
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
