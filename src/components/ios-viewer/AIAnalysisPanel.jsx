/**
 * AI Analysis Panel for IOS and DICOM viewers
 * Provides automated detection of dental problems and report generation
 */
import React, { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import {
  Brain, Scan, AlertCircle, CheckCircle,
  FileText, Loader2, Stethoscope, X,
  Camera, ChevronRight, Download
} from 'lucide-react';
import { useAI } from '@/hooks/useAI';

// Problem severity colors
const SEVERITY_COLORS = {
  critical: 'bg-red-500/20 text-red-400 border-red-500/50',
  high: 'bg-orange-500/20 text-orange-400 border-orange-500/50',
  medium: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
  low: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
  info: 'bg-gray-500/20 text-gray-400 border-gray-500/50',
};

const SEVERITY_ICONS = {
  critical: AlertCircle,
  high: AlertCircle,
  medium: AlertCircle,
  low: CheckCircle,
  info: CheckCircle,
};

export default function AIAnalysisPanel({
  fileUrl,
  fileType,
  fileName,
  scanType, // 'ios' or 'dicom'
  patientId,
  onClose,
  onGenerateReport
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [selectedFinding, setSelectedFinding] = useState(null);
  const { loading: aiLoading } = useAI();

  // Analyze scan with AI
  const analyzeScan = useCallback(async () => {
    setAnalyzing(true);
    try {
      // In production, this would call an AI Edge Function
      // For now, simulate the analysis
      await new Promise(resolve => setTimeout(resolve, 2000));

      const mockAnalysis = scanType === 'ios'
        ? generateIOSAnalysis(fileName)
        : generateDICOMAnalysis(fileName);

      setAnalysis(mockAnalysis);
      toast.success('AI analysis completed');
    } catch (error) {
      console.error('Analysis error:', error);
      toast.error('Failed to analyze scan');
    } finally {
      setAnalyzing(false);
    }
  }, [fileName, scanType]);

  // Generate report from analysis
  const handleGenerateReport = useCallback(() => {
    if (!analysis) return;

    const reportData = {
      scanType,
      fileName,
      analysisDate: new Date().toISOString(),
      summary: analysis.summary,
      findings: analysis.findings,
      recommendations: analysis.recommendations,
      confidence: analysis.confidence,
    };

    onGenerateReport?.(reportData);
  }, [analysis, fileName, scanType, onGenerateReport]);

  // Export findings
  const exportFindings = useCallback(() => {
    if (!analysis) return;

    const dataStr = JSON.stringify(analysis, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ai-analysis-${fileName}.json`;
    link.click();
    URL.revokeObjectURL(url);

    toast.success('Analysis exported');
  }, [analysis, fileName]);

  return (
    <div className="w-80 bg-gray-900 border-l border-gray-700 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-amber-500" />
          <span className="font-medium text-white">AI Analysis</span>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        {!analysis ? (
          <div className="p-4">
            <Card className="bg-gray-800 border-gray-700">
              <CardContent className="pt-6 pb-4 text-center">
                <Scan className="h-12 w-12 mx-auto mb-4 text-gray-500" />
                <h3 className="text-lg font-medium text-white mb-2">
                  Analyze {scanType === 'ios' ? '3D Scan' : 'DICOM'}
                </h3>
                <p className="text-sm text-gray-400 mb-4">
                  Use AI to detect dental problems, analyze bone structure,
                  and generate clinical insights automatically.
                </p>
                <Button
                  onClick={analyzeScan}
                  disabled={analyzing}
                  className="w-full bg-amber-500 hover:bg-amber-600 text-black"
                >
                  {analyzing ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Analyzing...
                    </>
                  ) : (
                    <>
                      <Brain className="h-4 w-4 mr-2" />
                      Start AI Analysis
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>

            <div className="mt-4 space-y-2">
              <p className="text-xs text-gray-500 uppercase font-semibold">What AI Detects:</p>
              {scanType === 'ios' ? (
                <>
                  <FeatureItem icon={Camera} text="Tooth alignment & occlusion" />
                  <FeatureItem icon={AlertCircle} text="Caries & decay detection" />
                  <FeatureItem icon={Scan} text="Missing teeth & gaps" />
                  <FeatureItem icon={Stethoscope} text="Gum recession analysis" />
                </>
              ) : (
                <>
                  <FeatureItem icon={Scan} text="Bone density assessment" />
                  <FeatureItem icon={AlertCircle} text="Impacted teeth detection" />
                  <FeatureItem icon={Stethoscope} text="Pathology identification" />
                  <FeatureItem icon={Camera} text="Sinus & nerve proximity" />
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {/* Summary */}
            <Card className="bg-gray-800 border-gray-700">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-gray-300">Analysis Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-white">{analysis.summary}</p>
                <div className="flex items-center gap-2 mt-3">
                  <Badge variant="outline" className="text-xs">
                    Confidence: {analysis.confidence}%
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    {analysis.findings.length} Findings
                  </Badge>
                </div>
              </CardContent>
            </Card>

            {/* Findings */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium text-white">Findings</h4>
                <Badge
                  variant="outline"
                  className={`text-xs ${getSeverityColor(analysis.overallSeverity)}`}
                >
                  {analysis.overallSeverity.toUpperCase()}
                </Badge>
              </div>

              <div className="space-y-2">
                {analysis.findings.map((finding, index) => (
                  <FindingCard
                    key={index}
                    finding={finding}
                    selected={selectedFinding?.id === finding.id}
                    onClick={() => setSelectedFinding(finding)}
                  />
                ))}
              </div>
            </div>

            {/* Selected Finding Detail */}
            {selectedFinding && (
              <Card className="bg-gray-800 border-gray-700">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm text-white">{selectedFinding.title}</CardTitle>
                    <SeverityBadge severity={selectedFinding.severity} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-sm text-gray-300">{selectedFinding.description}</p>
                  {selectedFinding.location && (
                    <p className="text-xs text-gray-500">
                      Location: {selectedFinding.location}
                    </p>
                  )}
                  {selectedFinding.measurements && (
                    <p className="text-xs text-gray-500">
                      Measurements: {selectedFinding.measurements}
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Recommendations */}
            {analysis.recommendations?.length > 0 && (
              <Card className="bg-gray-800 border-gray-700">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-gray-300">Recommendations</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {analysis.recommendations.map((rec, index) => (
                      <li key={index} className="flex items-start gap-2 text-sm">
                        <ChevronRight className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                        <span className="text-gray-300">{rec}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Actions */}
            <Separator className="bg-gray-700" />
            <div className="space-y-2">
              <Button
                onClick={handleGenerateReport}
                className="w-full bg-amber-500 hover:bg-amber-600 text-black"
              >
                <FileText className="h-4 w-4 mr-2" />
                Generate Clinical Report
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={exportFindings}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Export
                </Button>
                <Button
                  variant="outline"
                  onClick={analyzeScan}
                  disabled={analyzing}
                >
                  <Scan className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// Helper Components
function FeatureItem({ icon: Icon, text }) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-400">
      <Icon className="h-4 w-4 text-amber-500" />
      <span>{text}</span>
    </div>
  );
}

function FindingCard({ finding, selected, onClick }) {
  const Icon = SEVERITY_ICONS[finding.severity] || CheckCircle;

  return (
    <div
      onClick={onClick}
      className={`p-3 rounded-lg cursor-pointer transition-colors ${
        selected
          ? 'bg-amber-500/20 border border-amber-500/50'
          : 'bg-gray-800 border border-gray-700 hover:border-gray-600'
      }`}
    >
      <div className="flex items-start gap-2">
        <Icon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${
          finding.severity === 'critical' || finding.severity === 'high'
            ? 'text-red-400'
            : 'text-amber-500'
        }`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">{finding.title}</p>
          <p className="text-xs text-gray-500 truncate">{finding.location}</p>
        </div>
        <SeverityBadge severity={finding.severity} compact />
      </div>
    </div>
  );
}

function SeverityBadge({ severity, compact }) {
  const colors = SEVERITY_COLORS[severity] || SEVERITY_COLORS.info;
  return (
    <Badge variant="outline" className={`text-xs ${colors} ${compact ? 'px-1.5 py-0' : ''}`}>
      {compact ? severity[0].toUpperCase() : severity}
    </Badge>
  );
}

function getSeverityColor(severity) {
  const colors = {
    critical: 'bg-red-500/20 text-red-400',
    high: 'bg-orange-500/20 text-orange-400',
    medium: 'bg-yellow-500/20 text-yellow-400',
    low: 'bg-blue-500/20 text-blue-400',
    normal: 'bg-green-500/20 text-green-400',
  };
  return colors[severity] || colors.normal;
}

// Mock Analysis Generators
function generateIOSAnalysis(fileName) {
  return {
    summary: `Analysis of ${fileName} reveals moderate dental concerns requiring attention. Upper arch shows signs of crowding in anterior region with Class I occlusion. Lower arch presents with missing tooth #36 and evidence of bone resorption in the edentulous area.`,
    confidence: 87,
    overallSeverity: 'medium',
    findings: [
      {
        id: 1,
        title: 'Missing Tooth #36',
        description: 'Tooth #36 (lower left first molar) is missing with evidence of bone resorption in the socket area. Adjacent teeth show slight tilting.',
        location: 'Lower Left Quadrant',
        severity: 'high',
        measurements: 'Bone height: 8.2mm',
      },
      {
        id: 2,
        title: 'Anterior Crowding',
        description: 'Upper anterior teeth show moderate crowding with 3-4mm arch length discrepancy. Rotation noted on tooth #11.',
        location: 'Upper Anterior',
        severity: 'medium',
      },
      {
        id: 3,
        title: 'Caries Risk',
        description: 'Deep occlusal fissures on molars with staining suggestive of early caries. Recommend sealants or preventive resin restoration.',
        location: 'Upper Molars #16, #26',
        severity: 'medium',
      },
      {
        id: 4,
        title: 'Gingival Recession',
        description: 'Mild recession noted on buccal surfaces of canines, approximately 1-2mm. No sensitivity reported.',
        location: 'Upper Canines #13, #23',
        severity: 'low',
      },
      {
        id: 5,
        title: 'Class I Occlusion',
        description: 'Normal molar and canine relationships maintained. Slight overjet of 3mm within normal range.',
        location: 'Full Arch',
        severity: 'info',
      },
    ],
    recommendations: [
      'Consider implant placement for missing #36 to prevent further bone loss and restore function',
      'Orthodontic evaluation for anterior crowding - possible Invisalign or fixed braces',
      'Place preventive sealants on molars to reduce caries risk',
      'Monitor gingival recession with periodic charting - consider graft if progression',
      'Routine prophylaxis and oral hygiene reinforcement',
    ],
  };
}

function generateDICOMAnalysis(fileName) {
  return {
    summary: `CT scan analysis shows adequate bone density for implant planning. No significant pathology detected in maxillary sinuses. Mandibular canal is well-visualized with adequate safety margins for posterior implant placement.`,
    confidence: 92,
    overallSeverity: 'low',
    findings: [
      {
        id: 1,
        title: 'Adequate Bone Density',
        description: 'Cortical bone shows good density (HU: 850-1200) suitable for immediate implant placement. Trabecular bone pattern is normal.',
        location: 'Posterior Mandible',
        severity: 'info',
        measurements: 'Height: 12.4mm, Width: 6.8mm',
      },
      {
        id: 2,
        title: 'Mandibular Canal Visualized',
        description: 'Inferior alveolar nerve canal clearly visible with adequate bone height above (7.2mm). Safe for 10mm implant placement.',
        location: 'Left Posterior Mandible',
        severity: 'info',
        measurements: 'Canal diameter: 3.1mm',
      },
      {
        id: 3,
        title: 'Maxillary Sinus Clear',
        description: 'No mucosal thickening or fluid levels observed. Adequate sinus height for potential sinus lift if needed.',
        location: 'Bilateral Maxillary Sinuses',
        severity: 'info',
      },
      {
        id: 4,
        title: 'Root Fragments',
        description: 'Small residual root fragment detected in area of previous extraction #36. Recommend removal before implant placement.',
        location: 'Lower Left #36 Site',
        severity: 'medium',
      },
      {
        id: 5,
        title: 'TMJ Assessment',
        description: 'Condylar heads appear normal in shape and position. Joint spaces are symmetrical. No degenerative changes observed.',
        location: 'Bilateral TMJ',
        severity: 'info',
      },
    ],
    recommendations: [
      'Excellent candidate for immediate implant placement in posterior mandible',
      'Remove root fragment at #36 site prior to implant surgery',
      'Consider 10mm x 4.5mm implant for #36 with good primary stability expected',
      'No sinus lift required - adequate native bone height',
      'Routine post-operative CBCT recommended to verify implant position',
    ],
  };
}
