/**
 * Professional Intraoral Scan (IOS) Viewer
 * Fixed version with screenshot, view presets, and PLY colors
 */
import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Center } from '@react-three/drei';
import * as THREE from 'three';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Loader2, Maximize2, Minimize2, Camera, RotateCcw,
  Sun, Moon, X, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Eye,
  Brain
} from 'lucide-react';
import AIAnalysisPanel from './AIAnalysisPanel';

// View Presets
const VIEW_PRESETS = {
  front: { position: [0, 0, 200], target: [0, 0, 0] },
  back: { position: [0, 0, -200], target: [0, 0, 0] },
  top: { position: [0, 200, 0], target: [0, 0, 0] },
  bottom: { position: [0, -200, 0], target: [0, 0, 0] },
  left: { position: [-200, 0, 0], target: [0, 0, 0] },
  right: { position: [200, 0, 0], target: [0, 0, 0] },
};

// Scan Mesh with PLY color support
function ScanMesh({ url, type, onLoad, onError }) {
  const meshRef = useRef();
  const [geometry, setGeometry] = useState(null);
  const [hasVertexColors, setHasVertexColors] = useState(false);

  useEffect(() => {
    if (!url) {
      onError?.(new Error('No URL provided'));
      return;
    }

    const load = async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();

        if (arrayBuffer.byteLength === 0) {
          throw new Error('Empty file');
        }

        let geo;
        const ext = type?.toLowerCase();

        if (ext === 'stl') {
          const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader');
          geo = new STLLoader().parse(arrayBuffer);
        } else if (ext === 'ply') {
          const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader');
          geo = new PLYLoader().parse(arrayBuffer);
          // Check for vertex colors
          if (geo.attributes.color) {
            setHasVertexColors(true);
          }
        } else if (ext === 'obj') {
          const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader');
          const text = new TextDecoder().decode(arrayBuffer);
          const obj = new OBJLoader().parse(text);
          obj.traverse((child) => {
            if (child.isMesh && !geo) geo = child.geometry;
          });
        } else {
          throw new Error(`Unsupported format: ${ext}`);
        }

        if (geo) {
          geo.computeVertexNormals();
          geo.center();
          setGeometry(geo);
          onLoad?.();
        } else {
          throw new Error('No geometry found in file');
        }
      } catch (err) {
        console.error('[IOSViewer] Load error:', err);
        onError?.(err);
      }
    };

    load();
  }, [url, type, onLoad, onError]);

  if (!geometry) return null;

  return (
    <mesh ref={meshRef} geometry={geometry} castShadow receiveShadow>
      {hasVertexColors ? (
        <meshStandardMaterial
          vertexColors
          metalness={0.1}
          roughness={0.5}
          side={THREE.DoubleSide}
        />
      ) : (
        <meshStandardMaterial
          color="#e8daca"
          metalness={0.1}
          roughness={0.5}
          side={THREE.DoubleSide}
        />
      )}
    </mesh>
  );
}

// Scene with camera control
function Scene({ url, type, onLoad, onError, viewPreset }) {
  const { camera, controls, gl, scene } = useThree();

  // Apply view preset
  useEffect(() => {
    if (viewPreset && camera && controls) {
      const preset = VIEW_PRESETS[viewPreset];
      if (preset) {
        // Use smooth animation
        const startPos = camera.position.clone();
        const endPos = new THREE.Vector3(...preset.position);
        const startTarget = controls.target.clone();
        const endTarget = new THREE.Vector3(...preset.target);

        let progress = 0;
        const duration = 500; // ms
        const startTime = performance.now();

        const animate = (currentTime) => {
          const elapsed = currentTime - startTime;
          progress = Math.min(elapsed / duration, 1);

          // Easing
          const ease = 1 - Math.pow(1 - progress, 3);

          camera.position.lerpVectors(startPos, endPos, ease);
          controls.target.lerpVectors(startTarget, endTarget, ease);
          controls.update();

          if (progress < 1) {
            requestAnimationFrame(animate);
          }
        };

        requestAnimationFrame(animate);
      }
    }
  }, [viewPreset, camera, controls]);

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[100, 100, 100]} intensity={1.2} castShadow />
      <directionalLight position={[-100, -50, -100]} intensity={0.5} />

      <Grid
        position={[0, -50, 0]}
        args={[200, 200]}
        cellSize={10}
        cellColor="#666"
        sectionSize={50}
        sectionColor="#888"
        fadeDistance={400}
        infiniteGrid
      />

      <Center>
        <ScanMesh url={url} type={type} onLoad={onLoad} onError={onError} />
      </Center>

      <OrbitControls
        enablePan={true}
        enableRotate={true}
        enableZoom={true}
        dampingFactor={0.05}
        minDistance={10}
        maxDistance={500}
      />
    </>
  );
}

