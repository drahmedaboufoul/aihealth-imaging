import type { Patient, Scan } from '@/types';

export const patients: Patient[] = [
  { id: 'P001', name: 'John Smith', gender: 'male', age: 45 },
  { id: 'P002', name: 'Sarah Johnson', gender: 'female', age: 32 },
  { id: 'P003', name: 'Michael Brown', gender: 'male', age: 28 },
  { id: 'P004', name: 'Emily Davis', gender: 'female', age: 56 },
  { id: 'P005', name: 'Robert Wilson', gender: 'male', age: 41 },
  { id: 'P006', name: 'Lisa Anderson', gender: 'female', age: 34 },
  { id: 'P007', name: 'David Martinez', gender: 'male', age: 52 },
  { id: 'P008', name: 'Jennifer Taylor', gender: 'female', age: 29 },
];

export const scans: Scan[] = [
  // Patient P001 - John Smith
  { id: 'S001', patientId: 'P001', type: 'IOS', name: 'Full Arch Upper', createdAt: '2026-02-01 09:30', hasModel: true },
  { id: 'S002', patientId: 'P001', type: 'IOS', name: 'Full Arch Lower', createdAt: '2026-02-01 09:45', hasModel: true },
  { id: 'S003', patientId: 'P001', type: 'CT', name: 'CBCT Scan', createdAt: '2026-02-01 10:15', hasModel: true },
  { id: 'S004', patientId: 'P001', type: 'Face Scan', name: 'Facial Scan', createdAt: '2026-02-01 11:00', hasModel: false },

  // Patient P002 - Sarah Johnson
  { id: 'S005', patientId: 'P002', type: 'IOS', name: 'Upper Quadrant', createdAt: '2026-01-28 14:20', hasModel: true },
  { id: 'S006', patientId: 'P002', type: 'Panoramic', name: 'Panoramic X-Ray', createdAt: '2026-01-28 14:45', hasModel: false },

  // Patient P003 - Michael Brown
  { id: 'S007', patientId: 'P003', type: 'CT', name: 'Implant Planning CT', createdAt: '2026-01-25 16:00', hasModel: true },
  { id: 'S008', patientId: 'P003', type: 'IOS', name: 'Pre-op Scan', createdAt: '2026-01-25 16:30', hasModel: true },

  // Patient P004 - Emily Davis
  { id: 'S009', patientId: 'P004', type: 'Cephalometric', name: 'Ceph Analysis', createdAt: '2026-01-22 11:15', hasModel: false },
  { id: 'S010', patientId: 'P004', type: 'IOS', name: 'Orthodontic Records', createdAt: '2026-01-22 11:45', hasModel: true },

  // Patient P005 - Robert Wilson
  { id: 'S011', patientId: 'P005', type: 'IOS', name: 'Crown Prep Upper', createdAt: '2026-01-20 09:00', hasModel: true },
  { id: 'S012', patientId: 'P005', type: 'IOS', name: 'Crown Prep Lower', createdAt: '2026-01-20 09:20', hasModel: true },
  { id: 'S013', patientId: 'P005', type: 'CR', name: 'Bite Registration', createdAt: '2026-01-20 09:45', hasModel: false },
];

export const getPatientScans = (patientId: string): Scan[] => {
  return scans.filter(scan => scan.patientId === patientId);
};

export const getScanTypeColor = (type: string): string => {
  const colors: Record<string, string> = {
    'IOS': 'bg-emerald-500',
    'CT': 'bg-blue-500',
    'Face Scan': 'bg-purple-500',
    'Panoramic': 'bg-orange-500',
    'Cephalometric': 'bg-pink-500',
    'CR': 'bg-cyan-500',
  };
  return colors[type] || 'bg-gray-500';
};

export const getScanTypeTextColor = (type: string): string => {
  const colors: Record<string, string> = {
    'IOS': 'text-emerald-600',
    'CT': 'text-blue-600',
    'Face Scan': 'text-purple-600',
    'Panoramic': 'text-orange-600',
    'Cephalometric': 'text-pink-600',
    'CR': 'text-cyan-600',
  };
  return colors[type] || 'text-gray-600';
};
