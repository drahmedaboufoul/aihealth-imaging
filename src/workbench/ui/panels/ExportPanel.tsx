import { useState } from 'react';
import { Download, Image as ImageIcon, FileJson } from 'lucide-react';
import { useWorkbench, activeVersion, type Slot } from '../store';
import { exportMeasurements, exportMesh } from '../actions';
import { exportPng } from '../pngExport';
import { Btn, Field, Section, SlotSelect } from '../kit';
import { imageExportName, measurementsExportName, meshExportName } from '../../core/naming';

export function ExportPanel() {
  const scans = useWorkbench((s) => s.scans);
  const measurements = useWorkbench((s) => s.measurements);
  const first = (Object.keys(scans) as Slot[]).find((k) => scans[k]?.status === 'ready') ?? 'A';
  const [slot, setSlot] = useState<Slot>(first);
  const v = activeVersion(scans[slot]);
  return (
    <div data-testid="export-panel">
      <Section title="Mesh (current version)">
        <Field label="Scan"><SlotSelect value={slot} onChange={setSlot} testId="export-slot" /></Field>
        {v && <p className="text-[11px] text-gray-500 mb-1.5">Exports {v.id} ({v.op}). File names carry only the date, scan letter and version.</p>}
        <div className="flex gap-1.5">
          <Btn variant="primary" disabled={!v} onClick={() => v && void exportMesh(slot, v.id, 'stl')} testId="export-stl"><Download className="w-3.5 h-3.5" /> STL (binary)</Btn>
          <Btn disabled={!v} onClick={() => v && void exportMesh(slot, v.id, 'ply')} testId="export-ply"><Download className="w-3.5 h-3.5" /> PLY</Btn>
        </div>
        {v && <p className="text-[10px] text-gray-500 mt-1 font-mono">{meshExportName(slot, v.index, 'stl')}</p>}
      </Section>
      <Section title="Image">
        <Btn onClick={exportPng} testId="export-png"><ImageIcon className="w-3.5 h-3.5" /> PNG with scale bar and legend</Btn>
        <p className="text-[10px] text-gray-500 mt-1 font-mono">{imageExportName('view')}</p>
      </Section>
      <Section title="Measurements">
        <Btn onClick={exportMeasurements} disabled={measurements.length === 0} testId="export-measurements"><FileJson className="w-3.5 h-3.5" /> JSON ({measurements.length})</Btn>
        <p className="text-[10px] text-gray-500 mt-1 font-mono">{measurementsExportName()}</p>
      </Section>
      <p className="text-[10px] text-gray-500">Exports are generated in this browser and saved by your browser. Nothing is uploaded. The original scan is never overwritten.</p>
    </div>
  );
}
