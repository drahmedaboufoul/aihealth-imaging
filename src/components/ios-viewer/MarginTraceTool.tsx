/*
 * MarginTraceTool — freehand polyline tracing on the mesh surface,
 * for crown / inlay / onlay prep margin marking before sending to a
 * lab.
 *
 * UX:
 *   - Mounted inside the R3F Canvas. Active when activeTool === 'margin'.
 *   - LEFT-CLICK on the mesh adds a point at the raycast hit position
 *     (snapped exactly to the mesh surface — important for lab geometry).
 *   - As soon as 2+ points exist, a yellow polyline connects them.
 *   - DOUBLE-CLICK (within ~6mm of the start point) closes the loop and
 *     commits the margin as a closed annotation.
 *   - ESC cancels the in-progress trace.
 *   - "Close" button in the floating margin panel commits without
 *     requiring a double-click on the start point.
 *
 * Persistence:
 *   - Each closed margin saves as an annotation with type='margin' in
 *     the existing iosViewerStore.annotations array. Polyline points
 *     are stored in world space so the same margin renders on the
 *     mesh even if the camera moves.
 *
 * Roadmap:
 *   - v1 (this commit): raw polyline + dot markers, persisted to store
 *   - v2: snap-to-edge (find local mesh ridge / valley line), helpful
 *     for tracing along prep finish lines
 *   - v3: STL extrusion + boolean carve so the margin becomes a real
 *     mesh feature exportable to the lab (CAD/CAM)
 */

import { useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useIOSViewerStore } from './store/iosViewerStore';

interface Props {
  active: boolean;
}

// World-space distance threshold for "close to start" double-click to
// commit. 6mm is a generous touch target on typical IOS scans.
const CLOSE_THRESHOLD_MM = 6;

export default function MarginTraceTool({ active }: Props) {
  const { camera, scene, gl } = useThree();
  const addAnnotation = useIOSViewerStore((s: any) => s.addAnnotation);
  const annotations   = useIOSViewerStore((s: any) => s.annotations);

  // In-progress polyline (mutable ref so click handler always sees latest)
  const pendingRef = useRef<[number, number, number][]>([]);
  const [, force] = useState(0);
  const tick = () => force((n) => n + 1);

  // Commit the in-progress polyline as a margin annotation
  const commit = (closed: boolean) => {
    if (pendingRef.current.length < 2) {
      pendingRef.current = [];
      tick();
      return;
    }
    addAnnotation({
      type: 'margin',
      points: pendingRef.current.slice(),
      closed,
      categoryId: 'margin-line',
      label: closed ? 'Closed margin' : 'Open margin',
      color: '#facc15', // yellow
    });
    pendingRef.current = [];
    tick();
  };

  useEffect(() => {
    if (!active) {
      pendingRef.current = [];
      tick();
      return;
    }

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const canvas = gl.domElement;

    const pickWorldPoint = (clientX: number, clientY: number): THREE.Vector3 | null => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const meshes: THREE.Mesh[] = [];
      scene.traverse((o: any) => {
        if (o.isMesh && o.geometry && o.visible) meshes.push(o);
      });
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length === 0) return null;
      return hits[0].point.clone();
    };

    const onClick = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const tgt = ev.target as HTMLElement;
      if (tgt && tgt !== canvas && tgt.tagName !== 'CANVAS') return;
      ev.preventDefault();
      ev.stopPropagation();

      const p = pickWorldPoint(ev.clientX, ev.clientY);
      if (!p) return;

      // Check if click is near the start → close the loop
      const pts = pendingRef.current;
      if (pts.length >= 3) {
        const start = new THREE.Vector3(...pts[0]);
        if (start.distanceTo(p) < CLOSE_THRESHOLD_MM) {
          commit(true);
          return;
        }
      }

      pendingRef.current = [...pts, [p.x, p.y, p.z]];
      tick();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        pendingRef.current = [];
        tick();
      } else if (e.key === 'Enter' && pendingRef.current.length >= 2) {
        commit(false);
      }
    };

    canvas.addEventListener('pointerdown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      canvas.removeEventListener('pointerdown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [active, camera, scene, gl, addAnnotation]);

  return (
    <>
      {/* Committed margins (from annotations store) */}
      {(annotations || [])
        .filter((a: any) => a.type === 'margin' && Array.isArray(a.points) && a.points.length >= 2)
        .map((a: any) => (
          <MarginPolyline key={a.id} points={a.points} closed={!!a.closed} color={a.color || '#facc15'} />
        ))}
      {/* In-progress trace + control dots */}
      {active && pendingRef.current.length > 0 && (
        <group>
          {pendingRef.current.length >= 2 && (
            <PolylineMesh points={pendingRef.current} closed={false} color="#fde047" />
          )}
          {pendingRef.current.map((pt, i) => (
            <mesh key={i} position={pt} renderOrder={999}>
              <sphereGeometry args={[0.35, 12, 8]} />
              <meshBasicMaterial color={i === 0 ? '#22c55e' : '#facc15'} depthTest={false} />
            </mesh>
          ))}
          {/* Floating instruction near the latest point */}
          {pendingRef.current.length > 0 && (
            <Html
              position={pendingRef.current[pendingRef.current.length - 1] as [number, number, number]}
              center
              distanceFactor={12}
              style={{ pointerEvents: 'none' }}
            >
              <div
                style={{
                  background: 'rgba(11,13,16,0.85)', color: '#facc15',
                  padding: '4px 8px', borderRadius: 4, fontSize: 10,
                  fontFamily: 'monospace', whiteSpace: 'nowrap',
                  border: '1px solid #facc15', marginTop: 12,
                }}
              >
                {pendingRef.current.length < 3
                  ? `point ${pendingRef.current.length} — click to add more`
                  : `${pendingRef.current.length} points · click near start (green) to close · Esc to cancel`}
              </div>
            </Html>
          )}
        </group>
      )}
    </>
  );
}

/**
 * Renders a polyline mesh from an array of 3D points. Closes the loop
 * by repeating the first point at the end when `closed` is true.
 */
function PolylineMesh({
  points,
  closed,
  color,
}: {
  points: [number, number, number][] | number[][];
  closed: boolean;
  color: string;
}) {
  const positions = new Float32Array(
    (closed && points.length >= 2
      ? [...points, points[0]]
      : points
    ).flat()
  );
  return (
    <line>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={positions.length / 3}
          itemSize={3}
          array={positions}
        />
      </bufferGeometry>
      {/* @ts-ignore */}
      <lineBasicMaterial color={color} linewidth={3} depthTest={false} />
    </line>
  );
}

function MarginPolyline({
  points,
  closed,
  color,
}: {
  points: [number, number, number][] | number[][];
  closed: boolean;
  color: string;
}) {
  return (
    <group>
      <PolylineMesh points={points} closed={closed} color={color} />
      {points.map((pt, i) => (
        <mesh key={i} position={pt as [number, number, number]} renderOrder={998}>
          <sphereGeometry args={[0.25, 10, 6]} />
          <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.85} />
        </mesh>
      ))}
    </group>
  );
}