// Main Component
const IOSViewerPro = ({ fileUrl, fileName = 'Scan', fileType = 'stl', onClose, className = '', patientId }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [viewPreset, setViewPreset] = useState('front');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDark, setIsDark] = useState(true);
  const [showAI, setShowAI] = useState(false);
  const canvasRef = useRef();

  const handleLoad = () => {
    setLoading(false);
    setError(null);
  };

  const handleError = (err) => {
    setLoading(false);
    setError(err.message || 'Failed to load scan');
  };

  // Screenshot function
  const takeScreenshot = useCallback(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const dataUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `${fileName || 'scan'}_screenshot.png`;
    link.href = dataUrl;
    link.click();
    toast.success('Screenshot saved');
  }, [fileName]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  return (
    <div className={`flex flex-col ${isDark ? 'bg-gray-900' : 'bg-gray-100'} h-full ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <Camera className="h-5 w-5 text-amber-500" />
          <div>
            <span className="font-medium text-sm text-white">{fileName}</span>
            <span className="text-xs text-gray-400 ml-2 uppercase">{fileType}</span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className={`h-8 w-8 ${showAI ? 'text-amber-500' : 'text-gray-400'}`}
            onClick={() => setShowAI(!showAI)}
            title="AI Analysis"
          >
            <Brain className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-gray-400"
            onClick={takeScreenshot}
            title="Screenshot"
          >
            <Camera className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400" onClick={() => setIsDark(!isDark)}>
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400" onClick={() => setViewPreset('front')}>
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400" onClick={toggleFullscreen}>
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* View Presets */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-700 overflow-x-auto">
        {Object.entries({
          front: Eye, back: Eye, top: ChevronUp, bottom: ChevronDown,
          left: ChevronLeft, right: ChevronRight
        }).map(([key, Icon]) => (
          <Button
            key={key}
            variant={viewPreset === key ? "default" : "ghost"}
            size="sm"
            className={viewPreset === key ? "bg-amber-500 text-black" : "text-gray-400"}
            onClick={() => setViewPreset(key)}
          >
            <Icon className="h-4 w-4 mr-1" />
            {key}
          </Button>
        ))}
      </div>

      {/* Main Content with AI Panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Canvas */}
        <div className={`flex-1 relative ${showAI ? '' : ''}`} style={{ minHeight: '400px' }}>
        <Canvas
          ref={canvasRef}
          camera={{ position: [0, 0, 200], fov: 45 }}
          gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
          style={{
            background: isDark ? '#111827' : '#f3f4f6',
            width: '100%',
            height: '100%'
          }}
        >
          <Scene
            url={fileUrl}
            type={fileType}
            onLoad={handleLoad}
            onError={handleError}
            viewPreset={viewPreset}
          />
        </Canvas>

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
              <span className="text-sm text-white">Loading 3D scan...</span>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80">
            <div className="text-center">
              <p className="text-red-400 mb-2">{error}</p>
              <Button onClick={() => window.location.reload()}>Retry</Button>
            </div>
          </div>
        )}

        {/* Controls hint */}
        <div className="absolute bottom-4 left-4 text-xs text-gray-400 bg-black/50 px-2 py-1 rounded">
          Left: Rotate • Right: Pan • Scroll: Zoom
        </div>
        </div>

        {/* AI Analysis Panel */}
        {showAI && (
          <AIAnalysisPanel
            fileUrl={fileUrl}
            fileType={fileType}
            fileName={fileName}
            scanType="ios"
            patientId={patientId}
            onClose={() => setShowAI(false)}
          />
        )}
      </div>
    </div>
  );
};

export default IOSViewerPro;
