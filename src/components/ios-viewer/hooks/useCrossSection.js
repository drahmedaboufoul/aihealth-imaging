/**
 * IOS Viewer Pro - useCrossSection Hook
 * Handles cross-section slicing logic
 */
import { useState, useCallback } from 'react';
import * as THREE from 'three';
import { useIOSViewerStore } from '../store/iosViewerStore';

export const useCrossSection = () => {
  const { crossSection, setCrossSectionPosition, setCrossSectionAxis } = useIOSViewerStore();

  // Get the current clipping plane
  const getClippingPlane = useCallback(() => {
    if (!crossSection.enabled) return null;

    const plane = new THREE.Plane();
    const position = (crossSection.position - 0.5) * 100; // Normalize to -50 to 50

    switch (crossSection.axis) {
      case 'x':
        plane.setFromNormalAndCoplanarPoint(
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(position, 0, 0)
        );
        break;
      case 'y':
        plane.setFromNormalAndCoplanarPoint(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, position, 0)
        );
        break;
      case 'z':
        plane.setFromNormalAndCoplanarPoint(
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(0, 0, position)
        );
        break;
      default:
        plane.setFromNormalAndCoplanarPoint(
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(0, 0, 0)
        );
    }

    return plane;
  }, [crossSection]);

  // Update slice position
  const updateSlicePosition = useCallback((position) => {
    setCrossSectionPosition(Math.max(0, Math.min(1, position)));
  }, [setCrossSectionPosition]);

  // Step slice forward/backward
  const stepSlice = useCallback((direction, step = 0.05) => {
    const newPosition = crossSection.position + (direction === 'forward' ? step : -step);
    setCrossSectionPosition(Math.max(0, Math.min(1, newPosition)));
  }, [crossSection.position, setCrossSectionPosition]);

  return {
    crossSection,
    getClippingPlane,
    updateSlicePosition,
    stepSlice
  };
};

export default useCrossSection;
