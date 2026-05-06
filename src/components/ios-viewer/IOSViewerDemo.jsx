/**
 * IOS Viewer Pro - Demo Page
 * Example usage of the professional intraoral scan viewer
 */
import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { IOSViewerPro } from './index';
import {
  Upload,
  FileScan,
  AlertCircle,
  CheckCircle2,
  Info,
  Stethoscope,
  Ruler,
  MessageSquare,
  Scissors
} from 'lucide-react';
import { toast } from 'sonner';

// Demo scan metadata
const DEMO_SCAN_METADATA = {
  fileType: 'stl',
  scanDevice: '3Shape TRIOS 5',
  scanSoftware: '3Shape Dental System',
  scanDate: '2026-01-15T10:30:00Z',
  arch: 'upper',
  scanQuality: 'excellent',
  toothNumbers: [11, 12, 13, 14, 15, 16, 17, 21, 22, 23, 24, 25, 26, 27]
};

// Example measurements
const EXAMPLE_MEASUREMENTS = [
  {
    id: 'meas_1',
    type: 'distance',
    points: [[10, 5, 0], [25, 5, 0]],
    value: 15.2,
    label: 'Tooth width #11',
    createdAt: new Date().toISOString()
  },
  {
    id: 'meas_2',
    type: 'distance',
    points: [[30, 8, 5], [45, 8, 5]],
    value: 14.8,
    label: 'Tooth width #21',
    createdAt: new Date().toISOString()
  }
];

// Example annotations
const EXAMPLE_ANNOTATIONS = [
  {
    id: 'anno_1',
    position: [15, 10, 5],
    type: 'marker',
    category: 'finding',
    title: 'Caries detected',
    description: 'Small occlusal caries on tooth #11',
    toothNumber: 11,
    visible: true
  },
  {
    id: 'anno_2',
    position: [35, 8, 5],
    type: 'marker',
    category: 'note',
    title: 'Old filling',
    description: 'Composite filling present',
    toothNumber: 21,
    visible: true
  }
];

