import { useRef } from 'react';
import { Trash2, Download, Upload } from 'lucide-react';
import { useWorkbench, measurementKindLabel, type MeasureMode } from '../store';
import { exportMeasurements, importMeasurements } from '../actions';
import { Btn, Section } from '../kit';
import { formatValue } from '../../core/measurements';

const MODES: Array<[MeasureMode, string, string]> = [
  ['distance', 'Distance', 'Click two points'],
  ['angle', 'Angle', 'Click three points; the vertex second'],
  ['surface-path', 'Surface', 'Click two points on the same scan: shortest path over the surface'],
  ['area', 'Area', 'Draw a lasso around a region of one scan'],
];

export function MeasurePanel() {
  const mode = useWorkbench((s) => s.measureMode);
  const measurements = useWorkbench((s) => s.measurements);
  const scans = useWorkbench((s) => s.scans);
  const pending = useWorkbench((s) => s.pending);
  const set = useWorkbench((s) => s.set);
  const remove = useWorkbench((s) => s.removeMeasurement);
  const fileRef = useRef<HTMLInputElement>(null);
  const hint = MODES.find((m) => m[0] === mode)?.[2];
  return (
    <div data-testid="measure-panel">
      <Section title="Measure">
        <div className="grid grid-cols-4 gap-1">
          {MODES.map(([m, label]) => (
            <button key={m} type="button" data-testid={`measure-mode-${m}`}
              onClick={() => set({ measureMode: m, pending: [], lasso: m === 'area' ? { purpose: 'area', points: [], pane: 'left' } : null })}
              className={`text-[11px] font-medium py-1.5 rounded ${mode === m ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
              {label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-gray-500 mt-1.5">{hint}{pending.length ? ` · ${pending.length} point(s) picked` : ''}. Esc clears.</p>
        {mode === 'area' && (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-600">
            <span>Draw another lasso in</span>
            {(['left', 'right'] as const).map((p) => (
              <button key={p} type="button" onClick={() => set({ lasso: { purpose: 'area', points: [], pane: p } })}
                className="px-1.5 py-0.5 rounded bg-gray-100 hover:bg-gray-200">{p} pane</button>
            ))}
          </div>
        )}
      </Section>
      <Section title={`Measurements (${measurements.length})`} right={
        <span className="flex gap-1">
          <Btn variant="ghost" onClick={() => fileRef.current?.click()} title="Import measurements JSON" testId="measure-import"><Upload className="w-3.5 h-3.5" /></Btn>
          <Btn variant="ghost" onClick={exportMeasurements} disabled={measurements.length === 0} title="Export measurements-YYYY-MM-DD.json" testId="measure-export"><Download className="w-3.5 h-3.5" /></Btn>
        </span>
      }>
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-testid="measure-import-input"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importMeasurements(f); e.target.value = ''; }} />
        {measurements.length === 0 && <p className="text-[11px] text-gray-500">No measurements yet.</p>}
        <ul className="space-y-1" data-testid="measurement-list">
          {measurements.map((m) => {
            const sc = scans[m.slot as keyof typeof scans];
            const shown = sc?.versions.find((v) => v.id === sc.activeVersionId)?.outputSha256 === m.versionSha256;
            return (
              <li key={m.id} className="flex items-center gap-2 text-xs rounded border border-gray-200 px-2 py-1" data-testid="measurement-item">
                <span className="text-gray-500 w-20 shrink-0">{measurementKindLabel(m.kind)}</span>
                <span className="font-mono font-semibold text-gray-800 flex-1">{formatValue(m)}</span>
                <span className="text-[10px] text-gray-500" title={shown ? 'Shown on the active version' : 'Measured on another version of this scan'}>{m.versionId || `Scan ${m.slot}`}{shown ? '' : ' *'}</span>
                <button type="button" onClick={() => remove(m.id)} className="text-gray-400 hover:text-red-600" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
              </li>
            );
          })}
        </ul>
        <p className="text-[10px] text-gray-500 mt-1.5">Kept for this session. Export/import as JSON; points are stored in each scan&apos;s own frame and tied to the version&apos;s SHA-256.</p>
      </Section>
    </div>
  );
}
