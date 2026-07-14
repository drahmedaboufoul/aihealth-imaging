/**
 * IOS Viewer Pro - Cross Section Controls Component
 * Control slicing and cross-sectional views
 */
import React from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useIOSViewerStore } from '../store/iosViewerStore';
import { Scissors, RotateCcw } from 'lucide-react';

const AXIS_OPTIONS = [
  { id: 'x', name: 'Sagittal (X)', description: 'Left-Right' },
  { id: 'y', name: 'Coronal (Y)', description: 'Front-Back' },
  { id: 'z', name: 'Axial (Z)', description: 'Top-Bottom' },
];

export const CrossSectionControls = () => {
  const {
    crossSection,
    toggleCrossSection,
    setCrossSectionAxis,
    setCrossSectionPosition,
    toggleShowPlane,
    toggleClipIntersection
  } = useIOSViewerStore();

  return (
    <div className="space-y-4">
      {/* Enable/Disable Cross Section */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Scissors className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm">Enable Cross Section</span>
        </div>
        <Switch
          checked={crossSection.enabled}
          onCheckedChange={toggleCrossSection}
        />
      </div>

      {crossSection.enabled && (
        <>
          {/* Axis Selection */}
          <div>
            <Label className="text-xs mb-2 block">Plane Axis</Label>
            <div className="grid grid-cols-3 gap-2">
              {AXIS_OPTIONS.map((axis) => (
                <button
                  key={axis.id}
                  onClick={() => setCrossSectionAxis(axis.id)}
                  className={`px-2 py-1.5 text-xs rounded border transition-colors ${
                    crossSection.axis === axis.id
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background border-border hover:bg-muted'
                  }`}
                >
                  <div className="font-medium uppercase">{axis.id}</div>
                  <div className="text-[10px] opacity-70">{axis.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Position Slider */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <Label className="text-muted-foreground">Position</Label>
              <span>{Math.round(crossSection.position * 100)}%</span>
            </div>
            <Slider
              value={[crossSection.position]}
              onValueChange={([v]) => setCrossSectionPosition(v)}
              min={0}
              max={1}
              step={0.01}
            />
          </div>

          {/* Options */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Show Plane</span>
              <Switch
                checked={crossSection.showPlane}
                onCheckedChange={toggleShowPlane}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Clip Intersection</span>
              <Switch
                checked={crossSection.clipIntersection}
                onCheckedChange={toggleClipIntersection}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default CrossSectionControls;
