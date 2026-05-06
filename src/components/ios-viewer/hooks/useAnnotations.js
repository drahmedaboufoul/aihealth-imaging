/**
 * IOS Viewer Pro - useAnnotations Hook
 * Handles annotation creation and management
 */
import { useState, useCallback } from 'react';
import { useIOSViewerStore } from '../store/iosViewerStore';

export const useAnnotations = () => {
  const [isAnnotating, setIsAnnotating] = useState(false);
  const { addAnnotation, setSelectedAnnotation } = useIOSViewerStore();

  // Start annotation mode
  const startAnnotation = useCallback(() => {
    setIsAnnotating(true);
  }, []);

  // Add annotation at position
  const addAnnotationAt = useCallback((position, data = {}) => {
    const annotation = {
      position,
      type: 'marker',
      category: 'note',
      title: '',
      description: '',
      visible: true,
      ...data,
      id: `anno_${Date.now()}`
    };

    addAnnotation(annotation);
    setSelectedAnnotation(annotation.id);
    setIsAnnotating(false);

    return annotation;
  }, [addAnnotation, setSelectedAnnotation]);

  // Cancel annotation mode
  const cancelAnnotation = useCallback(() => {
    setIsAnnotating(false);
  }, []);

  return {
    isAnnotating,
    startAnnotation,
    addAnnotationAt,
    cancelAnnotation
  };
};

export default useAnnotations;
