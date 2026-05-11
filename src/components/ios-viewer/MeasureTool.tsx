/*
 * MeasureTool — real distance + angle measurement on the IOS mesh.
 *
 * Mounted INSIDE the R3F Canvas. Listens for clicks on the canvas
 * element, raycasts into the scene against mesh objects, and
 * accumulates points. Once enough points are collected for the
 * active tool, commits a measurement to the IOS viewer store.
 *
 * Distance: 2 points → straight-line distance in mm (geometry world
 *   units are already in mm for STL exports from IOS scanners).
 * Angle: 3 points → angle at the middle point (vertex) between the
 *   other two, in degrees.
 *
 * The store renders the committed measurements via MeasurementOverlay.
 * In-progress points (1 dot for distance after first click, 2 dots
 * for angle after second click) are rendered here.
 */

import { useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useIOSViewerStore } from './store/iosViewerStore';

interface MeasureToolProps {
  active: boolean;
  toolType?: 'distance' | 'angle';
  onComplete?: () => void;
}

export default function MeasureTool({
  active,
  toolType = 'distance',
  onComplete,
}: MeasureToolProps) {
  const { camera, scene, gl } = useThree();
  const addMeasurement = useIOSViewerStore((s: any) => s.addMeasurement);
  const setActiveMeasurement = useIOSViewerStore((s: any) => s.setActiveMeasurement);

  // Pending points kept in a ref so the click handler always sees the
  // latest state (avoids React closure staleness).
  const pendingRef = useRef<[number, number, number][]>([]);
  const [, force] = useState(0);
  const tick = () => force((n) => n + 1);

  useEffect(() => {
    if (!active) {
      pendingRef.current = [];
      tick();
      return;
    }

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const canvas = gl.domElement;

    // Need enough points for the active tool type:
    //   distance → 2
    //   angle    → 3
    const requiredPoints = toolType === 'angle' ? 3 : 2;

    const onClick = (ev: MouseEvent) => {
      // Skip if the click was on a UI control (button, slider, etc.)
      const tgt = ev.target as HTMLElement;
      if (tgt && tgt !== canvas && tgt.tagName !== 'CANVAS') return;
      // Skip right-click / middle-click (those drive orbit/pan)
      if (ev.button !== 0) return;

      const rect = canvas.getBoundingClientRect();
      ndc.set(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);

      // Raycast against actual mesh content (ignore grid / helpers)
      const meshes: THREE.Mesh[] = [];
      scene.traverse((o: any) => {
        if (o.isMesh && o.geometry && o.visible) meshes.push(o);
      });
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length === 0) return;

      const p = hits[0].point;
      pendingRef.current = [
        ...pendingRef.current,
        [p.x, p.y, p.z] as [number, number, number],
      ];

      if (pendingRef.current.length >= requiredPoints) {
        // Commit
        const points = pendingRef.current.slice(0, requiredPoints);
        const value =
          toolType === 'angle'
            ? computeAngleAtVertex(points)
            : computeDistance(points[0], points[1]);
        addMeasurement({
          type: toolType,
          points,
          value,
        });
        pendingRef.current = [];
        setActiveMeasurement?.(null);
        onComplete?.();
        tick();
      } else {
        tick();
      }
    };

    canvas.addEventListener('pointerdown', onClick);
    return () => canvas.removeEventListener('pointerdown', onClick);
  }, [active, toolType, camera, scene, gl, addMeasurement, setActiveMeasurement, onComplete]);

  // Render in-progress points as small spheres
  if (!active || pendingRef.current.length === 0) return null;

  return (
    <group>
      {pendingRef.current.map((pt, i) => (
        <mesh key={i} position={pt} renderOrder={999}>
          <sphereGeometry args={[0.4, 16, 12]} />
          <meshBasicMaterial color="#ff4444" depthTest={false} transparent opacity={0.95} />
        </mesh>
      ))}
      {/* Connecting line preview if 2+ points and tool is distance */}
      {toolType === 'distance' && pendingRef.current.length === 1 && (
        <PreviewLineToMouse from={pendingRef.current[0]} />
      )}
    </group>
  );
}

/**
 * Live preview line from the first picked point to the mouse cursor's
 * current raycast hit. Gives the user feedback while choosing the 2nd
 * point of a distance measurement.
 */
function PreviewLineToMouse({ from }: { from: [number, number, number] }) {
  const { camera, scene, gl } = useThree();
  const ref = useRef<THREE.BufferGeometry>(null!);
  const lineRef = useRef<THREE.Line>(null!);

  useEffect(() => {
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const canvas = gl.domElement;
    const tmp = new THREE.Vector3();

    const onMove = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const meshes: THREE.Mesh[] = [];
      scene.traverse((o: any) => {
        if (o.isMesh && o.geometry && o.visible) meshes.push(o);
      });
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length === 0) return;
      tmp.copy(hits[0].point);
      // Update geometry attribute in place
      const geo = ref.current;
      if (!geo) return;
      const arr = (geo.attributes.position.array as Float32Array);
      arr[0] = from[0]; arr[1] = from[1]; arr[2] = from[2];
      arr[3] = tmp.x;    arr[4] = tmp.y;    arr[5] = tmp.z;
      geo.attributes.position.needsUpdate = true;
    };

    canvas.addEventListener('pointermove', onMove);
    return () => canvas.removeEventListener('pointermove', onMove);
  }, [camera, scene, gl, from]);

  return (
    <line ref={lineRef as any}>
      <bufferGeometry ref={ref}>
        <bufferAttribute
          attach="attributes-position"
          count={2}
          itemSize={3}
          array={new Float32Array([from[0], from[1], from[2], from[0], from[1], from[2]])}
        />
      </bufferGeometry>
      {/* @ts-ignore - lineBasicMaterial works on <line>, TS3 typing is grumpy */}
      <lineBasicMaterial color="#ff4444" depthTest={false} />
    </line>
  );
}

function computeDistance(a: number[], b: number[]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function computeAngleAtVertex(points: number[][]) {
  // Angle at points[1] formed by vectors to points[0] and points[2]
  const v1 = [
    points[0][0] - points[1][0],
    points[0][1] - points[1][1],
    points[0][2] - points[1][2],
  ];
  const v2 = [
    points[2][0] - points[1][0],
    points[2][1] - points[1][1],
    points[2][2] - points[1][2],
  ];
  const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  const m1 = Math.hypot(v1[0], v1[1], v1[2]);
  const m2 = Math.hypot(v2[0], v2[1], v2[2]);
  if (m1 === 0 || m2 === 0) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}
