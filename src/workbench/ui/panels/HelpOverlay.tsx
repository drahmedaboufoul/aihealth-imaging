import { X } from 'lucide-react';
import { useWorkbench } from '../store';

export const SHORTCUTS: Array<[string, string]> = [
  ['O', 'Open scan files'],
  ['1 / 2 / 3', 'Single view / side by side / overlay'],
  ['L', 'Link or unlink the two panes’ cameras'],
  ['A', 'Align two scans (landmarks + ICP)'],
  ['D', 'Deviation map'],
  ['C', 'Occlusal contacts'],
  ['M', 'Measure'],
  ['S', 'Cross-section'],
  ['E', 'Edit (trim, fill, decimate, smooth)'],
  ['V', 'Versions'],
  ['X', 'Export'],
  ['F', 'Fit the view'],
  ['Ctrl+Z', 'Undo the last alignment step'],
  ['Esc', 'Cancel picking / lasso, close the tool'],
  ['?', 'This help'],
];

export function HelpOverlay() {
  const show = useWorkbench((s) => s.showHelp);
  const set = useWorkbench((s) => s.set);
  if (!show) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => set({ showHelp: false })}>
      <div className="bg-white rounded-xl shadow-2xl p-5 w-[420px] max-w-[92vw]" onClick={(e) => e.stopPropagation()} data-testid="help-overlay">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-800">Keyboard and mouse</h3>
          <button type="button" onClick={() => set({ showHelp: false })} className="text-gray-400 hover:text-gray-700"><X className="w-4 h-4" /></button>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {SHORTCUTS.map(([k, d]) => (
              <tr key={k} className="border-b border-gray-100 last:border-0">
                <td className="py-1 pr-3"><kbd className="px-1.5 py-0.5 rounded bg-gray-100 border border-gray-200 text-xs font-mono">{k}</kbd></td>
                <td className="py-1 text-gray-700">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-gray-500 mt-3">Mouse: right-drag rotates, middle-drag pans, wheel zooms. Left-click picks points when a tool needs them; otherwise left-drag rotates.</p>
      </div>
    </div>
  );
}
