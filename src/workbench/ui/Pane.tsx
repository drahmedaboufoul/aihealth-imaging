/*
 * One 3D pane of the workbench: orthographic camera (true-scale scale
 * bar), BVH-accelerated picking, optional camera link to the other pane,
 * the analysis colour maps, measurement / landmark / section overlays, a
 * hover readout and the lasso used for area measurement and trimming.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html, Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { create } from 'zustand';
import { useWorkbench, activeVersion, type Slot } from './store';
import { getGfx, registerPane, syncCameras, setPaneMesh, paneMesh } from './sceneRegistry';
import { paintContacts, paintDeviation } from '../core/colormap';
import { formatValue } from '../core/measurements';
import { onScanPick } from './picking';
import type { Vec3 } from '../core/types';

type PaneId = 'left' | 'right';

/* ---------- hover readout (separate tiny store: mouse moves must not re-render the app) ---------- */
interface HoverState { pane: PaneId | null; x: number; y: number; text: string; set: (h: Partial<HoverState>) => void }
export const useHover = create<HoverState>((set) => ({ pane: null, x: 0, y: 0, text: '', set: (h) => set(h) }));


const NEUTRAL = '#e8daca';
const tmpTri = new THREE.Triangle();
const tmpBary = new THREE.Vector3();

function valueAt(e: ThreeEvent<PointerEvent>, values: Float32Array, displayToTopo: Uint32Array | null): number {
  const mesh = e.object as THREE.Mesh;
  const g = mesh.geometry as THREE.BufferGeometry;
  const face = e.faceIndex ?? -1;
  if (face < 0 || !g.index) return NaN;
  const ia = g.index.getX(face * 3), ib = g.index.getX(face * 3 + 1), ic = g.index.getX(face * 3 + 2);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const local = mesh.worldToLocal(e.point.clone());
  tmpTri.setFromAttributeAndIndices(pos, ia, ib, ic).getBarycoord(local, tmpBary);
  const map = (i: number) => values[displayToTopo ? displayToTopo[i] : i];
  const va = map(ia), vb = map(ib), vc = map(ic);
  if (![va, vb, vc].every(Number.isFinite)) {
    // nearest corner with data
    const best = [[tmpBary.x, va], [tmpBary.y, vb], [tmpBary.z, vc]].filter(([, v]) => Number.isFinite(v)).sort((p, q) => q[0] - p[0])[0];
    return best ? best[1] : NaN;
  }
  return tmpBary.x * va + tmpBary.y * vb + tmpBary.z * vc;
}

