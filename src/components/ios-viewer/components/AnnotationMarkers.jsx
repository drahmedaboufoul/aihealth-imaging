/**
 * IOS Viewer Pro - Annotation Markers Component
 * Renders 3D annotation markers and labels
 */
import React from 'react';
import { Html } from '@react-three/drei';
import { useIOSViewerStore } from '../store/iosViewerStore';
import { MessageSquare, MapPin, AlertCircle, Info } from 'lucide-react';

const CATEGORY_ICONS = {
  finding: AlertCircle,
  note: Info,
  instruction: MessageSquare,
  measurement: MapPin
};

// Individual annotation marker
const AnnotationMarker = ({ annotation, isSelected, category }) => {
  const Icon = CATEGORY_ICONS[annotation.category] || MapPin;
  const color = category?.color || '#888888';

  if (annotation.visible === false) {
    return null;
  }

  return (
    <group position={annotation.position}>
      {/* 3D Marker */}
      <mesh>
        <sphereGeometry args={[1.5, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>

      {/* Label */}
      <Html center distanceFactor={10}>
        <div
          className={`flex flex-col items-center gap-1 p-2 rounded-lg shadow-lg transition-all ${
            isSelected ? 'bg-primary text-primary-foreground scale-110' : 'bg-background'
          }`}
          style={{ minWidth: '120px' }}
        >
          <div className="flex items-center gap-1">
            <Icon className="h-3 w-3" style={{ color }} />
            <span className="text-xs font-medium truncate max-w-[100px]">
              {annotation.title || 'Untitled'}
            </span>
          </div>
          {annotation.description && (
            <p className="text-[10px] text-muted-foreground line-clamp-2 max-w-[150px]">
              {annotation.description}
            </p>
          )}
          {annotation.toothNumber && (
            <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">
              Tooth #{annotation.toothNumber}
            </span>
          )}
        </div>
      </Html>
    </group>
  );
};

// Main Annotations Component
export const AnnotationMarkers = () => {
  const { annotations, selectedAnnotation, annotationCategories } = useIOSViewerStore();

  if (annotations.length === 0) {
    return null;
  }

  return (
    <group>
      {annotations.map((annotation) => {
        const category = annotationCategories.find(c => c.id === annotation.category);
        const isSelected = selectedAnnotation === annotation.id;

        return (
          <AnnotationMarker
            key={annotation.id}
            annotation={annotation}
            isSelected={isSelected}
            category={category}
          />
        );
      })}
    </group>
  );
};

export default AnnotationMarkers;
