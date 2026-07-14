/*
 * ComparisonModel — loads a SECOND IOS scan and renders it alongside
 * the primary one in the same scene, tinted differently and with an
 * adjustable opacity blend so clinicians can see before/after,
 * post-op changes, or alignment drift over time.
 *
 * The primary scan still loads via MultiMeshModel as usual. This
 * component fetches the second study's STL/PLY/OBJ files using the
 * same MeshFile shape and renders them with a single override color
 * (typically cyan) so they're visually distinct from the primary
 * (which keeps its per-role colors: maxilla pinkish-tan,
 * mandible warm cream, occlusion violet).
 *
 * Geometry is parsed via the same loaders as the primary so all the
 * downstream logic (auto-orient, bbox, measurement raycast) works
 * uniformly. We do NOT auto-orient the comparison scan independently
 * — we assume IOS scans of the same patient at different time points
 * are roughly in the same coordinate frame.
 */

import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { MeshFile } from './MultiMeshModel';

interface ComparisonModelProps {
  files: MeshFile[];
  opacity?: number;       // 0..1, default 0.5
  color?: string;         // hex, default '#22d3ee' cyan
  visible?: boolean;
}

interface LoadedComparisonMesh {
  key: string;
  geometry: THREE.BufferGeometry;
}

export default function ComparisonModel({
  files,
  opacity = 0.5,
  color = '#22d3ee',
  visible = true,
}: ComparisonModelProps) {
  const [meshes, setMeshes] = useState<LoadedComparisonMesh[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!files || files.length === 0) {
      setMeshes([]);
      return;
    }

    (async () => {
      const loaded: LoadedComparisonMesh[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const buf = await fetch(file.url).then((r) => r.arrayBuffer());
          if (cancelled) return;
          const ext = (file.fileType || file.fileName.split('.').pop() || 'stl').toLowerCase();
          let geo: THREE.BufferGeometry | null = null;
          if (ext === 'stl') {
            geo = new STLLoader().parse(buf);
          } else if (ext === 'ply') {
            geo = new PLYLoader().parse(buf as ArrayBuffer);
          } else if (ext === 'obj') {
            const txt = new TextDecoder().decode(new Uint8Array(buf));
            const root = new OBJLoader().parse(txt);
            // Pull the first sub-mesh's geometry
            root.traverse((o: any) => {
              if (o.isMesh && o.geometry && !geo) geo = o.geometry as THREE.BufferGeometry;
            });
          }
          if (!geo) continue;
          geo.computeBoundingBox();
          geo.computeVertexNormals();
          loaded.push({ key: `${file.fileName}-${i}`, geometry: geo });
        } catch (e) {
          console.warn('[ComparisonModel] failed to load', file.fileName, e);
        }
      }
      if (!cancelled) setMeshes(loaded);
    })();

    return () => { cancelled = true; };
  }, [files]);

  if (!visible || meshes.length === 0) return null;
  return (
    <group>
      {meshes.map((m) => (
        <mesh
          key={m.key}
          geometry={m.geometry}
          // Mark so other tools can identify comparison meshes and skip them
          userData={{ role: 'comparison', layerKey: m.key }}
        >
          <meshPhysicalMaterial
            color={color}
            transparent
            opacity={opacity}
            depthWrite={opacity > 0.9}
            roughness={0.4}
            metalness={0.05}
            clearcoat={0.1}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}
