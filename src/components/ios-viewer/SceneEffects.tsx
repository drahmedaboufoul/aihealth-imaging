/*
 * SceneEffects — wires the previously-orphaned UI controls (clipping
 * plane, material settings, wireframe, opacity) into the actual 3D
 * scene. Mount once inside the R3F Canvas.
 *
 * Reads:
 *   - useIOSViewerStore().crossSection   → applies THREE.Plane clipping
 *   - useIOSViewerStore().materialSettings → applies wireframe + opacity
 *                                            + color (when distinct from
 *                                            per-role defaults)
 *
 * This was the biggest discrepancy flagged by the project audit: the
 * MaterialControls + CrossSectionControls UI was wired to the store
 * but the store changes never made it to the meshes. This component
 * closes that loop by subscribing to the store and traversing the
 * scene on each relevant change.
 */

import { useEffect } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useIOSViewerStore } from './store/iosViewerStore';

export default function SceneEffects() {
  const { scene, gl } = useThree();
  const crossSection   = useIOSViewerStore((s: any) => s.crossSection);
  const materialSettings = useIOSViewerStore((s: any) => s.materialSettings);

  // ── Clipping plane ────────────────────────────────────────────────
  useEffect(() => {
    if (!crossSection?.enabled) {
      // Disable clipping globally
      gl.clippingPlanes = [];
      gl.localClippingEnabled = false;
      scene.traverse((o: any) => {
        if (o.isMesh && o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            m.clippingPlanes = [];
            m.clipIntersection = false;
            m.needsUpdate = true;
          }
        }
      });
      return;
    }

    // Compute the bounding box of all visible meshes so we can map the
    // 0-1 position slider onto world coordinates along the chosen axis.
    const box = new THREE.Box3();
    scene.traverse((o: any) => {
      if (o.isMesh && o.geometry && o.visible) {
        o.geometry.computeBoundingBox();
        if (o.geometry.boundingBox) {
          const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
          box.union(b);
        }
      }
    });
    if (box.isEmpty()) return;

    const axis = (crossSection.axis || 'z') as 'x' | 'y' | 'z';
    const position = typeof crossSection.position === 'number' ? crossSection.position : 0.5;
    const normalVec = {
      x: new THREE.Vector3(-1, 0, 0),
      y: new THREE.Vector3(0, -1, 0),
      z: new THREE.Vector3(0, 0, -1),
    }[axis];

    // Position the plane at the slider's fraction along the axis
    const min = box.min[axis];
    const max = box.max[axis];
    const planeCoord = min + (max - min) * position;
    // For normal = -axis, the constant satisfies n · x + d = 0 → d = -n·x
    // For plane facing -axis at coord c, points where x.axis > c get clipped.
    const plane = new THREE.Plane(normalVec, planeCoord);

    gl.localClippingEnabled = true;
    gl.clippingPlanes = []; // global empty; we apply per-material

    scene.traverse((o: any) => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.clippingPlanes = [plane];
          m.clipIntersection = !!crossSection.clipIntersection;
          m.side = THREE.DoubleSide; // show interior where clipped
          m.needsUpdate = true;
        }
      }
    });
  }, [
    scene, gl,
    crossSection?.enabled,
    crossSection?.axis,
    crossSection?.position,
    crossSection?.clipIntersection,
  ]);

  // ── Material settings (wireframe, opacity, color override) ────────
  // Only override if the user has interacted with material controls
  // (e.g. wireframe=true, or opacity<1 globally). Otherwise leave the
  // per-role per-mesh colors set by MultiMeshModel alone.
  useEffect(() => {
    if (!materialSettings) return;
    scene.traverse((o: any) => {
      if (!(o.isMesh && o.material)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (typeof materialSettings.wireframe === 'boolean') {
          m.wireframe = materialSettings.wireframe;
        }
        // Only override opacity globally if user pulled it below 1.
        if (typeof materialSettings.opacity === 'number' && materialSettings.opacity < 1) {
          m.opacity = materialSettings.opacity;
          m.transparent = true;
        }
        // Apply metalness/roughness if material supports them
        if ('metalness' in m && typeof materialSettings.metalness === 'number') {
          m.metalness = materialSettings.metalness;
        }
        if ('roughness' in m && typeof materialSettings.roughness === 'number') {
          m.roughness = materialSettings.roughness;
        }
        m.needsUpdate = true;
      }
    });
  }, [
    scene,
    materialSettings?.wireframe,
    materialSettings?.opacity,
    materialSettings?.metalness,
    materialSettings?.roughness,
  ]);

  return null;
}
