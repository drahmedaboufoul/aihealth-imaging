/**
 * IOS Viewer Pro - Sidebar Component
 * Information panel, measurements, annotations, and settings
 */
import React from 'react';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Info,
  Ruler,
  MessageSquare,
  Settings2,
  Trash2,
  Edit2,
  Eye,
  EyeOff,
  FileDown,
  Stethoscope,
  Box,
  Palette,
  Sun,
  Grid3X3,
  X
} from 'lucide-react';
import { useIOSViewerStore, DENTAL_VIEW_PRESETS } from '../store/iosViewerStore';
import { MaterialControls } from './MaterialControls';
import { CrossSectionControls } from './CrossSectionControls';

// Info Panel Component
const InfoPanel = ({ fileName, scanMetadata }) => {
  const { meshStatistics } = useIOSViewerStore();

  const formatNumber = (num) => {
    if (num === undefined || num === null) return '—';
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(2) + 'K';
    return num.toLocaleString();
  };

  return (
    <div className="space-y-4">
      {/* File Info */}
      <div>
        <h4 className="text-sm font-medium mb-2">File Information</h4>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Name</span>
            <span className="font-medium truncate max-w-[150px]">{fileName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Type</span>
            <span className="uppercase">{scanMetadata.fileType || 'STL'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Date</span>
            <span>{scanMetadata.scanDate ? new Date(scanMetadata.scanDate).toLocaleDateString() : '—'}</span>
          </div>
        </div>
      </div>

      <Separator />

      {/* Mesh Statistics */}
      {meshStatistics && (
        <div>
          <h4 className="text-sm font-medium mb-2">Mesh Statistics</h4>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Vertices</span>
              <span>{formatNumber(meshStatistics.vertexCount)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Faces</span>
              <span>{formatNumber(meshStatistics.faceCount)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Surface Area</span>
              <span>{meshStatistics.surfaceArea ? meshStatistics.surfaceArea.toFixed(2) + ' mm²' : '—'}</span>
            </div>
            {meshStatistics.boundingBox && (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Dimensions</span>
                  <span>
                    {meshStatistics.boundingBox.size.x.toFixed(1)} ×{' '}
                    {meshStatistics.boundingBox.size.y.toFixed(1)} ×{' '}
                    {meshStatistics.boundingBox.size.z.toFixed(1)} mm
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <Separator />

      {/* Scan Metadata */}
      {(scanMetadata.scanDevice || scanMetadata.scanSoftware) && (
        <div>
          <h4 className="text-sm font-medium mb-2">Scan Information</h4>
          <div className="space-y-1 text-sm">
            {scanMetadata.scanDevice && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Device</span>
                <span>{scanMetadata.scanDevice}</span>
              </div>
            )}
            {scanMetadata.scanSoftware && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Software</span>
                <span>{scanMetadata.scanSoftware}</span>
              </div>
            )}
            {scanMetadata.arch && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Arch</span>
                <span className="capitalize">{scanMetadata.arch}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Measurements Panel
const MeasurementsPanel = () => {
  const {
    measurements,
    activeMeasurement,
    removeMeasurement,
    setActiveMeasurement,
    measurementSettings,
    clearMeasurements
  } = useIOSViewerStore();

  const formatValue = (value, type) => {
    switch (type) {
      case 'distance':
        return `${value.toFixed(measurementSettings.precision)} mm`;
      case 'angle':
        return `${value.toFixed(measurementSettings.precision)}°`;
      case 'area':
        return `${value.toFixed(measurementSettings.precision)} mm²`;
      default:
        return value.toFixed(measurementSettings.precision);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Measurements ({measurements.length})</h4>
        {measurements.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearMeasurements}>
            <Trash2 className="h-3 w-3 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {measurements.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Ruler className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No measurements yet</p>
          <p className="text-xs">Select the measurement tool to start</p>
        </div>
      ) : (
        <ScrollArea className="h-[300px]">
          <div className="space-y-2">
            {measurements.map((measurement) => (
              <Card
                key={measurement.id}
                className={`p-3 cursor-pointer transition-colors ${
                  activeMeasurement === measurement.id ? 'border-primary bg-primary/5' : ''
                }`}
                onClick={() => setActiveMeasurement(measurement.id)}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs capitalize">
                        {measurement.type}
                      </Badge>
                      <span className="font-medium text-sm">
                        {formatValue(measurement.value, measurement.type)}
                      </span>
                    </div>
                    {measurement.label && (
                      <p className="text-xs text-muted-foreground mt-1">{measurement.label}</p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeMeasurement(measurement.id);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </ScrollArea>
      )}

      {/* Measurement Settings */}
      <Separator />
      <div>
        <h4 className="text-sm font-medium mb-3">Settings</h4>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Precision</Label>
            <div className="flex items-center gap-2 mt-1">
              <Slider
                value={[measurementSettings.precision]}
                onValueChange={([v]) => useIOSViewerStore.setState(state => {
                  state.measurementSettings.precision = v;
                })}
                min={0}
                max={3}
                step={1}
              />
              <span className="text-xs w-8">{measurementSettings.precision}</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Show Labels</Label>
            <input
              type="checkbox"
              checked={measurementSettings.showLabels}
              onChange={(e) => useIOSViewerStore.setState(state => {
                state.measurementSettings.showLabels = e.target.checked;
              })}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

// Annotations Panel
const AnnotationsPanel = () => {
  const {
    annotations,
    selectedAnnotation,
    annotationCategories,
    setSelectedAnnotation,
    removeAnnotation,
    toggleAnnotationVisibility
  } = useIOSViewerStore();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Annotations ({annotations.length})</h4>
      </div>

      {annotations.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No annotations yet</p>
          <p className="text-xs">Select the annotate tool to add markers</p>
        </div>
      ) : (
        <ScrollArea className="h-[300px]">
          <div className="space-y-2">
            {annotations.map((annotation) => {
              const category = annotationCategories.find(c => c.id === annotation.category);
              return (
                <Card
                  key={annotation.id}
                  className={`p-3 cursor-pointer transition-colors ${
                    selectedAnnotation === annotation.id ? 'border-primary bg-primary/5' : ''
                  }`}
                  onClick={() => setSelectedAnnotation(annotation.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: category?.color || '#888' }}
                        />
                        <span className="font-medium text-sm truncate">
                          {annotation.title || 'Untitled'}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {annotation.description || 'No description'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 ml-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleAnnotationVisibility(annotation.id);
                        }}
                      >
                        {annotation.visible !== false ? (
                          <Eye className="h-3 w-3" />
                        ) : (
                          <EyeOff className="h-3 w-3" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeAnnotation(annotation.id);
                        }}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </ScrollArea>
      )}

      {/* Legend */}
      <Separator />
      <div>
        <h4 className="text-sm font-medium mb-2">Categories</h4>
        <div className="flex flex-wrap gap-2">
          {annotationCategories.map(category => (
            <div key={category.id} className="flex items-center gap-1">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: category.color }}
              />
              <span className="text-xs text-muted-foreground">{category.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// Settings Panel
const SettingsPanel = () => {
  const {
    lighting,
    setAmbientLight,
    setDirectionalLight,
    toggleShadows,
    showAxes,
    toggleAxes,
    showBoundingBox,
    toggleBoundingBox,
    showStatistics,
    toggleStatistics
  } = useIOSViewerStore();

  return (
    <div className="space-y-4">
      {/* Material Settings */}
      <div>
        <h4 className="text-sm font-medium mb-3">Material</h4>
        <MaterialControls />
      </div>

      <Separator />

      {/* Lighting Settings */}
      <div>
        <h4 className="text-sm font-medium mb-3">Lighting</h4>
        <div className="space-y-3">
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-muted-foreground">Ambient</span>
              <span>{Math.round(lighting.ambient * 100)}%</span>
            </div>
            <Slider
              value={[lighting.ambient]}
              onValueChange={([v]) => setAmbientLight(v)}
              min={0}
              max={2}
              step={0.1}
            />
          </div>
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-muted-foreground">Directional</span>
              <span>{Math.round(lighting.directional * 100)}%</span>
            </div>
            <Slider
              value={[lighting.directional]}
              onValueChange={([v]) => setDirectionalLight(v)}
              min={0}
              max={2}
              step={0.1}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Shadows</span>
            <input
              type="checkbox"
              checked={lighting.shadows}
              onChange={toggleShadows}
            />
          </div>
        </div>
      </div>

      <Separator />

      {/* Display Settings */}
      <div>
        <h4 className="text-sm font-medium mb-3">Display</h4>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Show Axes</span>
            <input
              type="checkbox"
              checked={showAxes}
              onChange={toggleAxes}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Show Bounding Box</span>
            <input
              type="checkbox"
              checked={showBoundingBox}
              onChange={toggleBoundingBox}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Show Statistics</span>
            <input
              type="checkbox"
              checked={showStatistics}
              onChange={toggleStatistics}
            />
          </div>
        </div>
      </div>

      <Separator />

      {/* Cross Section */}
      <div>
        <h4 className="text-sm font-medium mb-3">Cross Section</h4>
        <CrossSectionControls />
      </div>
    </div>
  );
};

// Main Sidebar Component
export const Sidebar = ({ className, fileName, scanMetadata }) => {
  const { activePanel, setActivePanel } = useIOSViewerStore();

  return (
    <Card className={`flex flex-col h-full rounded-none border-0 ${className}`}>
      <Tabs value={activePanel} onValueChange={setActivePanel} className="flex flex-col h-full">
        <TabsList className="grid grid-cols-4 m-2">
          <TabsTrigger value="info" className="text-xs">
            <Info className="h-4 w-4" />
          </TabsTrigger>
          <TabsTrigger value="measurements" className="text-xs">
            <Ruler className="h-4 w-4" />
          </TabsTrigger>
          <TabsTrigger value="annotations" className="text-xs">
            <MessageSquare className="h-4 w-4" />
          </TabsTrigger>
          <TabsTrigger value="settings" className="text-xs">
            <Settings2 className="h-4 w-4" />
          </TabsTrigger>
        </TabsList>

        <div className="flex-1 overflow-hidden">
          <TabsContent value="info" className="h-full m-0 p-4">
            <InfoPanel fileName={fileName} scanMetadata={scanMetadata} />
          </TabsContent>

          <TabsContent value="measurements" className="h-full m-0 p-4">
            <MeasurementsPanel />
          </TabsContent>

          <TabsContent value="annotations" className="h-full m-0 p-4">
            <AnnotationsPanel />
          </TabsContent>

          <TabsContent value="settings" className="h-full m-0 p-4">
            <SettingsPanel />
          </TabsContent>
        </div>
      </Tabs>
    </Card>
  );
};

export default Sidebar;
