/*
 * compareMeshPanes — three.js (react-three-fiber) panes used by the CBCT
 * Compare tab for intraoral-scan meshes:
 *
 *   MeshSidePane    — standalone mesh viewer for the CBCT-vs-mesh side-by-side
 *                     layout (orientation presets linked to the CBCT 3D pane).
 *   MeshOverlayPane — the registration scene: the CBCT rendered as world-space
 *                     textured planes (axial MIP over the dentition slab +
 *                     coronal/sagittal mid-slices) with the mesh INSIDE the
 *                     same patient/world coordinate frame, movable manually
 *                     (buttons + drag gizmo) or by the ICP auto-align.
 *
 * WHY three.js (and not a mesh inside cornerstone's 3D viewport): cornerstone3D
 * v4's VOLUME_3D viewport is vtk.js-backed and exposes no supported API for
 * injecting foreign geometry; converting THREE geometry to vtkPolyData would
 * mean depending on vtk.js internals that aren't part of cornerstone's public
 * surface. The inverse direction — sampling the already-loaded volume into
 * textured patient-space planes for a three.js scene — uses only our own code
 * (see src/lib/volumeMeshSampling.js), is deterministic, and is testable.
 *
 * This module is loaded lazily (only when a mesh study is selected in Compare)
 * so the three.js stack stays out of the viewer's initial bundle.
 */
/* eslint-disable react/no-unknown-property -- react-three-fiber JSX (geometry,
   position, intensity, …) is not DOM JSX; the rule has no r3f awareness. */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader';
import { Loader2 } from 'lucide-react';
import { downsamplePoints } from '@/lib/meshRegistration';

const COMPONENT_COLORS = {
  'Upper jaw': '#e8d5b8',
  'Lower jaw': '#d8c4ad',
};
const DEFAULT_MESH_COLOR = '#cfc0ae';

