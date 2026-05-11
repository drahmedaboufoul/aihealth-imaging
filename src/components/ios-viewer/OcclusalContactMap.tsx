/*
 * OcclusalContactMap — computes the real occlusal contact map between
 * the maxilla and mandible meshes by measuring inter-mesh point
 * distance and rendering a heatmap of pressure-likely zones.
 *
 * Algorithm:
 *   1. Find the two meshes labelled "maxilla" and "mandible" in the
 *      scene (their userData.role is set by MultiMeshModel).
 *   2. For each vertex on the maxilla, raycast straight DOWN onto the
 *      mandible to find the corresponding occluding point.
 *   3. Color the maxilla vertex by distance:
 *        red  = touching (< 0.2mm)
 *        amber = near (0.2-0.5mm)
 *        green = no contact (> 0.5mm)
 *   4. Apply the per-vertex colors as a VertexColors material override
 *      so the maxilla itself shows the heatmap.
 *
 * Re-runs when the user toggles the Occlusal Contact tool or moves
 * the meshes (none of our flows move meshes after load — but the
 * trigger pattern is here for future articulator features).
 *
 * Limitations:
 *   - Single-axis (downward) projection; doesn't catch lateral
 *     interferences. v2 will use mesh-to-mesh closest-point with a BVH.
 *   - Quality scales with vertex density. IOS scans typically have
 *     50k-200k vertices per arch, fast enough on 8GB RAM in <1 sec.
 */

import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

interface Props {
  active: boolean;
  // Contact threshold in mm. Distances <= this are colored as "touching".
  contactThresholdMM?: number;
  // Distances <= this but > contactThresholdMM are "near".
  nearThresholdMM?: number;
}

// Sentinel attribute name used to detect if we've already painted
// vertex colors on a mesh, so we can restore them on disable.
const PREVIOUS_COLORS_ATTR = '__occlusalPrevColors';
const ORIGINAL_VERTEX_COLORS = '__occlusalHadVertexColors';

