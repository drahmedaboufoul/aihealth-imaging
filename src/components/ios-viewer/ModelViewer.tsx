import { useState, useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, PerspectiveCamera, Line, Environment } from '@react-three/drei';
import * as THREE from 'three';
import type { Patient, Scan, ViewerSettings, ToolType, MouseSettings } from './types';
import { MultiMeshModel, type MeshFile } from './MultiMeshModel';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  X,
  Camera,
  RotateCcw,
  Grid3X3,
  MousePointer2,
  Eye,
  EyeOff,
  Ruler,
  CircleDot,
  BarChart3,
  ChevronRight,
  ChevronLeft,
  Monitor
} from 'lucide-react';

interface ModelViewerProps {
  scan: Scan;
  patient: Patient;
  viewerSettings: ViewerSettings;
  onUpdateSettings: (settings: Partial<ViewerSettings>) => void;
  activeTool: ToolType;
  onSetTool: (tool: ToolType) => void;
  mouseSettings: MouseSettings;
  onUpdateMouseSettings: (settings: MouseSettings) => void;
  onClose: () => void;
  /** Single-file legacy mode (?id= or ?path=) */
  fileUrl?: string | null;
  fileType?: string;
  /** Multi-file study mode (?study=) — array of upper / lower / occlusion files */
  files?: MeshFile[] | null;
}

