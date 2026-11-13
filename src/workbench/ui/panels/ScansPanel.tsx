import { Eye, EyeOff, Trash2, Loader2, AlertCircle } from 'lucide-react';
import { useWorkbench, SLOTS, activeVersion, type Slot, type Role } from '../store';
import { removeScan, setRole } from '../actions';
import { Section, SlotSelect } from '../kit';

export function ScansPanel() {
  const scans = useWorkbench((s) => s.scans);
  const layout = useWorkbench((s) => s.layout);
  const panes = useWorkbench((s) => s.panes);
  const patchScan = useWorkbench((s) => s.patchScan);
  const set = useWorkbench((s) => s.set);
  const present = SLOTS.filter((s) => scans[s]);
  if (present.length === 0) return null;
  return (
    <Section title="Scans" testId="scans-panel">
      <div className="space-y-2">
        {present.map((slot) => {
          const sc = scans[slot]!;
          const v = activeVersion(sc);
          return (
            <div key={slot} className="rounded-md border border-gray-200 p-2" data-testid={`scan-row-${slot}`}>
              <div className="flex items-center gap-2">
                <input type="color" value={sc.color} onChange={(e) => patchScan(slot, { color: e.target.value })}
                  title="Overlay colour" className="w-5 h-5 rounded border-0 p-0 bg-transparent cursor-pointer" />
                <span className="text-sm font-semibold text-gray-800">Scan {slot}</span>
                <span className="text-[11px] text-gray-500 truncate flex-1" title={`${sc.sourceName} (local file name, never exported)`}>{sc.sourceName}</span>
                {sc.status === 'ready' && (
                  <button type="button" onClick={() => patchScan(slot, { visible: !sc.visible })} title={sc.visible ? 'Hide' : 'Show'} className="text-gray-500 hover:text-gray-800">
                    {sc.visible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </button>
                )}
                <button type="button" onClick={() => removeScan(slot)} title="Close this scan" className="text-gray-400 hover:text-red-600">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {sc.status === 'loading' && (
                <div className="mt-1.5 flex items-center gap-2 text-[11px] text-gray-500">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> {sc.stage} {Math.round(sc.progress * 100)}%
                </div>
              )}
              {sc.status === 'error' && (
                <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-red-600"><AlertCircle className="w-3.5 h-3.5" />{sc.error}</div>
              )}
              {sc.status === 'ready' && (
                <>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-gray-500" data-testid={`scan-status-${slot}`}>
                    <span>{v?.id} · {v?.triangles.toLocaleString('en-GB')} triangles{sc.hasTexture ? ' · texture' : sc.hasColors ? ' · vertex colour' : ''}</span>
                    <span className="text-emerald-700 font-medium">ready</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-[11px] text-gray-500 w-12">Opacity</span>
                    <input type="range" min={0.1} max={1} step={0.05} value={sc.opacity} data-testid={`opacity-${slot}`}
                      onChange={(e) => patchScan(slot, { opacity: Number(e.target.value) })} className="flex-1 accent-blue-600" />
                    <span className="text-[11px] font-mono w-8 text-right">{Math.round(sc.opacity * 100)}%</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[11px] text-gray-500 w-12">Role</span>
                    <select value={sc.role} onChange={(e) => setRole(slot, e.target.value as Role)} data-testid={`role-${slot}`}
                      className="rounded border border-gray-200 bg-white px-1 py-0.5 text-[11px]">
                      <option value="unknown">Not set</option>
                      <option value="upper">Upper arch</option>
                      <option value="lower">Lower arch</option>
                    </select>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {layout === 'side' && present.length > 1 && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-600">
          <span>Left</span>
          <SlotSelect value={panes.left[0]} onChange={(s: Slot) => set({ panes: { ...panes, left: [s] } })} testId="pane-left-slot" />
          <span>Right</span>
          <SlotSelect value={panes.right[0]} onChange={(s: Slot) => set({ panes: { ...panes, right: [s] } })} testId="pane-right-slot" />
        </div>
      )}
    </Section>
  );
}