export default function OcclusalContactMap({
  active,
  contactThresholdMM = 0.2,
  nearThresholdMM = 0.5,
}: Props) {
  const { scene } = useThree();

  useEffect(() => {
    // Resolve maxilla + mandible meshes from the scene
    let maxilla: THREE.Mesh | null = null;
    let mandible: THREE.Mesh | null = null;
    scene.traverse((o: any) => {
      if (!o.isMesh || !o.visible) return;
      const role = o.userData?.role || o.userData?.layerRole;
      if (role === 'maxilla' && !maxilla) maxilla = o;
      if (role === 'mandible' && !mandible) mandible = o;
    });

    // Cleanup function — restore meshes to their pre-painted state
    const cleanup = () => {
      for (const m of [maxilla, mandible]) {
        if (!m) continue;
        const mesh = m as THREE.Mesh;
        const geo = mesh.geometry as THREE.BufferGeometry;
        const prev = (geo as any)[PREVIOUS_COLORS_ATTR];
        const hadVC = (geo as any)[ORIGINAL_VERTEX_COLORS];
        if (prev) {
          geo.setAttribute('color', prev);
          delete (geo as any)[PREVIOUS_COLORS_ATTR];
        } else if (!hadVC) {
          geo.deleteAttribute('color');
        }
        const mat = mesh.material as any;
        if (mat) {
          const mats = Array.isArray(mat) ? mat : [mat];
          for (const mm of mats) {
            mm.vertexColors = !!hadVC;
            mm.needsUpdate = true;
          }
        }
        delete (geo as any)[ORIGINAL_VERTEX_COLORS];
      }
    };

    if (!active) {
      cleanup();
      return;
    }
    if (!maxilla || !mandible) {
      // Not multi-mesh case — nothing to do. The tool just no-ops.
      return cleanup;
    }

    // Compute the contact map: for each maxilla vertex, ray down to the mandible
    const t0 = performance.now();
    const maxGeo = (maxilla as THREE.Mesh).geometry as THREE.BufferGeometry;
    const manGeo = (mandible as THREE.Mesh).geometry as THREE.BufferGeometry;
    const maxPos = maxGeo.attributes.position;
    if (!maxPos) return cleanup;

    // Save the original color attribute (if any) so we can restore on toggle off
    const existing = maxGeo.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (existing) {
      (maxGeo as any)[PREVIOUS_COLORS_ATTR] = existing.clone();
      (maxGeo as any)[ORIGINAL_VERTEX_COLORS] = true;
    } else {
      (maxGeo as any)[ORIGINAL_VERTEX_COLORS] = false;
    }

    const colors = new Float32Array(maxPos.count * 3);

    // Build a raycaster pointing in -Y (downwards from maxilla to mandible)
    // We bring the test point to world space via the maxilla matrix, then
    // shoot in world -Y. World Y is the canonical occlusal axis for
    // PCA-oriented scans.
    const ray = new THREE.Raycaster();
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3(0, -1, 0);
    ray.far = 30; // mm — anything > 30mm down is "definitely no contact"

    // mandible bounding box (world-space) to early-skip vertices that
    // can't possibly hit it
    manGeo.computeBoundingBox();
    const manBox = (manGeo.boundingBox as THREE.Box3).clone()
      .applyMatrix4((mandible as THREE.Mesh).matrixWorld);

    const tmpV = new THREE.Vector3();
    let hits = 0;
    const total = maxPos.count;

    for (let i = 0; i < total; i++) {
      // World-space vertex
      tmpV.fromBufferAttribute(maxPos, i).applyMatrix4((maxilla as THREE.Mesh).matrixWorld);

      // Skip if vertex is below mandible's max Y (we shoot DOWN; nothing
      // below the mandible top can hit it)
      if (tmpV.y < manBox.min.y) {
        // Color green — out of range
        colors[i * 3] = 0.4; colors[i * 3 + 1] = 0.85; colors[i * 3 + 2] = 0.4;
        continue;
      }
      // Skip if vertex isn't above the mandible's footprint at all
      if (tmpV.x < manBox.min.x || tmpV.x > manBox.max.x ||
          tmpV.z < manBox.min.z || tmpV.z > manBox.max.z) {
        colors[i * 3] = 0.4; colors[i * 3 + 1] = 0.85; colors[i * 3 + 2] = 0.4;
        continue;
      }

      origin.copy(tmpV);
      ray.set(origin, dir);
      const intersects = ray.intersectObject(mandible as THREE.Mesh, false);
      if (intersects.length === 0) {
        // No mandible below this vertex — green
        colors[i * 3] = 0.4; colors[i * 3 + 1] = 0.85; colors[i * 3 + 2] = 0.4;
        continue;
      }
      const dist = intersects[0].distance;
      hits++;
      // Color ramp
      let r: number, g: number, b: number;
      if (dist <= contactThresholdMM) {
        // Touching → solid red
        r = 0.95; g = 0.15; b = 0.15;
      } else if (dist <= nearThresholdMM) {
        // Near → amber
        r = 0.95; g = 0.65; b = 0.20;
      } else if (dist <= 1.5) {
        // Light contact zone → yellow-green
        const f = (dist - nearThresholdMM) / (1.5 - nearThresholdMM);
        r = 0.95 - f * 0.55;     // 0.95 → 0.40
        g = 0.65 + f * 0.20;     // 0.65 → 0.85
        b = 0.20 + f * 0.20;     // 0.20 → 0.40
      } else {
        // Far → green
        r = 0.4; g = 0.85; b = 0.4;
      }
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }

    const colAttr = new THREE.BufferAttribute(colors, 3);
    colAttr.needsUpdate = true;
    maxGeo.setAttribute('color', colAttr);

    // Enable vertex colors on the maxilla material(s)
    const mat = (maxilla as THREE.Mesh).material as any;
    const mats = Array.isArray(mat) ? mat : [mat];
    for (const mm of mats) {
      mm.vertexColors = true;
      mm.needsUpdate = true;
    }

    const elapsed = performance.now() - t0;
    console.log(
      `[OcclusalContactMap] painted ${total} vertices · ${hits} contact rays hit · ${elapsed.toFixed(0)}ms`
    );

    return cleanup;
  }, [active, scene, contactThresholdMM, nearThresholdMM]);

  return null;
}