// File-based 3D Model Component
function FileModel({
  fileUrl,
  fileType,
  viewerSettings
}: {
  fileUrl: string;
  fileType: string;
  viewerSettings: ViewerSettings;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [hasVertexColors, setHasVertexColors] = useState(false);

  useEffect(() => {
    if (!fileUrl) return;

    const loadMesh = async () => {
      try {
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();

        let loadedGeometry: THREE.BufferGeometry | null = null;
        const ext = fileType?.toLowerCase() || 'stl';

        if (ext === 'stl') {
          const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader');
          loadedGeometry = new STLLoader().parse(arrayBuffer);
        } else if (ext === 'ply') {
          const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader');
          loadedGeometry = new PLYLoader().parse(arrayBuffer);
          if (loadedGeometry.hasAttribute('color')) {
            setHasVertexColors(true);
          }
        } else if (ext === 'obj') {
          const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader');
          const text = new TextDecoder().decode(arrayBuffer);
          const obj = new OBJLoader().parse(text);
          obj.traverse((child) => {
            if (child instanceof THREE.Mesh && !loadedGeometry) {
              loadedGeometry = child.geometry;
            }
          });
        }

        if (loadedGeometry) {
          loadedGeometry.computeVertexNormals();
          loadedGeometry.center();
          setGeometry(loadedGeometry);
        }
      } catch (err) {
        console.error('Error loading mesh:', err);
      }
    };

    loadMesh();
  }, [fileUrl, fileType]);

  if (!geometry) return null;

  return (
    <mesh ref={meshRef} geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial
        color={hasVertexColors ? 0xffffff : '#e8daca'}
        vertexColors={hasVertexColors}
        metalness={0.1}
        roughness={0.5}
        side={THREE.DoubleSide}
        transparent
        opacity={viewerSettings.maxillaOpacity / 100}
      />
    </mesh>
  );
}

// Mock 3D Dental Model Component (fallback when no file)
//
// Phase 2.5 batch (2026-05-06):
// - Teeth follow a U-shaped arch curve (parametric ellipse), not a straight
//   line. Looks like a real dental arch instead of fence posts.
// - Persistent rendering + opacity lerp on visibility toggle.
// - onClick / onPointerOver / onPointerOut wired to each arch.
// - Hover: accent-blue emissive + scale 1.025. Selected: stronger
//   accent emissive + scale 1.04. Per impeccable motion-design, exit
//   animations are 75% of enter so deselect snaps faster.
// - Removed sine-wave idle drift.
// - Respects prefers-reduced-motion.
function DentalModel({
  viewerSettings,
  activeTool
}: {
  viewerSettings: ViewerSettings;
  activeTool: ToolType;
}) {
  const maxillaRef = useRef<THREE.Group>(null);
  const mandibleRef = useRef<THREE.Group>(null);

  const [hovered, setHovered] = useState<'maxilla' | 'mandible' | null>(null);
  const [selected, setSelected] = useState<'maxilla' | 'mandible' | null>(null);

  const maxillaOpacityRef = useRef(viewerSettings.maxillaVisible ? viewerSettings.maxillaOpacity / 100 : 0);
  const mandibleOpacityRef = useRef(viewerSettings.mandibleVisible ? viewerSettings.mandibleOpacity / 100 : 0);

  const reducedMotion = useRef(
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  // U-arch tooth positions (parametric ellipse around -π/3 to π/3 covering 7 teeth).
  // a = lateral half-width; b = anteroposterior depth.
  const archAngles = [...Array(7)].map((_, i) => -Math.PI / 3 + (Math.PI * 2 / 3) * (i / 6));
  const archA = 0.85;
  const archB = 0.7;

  useFrame((_, delta) => {
    const lerpAmt = reducedMotion.current ? 1 : Math.min(1, delta * 6);

    const maxTarget = viewerSettings.maxillaVisible ? viewerSettings.maxillaOpacity / 100 : 0;
    const manTarget = viewerSettings.mandibleVisible ? viewerSettings.mandibleOpacity / 100 : 0;

    maxillaOpacityRef.current = THREE.MathUtils.lerp(maxillaOpacityRef.current, maxTarget, lerpAmt);
    mandibleOpacityRef.current = THREE.MathUtils.lerp(mandibleOpacityRef.current, manTarget, lerpAmt);

    const applyArchState = (
      group: THREE.Group | null,
      opacity: number,
      isHover: boolean,
      isSelect: boolean,
    ) => {
      if (!group) return;
      group.traverse((c: any) => {
        if (c.isMesh && c.material) {
          c.material.transparent = true;
          c.material.opacity = opacity;
          if (c.material.emissive) {
            // Accent blue (#5DA9E9 ≈ rgb 93, 169, 233) for clear feedback.
            // Selected = stronger; hover = subtle.
            if (isSelect)      c.material.emissive.setHex(0x1f4a78);
            else if (isHover)  c.material.emissive.setHex(0x12325a);
            else               c.material.emissive.setHex(0x000000);
            c.material.emissiveIntensity = isSelect ? 0.9 : (isHover ? 0.5 : 0);
          }
        }
      });
      const scaleTarget = isSelect ? 1.04 : (isHover ? 1.025 : 1.0);
      group.scale.lerp(new THREE.Vector3(scaleTarget, scaleTarget, scaleTarget), lerpAmt);
    };

    applyArchState(maxillaRef.current,  maxillaOpacityRef.current,  hovered === 'maxilla',  selected === 'maxilla');
    applyArchState(mandibleRef.current, mandibleOpacityRef.current, hovered === 'mandible', selected === 'mandible');
  });

  const onArchOver  = (which: 'maxilla' | 'mandible') => (e: any) => {
    e.stopPropagation(); setHovered(which);
    if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
  };
  const onArchOut   = (which: 'maxilla' | 'mandible') => (e: any) => {
    e.stopPropagation(); setHovered((h) => (h === which ? null : h));
    if (typeof document !== 'undefined') document.body.style.cursor = '';
  };
  const onArchClick = (which: 'maxilla' | 'mandible') => (e: any) => {
    e.stopPropagation(); setSelected((cur) => (cur === which ? null : which));
  };

  return (
    <group>
      {/* Maxilla — curved arch with U-shaped teeth */}
      <group
        ref={maxillaRef}
        position={[0, 0.5, 0]}
        onPointerOver={onArchOver('maxilla')}
        onPointerOut={onArchOut('maxilla')}
        onClick={onArchClick('maxilla')}
      >
        {/* Palate dome */}
        <mesh position={[0, 0.1, 0]}>
          <sphereGeometry args={[0.95, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.35]} />
          <meshStandardMaterial color="#e8a4a4" transparent opacity={1} roughness={0.6} />
        </mesh>
        {/* Teeth along arch — 7 teeth from molar to molar */}
        {archAngles.map((angle, i) => {
          const x = archA * Math.sin(angle);
          const z = archB * Math.cos(angle);
          // Make molars (at extremes) larger than incisors (center)
          const isMolar = Math.abs(i - 3) >= 2;
          const w = isMolar ? 0.22 : 0.16;
          const h = isMolar ? 0.32 : 0.4;
          const d = isMolar ? 0.22 : 0.14;
          return (
            <mesh key={`upper-tooth-${i}`} position={[x, -0.15, z]} rotation={[0, -angle, 0]}>
              <boxGeometry args={[w, h, d]} />
              <meshStandardMaterial color="#f5f0e6" transparent opacity={1} roughness={0.3} />
            </mesh>
          );
        })}
        {activeTool === 'occlusal' && (
          <mesh position={[0, -0.3, 0.6]}>
            <ringGeometry args={[0.55, 0.85, 32]} />
            <meshBasicMaterial color="#ff4444" transparent opacity={0.3} side={THREE.DoubleSide} />
          </mesh>
        )}
      </group>

      {/* Mandible — mirror of maxilla */}
      <group
        ref={mandibleRef}
        position={[0, -0.5, 0]}
        onPointerOver={onArchOver('mandible')}
        onPointerOut={onArchOut('mandible')}
        onClick={onArchClick('mandible')}
      >
        {/* Floor of mouth dome (flipped) */}
        <mesh position={[0, -0.1, 0]} rotation={[Math.PI, 0, 0]}>
          <sphereGeometry args={[0.95, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.35]} />
          <meshStandardMaterial color="#e8a4a4" transparent opacity={1} roughness={0.6} />
        </mesh>
        {archAngles.map((angle, i) => {
          const x = archA * Math.sin(angle);
          const z = archB * Math.cos(angle);
          const isMolar = Math.abs(i - 3) >= 2;
          const w = isMolar ? 0.22 : 0.16;
          const h = isMolar ? 0.32 : 0.4;
          const d = isMolar ? 0.22 : 0.14;
          return (
            <mesh key={`lower-tooth-${i}`} position={[x, 0.15, z]} rotation={[0, -angle, 0]}>
              <boxGeometry args={[w, h, d]} />
              <meshStandardMaterial color="#f5f0e6" transparent opacity={1} roughness={0.3} />
            </mesh>
          );
        })}
        {activeTool === 'occlusal' && (
          <mesh position={[0, 0.3, 0.6]}>
            <ringGeometry args={[0.55, 0.85, 32]} />
            <meshBasicMaterial color="#44ff44" transparent opacity={0.3} side={THREE.DoubleSide} />
          </mesh>
        )}
      </group>

      {/* Occlusion/Bite contact markers */}
      {viewerSettings.occlusionVisible && activeTool === 'occlusal' && (
        <group>
          {archAngles.filter((_, i) => i % 2 === 0).map((angle, i) => {
            const x = archA * Math.sin(angle) * 0.95;
            const z = archB * Math.cos(angle) * 0.95;
            return (
              <mesh key={`bite-${i}`} position={[x, 0, z]}>
                <sphereGeometry args={[0.06, 16, 16]} />
                <meshBasicMaterial color="#ff0000" transparent opacity={viewerSettings.occlusionOpacity / 100} />
              </mesh>
            );
          })}
        </group>
      )}

      {/* Measurement Lines */}
      {activeTool === 'measure' && (
        <group>
          <Line points={[[-0.5, 0, 0.5], [0.5, 0, 0.5]]} color="#0066ff" lineWidth={2} />
          <mesh position={[-0.5, 0, 0.5]}>
            <sphereGeometry args={[0.05, 16, 16]} />
            <meshBasicMaterial color="#0066ff" />
          </mesh>
          <mesh position={[0.5, 0, 0.5]}>
            <sphereGeometry args={[0.05, 16, 16]} />
            <meshBasicMaterial color="#0066ff" />
          </mesh>
        </group>
      )}
    </group>
  );
}

// CameraAutoFit — frames whatever is in the scene to fit the camera frustum.
// Runs once on mount + once when fileUrl/scan changes. Computes the bounding
// box of the visible meshes, finds the bounding sphere, and positions the
// camera at the right distance along +Z so the mesh fills ~80% of the view.
function CameraAutoFit({ trigger }: { trigger: any }) {
  const { camera, scene, controls } = useThree();
  useEffect(() => {
    // Defer one frame to let geometry mount + materials settle
    const id = requestAnimationFrame(() => {
      const box = new THREE.Box3();
      // Only fit to actual mesh content (skip lights, grid, helpers)
      scene.traverse((o: any) => {
        if (o.isMesh && o.geometry) {
          o.geometry.computeBoundingBox();
          const childBox = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
          box.union(childBox);
        }
      });
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const sphere = new THREE.Sphere();
      box.getBoundingSphere(sphere);
      const radius = sphere.radius;

      const fov = (camera as THREE.PerspectiveCamera).fov * (Math.PI / 180);
      const distance = (radius / Math.sin(fov / 2)) * 1.4; // 1.4 = ~70% fill, slight margin

      const dir = new THREE.Vector3(0, 0, 1);
      camera.position.copy(center.clone().add(dir.multiplyScalar(distance)));
      camera.lookAt(center);
      camera.near = Math.max(0.01, distance / 100);
      camera.far  = distance * 100;
      camera.updateProjectionMatrix();

      if (controls && (controls as any).target) {
        (controls as any).target.copy(center);
        (controls as any).update?.();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [trigger, camera, scene, controls]);
  return null;
}

// ViewPresets — fly the camera to standard orientations. Values match
// exocad's view-button conventions (front/back along Z, right/left along X,
// occlusal/from-below along Y). Animation tweens position + target over
// 350ms with quart-out easing for a refined feel.
function flyCameraTo(
  camera: THREE.Camera,
  controls: any,
  targetPos: THREE.Vector3,
  lookAt: THREE.Vector3 = new THREE.Vector3(0, 0, 0),
  durationMs = 350,
) {
  const startPos = camera.position.clone();
  const startTarget = controls?.target ? controls.target.clone() : new THREE.Vector3(0, 0, 0);
  const t0 = performance.now();
  const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);

  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / durationMs);
    const k = easeOutQuart(t);
    camera.position.lerpVectors(startPos, targetPos, k);
    if (controls?.target) {
      controls.target.lerpVectors(startTarget, lookAt, k);
      controls.update?.();
    } else {
      camera.lookAt(lookAt);
    }
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Loading Screen Component
function LoadingScreen({ progress }: { progress: number }) {
  const circumference = 2 * Math.PI * 40;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  return (
    <div className="absolute inset-0 bg-white/90 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl p-10 flex flex-col items-center">
        {/* Circular Progress */}
        <div className="relative w-24 h-24 mb-6">
          <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
            {/* Background circle */}
            <circle
              cx="50"
              cy="50"
              r="40"
              fill="none"
              stroke="#e5e7eb"
              strokeWidth="8"
            />
            {/* Progress circle */}
            <circle
              cx="50"
              cy="50"
              r="40"
              fill="none"
              stroke="#3b82f6"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              className="transition-all duration-300"
            />
          </svg>
          {/* Percentage text */}
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xl font-bold text-blue-600">{progress}%</span>
          </div>
        </div>

        <h3 className="text-lg font-semibold text-gray-800 mb-2">Model Loading</h3>
        <p className="text-gray-500">Please Wait...</p>
      </div>
    </div>
  );
}

// Mouse Settings Dialog
function MouseSettingsDialog({
  open,
  onOpenChange,
  mouseSettings,
  onUpdateMouseSettings
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mouseSettings: MouseSettings;
  onUpdateMouseSettings: (settings: MouseSettings) => void;
}) {
  const [tempSettings, setTempSettings] = useState(mouseSettings);

  const handleConfirm = () => {
    onUpdateMouseSettings(tempSettings);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MousePointer2 className="w-5 h-5" />
            Mouse Operation Settings
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div
            className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${
              tempSettings.leftRotation
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 hover:border-gray-300'
            }`}
            onClick={() => setTempSettings({ leftRotation: true })}
          >
            <div className="flex items-center gap-4">
              <div className="w-16 h-12 bg-gray-800 rounded flex items-center justify-center">
                <MousePointer2 className="w-6 h-6 text-white" />
              </div>
              <div>
                <p className="font-medium text-gray-800">Option 1</p>
                <p className="text-sm text-gray-500">Left controls rotation, Right controls selection</p>
              </div>
            </div>
          </div>

          <div
            className={`p-4 border-2 rounded-lg cursor-pointer transition-all ${
              !tempSettings.leftRotation
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 hover:border-gray-300'
            }`}
            onClick={() => setTempSettings({ leftRotation: false })}
          >
            <div className="flex items-center gap-4">
              <div className="w-16 h-12 bg-gray-800 rounded flex items-center justify-center">
                <MousePointer2 className="w-6 h-6 text-white rotate-180" />
              </div>
              <div>
                <p className="font-medium text-gray-800">Option 2</p>
                <p className="text-sm text-gray-500">Right controls rotation, Left controls selection</p>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} className="bg-blue-600 hover:bg-blue-700">
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ModelViewer({
  scan,
  patient,
  viewerSettings,
  onUpdateSettings,
  activeTool,
  onSetTool,
  mouseSettings,
  onUpdateMouseSettings,
  onClose,
  fileUrl,
  fileType,
  files,
}: ModelViewerProps) {
  const isMultiFile = !!(files && files.length > 0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [showMouseSettings, setShowMouseSettings] = useState(false);
  const controlsRef = useRef<any>(null);

  // Simulate loading
  useEffect(() => {
    setIsLoading(true);
    setLoadingProgress(0);

    const interval = setInterval(() => {
      setLoadingProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval);
          setTimeout(() => setIsLoading(false), 300);
          return 100;
        }
        return prev + Math.random() * 15;
      });
    }, 150);

    return () => clearInterval(interval);
  }, [scan]);

  const handleResetView = () => {
    if (controlsRef.current) {
      controlsRef.current.reset();
    }
  };

  const handleScreenshot = () => {
    // Screenshot functionality would be implemented here
    alert('Screenshot captured!');
  };

  const tools = [
    { id: 'measure' as ToolType, icon: Ruler, label: 'Measurement' },
    { id: 'occlusal' as ToolType, icon: CircleDot, label: 'Occlusal Contact' },
    { id: 'analysis' as ToolType, icon: BarChart3, label: 'Analysis' },
  ];

  return (
    <div className="h-full w-full bg-gray-100 flex flex-col">
      {/* Header */}
      <div className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-5 h-5" />
          </Button>
          <h2 className="font-semibold text-gray-800">Model Viewer</h2>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600">{patient.name}</span>
          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs text-white ${
            patient.gender === 'male' ? 'bg-blue-500' : 'bg-pink-500'
          }`}>
            {patient.gender === 'male' ? 'M' : 'F'}
          </div>
        </div>
      </div>

      {/* Main Viewer Area */}
      <div className="flex-1 flex relative">
        {/* Loading Screen */}
        {isLoading && <LoadingScreen progress={Math.min(Math.round(loadingProgress), 100)} />}

        {/* Left Toolbar */}
        <div className="absolute left-4 top-1/2 -translate-y-1/2 z-10 flex flex-col gap-2">
          {tools.map((tool) => (
            <button
              key={tool.id}
              onClick={() => onSetTool(activeTool === tool.id ? 'none' : tool.id)}
              className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${
                activeTool === tool.id
                  ? 'bg-blue-600 text-white shadow-lg'
                  : 'bg-white text-gray-600 hover:bg-gray-50 shadow-md'
              }`}
              title={tool.label}
            >
              <tool.icon className="w-5 h-5" />
            </button>
          ))}
        </div>

        {/* 3D Canvas */}
        <div className="flex-1 relative">
          <Canvas shadows dpr={[1, 2]}>
            <PerspectiveCamera makeDefault position={[0, 0, 4]} fov={45} />
            <ambientLight intensity={0.45} />
            <directionalLight position={[5, 5, 5]} intensity={0.75} castShadow />
            <directionalLight position={[-5, -5, -5]} intensity={0.2} />
            {/* IBL — gives the meshPhysicalMaterial proper reflections so
                 enamel doesn't read as flat plastic. Apartment is a soft
                 indoor preset; doesn't introduce harsh highlights. */}
            <Environment preset="apartment" background={false} />

            {isMultiFile ? (
              <MultiMeshModel
                files={files!}
                viewerSettings={viewerSettings}
              />
            ) : fileUrl ? (
              <FileModel
                fileUrl={fileUrl}
                fileType={fileType || 'stl'}
                viewerSettings={viewerSettings}
              />
            ) : (
              <DentalModel viewerSettings={viewerSettings} activeTool={activeTool} />
            )}

            {viewerSettings.showGrid && (
              <Grid
                args={[10, 10]}
                cellSize={0.5}
                cellThickness={0.5}
                cellColor="#d1d5db"
                sectionSize={2}
                sectionThickness={1}
                sectionColor="#9ca3af"
                fadeDistance={25}
                fadeStrength={1}
                followCamera={false}
                infiniteGrid={true}
              />
            )}

            {/* MultiMeshModel does its own auto-frame across the whole case;
                 only invoke CameraAutoFit for the legacy single-file/demo paths. */}
            {!isMultiFile && <CameraAutoFit trigger={fileUrl || 'demo'} />}

            <OrbitControls
              ref={controlsRef}
              makeDefault
              enablePan={true}
              enableZoom={true}
              enableRotate={true}
              enableDamping={true}
              dampingFactor={0.08}
              rotateSpeed={0.6}
              zoomSpeed={0.8}
              panSpeed={0.7}
              screenSpacePanning={true}
              minDistance={1}
              maxDistance={50}
              mouseButtons={{
                LEFT: mouseSettings.leftRotation ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN,
                MIDDLE: THREE.MOUSE.DOLLY,
                RIGHT: mouseSettings.leftRotation ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
              }}
            />
          </Canvas>

          {/* View preset chips — exocad-style camera presets. Animated 350ms ease-out-quart. */}
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-white/95 backdrop-blur-sm rounded-full shadow-md px-1 py-0.5 border border-gray-200">
            {[
              { label: 'Front',    pos: [0, 0, 4]   },
              { label: 'Right',    pos: [4, 0, 0]   },
              { label: 'Top',      pos: [0, 4, 0.001] },  // tiny Z to keep up vector valid
              { label: 'Left',     pos: [-4, 0, 0]  },
              { label: 'Back',     pos: [0, 0, -4]  },
              { label: 'Bottom',   pos: [0, -4, 0.001] },
            ].map(preset => (
              <button
                key={preset.label}
                type="button"
                onClick={() => {
                  const cam = controlsRef.current?.object;
                  if (!cam) return;
                  flyCameraTo(
                    cam,
                    controlsRef.current,
                    new THREE.Vector3(...(preset.pos as [number, number, number])),
                    new THREE.Vector3(0, 0, 0),
                  );
                }}
                className="px-2.5 py-1 text-[11px] font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-full transition-colors"
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Right Toolbar */}
          <div className="absolute right-4 top-1/2 -translate-y-1/2 z-10 flex flex-col gap-2">
            <button
              onClick={handleScreenshot}
              className="w-10 h-10 rounded-lg bg-white text-gray-600 hover:bg-gray-50 shadow-md flex items-center justify-center"
              title="Screenshot"
            >
              <Camera className="w-5 h-5" />
            </button>
            <button
              onClick={handleResetView}
              className="w-10 h-10 rounded-lg bg-white text-gray-600 hover:bg-gray-50 shadow-md flex items-center justify-center"
              title="Reset View"
            >
              <RotateCcw className="w-5 h-5" />
            </button>
            <button
              onClick={() => setShowMouseSettings(true)}
              className="w-10 h-10 rounded-lg bg-white text-gray-600 hover:bg-gray-50 shadow-md flex items-center justify-center"
              title="Mouse Settings"
            >
              <MousePointer2 className="w-5 h-5" />
            </button>
            <button
              onClick={() => onUpdateSettings({ showGrid: !viewerSettings.showGrid })}
              className={`w-10 h-10 rounded-lg shadow-md flex items-center justify-center transition-colors ${
                viewerSettings.showGrid ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
              title="Toggle Grid"
            >
              <Grid3X3 className="w-5 h-5" />
            </button>
            <button
              onClick={() => setShowControls(!showControls)}
              className="w-10 h-10 rounded-lg bg-white text-gray-600 hover:bg-gray-50 shadow-md flex items-center justify-center"
              title="Toggle Controls"
            >
              <Monitor className="w-5 h-5" />
            </button>
          </div>

          {/* Right Control Panel */}
          {showControls && (
            <div className="absolute right-16 top-4 w-64 bg-white rounded-xl shadow-lg p-4 z-10">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-800">Visibility</h3>
                <button
                  onClick={() => setShowControls(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Isolate row — quick way to focus on one role without
                   toggling each visibility flag manually. Only meaningful
                   in multi-mesh study mode; harmless otherwise. */}
              {isMultiFile && (
                <div className="mb-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">
                    Isolate
                  </div>
                  <div className="grid grid-cols-4 gap-1">
                    {([
                      { key: null,         label: 'All' },
                      { key: 'maxilla',    label: 'Up' },
                      { key: 'mandible',   label: 'Low' },
                      { key: 'occlusion',  label: 'Bite' },
                    ] as const).map((opt) => {
                      const active = (viewerSettings.isolatedRole ?? null) === opt.key;
                      return (
                        <button
                          key={String(opt.key)}
                          onClick={() => onUpdateSettings({ isolatedRole: opt.key })}
                          className={`text-[11px] font-medium py-1.5 rounded transition-colors ${
                            active
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                          }`}
                          title={opt.key ? `Show only ${opt.label}` : 'Show all meshes'}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Maxilla Control */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onUpdateSettings({ maxillaVisible: !viewerSettings.maxillaVisible })}
                      className="text-gray-600 hover:text-gray-800"
                    >
                      {viewerSettings.maxillaVisible ? (
                        <Eye className="w-4 h-4" />
                      ) : (
                        <EyeOff className="w-4 h-4" />
                      )}
                    </button>
                    <span className="text-sm font-medium text-gray-700">Maxilla</span>
                  </div>
                  <span className="text-xs text-gray-500">{viewerSettings.maxillaOpacity}%</span>
                </div>
                <Slider
                  value={[viewerSettings.maxillaOpacity]}
                  onValueChange={([value]) => onUpdateSettings({ maxillaOpacity: value })}
                  min={0}
                  max={100}
                  step={1}
                  disabled={!viewerSettings.maxillaVisible}
                  className="w-full"
                />
              </div>

              {/* Mandible Control */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onUpdateSettings({ mandibleVisible: !viewerSettings.mandibleVisible })}
                      className="text-gray-600 hover:text-gray-800"
                    >
                      {viewerSettings.mandibleVisible ? (
                        <Eye className="w-4 h-4" />
                      ) : (
                        <EyeOff className="w-4 h-4" />
                      )}
                    </button>
                    <span className="text-sm font-medium text-gray-700">Mandible</span>
                  </div>
                  <span className="text-xs text-gray-500">{viewerSettings.mandibleOpacity}%</span>
                </div>
                <Slider
                  value={[viewerSettings.mandibleOpacity]}
                  onValueChange={([value]) => onUpdateSettings({ mandibleOpacity: value })}
                  min={0}
                  max={100}
                  step={1}
                  disabled={!viewerSettings.mandibleVisible}
                  className="w-full"
                />
              </div>

              {/* Occlusion Control */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onUpdateSettings({ occlusionVisible: !viewerSettings.occlusionVisible })}
                      className="text-gray-600 hover:text-gray-800"
                    >
                      {viewerSettings.occlusionVisible ? (
                        <Eye className="w-4 h-4" />
                      ) : (
                        <EyeOff className="w-4 h-4" />
                      )}
                    </button>
                    <span className="text-sm font-medium text-gray-700">Occlusion</span>
                  </div>
                  <span className="text-xs text-gray-500">{viewerSettings.occlusionOpacity}%</span>
                </div>
                <Slider
                  value={[viewerSettings.occlusionOpacity]}
                  onValueChange={([value]) => onUpdateSettings({ occlusionOpacity: value })}
                  min={0}
                  max={100}
                  step={1}
                  disabled={!viewerSettings.occlusionVisible}
                  className="w-full"
                />
              </div>
            </div>
          )}

          {/* Show controls button when hidden */}
          {!showControls && (
            <button
              onClick={() => setShowControls(true)}
              className="absolute right-4 top-4 w-8 h-8 bg-white rounded-lg shadow-md flex items-center justify-center text-gray-600 hover:text-gray-800 z-10"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Bottom Legend */}
      <div className="h-16 bg-white border-t border-gray-200 flex items-center justify-center px-4">
        <div className="flex items-center gap-4">
          <span className="text-xs text-gray-500">-0.40</span>
          <div className="w-64 h-4 rounded-full bg-gradient-to-r from-purple-500 via-blue-500 via-green-500 via-yellow-500 to-red-500" />
          <span className="text-xs text-gray-500">1.20 mm</span>
        </div>
        <div className="ml-8 flex items-center gap-4 text-xs text-gray-500">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <span>High</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <span>Medium</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span>Low</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-blue-500" />
            <span>Minimal</span>
          </div>
        </div>
      </div>

      {/* Mouse Settings Dialog */}
      <MouseSettingsDialog
        open={showMouseSettings}
        onOpenChange={setShowMouseSettings}
        mouseSettings={mouseSettings}
        onUpdateMouseSettings={onUpdateMouseSettings}
      />
    </div>
  );
}
