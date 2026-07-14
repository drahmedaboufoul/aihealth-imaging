/**
 * IOS Viewer Pro - useMeasurements Hook
 * Handles measurement tool logic
 */
import { useState, useCallback, useRef } from 'react';
import * as THREE from 'three';
import { useIOSViewerStore } from '../store/iosViewerStore';

export const useMeasurements = () => {
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [tempPoints, setTempPoints] = useState([]);
  const { addMeasurement, setActiveMeasurement } = useIOSViewerStore();

  // Start a new measurement
  const startMeasurement = useCallback((type) => {
    setIsMeasuring(true);
    setTempPoints([]);
  }, []);

  // Add a point to the current measurement
  const addPoint = useCallback((point) => {
    setTempPoints(prev => {
      const newPoints = [...prev, point];

      // Check if we have enough points to complete the measurement
      if (newPoints.length >= 2) {
        // For distance measurement, 2 points are enough
        completeMeasurement('distance', newPoints);
      }

      return newPoints;
    });
  }, []);

  // Complete the measurement
  const completeMeasurement = useCallback((type, points) => {
    let value = 0;

    switch (type) {
      case 'distance':
        if (points.length >= 2) {
          const start = new THREE.Vector3(...points[0]);
          const end = new THREE.Vector3(...points[1]);
          value = start.distanceTo(end);
        }
        break;

      case 'angle':
        if (points.length >= 3) {
          const p1 = new THREE.Vector3(...points[0]);
          const vertex = new THREE.Vector3(...points[1]);
          const p2 = new THREE.Vector3(...points[2]);

          const v1 = new THREE.Vector3().subVectors(p1, vertex).normalize();
          const v2 = new THREE.Vector3().subVectors(p2, vertex).normalize();

          value = Math.acos(v1.dot(v2)) * (180 / Math.PI);
        }
        break;

      case 'area':
        // Simplified area calculation for triangle
        if (points.length >= 3) {
          const a = new THREE.Vector3(...points[0]);
          const b = new THREE.Vector3(...points[1]);
          const c = new THREE.Vector3(...points[2]);

          const ab = new THREE.Vector3().subVectors(b, a);
          const ac = new THREE.Vector3().subVectors(c, a);
          const cross = new THREE.Vector3().crossVectors(ab, ac);

          value = cross.length() / 2;
        }
        break;

      default:
        break;
    }

    const measurement = {
      type,
      points,
      value,
      label: `${type} measurement`,
      id: `meas_${Date.now()}`
    };

    addMeasurement(measurement);
    setActiveMeasurement(measurement.id);
    setIsMeasuring(false);
    setTempPoints([]);
  }, [addMeasurement, setActiveMeasurement]);

  // Cancel current measurement
  const cancelMeasurement = useCallback(() => {
    setIsMeasuring(false);
    setTempPoints([]);
  }, []);

  return {
    isMeasuring,
    tempPoints,
    startMeasurement,
    addPoint,
    completeMeasurement,
    cancelMeasurement
  };
};

export default useMeasurements;
