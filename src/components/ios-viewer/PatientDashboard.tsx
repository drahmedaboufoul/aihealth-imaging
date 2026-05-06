import { useState, useMemo } from 'react';
import type { Patient, Scan, ScanType } from '@/types';
import { patients, getPatientScans, getScanTypeColor } from '@/data/mockData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Search,
  Plus,
  Calendar,
  Edit2,
  Trash2,
  Grid3X3,
  List,
  UploadCloud,
  Cpu,
  Box,
  Crown,
  Layers,
  ScanFace,
  MoreHorizontal
} from 'lucide-react';

interface PatientDashboardProps {
  patients: Patient[];
  selectedPatient: Patient | null;
  onSelectPatient: (patient: Patient) => void;
  onOpenViewer: (scan: Scan) => void;
}

const scanTypes: (ScanType | 'All')[] = ['All', 'IOS', 'CT', 'Face Scan', 'Panoramic', 'Cephalometric', 'CR'];

export function PatientDashboard({
  selectedPatient,
  onSelectPatient,
  onOpenViewer
}: PatientDashboardProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedScanType, setSelectedScanType] = useState<ScanType | 'All'>('All');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [activeTab, setActiveTab] = useState('data');

  const filteredPatients = useMemo(() => {
    return patients.filter(p =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.id.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery]);

  const patientScans = useMemo(() => {
    if (!selectedPatient) return [];
    const scans = getPatientScans(selectedPatient.id);
    if (selectedScanType === 'All') return scans;
    return scans.filter(s => s.type === selectedScanType);
  }, [selectedPatient, selectedScanType]);

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };

  return (
    <div className="flex h-full bg-white">
      {/* Left Sidebar - Patient List */}
      <div className="w-72 border-r border-gray-200 flex flex-col bg-white">
        {/* Header */}
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">D</span>
            </div>
            <h1 className="font-semibold text-gray-800">Dental X</h1>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder="Search patient..."
              className="pl-9 h-9 text-sm"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Patient List */}
        <ScrollArea className="flex-1">
          <div className="p-2">
            {filteredPatients.map((patient) => (
              <div
                key={patient.id}
                onClick={() => onSelectPatient(patient)}
                className={`p-3 rounded-lg cursor-pointer transition-colors mb-1 ${
                  selectedPatient?.id === patient.id
                    ? 'bg-blue-50 border border-blue-200'
                    : 'hover:bg-gray-50 border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Avatar className="w-10 h-10">
                      <AvatarFallback className="bg-gray-200 text-gray-600 text-sm">
                        {getInitials(patient.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full border-2 border-white flex items-center justify-center ${
                      patient.gender === 'male' ? 'bg-blue-500' : 'bg-pink-500'
                    }`}>
                      {patient.gender === 'male' ? (
                        <span className="text-white text-[8px]">M</span>
                      ) : (
                        <span className="text-white text-[8px]">F</span>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-gray-900 truncate">{patient.name}</p>
                    <p className="text-xs text-gray-500">{patient.id} · {patient.age}y · {patient.gender === 'male' ? 'M' : 'F'}</p>
                  </div>
                  <div className="flex gap-1">
                    <button className="p-1 hover:bg-gray-200 rounded">
                      <Edit2 className="w-3.5 h-3.5 text-gray-400" />
                    </button>
                    <button className="p-1 hover:bg-gray-200 rounded">
                      <Trash2 className="w-3.5 h-3.5 text-gray-400" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header */}
        <div className="h-16 border-b border-gray-200 flex items-center justify-between px-6 bg-white">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-gray-800">Patient Management</h2>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="Patient name / ID / Case"
                className="pl-9 w-64 h-9 text-sm"
              />
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 border rounded-md text-sm text-gray-600 bg-white">
              <Calendar className="w-4 h-4" />
              <span>2026/01/01 - 2026/02/03</span>
            </div>
            <Button className="bg-blue-600 hover:bg-blue-700 h-9">
              <Plus className="w-4 h-4 mr-1" />
              Add Patient
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-6 pt-4">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="bg-gray-100">
              <TabsTrigger value="data" className="data-[state=active]:bg-white">Data List</TabsTrigger>
              <TabsTrigger value="order" className="data-[state=active]:bg-white">Order List</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Scan Type Filters */}
        <div className="px-6 py-3 flex items-center gap-2">
          {scanTypes.map((type) => (
            <button
              key={type}
              onClick={() => setSelectedScanType(type)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                selectedScanType === type
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {type}
            </button>
          ))}
          <div className="flex-1" />
          <div className="flex gap-1">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-2 rounded ${viewMode === 'grid' ? 'bg-gray-200' : 'hover:bg-gray-100'}`}
            >
              <Grid3X3 className="w-4 h-4 text-gray-600" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-2 rounded ${viewMode === 'list' ? 'bg-gray-200' : 'hover:bg-gray-100'}`}
            >
              <List className="w-4 h-4 text-gray-600" />
            </button>
          </div>
        </div>

        {/* Scan Grid */}
        <ScrollArea className="flex-1 px-6 pb-6">
          {viewMode === 'grid' ? (
            <div className="grid grid-cols-4 gap-4">
              {patientScans.map((scan) => (
                <div
                  key={scan.id}
                  onClick={() => scan.hasModel && onOpenViewer(scan)}
                  className={`bg-white border border-gray-200 rounded-xl overflow-hidden hover:shadow-md transition-shadow ${
                    scan.hasModel ? 'cursor-pointer' : 'cursor-default'
                  }`}
                >
                  <div className="aspect-[4/3] bg-gray-100 flex items-center justify-center relative">
                    <div className="w-16 h-16 bg-gray-200 rounded-lg flex items-center justify-center">
                      <ScanFace className="w-8 h-8 text-gray-400" />
                    </div>
                    <Badge className={`absolute top-2 left-2 ${getScanTypeColor(scan.type)} text-white text-xs`}>
                      {scan.type}
                    </Badge>
                  </div>
                  <div className="p-3">
                    <p className="font-medium text-sm text-gray-800 truncate">{scan.name}</p>
                    <p className="text-xs text-gray-500 mt-1">{scan.createdAt}</p>
                  </div>
                </div>
              ))}
              {/* Upload Card */}
              <div className="bg-gray-50 border-2 border-dashed border-gray-300 rounded-xl flex flex-col items-center justify-center aspect-[4/3] cursor-pointer hover:bg-gray-100 transition-colors">
                <UploadCloud className="w-10 h-10 text-gray-400 mb-2" />
                <p className="text-sm text-gray-500">Upload Scan</p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {patientScans.map((scan) => (
                <div
                  key={scan.id}
                  onClick={() => scan.hasModel && onOpenViewer(scan)}
                  className={`flex items-center p-3 bg-white border border-gray-200 rounded-lg hover:shadow-sm transition-shadow ${
                    scan.hasModel ? 'cursor-pointer' : 'cursor-default'
                  }`}
                >
                  <div className="w-12 h-12 bg-gray-100 rounded-lg flex items-center justify-center mr-4">
                    <ScanFace className="w-6 h-6 text-gray-400" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-sm text-gray-800">{scan.name}</p>
                    <p className="text-xs text-gray-500">{scan.createdAt}</p>
                  </div>
                  <Badge className={`${getScanTypeColor(scan.type)} text-white text-xs`}>
                    {scan.type}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Right Sidebar - Digital Applications */}
      <div className="w-20 border-l border-gray-200 bg-white flex flex-col items-center py-4">
        <p className="text-[10px] text-gray-500 font-medium mb-3 text-center leading-tight">Digital<br/>Application</p>

        <div className="space-y-3">
          <button className="w-12 h-12 bg-blue-50 rounded-xl flex flex-col items-center justify-center hover:bg-blue-100 transition-colors group">
            <Cpu className="w-5 h-5 text-blue-600 group-hover:scale-110 transition-transform" />
            <span className="text-[8px] text-blue-600 mt-0.5">AI Implant</span>
          </button>

          <button className="w-12 h-12 bg-green-50 rounded-xl flex flex-col items-center justify-center hover:bg-green-100 transition-colors group">
            <Box className="w-5 h-5 text-green-600 group-hover:scale-110 transition-transform" />
            <span className="text-[8px] text-green-600 mt-0.5">AI Model</span>
          </button>

          <button className="w-12 h-12 bg-purple-50 rounded-xl flex flex-col items-center justify-center hover:bg-purple-100 transition-colors group">
            <Crown className="w-5 h-5 text-purple-600 group-hover:scale-110 transition-transform" />
            <span className="text-[8px] text-purple-600 mt-0.5">AI Crown</span>
          </button>

          <button className="w-12 h-12 bg-orange-50 rounded-xl flex flex-col items-center justify-center hover:bg-orange-100 transition-colors group">
            <Layers className="w-5 h-5 text-orange-600 group-hover:scale-110 transition-transform" />
            <span className="text-[8px] text-orange-600 mt-0.5">Multi-D</span>
          </button>

          <button className="w-12 h-12 bg-pink-50 rounded-xl flex flex-col items-center justify-center hover:bg-pink-100 transition-colors group">
            <ScanFace className="w-5 h-5 text-pink-600 group-hover:scale-110 transition-transform" />
            <span className="text-[8px] text-pink-600 mt-0.5">3D DSD</span>
          </button>
        </div>

        <div className="flex-1" />

        <button className="w-10 h-10 hover:bg-gray-100 rounded-lg flex items-center justify-center">
          <MoreHorizontal className="w-5 h-5 text-gray-400" />
        </button>
      </div>
    </div>
  );
}
