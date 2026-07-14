/**
 * IOS Viewer Pro - Measurement Overlay Component
 * Renders measurement lines and labels in 3D space
 */
import React, { useMemo } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useIOSViewerStore } from '../store/iosViewerStore';

// Minimal local Badge — the EMR's @/components/ui/badge isn't available
// in the imaging-viewer repo. Same visual: amber pill for active, gray
// for completed measurements.
function Badge({ variant = 'secondary', className = '', children }) {
  const bg = variant === 'default' ? '#f59e0b' : '#1f2937';
  const fg = variant === 'default' ? '#0b0d10' : '#f3f4f6';
  return (
    <span
      style={{
        backgroundColor: bg,
        color: fg,
        padding: '2px 8px',
        borderRadius: 12,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: 'monospace',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        border: '1px solid rgba(255,255,255,0.1)',
      }}
      className={className}
    >
      {children}
    </span>
  );
}

// Line component for measurements
const MeasurementLine = ({ start, end, color = '#ff0000' }) => {
  const points = useMemo(() => [
    new THREE.Vector3(...start),
    new THREE.Vector3(...end)
  ], [start, end]);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    return geo;
  }, [points]);

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} linewidth={2} />
    </line>
  );
};

// Point marker component
const PointMarker = ({ position, color = '#ff0000' }) => {
  return (
    <mesh position={position}>
      <sphereGeometry args={[1.5, 16, 16]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
};

// Measurement label component
const MeasurementLabel = ({ position, value, type, isActive }) => {
  const formatValue = (val, t) => {
    switch (t) {
      case 'distance':
        return `${val.toFixed(1)} mm`;
      case 'angle':
        return `${val.toFixed(1)}°`;
      case 'area':
        return `${val.toFixed(1)} mm²`;
      default:
        return val.toFixed(1);
    }
  };

  return (
    <Html position={position} center>
      <Badge
        variant={isActive ? 'default' : 'secondary'}
        className="text-xs whitespace-nowrap pointer-events-none select-none"
      >
        {formatValue(value, type)}
      </Badge>
    </Html>
  );
};

// Main Measurement Overlay
export const MeasurementOverlay = () => {
  const { measurements, activeMeasurement, measurementSettings } = useIOSViewerStore();

  if (!measurementSettings.showLabels || measurements.length === 0) {
    return null;
  }

  return (
    <group>
      {measurements.map((measurement) => {
        const isActive = activeMeasurement === measurement.id;
        const color = isActive ? '#00ff00' : measurementSettings.color;

        switch (measurement.type) {
          case 'distance':
            if (measurement.points.length >= 2) {
              const start = measurement.points[0];
              const end = measurement.points[1];
              const midPoint = [
                (start[0] + end[0]) / 2,
                (start[1] + end[1]) / 2,
                (start[2] + end[2]) / 2
              ];

              return (
                <group key={measurement.id}>
                  <MeasurementLine start={start} end={end} color={color} />
                  <PointMarker position={start} color={color} />
                  <PointMarker position={end} color={color} />
                  <MeasurementLabel
                    position={midPoint}
                    value={measurement.value}
                    type={measurement.type}
                    isActive={isActive}
                  />
                </group>
              );
            }
            break;

          case 'angle':
            if (measurement.points.length >= 3) {
              const vertex = measurement.points[1];
              return (
                <group key={measurement.id}>
                  <MeasurementLine
                    start={measurement.points[0]}
                    end={vertex}
                    color={color}
                  />
                  <MeasurementLine
                    start={vertex}
                    end={measurement.points[2]}
                    color={color}
                  />
                  <PointMarker position={measurement.points[0]} color={color} />
                  <PointMarker position={vertex} color={color} />
                  <PointMarker position={measurement.points[2]} color={color} />
                  <MeasurementLabel
                    position={vertex}
                    value={measurement.value}
                    type={measurement.type}
                    isActive={isActive}
                  />
                </group>
              );
            }
            break;

          default:
            return null;
        }
      })}
    </group>
  );
};

export default MeasurementOverlay;