const IOSViewerDemo = () => {
  const [fileUrl, setFileUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileType, setFileType] = useState('stl');
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('demo');
  const [screenshots, setScreenshots] = useState([]);

  // Handle file upload
  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['.stl', '.ply', '.obj'];
    const fileExt = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

    if (!allowedTypes.includes(fileExt)) {
      toast.error('Invalid file type. Please upload STL, PLY, or OBJ files.');
      return;
    }

    // Create object URL
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    setFileName(file.name);
    setFileType(fileExt.substring(1));
    setIsViewerOpen(true);

    toast.success(`Loaded: ${file.name}`);
  };

  // Handle screenshot
  const handleScreenshot = (dataUrl) => {
    setScreenshots(prev => [...prev, {
      id: Date.now(),
      dataUrl,
      timestamp: new Date().toLocaleString()
    }]);
  };

  // Load example scan
  const loadExampleScan = () => {
    // In a real app, this would be a URL to an example scan
    toast.info('Example scan would load here in production');
    // setFileUrl('/examples/upper-arch.stl');
    // setFileName('Example Upper Arch.stl');
    // setIsViewerOpen(true);
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <Stethoscope className="h-8 w-8 text-primary" />
          IOS Viewer Pro
        </h1>
        <p className="text-muted-foreground mt-2">
          Professional intraoral scan viewer with measurements, annotations, and analysis tools
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3 max-w-md">
          <TabsTrigger value="demo">Demo</TabsTrigger>
          <TabsTrigger value="features">Features</TabsTrigger>
          <TabsTrigger value="api">API Reference</TabsTrigger>
        </TabsList>

        {/* Demo Tab */}
        <TabsContent value="demo" className="space-y-6">
          {/* Upload Section */}
          <Card>
            <CardHeader>
              <CardTitle>Load Scan</CardTitle>
              <CardDescription>
                Upload an intraoral scan file (STL, PLY, or OBJ format)
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <Label htmlFor="file-upload" className="cursor-pointer">
                    <div className="border-2 border-dashed border-border rounded-lg p-8 text-center hover:bg-muted/50 transition-colors">
                      <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm font-medium">Click to upload or drag and drop</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        STL, PLY, or OBJ up to 100MB
                      </p>
                    </div>
                    <Input
                      id="file-upload"
                      type="file"
                      accept=".stl,.ply,.obj"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                  </Label>
                </div>

                <div className="text-center text-muted-foreground">or</div>

                <Button variant="outline" onClick={loadExampleScan}>
                  <FileScan className="h-4 w-4 mr-2" />
                  Load Example
                </Button>
              </div>

              {fileUrl && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>File Ready</AlertTitle>
                  <AlertDescription>
                    {fileName} ({fileType.toUpperCase()})
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {/* Viewer */}
          {isViewerOpen && fileUrl && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Scan Viewer</CardTitle>
                    <CardDescription>
                      Use tools to measure, annotate, and analyze the scan
                    </CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setIsViewerOpen(false)}>
                    Close Viewer
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <IOSViewerPro
                  fileUrl={fileUrl}
                  fileName={fileName}
                  fileType={fileType}
                  scanMetadata={DEMO_SCAN_METADATA}
                  onScreenshot={handleScreenshot}
                  className="h-[600px]"
                />
              </CardContent>
            </Card>
          )}

          {/* Screenshots */}
          {screenshots.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Screenshots</CardTitle>
                <CardDescription>
                  Captured screenshots from the viewer
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-4 gap-4">
                  {screenshots.map((screenshot) => (
                    <div key={screenshot.id} className="relative group">
                      <img
                        src={screenshot.dataUrl}
                        alt={`Screenshot ${screenshot.id}`}
                        className="w-full aspect-video object-cover rounded-lg border"
                      />
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            const link = document.createElement('a');
                            link.download = `screenshot_${screenshot.id}.png`;
                            link.href = screenshot.dataUrl;
                            link.click();
                          }}
                        >
                          Download
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {screenshot.timestamp}
                      </p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Features Tab */}
        <TabsContent value="features" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Feature Cards */}
            <FeatureCard
              icon={Ruler}
              title="Measurements"
              description="Calibrated distance and angle measurements with 0.1mm precision"
              features={[
                'Point-to-point distance',
                'Angle measurement',
                'Surface area calculation',
                'Persistent annotations'
              ]}
            />

            <FeatureCard
              icon={Scissors}
              title="Cross-Section"
              description="Slice through the model to analyze internal structures"
              features={[
                '3-axis slicing (X, Y, Z)',
                'Adjustable plane position',
                'Cap surface rendering',
                'Measurements on slice'
              ]}
            />

            <FeatureCard
              icon={MessageSquare}
              title="Annotations"
              description="Add markers and notes to specific locations on the scan"
              features={[
                '3D marker placement',
                'Text annotations',
                'Category tagging',
                'Tooth number linking'
              ]}
            />

            <FeatureCard
              icon={Stethoscope}
              title="View Presets"
              description="Dental-specific viewing angles for quick navigation"
              features={[
                'Buccal/Lingual views',
                'Occlusal views',
                'Smile line view',
                'Custom view saving'
              ]}
            />

            <FeatureCard
              icon={FileScan}
              title="File Support"
              description="Multiple 3D file formats for maximum compatibility"
              features={[
                'STL (binary/ASCII)',
                'PLY with color',
                'OBJ format',
                'Automatic detection'
              ]}
            />

            <FeatureCard
              icon={Info}
              title="Scan Info"
              description="Comprehensive metadata and statistics display"
              features={[
                'Mesh statistics',
                'Bounding box dimensions',
                'Surface area',
                'Vertex/face count'
              ]}
            />
          </div>

          {/* Keyboard Shortcuts */}
          <Card>
            <CardHeader>
              <CardTitle>Keyboard Shortcuts</CardTitle>
              <CardDescription>
                Quick access to common actions
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Shortcut key="M" action="Measure tool" />
                <Shortcut key="A" action="Annotate tool" />
                <Shortcut key="C" action="Cross-section" />
                <Shortcut key="R" action="Reset view" />
                <Shortcut key="Ctrl+Z" action="Undo" />
                <Shortcut key="Ctrl+Shift+Z" action="Redo" />
                <Shortcut key="Ctrl+S" action="Screenshot" />
                <Shortcut key="Ctrl+F" action="Fullscreen" />
                <Shortcut key="Esc" action="Navigation mode" />
                <Shortcut key="G" action="Toggle grid" />
                <Shortcut key="W" action="Wireframe" />
                <Shortcut key="T" action="Toggle theme" />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* API Reference Tab */}
        <TabsContent value="api" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Component Props</CardTitle>
              <CardDescription>
                IOSViewerPro component API reference
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="bg-muted p-4 rounded-lg text-sm overflow-x-auto">
{`<IOSViewerPro
  // Required props
  fileUrl="https://example.com/scan.stl"
  fileName="Upper Arch Scan"
  fileType="stl"

  // Optional props
  patientId="uuid"
  encounterId="uuid"
  scanMetadata={{
    scanDevice: "3Shape TRIOS",
    scanSoftware: "Dental System",
    scanDate: "2026-01-15",
    arch: "upper"
  }}

  // Callbacks
  onClose={() => {}}
  onScreenshot={(dataUrl) => {}}
  onAnnotationAdd={(annotation) => {}}
  onMeasurementAdd={(measurement) => {}}

  // Styling
  className="h-[600px]"
/>`}
              </pre>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Store API</CardTitle>
              <CardDescription>
                useIOSViewerStore hooks for programmatic control
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="bg-muted p-4 rounded-lg text-sm overflow-x-auto">
{`const {
  // Tools
  activeTool,
  setActiveTool,

  // View
  viewPreset,
  applyViewPreset,
  resetView,

  // Measurements
  measurements,
  addMeasurement,
  removeMeasurement,

  // Annotations
  annotations,
  addAnnotation,
  updateAnnotation,

  // Cross-section
  crossSection,
  toggleCrossSection,
  setCrossSectionPosition,

  // History
  undo,
  redo,
  canUndo,
  canRedo
} = useIOSViewerStore();`}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

// Helper Components
const FeatureCard = ({ icon: Icon, title, description, features }) => (
  <Card>
    <CardHeader>
      <div className="flex items-center gap-2">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <CardTitle className="text-lg">{title}</CardTitle>
      </div>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
    <CardContent>
      <ul className="space-y-2">
        {features.map((feature, index) => (
          <li key={index} className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </CardContent>
  </Card>
);

const Shortcut = ({ key, action }) => (
  <div className="flex items-center justify-between p-2 bg-muted rounded">
    <span className="text-sm text-muted-foreground">{action}</span>
    <kbd className="px-2 py-1 bg-background rounded text-xs font-mono border">
      {key}
    </kbd>
  </div>
);

export default IOSViewerDemo;