function ScanObject({ pane, slot }: { pane: PaneId; slot: Slot }) {
  const scan = useWorkbench((s) => s.scans[slot]);
  const layout = useWorkbench((s) => s.layout);
  const mapView = useWorkbench((s) => s.mapView);
  const deviation = useWorkbench((s) => s.deviation);
  const contact = useWorkbench((s) => s.contact);
  const trimPreview = useWorkbench((s) => s.trimPreview);
  const tool = useWorkbench((s) => s.tool);
  const invalidate = useThree((s) => s.invalidate);
  const meshRef = useRef<THREE.Mesh>(null);
  const down = useRef<{ x: number; y: number; button: number } | null>(null);
  const [, setTextureTick] = useState(0);
  const gfx = getGfx(scan?.activeVersionId);
  const versionId = scan?.activeVersionId ?? null;

  const deviationOn = mapView === 'deviation' && deviation.test === slot && !!deviation.values && deviation.basis?.testVersion === versionId;
  const contactValues = mapView === 'contact' && contact.basis
    ? (contact.upper === slot && contact.basis.upperVersion === versionId ? contact.upperValues
      : contact.lower === slot && contact.basis.lowerVersion === versionId ? contact.lowerValues : undefined)
    : undefined;
  const previewOn = !!trimPreview && trimPreview.slot === slot && trimPreview.versionId === versionId && !!trimPreview.mask;
  // The reference of a shown deviation map is hidden in the same pane: it is
  // coincident with the coloured scan and would z-fight with it.
  const hiddenAsReference = mapView === 'deviation' && deviation.ref === slot && !!deviation.values && layout !== 'side';
  const mapped = deviationOn || !!contactValues || previewOn;

  useEffect(() => {
    if (!gfx || !mapped) return;
    const out = gfx.mapColor.array as Float32Array;
    if (previewOn && trimPreview?.mask) {
      // selected triangles red, the rest neutral
      const base = new THREE.Color(NEUTRAL).convertSRGBToLinear();
      for (let i = 0; i < out.length; i += 3) { out[i] = base.r; out[i + 1] = base.g; out[i + 2] = base.b; }
      const idx = gfx.natural.index!;
      const red = new THREE.Color('#ef4444').convertSRGBToLinear();
      const mask = trimPreview.mask;
      for (let t = 0; t < mask.length; t++) {
        if (!mask[t]) continue;
        for (let k = 0; k < 3; k++) { const v = idx.getX(t * 3 + k); out[v * 3] = red.r; out[v * 3 + 1] = red.g; out[v * 3 + 2] = red.b; }
      }
    } else if (deviationOn && deviation.values) {
      paintDeviation(out, deviation.values, deviation.range, deviation.tolerance, gfx.displayToTopo);
    } else if (contactValues) {
      const c = new THREE.Color(NEUTRAL);
      paintContacts(out, contactValues, contact.thresholds, [c.r, c.g, c.b], gfx.displayToTopo);
    }
    gfx.mapColor.needsUpdate = true;
    invalidate();
  }, [gfx, mapped, deviationOn, previewOn, trimPreview, deviation.values, deviation.range, deviation.tolerance, contactValues, contact.thresholds, invalidate]);

  useEffect(() => {
    // a texture may arrive after the mesh
    if (gfx?.hasUvs && !gfx.texture) {
      const t = setInterval(() => { if (gfx.texture) { setTextureTick((n) => n + 1); invalidate(); clearInterval(t); } }, 250);
      return () => clearInterval(t);
    }
    return undefined;
  }, [gfx, invalidate]);

  useEffect(() => {
    const m = meshRef.current;
    if (!m) return undefined;
    setPaneMesh(pane, slot, m);
    return () => { if (paneMesh(pane, slot) === m) setPaneMesh(pane, slot, null); };
  });

  const matrix = useMemo(() => new THREE.Matrix4().fromArray(scan?.matrix ?? []), [scan?.matrix]);
  useEffect(() => { invalidate(); }, [matrix, scan?.opacity, scan?.visible, layout, invalidate]);

  if (!scan || scan.status !== 'ready' || !gfx) return null;
  const tinted = layout === 'overlay' && !mapped;
  const useTexture = !mapped && !tinted && !!gfx.texture;
  const useVertexColors = mapped || (!tinted && !useTexture && gfx.hasColors);
  const color = mapped || useTexture || useVertexColors ? '#ffffff' : tinted ? scan.color : NEUTRAL;
  const opacity = scan.opacity;
  const pickTool = ['align', 'measure', 'section'].includes(tool);

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    down.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY, button: e.nativeEvent.button };
  };
  const onUp = (e: ThreeEvent<PointerEvent>) => {
    const d = down.current;
    down.current = null;
    if (!d || d.button !== 0 || !pickTool) return;
    if (Math.hypot(e.nativeEvent.clientX - d.x, e.nativeEvent.clientY - d.y) > 4) return;
    e.stopPropagation();
    const mesh = e.object as THREE.Mesh;
    const native = mesh.worldToLocal(e.point.clone());
    const root = mesh.parent as THREE.Object3D;
    const casePoint = root.worldToLocal(e.point.clone());
    onScanPick(slot, [native.x, native.y, native.z], [casePoint.x, casePoint.y, casePoint.z], e.faceIndex ?? -1, pane);
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const values = deviationOn ? deviation.values : contactValues;
    if (!values) return;
    const v = valueAt(e, values, gfx.displayToTopo);
    const host = (e.nativeEvent.target as HTMLElement)?.closest('[data-pane]') as HTMLElement | null;
    const r = host?.getBoundingClientRect();
    useHover.getState().set({
      pane, x: e.nativeEvent.clientX - (r?.left ?? 0), y: e.nativeEvent.clientY - (r?.top ?? 0),
      text: Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(3)} mm` : 'no counterpart',
    });
  };
  const onOut = () => useHover.getState().set({ pane: null });

  return (
    <mesh
      ref={meshRef}
      geometry={mapped ? gfx.mapped : gfx.natural}
      matrixAutoUpdate={false}
      matrix={matrix}
      visible={scan.visible && !hiddenAsReference}
      raycast={acceleratedRaycast}
      userData={{ slot }}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerMove={onMove}
      onPointerOut={onOut}
    >
      <meshStandardMaterial
        key={`${mapped}-${useTexture}-${useVertexColors}-${tinted}`}
        color={color}
        map={useTexture ? gfx.texture : null}
        vertexColors={useVertexColors}
        roughness={0.75}
        metalness={0}
        side={THREE.DoubleSide}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity >= 0.99}
      />
    </mesh>
  );
}

function Marker({ p, color, label, r = 0.22 }: { p: Vec3; color: string; label?: string; r?: number }) {
  return (
    <group position={p}>
      <mesh renderOrder={10}>
        <sphereGeometry args={[r, 12, 12]} />
        <meshBasicMaterial color={color} depthTest={false} />
      </mesh>
      {label && (
        <Html center style={{ pointerEvents: 'none' }} zIndexRange={[20, 0]}>
          <div className="translate-y-[-14px] text-[10px] font-semibold px-1 rounded bg-white/90 text-gray-800 shadow">{label}</div>
        </Html>
      )}
    </group>
  );
}

function ScanOverlays({ slot }: { slot: Slot }) {
  const scan = useWorkbench((s) => s.scans[slot]);
  const measurements = useWorkbench((s) => s.measurements);
  const pending = useWorkbench((s) => s.pending);
  const alignment = useWorkbench((s) => s.alignment);
  const tool = useWorkbench((s) => s.tool);
  const matrix = useMemo(() => new THREE.Matrix4().fromArray(scan?.matrix ?? []), [scan?.matrix]);
  if (!scan || scan.status !== 'ready' || !scan.visible) return null;
  const v = activeVersion(scan);
  const mine = measurements.filter((m) => m.slot === slot && m.versionSha256 === v?.outputSha256);
  const landmarks = tool === 'align'
    ? (alignment.fixed === slot ? alignment.landmarksFixed : alignment.moving === slot ? alignment.landmarksMoving : [])
    : [];
  const lmColor = alignment.fixed === slot ? '#2563eb' : '#db2777';
  return (
    <group matrixAutoUpdate={false} matrix={matrix}>
      {mine.map((m) => {
        if (m.kind === 'area' || m.points.length === 0) return null;
        const path = (m.kind === 'surface-path' && Array.isArray(m.meta?.path) ? (m.meta!.path as Vec3[]) : m.points);
        const mid = m.kind === 'angle' ? m.points[1] : path[Math.floor(path.length / 2)];
        return (
          <group key={m.id}>
            {m.points.map((p, i) => <Marker key={i} p={p} color="#1d4ed8" r={0.16} />)}
            {path.length > 1 && <Line points={path} color={m.kind === 'surface-path' ? '#7c3aed' : '#1d4ed8'} lineWidth={2} depthTest={false} renderOrder={9} />}
            <Html position={mid} center style={{ pointerEvents: 'none' }} zIndexRange={[20, 0]}>
              <div className="translate-y-[-16px] whitespace-nowrap text-[11px] font-semibold px-1.5 py-0.5 rounded bg-blue-600 text-white shadow">{formatValue(m)}</div>
            </Html>
          </group>
        );
      })}
      {pending.filter((p) => p.slot === slot).map((p, i) => <Marker key={`p${i}`} p={p.native} color="#f59e0b" r={0.18} />)}
      {landmarks.map((p, i) => <Marker key={`l${i}`} p={p} color={lmColor} label={`${alignment.fixed === slot ? 'F' : 'M'}${i + 1}`} />)}
    </group>
  );
}

function SectionLines() {
  const section = useWorkbench((s) => s.section);
  const scans = useWorkbench((s) => s.scans);
  if (!section.profiles) return null;
  return (
    <group>
      {section.profiles.flatMap((p) => p.polylinesCase.map((pl, i) => (
        pl.length > 1 ? <Line key={`${p.slot}-${i}`} points={pl} color={scans[p.slot]?.color ?? '#111'} lineWidth={3} depthTest={false} renderOrder={8} /> : null
      )))}
    </group>
  );
}

/** Camera-relative lighting (same rig as the main IOS viewer). */
function Lighting() {
  const rig = useRef<THREE.Group>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  useFrame(({ camera }) => { if (rig.current) rig.current.quaternion.copy(camera.quaternion); });
  return (
    <group ref={rig}>
      <primitive object={target} />
      <hemisphereLight intensity={1.2} color="white" groundColor="white" />
      <directionalLight target={target} position={[2, 2.5, 3]} intensity={2.2} />
      <directionalLight target={target} position={[-3, 1, 2]} intensity={0.9} />
    </group>
  );
}

const VIEW_DIRS: Record<string, [number, number, number]> = {
  Occlusal: [0, 1, 0.0001], Front: [0, 0, 1], Left: [-1, 0, 0], Right: [1, 0, 0], Back: [0, 0, -1], Bottom: [0, -1, 0.0001],
};

function PaneScene({ id, slots }: { id: PaneId; slots: Slot[] }) {
  const { camera, gl, scene, invalidate, size } = useThree();
  const controlsRef = useRef<unknown>(null);
  const rootMatrix = useWorkbench((s) => s.rootMatrix);
  const frameRequest = useWorkbench((s) => s.frameRequest);
  const tool = useWorkbench((s) => s.tool);
  const lasso = useWorkbench((s) => s.lasso);
  const root = useMemo(() => new THREE.Matrix4().fromArray(rootMatrix), [rootMatrix]);
  const rootRef = useRef<THREE.Group>(null);
  const scanKey = useWorkbench((s) => slots.map((sl) => `${sl}:${s.scans[sl]?.status}:${s.scans[sl]?.activeVersionId}`).join('|'));

  // register for camera link + capture
  useEffect(() => {
    const controls = controlsRef.current as PaneHandleControls | null;
    if (!controls) return undefined;
    return registerPane({
      id, camera: camera as THREE.OrthographicCamera, controls, invalidate, scene, canvas: gl.domElement,
      capture: () => { gl.render(scene, camera); return gl.domElement; },
    });
  }, [id, camera, gl, scene, invalidate]);

  // linked cameras
  useEffect(() => {
    const controls = controlsRef.current as PaneHandleControls | null;
    if (!controls) return undefined;
    const onChange = () => { if (useWorkbench.getState().linkCameras && useWorkbench.getState().layout === 'side') syncCameras(id); };
    controls.addEventListener('change', onChange);
    return () => controls.removeEventListener('change', onChange);
  }, [id]);

  // fit to the visible scans of this pane
  const fit = useCallback((dir?: [number, number, number]) => {
    const controls = controlsRef.current as PaneHandleControls | null;
    const group = rootRef.current;
    if (!controls || !group) return;
    group.updateMatrixWorld(true);
    const box = new THREE.Box3();
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.visible && m.userData?.slot && m.geometry.boundingBox) box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld));
    });
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    const cam = camera as THREE.OrthographicCamera;
    const d = dir ? new THREE.Vector3(...dir).normalize() : cam.position.clone().sub(controls.target).normalize();
    if (!Number.isFinite(d.x) || d.lengthSq() === 0) d.set(0, 0, 1);
    controls.target.copy(center);
    cam.up.set(0, 1, 0);
    if (Math.abs(d.y) > 0.9) cam.up.set(0, 0, -Math.sign(d.y));
    cam.position.copy(center).add(d.clone().multiplyScalar(radius * 4 + 50));
    cam.near = 0.1;
    cam.far = radius * 10 + 500;
    cam.zoom = Math.max(0.05, Math.min(size.width, size.height) / (radius * 2.3));
    cam.lookAt(center);
    cam.updateProjectionMatrix();
    controls.update();
    invalidate();
  }, [camera, size.width, size.height, invalidate]);

  const firstFit = useRef(true);
  useEffect(() => {
    const t = setTimeout(() => {
      // first framing: a three-quarter view (front and occlusal surfaces visible)
      if (firstFit.current) { fit([0, 0.7, 1]); firstFit.current = false; } else fit();
    }, 30);
    return () => clearTimeout(t);
  }, [frameRequest, scanKey, root, fit]);

  useEffect(() => {
    const onView = (e: Event) => {
      const detail = (e as CustomEvent<{ pane?: PaneId; view: string; dir?: [number, number, number] }>).detail;
      if (detail.pane && detail.pane !== id) return;
      if (detail.dir) fit(detail.dir);
      else if (detail.view === 'fit') fit();
      else if (VIEW_DIRS[detail.view]) fit(VIEW_DIRS[detail.view]);
    };
    window.addEventListener('iosw-view', onView);
    return () => window.removeEventListener('iosw-view', onView);
  }, [id, fit]);

  const pickTool = ['align', 'measure', 'section'].includes(tool) || !!lasso;
  return (
    <>
      <Lighting />
      <group ref={rootRef} matrixAutoUpdate={false} matrix={root}>
        {slots.map((s) => <ScanObject key={s} pane={id} slot={s} />)}
        {slots.map((s) => <ScanOverlays key={`o${s}`} slot={s} />)}
        <SectionLines />
      </group>
      <OrbitControls
        ref={controlsRef as never}
        makeDefault
        enableDamping={false}
        screenSpacePanning
        enableRotate
        enablePan
        enableZoom
        zoomSpeed={1.1}
        mouseButtons={{
          LEFT: (pickTool ? -1 : THREE.MOUSE.ROTATE) as THREE.MOUSE,
          MIDDLE: THREE.MOUSE.PAN,
          RIGHT: THREE.MOUSE.ROTATE,
        }}
      />
    </>
  );
}

type PaneHandleControls = { target: THREE.Vector3; update: () => void; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void };

function LassoOverlay({ pane }: { pane: PaneId }) {
  const lasso = useWorkbench((s) => s.lasso);
  const [pts, setPts] = useState<[number, number][]>([]);
  const drawing = useRef(false);
  if (!lasso || lasso.pane !== pane) return null;
  const rel = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as [number, number];
  };
  return (
    <div
      className="absolute inset-0 z-20 cursor-crosshair"
      data-testid="lasso-overlay"
      onPointerDown={(e) => { drawing.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setPts([rel(e)]); }}
      onPointerMove={(e) => {
        if (!drawing.current) return;
        const p = rel(e);
        setPts((cur) => {
          const last = cur[cur.length - 1];
          return !last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 3 ? [...cur, p] : cur;
        });
      }}
      onPointerUp={(e) => {
        drawing.current = false;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const finished = pts;
        setPts([]);
        if (finished.length >= 3) window.dispatchEvent(new CustomEvent('iosw-lasso', { detail: { pane, points: finished, width: r.width, height: r.height } }));
      }}
    >
      <svg className="w-full h-full">
        {pts.length > 1 && <polygon points={pts.map((p) => p.join(',')).join(' ')} fill="rgba(239,68,68,0.12)" stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 3" />}
      </svg>
      <div className="absolute top-2 left-1/2 -translate-x-1/2 text-[11px] bg-white/95 border border-gray-200 rounded px-2 py-1 shadow">
        {lasso.purpose === 'area' ? 'Draw around the region to measure its area' : 'Draw around the surface to trim'} · Esc cancels
      </div>
    </div>
  );
}

function HoverReadout({ pane }: { pane: PaneId }) {
  const h = useHover();
  if (h.pane !== pane || !h.text) return null;
  return (
    <div className="absolute z-30 pointer-events-none text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded bg-gray-900/85 text-white shadow"
      style={{ left: h.x + 14, top: h.y + 10 }} data-testid="hover-readout">
      {h.text}
    </div>
  );
}

export function Pane({ id, slots, label }: { id: PaneId; slots: Slot[]; label?: string }) {
  return (
    <div className="relative flex-1 min-w-0 h-full bg-gray-100" data-pane={id} data-testid={`pane-${id}`}>
      <Canvas
        orthographic
        frameloop="demand"
        dpr={[1, 2]}
        camera={{ position: [0, 0, 300], zoom: 6, near: 0.1, far: 5000 }}
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        raycaster={{ firstHitOnly: true } as never}
        onContextMenu={(e) => e.preventDefault()}
      >
        <PaneScene id={id} slots={slots} />
      </Canvas>
      {label && <div className="absolute top-2 left-2 z-10 text-[11px] font-semibold px-2 py-0.5 rounded bg-white/95 border border-gray-200 shadow-sm text-gray-700">{label}</div>}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-0.5 bg-white/95 rounded-full shadow-md px-1 py-0.5 border border-gray-200">
        {[...Object.keys(VIEW_DIRS), 'fit'].map((v) => (
          <button key={v} type="button" onClick={() => window.dispatchEvent(new CustomEvent('iosw-view', { detail: { pane: id, view: v } }))}
            className="px-2 py-0.5 text-[11px] font-medium text-gray-700 hover:bg-gray-100 rounded-full">
            {v === 'fit' ? 'Fit' : v}
          </button>
        ))}
      </div>
      <LassoOverlay pane={id} />
      <HoverReadout pane={id} />
    </div>
  );
}
