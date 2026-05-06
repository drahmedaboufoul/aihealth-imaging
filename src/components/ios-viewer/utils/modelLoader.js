/**
 * IOS Viewer Pro - Model Loader Utility
 * Handles loading of various 3D file formats
 */
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader';

/**
 * Load a 3D model from URL
 * @param {string} url - File URL
 * @param {string} fileType - File extension/type
 * @returns {Promise<THREE.BufferGeometry>}
 */
export const loadModel = async (url, fileType) => {
  const ext = fileType.toLowerCase();

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();

    switch (ext) {
      case 'stl':
        return loadSTL(arrayBuffer);
      case 'ply':
        return loadPLY(arrayBuffer);
      case 'obj':
        return loadOBJ(arrayBuffer);
      default:
        throw new Error(`Unsupported file format: ${ext}`);
    }
  } catch (error) {
    console.error('Error loading model:', error);
    throw error;
  }
};

/**
 * Load STL file (binary or ASCII)
 */
const loadSTL = (arrayBuffer) => {
  const loader = new STLLoader();
  const geometry = loader.parse(arrayBuffer);
  return geometry;
};

/**
 * Load PLY file
 */
const loadPLY = (arrayBuffer) => {
  const loader = new PLYLoader();
  const geometry = loader.parse(arrayBuffer);
  return geometry;
};

/**
 * Load OBJ file
 */
const loadOBJ = (arrayBuffer) => {
  const text = new TextDecoder().decode(arrayBuffer);
  const loader = new OBJLoader();
  const object = loader.parse(text);

  // Extract geometry from OBJ
  let geometry = null;
  object.traverse((child) => {
    if (child.isMesh && !geometry) {
      geometry = child.geometry;
    }
  });

  if (!geometry) {
    throw new Error('No mesh geometry found in OBJ file');
  }

  return geometry;
};

/**
 * Detect file type from filename
 * @param {string} filename
 * @returns {string}
 */
export const detectFileType = (filename) => {
  const ext = filename.split('.').pop().toLowerCase();

  const typeMap = {
    'stl': 'stl',
    'ply': 'ply',
    'obj': 'obj',
    'dcm': 'dicom',
    'dicom': 'dicom',
    'cs3': 'cs3'
  };

  return typeMap[ext] || 'unknown';
};

/**
 * Get file info from URL or filename
 * @param {string} url
 * @returns {Object}
 */
export const getFileInfo = (url) => {
  const filename = url.split('/').pop().split('?')[0];
  const fileType = detectFileType(filename);

  return {
    filename,
    fileType,
    extension: filename.split('.').pop().toLowerCase()
  };
};

/**
 * Calculate mesh statistics
 * @param {THREE.BufferGeometry} geometry
 * @returns {Object}
 */
export const calculateMeshStatistics = (geometry) => {
  // Ensure bounding box is computed
  if (!geometry.boundingBox) {
    geometry.computeBoundingBox();
  }

  const bbox = geometry.boundingBox;
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const center = new THREE.Vector3();
  bbox.getCenter(center);

  // Calculate surface area (approximate)
  let surfaceArea = 0;
  const positions = geometry.attributes.position.array;

  if (geometry.index) {
    // Indexed geometry
    const indices = geometry.index.array;
    for (let i = 0; i < indices.length; i += 3) {
      const a = new THREE.Vector3(
        positions[indices[i] * 3],
        positions[indices[i] * 3 + 1],
        positions[indices[i] * 3 + 2]
      );
      const b = new THREE.Vector3(
        positions[indices[i + 1] * 3],
        positions[indices[i + 1] * 3 + 1],
        positions[indices[i + 1] * 3 + 2]
      );
      const c = new THREE.Vector3(
        positions[indices[i + 2] * 3],
        positions[indices[i + 2] * 3 + 1],
        positions[indices[i + 2] * 3 + 2]
      );

      const ab = new THREE.Vector3().subVectors(b, a);
      const ac = new THREE.Vector3().subVectors(c, a);
      const cross = new THREE.Vector3().crossVectors(ab, ac);
      surfaceArea += cross.length() / 2;
    }
  } else {
    // Non-indexed geometry
    for (let i = 0; i < positions.length; i += 9) {
      const a = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
      const b = new THREE.Vector3(positions[i + 3], positions[i + 4], positions[i + 5]);
      const c = new THREE.Vector3(positions[i + 6], positions[i + 7], positions[i + 8]);

      const ab = new THREE.Vector3().subVectors(b, a);
      const ac = new THREE.Vector3().subVectors(c, a);
      const cross = new THREE.Vector3().crossVectors(ab, ac);
      surfaceArea += cross.length() / 2;
    }
  }

  return {
    vertexCount: geometry.attributes.position.count,
    faceCount: geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3,
    boundingBox: {
      min: { x: bbox.min.x, y: bbox.min.y, z: bbox.min.z },
      max: { x: bbox.max.x, y: bbox.max.y, z: bbox.max.z },
      size: { x: size.x, y: size.y, z: size.z },
      center: { x: center.x, y: center.y, z: center.z }
    },
    surfaceArea
  };
};

export default {
  loadModel,
  detectFileType,
  getFileInfo,
  calculateMeshStatistics
};
