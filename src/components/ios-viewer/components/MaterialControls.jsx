/**
 * IOS Viewer Pro - Material Controls Component
 * Adjust material properties of the 3D model
 */
import React from 'react';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useIOSViewerStore } from '../store/iosViewerStore';
import { Check } from 'lucide-react';

export const MaterialControls = () => {
  const {
    materialSettings,
    colorPresets,
    setMaterialColor,
    setMetalness,
    setRoughness,
    toggleWireframe,
    setOpacity
  } = useIOSViewerStore();

  return (
    <div className="space-y-4">
      {/* Color Presets */}
      <div>
        <Label className="text-xs mb-2 block">Color</Label>
        <div className="flex flex-wrap gap-2">
          {colorPresets.map((preset) => (
            <button
              key={preset.color}
              onClick={() => setMaterialColor(preset.color)}
              className={`w-6 h-6 rounded-full border-2 transition-all ${
                materialSettings.color === preset.color
                  ? 'border-primary scale-110'
                  : 'border-transparent hover:scale-105'
              }`}
              style={{ backgroundColor: preset.color }}
              title={preset.name}
            >
              {materialSettings.color === preset.color && (
                <Check className="h-3 w-3 mx-auto text-white drop-shadow-md" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Metalness */}
      <div>
        <div className="flex justify-between text-xs mb-1">
          <Label className="text-muted-foreground">Metalness</Label>
          <span>{Math.round(materialSettings.metalness * 100)}%</span>
        </div>
        <Slider
          value={[materialSettings.metalness]}
          onValueChange={([v]) => setMetalness(v)}
          min={0}
          max={1}
          step={0.05}
        />
      </div>

      {/* Roughness */}
      <div>
        <div className="flex justify-between text-xs mb-1">
          <Label className="text-muted-foreground">Roughness</Label>
          <span>{Math.round(materialSettings.roughness * 100)}%</span>
        </div>
        <Slider
          value={[materialSettings.roughness]}
          onValueChange={([v]) => setRoughness(v)}
          min={0}
          max={1}
          step={0.05}
        />
      </div>

      {/* Opacity */}
      <div>
        <div className="flex justify-between text-xs mb-1">
          <Label className="text-muted-foreground">Opacity</Label>
          <span>{Math.round(materialSettings.opacity * 100)}%</span>
        </div>
        <Slider
          value={[materialSettings.opacity]}
          onValueChange={([v]) => setOpacity(v)}
          min={0.1}
          max={1}
          step={0.05}
        />
      </div>

      {/* Wireframe Toggle */}
      <div className="flex items-center justify-between">
        <Label className="text-sm text-muted-foreground">Wireframe</Label>
        <input
          type="checkbox"
          checked={materialSettings.wireframe}
          onChange={toggleWireframe}
        />
      </div>
    </div>
  );
};

export default MaterialControls;