async function parseGeometry(url, kind) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching mesh`);
  const buffer = await response.arrayBuffer();
  let geometry = null;
  if (kind === 'stl') geometry = new STLLoader().parse(buffer);
  else if (kind === 'ply') geometry = new PLYLoader().parse(buffer);
  else if (kind === 'obj') {
    const obj = new OBJLoader().parse(new TextDecoder().decode(buffer));
    obj.traverse((child) => { if (child.isMesh && !geometry) geometry = child.geometry; });
  }
  if (!geometry) throw new Error(`Unsupported mesh kind: ${kind}`);
  geometry.computeVertexNormals();
  return geometry;
}

/** Sample up to maxPoints vertex positions (mesh-local coords) from a geometry. */
function sampleGeometryPoints(geometry, maxPoints = 2000) {
  const pos = geometry.getAttribute('position');
  if (!pos) return [];
  const points = [];
  for (let i = 0; i < pos.count; i++) points.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
  return downsamplePoints(points, maxPoints);
}

/**
 * Load every mesh component of a study. Geometries are kept in their NATIVE
 * scanner coordinates (NOT centered) so multi-component scans (upper + lower
 * jaw) keep their mutual position and one registration matrix moves them all.
 */
export function useMeshComponents(files, onInfo) {
  const [state, setState] = useState({ status: 'idle', components: [], error: null });

  useEffect(() => {
    let off = false;
    if (!files || !files.length) { setState({ status: 'idle', components: [], error: null }); return undefined; }
    setState({ status: 'loading', components: [], error: null });
    (async () => {
      try {
        const components = [];
        for (const file of files) {
          const geometry = await parseGeometry(file.url, file.file_kind);
          if (off) return;
          components.push({ name: file.baseName, label: file.label, geometry });
        }
        // Combined bounds + centroid (mesh-local) for camera fitting and the
        // gizmo pivot; sampled local points per component for the ICP source.
        const box = new THREE.Box3();
        components.forEach((c) => box.expandByBufferAttribute(c.geometry.getAttribute('position')));
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const componentPoints = {};
        components.forEach((c) => { componentPoints[c.name] = sampleGeometryPoints(c.geometry, 1600); });
        const info = {
          centroid: [center.x, center.y, center.z],
          size: [size.x, size.y, size.z],
          diag: size.length(),
          componentPoints,
          componentNames: components.map((c) => c.name),
          componentLabels: Object.fromEntries(components.map((c) => [c.name, c.label])),
        };
        setState({ status: 'ready', components, error: null, info });
        onInfo?.(info);
      } catch (e) {
        if (!off) setState({ status: 'error', components: [], error: e?.message || 'Mesh load failed' });
      }
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  return state;
}

// Orientation presets in the volume's LPS world frame (L=+X, P=+Y, S=+Z):
// direction = where the CAMERA sits relative to the subject.
export const ORIENTATION_PRESETS = {
  front: { dir: [0, -1, 0], up: [0, 0, 1], label: 'Front' },
  left: { dir: [1, 0, 0], up: [0, 0, 1], label: 'Left' },
  right: { dir: [-1, 0, 0], up: [0, 0, 1], label: 'Right' },
  top: { dir: [0, 0, 1], up: [0, -1, 0], label: 'Top' },
};

/** Applies an orientation preset to the camera whenever preset.seq changes. */
function CameraRig({ preset, center, distance, controlsRef }) {
  const { camera } = useThree();
  useEffect(() => {
    if (!preset || !center) return;
    const p = ORIENTATION_PRESETS[preset.id] || ORIENTATION_PRESETS.front;
    camera.up.set(p.up[0], p.up[1], p.up[2]);
    camera.position.set(
      center[0] + p.dir[0] * distance,
      center[1] + p.dir[1] * distance,
      center[2] + p.dir[2] * distance
    );
    camera.near = Math.max(0.1, distance / 1000);
    camera.far = distance * 20;
    camera.updateProjectionMatrix();
    camera.lookAt(center[0], center[1], center[2]);
    if (controlsRef.current) {
      controlsRef.current.target.set(center[0], center[1], center[2]);
      controlsRef.current.update();
    }
  }, [preset, center, distance, camera, controlsRef]);
  return null;
}

/** Exposes a () => dataURL screenshot function on captureRef. */
function CaptureBridge({ captureRef }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    if (!captureRef) return undefined;
    captureRef.current = () => {
      gl.render(scene, camera); // fresh frame so the capture isn't stale/black
      return gl.domElement.toDataURL('image/png');
    };
    return () => { captureRef.current = null; };
  }, [captureRef, gl, scene, camera]);
  return null;
}

function MeshComponents({ components, visibleSet, opacity = 1, color = null }) {
  return components.map((c) => (
    <mesh
      key={c.name}
      geometry={c.geometry}
      visible={!visibleSet || visibleSet.has(c.name)}
    >
      <meshStandardMaterial
        color={color || COMPONENT_COLORS[c.label] || DEFAULT_MESH_COLOR}
        metalness={0.05}
        roughness={0.55}
        transparent={opacity < 1}
        opacity={opacity}
        side={THREE.DoubleSide}
      />
    </mesh>
  ));
}

function PaneStatus({ status, error }) {
  if (status === 'loading') {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10">
        <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
        <span className="ml-2 text-xs text-neutral-300">Loading mesh…</span>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10 px-4 text-center">
        <span className="text-xs text-red-300">Mesh failed to load: {error}</span>
      </div>
    );
  }
  return null;
}

// ── Side-by-side mesh pane ───────────────────────────────────────────────────
export function MeshSidePane({ files, preset, visibleSet, onInfo, onToggleComponent }) {
  const { status, components, error, info } = useMeshComponents(files, onInfo);
  const controlsRef = useRef(null);
  const center = info?.centroid || null;
  const distance = info ? Math.max(40, info.diag * 1.6) : 100;

  return (
    <div className="relative h-full w-full bg-neutral-950">
      <PaneStatus status={status} error={error} />
      <Canvas gl={{ preserveDrawingBuffer: true, antialias: true }}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[80, -120, 140]} intensity={0.9} />
        <directionalLight position={[-90, 60, -80]} intensity={0.35} />
        {status === 'ready' && (
          <MeshComponents components={components} visibleSet={visibleSet} />
        )}
        {center && <CameraRig preset={preset} center={center} distance={distance} controlsRef={controlsRef} />}
        <OrbitControls ref={controlsRef} enablePan enableZoom enableRotate />
      </Canvas>
      {status === 'ready' && info?.componentNames?.length > 1 && onToggleComponent && (
        <div className="absolute bottom-2 left-2 flex flex-wrap gap-1 z-10">
          {info.componentNames.map((name) => {
            const on = !visibleSet || visibleSet.has(name);
            return (
              <button
                key={name}
                type="button"
                onClick={() => onToggleComponent(name)}
                className={`px-2 py-0.5 rounded text-[10px] border ${
                  on ? 'bg-amber-500/20 border-amber-500/50 text-amber-200' : 'bg-neutral-900/80 border-neutral-700 text-neutral-500'
                }`}
              >
                {info.componentLabels[name]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Overlay (registration) pane ──────────────────────────────────────────────
function VolumePlane({ plane, visible }) {
  const texture = useMemo(() => {
    const t = new THREE.DataTexture(plane.rgba, plane.width, plane.height, THREE.RGBAFormat);
    t.needsUpdate = true;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.flipY = false;
    return t;
  }, [plane]);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const c = plane.corners;
    const positions = new Float32Array([...c[0], ...c[1], ...c[2], ...c[3]]);
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    return g;
  }, [plane]);
  useEffect(() => () => { texture.dispose(); geometry.dispose(); }, [texture, geometry]);
  return (
    <mesh geometry={geometry} visible={visible}>
      <meshBasicMaterial map={texture} side={THREE.DoubleSide} toneMapped={false} />
    </mesh>
  );
}

/**
 * MeshOverlayPane — mesh in CBCT patient space.
 *
 * Props:
 *   files       mesh files (signed URLs)
 *   planes      [{ id, label, rgba, width, height, corners }] from
 *               volumeMeshSampling (already windowed to RGBA)
 *   planeVis    { [planeId]: boolean }
 *   xform       { position:[3], quaternion:[x,y,z,w], scale:number } of the
 *               OUTER group (pivot at the mesh centroid)
 *   onXformChange(next)
 *   meshOpacity 0..1
 *   gizmo       { enabled:boolean, mode:'translate'|'rotate' }
 *   visibleSet  Set of visible component names (null = all)
 *   onInfo(info)  mesh centroid/sampled points (for ICP + pivot math)
 *   captureRef  ref that receives a () => dataURL screenshot fn
 *   preset      orientation preset { id, seq }
 *   volumeCenter / volumeDiag  world-space framing of the CBCT
 */
export function MeshOverlayPane({
  files, planes, planeVis, xform, onXformChange, meshOpacity = 0.85,
  gizmo, visibleSet, onInfo, captureRef, preset, volumeCenter, volumeDiag,
}) {
  const { status, components, error, info } = useMeshComponents(files, onInfo);
  const controlsRef = useRef(null);
  const [outerObj, setOuterObj] = useState(null);
  const outerRefCb = useCallback((node) => setOuterObj(node || null), []);

  const center = volumeCenter || [0, 0, 0];
  const distance = Math.max(120, (volumeDiag || 250) * 1.1);
  const negCentroid = info ? [-info.centroid[0], -info.centroid[1], -info.centroid[2]] : [0, 0, 0];

  // Push the controlled transform into the three group (gizmo edits it back).
  useEffect(() => {
    if (!outerObj || !xform) return;
    outerObj.position.set(xform.position[0], xform.position[1], xform.position[2]);
    outerObj.quaternion.set(xform.quaternion[0], xform.quaternion[1], xform.quaternion[2], xform.quaternion[3]);
    outerObj.scale.setScalar(xform.scale || 1);
    outerObj.updateMatrixWorld(true);
  }, [outerObj, xform]);

  const handleGizmoChange = useCallback(() => {
    if (!outerObj || !onXformChange) return;
    onXformChange({
      position: [outerObj.position.x, outerObj.position.y, outerObj.position.z],
      quaternion: [outerObj.quaternion.x, outerObj.quaternion.y, outerObj.quaternion.z, outerObj.quaternion.w],
      scale: (outerObj.scale.x + outerObj.scale.y + outerObj.scale.z) / 3,
    });
  }, [outerObj, onXformChange]);

  return (
    <div className="relative h-full w-full bg-neutral-950">
      <PaneStatus status={status} error={error} />
      <Canvas gl={{ preserveDrawingBuffer: true, antialias: true }}>
        <ambientLight intensity={0.75} />
        <directionalLight position={[150, -200, 260]} intensity={0.9} />
        <directionalLight position={[-160, 140, -120]} intensity={0.3} />
        {(planes || []).map((plane) => (
          <VolumePlane key={plane.id} plane={plane} visible={planeVis?.[plane.id] !== false} />
        ))}
        {status === 'ready' && (
          <group ref={outerRefCb}>
            <group position={negCentroid}>
              <MeshComponents
                components={components}
                visibleSet={visibleSet}
                opacity={meshOpacity}
                color="#7dd3fc"
              />
            </group>
          </group>
        )}
        {gizmo?.enabled && outerObj && (
          <TransformControls
            object={outerObj}
            mode={gizmo.mode === 'rotate' ? 'rotate' : 'translate'}
            size={0.8}
            onObjectChange={handleGizmoChange}
            onMouseDown={() => { if (controlsRef.current) controlsRef.current.enabled = false; }}
            onMouseUp={() => { if (controlsRef.current) controlsRef.current.enabled = true; }}
          />
        )}
        <CameraRig preset={preset} center={center} distance={distance} controlsRef={controlsRef} />
        <OrbitControls ref={controlsRef} enablePan enableZoom enableRotate makeDefault={false} />
        <CaptureBridge captureRef={captureRef} />
      </Canvas>
    </div>
  );
}

export default MeshOverlayPane;
