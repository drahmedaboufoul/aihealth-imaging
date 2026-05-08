import { useState, useEffect, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, PerspectiveCamera, Line } from '@react-three/drei';
import * as THREE from 'three';
import type { Patient, Scan, ViewerSettings, ToolType, MouseSettings } from './types';
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
  fileUrl?: string;
  fileType?: string;
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
// 2026-05-06 phase 2.5 fixes:
// - Arches render persistently. Visibility toggles drive a smooth opacity
//   lerp (~167ms) instead of unmounting the geometry. Hidden meshes
//   stay raycastable so click handlers still resolve.
// - onClick / onPointerOver / onPointerOut wired on each arch.
// - Hover and selection produce subtle emissive feedback + scale lift,
//   per Emil Kowalski's "feel right" framework + impeccable's motion-design
//   100/300/500 rule (200-300ms for state changes, exponential easing).
// - Removed the constant sine-wave oscillation. Idle motion is
//   animation fatigue, not polish.
// - Respects prefers-reduced-motion: lerp factor jumps to 1 so toggles
//   are instant for vestibular-sensitive users.
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

  // Smooth opacity tracker per arch (current visual opacity, lerped each frame)
  const maxillaOpacityRef = useRef(viewerSettings.maxillaVisible ? viewerSettings.maxillaOpacity / 100 : 0);
  const mandibleOpacityRef = useRef(viewerSettings.mandibleVisible ? viewerSettings.mandibleOpacity / 100 : 0);

  // Detect prefers-reduced-motion once
  const reducedMotion = useRef(
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  useFrame((_, delta) => {
    // ~167ms feel under normal motion; instant under reduced-motion
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
          // Subtle emissive lift for hover; stronger for selected
          if (c.material.emissive) {
            if (isSelect)      c.material.emissive.setHex(0x1a3a2a);
            else if (isHover)  c.material.emissive.setHex(0x0e1a1a);
            else               c.material.emissive.setHex(0x000000);
          }
        }
      });
      // Subtle scale lift — feels like a soft hover/select state without bounce
      const scaleTarget = isSelect ? 1.025 : (isHover ? 1.012 : 1.0);
      group.scale.lerp(new THREE.Vector3(scaleTarget, scaleTarget, scaleTarget), lerpAmt);
    };

    applyArchState(
      maxillaRef.current,
      maxillaOpacityRef.current,
      hovered === 'maxilla',
      selected === 'maxilla',
    );
    applyArchState(
      mandibleRef.current,
      mandibleOpacityRef.current,
      hovered === 'mandible',
      selected === 'mandible',
    );
  });

  // Pointer handlers — onClick toggles selection. Cursor change gives the
  // affordance that the arch is interactive.
  const onArchOver = (which: 'maxilla' | 'mandible') => (e: any) => {
    e.stopPropagation();
    setHovered(which);
    if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
  };
  const onArchOut = (_which: 'maxilla' | 'mandible') => (e: any) => {
    e.stopPropagation();
    setHovered((h) => (h === _which ? null : h));
    if (typeof document !== 'undefined') document.body.style.cursor = '';
  };
  const onArchClick = (which: 'maxilla' | 'mandible') => (e: any) => {
    e.stopPropagation();
    setSelected((cur) => (cur === which ? null : which));
  };

  return (
    <group>
      {/* Maxilla (Upper Jaw) — rendered always; visibility drives opacity lerp */}
      <group
        ref={maxillaRef}
        position={[0, 0.8, 0]}
        onPointerOver={onArchOver('maxilla')}
        onPointerOut={onArchOut('maxilla')}
        onClick={onArchClick('maxilla')}
      >
        <mesh>
          <sphereGeometry args={[1.2, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.3]} />
          <meshStandardMaterial
            color="#e8a4a4"
            transparent
            opacity={viewerSettings.maxillaOpacity / 100}
            roughness={0.6}
          />
        </mesh>
        {[-0.8, -0.5, -0.2, 0.1, 0.4, 0.7].map((x, i) => (
          <mesh key={`upper-tooth-${i}`} position={[x, 0.3, 0.8]}>
            <boxGeometry args={[0.2, 0.4, 0.15]} />
            <meshStandardMaterial
              color="#f5f5dc"
              transparent
              opacity={viewerSettings.maxillaOpacity / 100}
              roughness={0.3}
            />
          </mesh>
        ))}
        {activeTool === 'occlusal' && (
          <mesh position={[0, 0.55, 0.8]}>
            <planeGeometry args={[2, 0.5]} />
            <meshBasicMaterial color="#ff4444" transparent opacity={0.4 * (viewerSettings.maxillaOpacity / 100)} />
          </mesh>
        )}
      </group>

      {/* Mandible (Lower Jaw) */}
      <group
        ref={mandibleRef}
        position={[0, -0.8, 0]}
        onPointerOver={onArchOver('mandible')}
        onPointerOut={onArchOut('mandible')}
        onClick={onArchClick('mandible')}
      >
        <mesh rotation={[Math.PI, 0, 0]}>
          <sphereGeometry args={[1.2, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.3]} />
          <meshStandardMaterial
            color="#e8a4a4"
            transparent
            opacity={viewerSettings.mandibleOpacity / 100}
            roughness={0.6}
          />
        </mesh>
        {[-0.8, -0.5, -0.2, 0.1, 0.4, 0.7].map((x, i) => (
          <mesh key={`lower-tooth-${i}`} position={[x, -0.3, 0.8]}>
            <boxGeometry args={[0.2, 0.4, 0.15]} />
            <meshStandardMaterial
              color="#f5f5dc"
              transparent
              opacity={viewerSettings.mandibleOpacity / 100}
              roughness={0.3}
            />
          </mesh>
        ))}
        {activeTool === 'occlusal' && (
          <mesh position={[0, -0.55, 0.8]}>
            <planeGeometry args={[2, 0.5]} />
            <meshBasicMaterial color="#44ff44" transparent opacity={0.4 * (viewerSettings.mandibleOpacity / 100)} />
          </mesh>
        )}
      </group>

      {/* Occlusion/Bite — tool-driven overlay, conditional render is fine */}
      {viewerSettings.occlusionVisible && activeTool === 'occlusal' && (
        <group>
          <mesh position={[-0.5, 0, 0.9]}>
            <sphereGeometry args={[0.08, 16, 16]} />
            <meshBasicMaterial color="#ff0000" transparent opacity={viewerSettings.occlusionOpacity / 100} />
          </mesh>
          <mesh position={[0.2, 0, 0.9]}>
            <sphereGeometry args={[0.06, 16, 16]} />
            <meshBasicMaterial color="#ffff00" transparent opacity={viewerSettings.occlusionOpacity / 100} />
          </mesh>
          <mesh position={[0.6, 0, 0.9]}>
            <sphereGeometry args={[0.05, 16, 16]} />
            <meshBasicMaterial color="#00ff00" transparent opacity={viewerSettings.occlusionOpacity / 100} />
          </mesh>
        </group>
      )}

      {/* Measurement Lines */}
      {activeTool === 'measure' && (
        <group>
          <Line points={[[-0.5, 0.5, 1], [0.5, 0.5, 1]]} color="#0066ff" lineWidth={2} />
          <mesh position={[-0.5, 0.5, 1]}>
            <sphereGeometry args={[0.05, 16, 16]} />
            <meshBasicMaterial color="#0066ff" />
          </mesh>
          <mesh position={[0.5, 0.5, 1]}>
            <sphereGeometry args={[0.05, 16, 16]} />
            <meshBasicMaterial color="#0066ff" />
          </mesh>
        </group>
      )}
    </group>
  );
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
}: ModelViewerProps) {
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
          <Canvas shadows>
            <PerspectiveCamera makeDefault position={[0, 0, 5]} fov={50} />
            <ambientLight intensity={0.6} />
            <directionalLight position={[5, 5, 5]} intensity={0.8} castShadow />
            <directionalLight position={[-5, -5, -5]} intensity={0.3} />

            {fileUrl ? (
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

            <OrbitControls
              ref={controlsRef}
              enablePan={true}
              enableZoom={true}
              enableRotate={true}
              mouseButtons={{
                LEFT: mouseSettings.leftRotation ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN,
                MIDDLE: THREE.MOUSE.DOLLY,
                RIGHT: mouseSettings.leftRotation ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
              }}
            />
          </Canvas>

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
