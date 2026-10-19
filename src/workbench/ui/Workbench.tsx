/*
 * IOS workbench v1 — side-by-side / overlay intraoral scan analysis in the
 * browser: alignment (landmarks + ICP), deviation map, occlusal contacts,
 * measurements, cross-sections, versioned edits and neutral exports.
 *
 * Patient scans never leave the browser: local files are read with the
 * File API, study files come from the clinic's own signed URLs (same as
 * the main IOS viewer), and all geometry runs in a same-origin worker.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, FolderOpen, HelpCircle, Link2, Link2Off, GitCompare, Activity, CircleDot, Ruler, Slice, Wrench, History, Download, Loader2, X,
} from 'lucide-react';
import { useWorkbench, SLOTS, readyScans, type Tool, type Layout, type Slot } from './store';
import { Pane } from './Pane';
import { loadFiles, pairLocalFiles, resetWorkbench, undoAlignment, type IncomingFile } from './actions';
import { lassoSpecFor } from './picking';
import { getEngine, resetEngine } from './sceneRegistry';
import { ScansPanel } from './panels/ScansPanel';
import { AlignPanel } from './panels/AlignPanel';
import { DeviationPanel } from './panels/DeviationPanel';
import { ContactPanel } from './panels/ContactPanel';
import { MeasurePanel } from './panels/MeasurePanel';
import { SectionPanel } from './panels/SectionPanel';
import { EditPanel } from './panels/EditPanel';
import { VersionsPanel } from './panels/VersionsPanel';
import { ExportPanel } from './panels/ExportPanel';
import { HelpOverlay } from './panels/HelpOverlay';
import { activeVersion } from './store';
import { nextMeasurementId } from './actions';

const TOOLS: Array<{ id: Tool; label: string; key: string; icon: typeof Ruler }> = [
  { id: 'align', label: 'Align scans', key: 'A', icon: GitCompare },
  { id: 'deviation', label: 'Deviation map', key: 'D', icon: Activity },
  { id: 'contact', label: 'Occlusal contacts', key: 'C', icon: CircleDot },
  { id: 'measure', label: 'Measure', key: 'M', icon: Ruler },
  { id: 'section', label: 'Cross-section', key: 'S', icon: Slice },
  { id: 'edit', label: 'Edit', key: 'E', icon: Wrench },
  { id: 'versions', label: 'Versions', key: 'V', icon: History },
  { id: 'export', label: 'Export', key: 'X', icon: Download },
];

const LAYOUTS: Array<{ id: Layout; label: string; key: string }> = [
  { id: 'single', label: 'Single', key: '1' },
  { id: 'side', label: 'Side by side', key: '2' },
  { id: 'overlay', label: 'Overlay', key: '3' },
];

function ToolPanel({ tool }: { tool: Tool }) {
  switch (tool) {
    case 'align': return <AlignPanel />;
    case 'deviation': return <DeviationPanel />;
    case 'contact': return <ContactPanel />;
    case 'measure': return <MeasurePanel />;
    case 'section': return <SectionPanel />;
    case 'edit': return <EditPanel />;
    case 'versions': return <VersionsPanel />;
    case 'export': return <ExportPanel />;
    default: return null;
  }
}

function useLassoHandler(): void {
  useEffect(() => {
    const onLasso = async (e: Event) => {
      const { pane, points, width, height } = (e as CustomEvent<{ pane: 'left' | 'right'; points: [number, number][]; width: number; height: number }>).detail;
      const s = useWorkbench.getState();
      const lasso = s.lasso;
      if (!lasso) return;
      const paneSlots: Slot[] = s.layout === 'side' ? s.panes[pane] : SLOTS.filter((x) => s.scans[x]?.status === 'ready');
      try {
        if (lasso.purpose === 'trim') {
          const slot = s.editTarget;
          const sc = s.scans[slot];
          const spec = lassoSpecFor(pane, slot, points, width, height, s.lassoVisibleOnly);
          if (!sc || !spec || !paneSlots.includes(slot)) { s.notify('error', `Scan ${slot} is not shown in that pane.`); return; }
          const res = await getEngine().request({ kind: 'area', key: sc.activeVersionId!, lasso: spec });
          useWorkbench.getState().set({ trimPreview: { slot, versionId: sc.activeVersionId!, lasso: spec, triangles: res.triangles, area: res.area, mask: res.mask }, lasso: null });
          return;
        }
        // area measurement: the visible scan with the largest selection in that pane
        let best: { slot: Slot; area: number; triangles: number; spec: NonNullable<ReturnType<typeof lassoSpecFor>> } | null = null;
        for (const slot of paneSlots) {
          const sc = s.scans[slot];
          if (!sc?.visible) continue;
          const spec = lassoSpecFor(pane, slot, points, width, height, true);
          if (!spec) continue;
          const res = await getEngine().request({ kind: 'area', key: sc.activeVersionId!, lasso: spec });
          if (res.triangles > 0 && (!best || res.area > best.area)) best = { slot, area: res.area, triangles: res.triangles, spec };
        }
        if (!best) { useWorkbench.getState().notify('info', 'The lasso did not enclose any visible surface.'); return; }
        const v = activeVersion(useWorkbench.getState().scans[best.slot])!;
        useWorkbench.getState().addMeasurement({
          id: nextMeasurementId(), kind: 'area', slot: best.slot, versionId: v.id, versionSha256: v.outputSha256,
          points: [], value: best.area, unit: 'mm2', method: 'lasso-visible-surface', createdAt: new Date().toISOString(),
          meta: { triangles: best.triangles, lasso: best.spec },
        });
      } catch {
        useWorkbench.getState().notify('error', 'The lasso selection failed.');
      } finally {
        // one lasso per arm, so right-drag rotation works again straight away
        useWorkbench.getState().set({ lasso: null });
      }
    };
    window.addEventListener('iosw-lasso', onLasso);
    return () => window.removeEventListener('iosw-lasso', onLasso);
  }, []);
}

function useHotkeys(openPicker: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useWorkbench.getState();
      const inField = (e.target as HTMLElement)?.closest?.('input,textarea,select,[contenteditable]');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !inField) {
        e.preventDefault();
        undoAlignment();
        return;
      }
      if (e.key === 'Escape') {
        if (s.lasso || s.pending.length || s.alignment.picking || s.trimPreview) {
          s.set({ lasso: null, pending: [], trimPreview: null });
          s.patchAlignment({ picking: null });
        } else if (s.showHelp) s.set({ showHelp: false });
        else s.set({ tool: 'none' });
        return;
      }
      // Letter shortcuts work even when a button has focus; never while typing.
      if (inField || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const k = e.key;
      if (k === '?') { s.set({ showHelp: !s.showHelp }); return; }
      const layout = LAYOUTS.find((l) => l.key === k);
      if (layout) { s.set({ layout: layout.id }); s.requestFrame(); return; }
      const up = k.toUpperCase();
      if (up === 'L') { s.set({ linkCameras: !s.linkCameras }); return; }
      if (up === 'O') { openPicker(); return; }
      if (up === 'F') { window.dispatchEvent(new CustomEvent('iosw-view', { detail: { view: 'fit' } })); return; }
      const tool = TOOLS.find((t) => t.key === up);
      if (tool) {
        s.set({ tool: s.tool === tool.id ? 'none' : tool.id, pending: [], lasso: null });
        s.patchAlignment({ picking: null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPicker]);
}

function Notice() {
  const notice = useWorkbench((s) => s.notice);
  const set = useWorkbench((s) => s.set);
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => set({ notice: null }), notice.tone === 'error' ? 9000 : 6000);
    return () => clearTimeout(t);
  }, [notice, set]);
  if (!notice) return null;
  const tone = notice.tone === 'error' ? 'bg-red-600' : notice.tone === 'success' ? 'bg-emerald-600' : 'bg-gray-800';
  return (
    <div className={`fixed bottom-10 left-1/2 -translate-x-1/2 z-50 max-w-xl px-3 py-2 rounded-lg shadow-lg text-white text-xs flex items-center gap-2 ${tone}`} data-testid="notice" role="status">
      <span>{notice.text}</span>
      <button type="button" onClick={() => set({ notice: null })} className="opacity-80 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
    </div>
  );
}

function StatusBar() {
  const scans = useWorkbench((s) => s.scans);
  const busy = useWorkbench((s) => s.busy);
  const ready = readyScans({ scans });
  return (
    <div className="h-7 bg-white border-t border-gray-200 px-3 flex items-center gap-4 text-[11px] text-gray-500" data-testid="status-bar">
      {busy ? <span className="flex items-center gap-1 text-blue-700"><Loader2 className="w-3 h-3 animate-spin" />{busy}</span> : <span>Geometry runs in a background worker · files stay in this browser</span>}
      <span className="ml-auto flex gap-4">
        {ready.map((sc) => sc.loadStats && (
          <span key={sc.slot} data-testid={`load-stats-${sc.slot}`} data-load-stats={JSON.stringify(sc.loadStats)}
            title={`File read ${Math.round(sc.loadStats.fileReadMs ?? 0)} ms · source hash ${Math.round(sc.loadStats.sourceHashMs)} · parse ${Math.round(sc.loadStats.parseMs)} · weld ${Math.round(sc.loadStats.weldMs)} · normals ${Math.round(sc.loadStats.normalsMs)} · BVH ${Math.round(sc.loadStats.bvhMs)} · topology ${Math.round(sc.loadStats.topologyMs)} · total ${Math.round(sc.loadStats.totalMs)} ms (worker)`}>
            {sc.slot}: {sc.loadStats.triangles.toLocaleString('en-GB')} tri · parse {Math.round(sc.loadStats.parseMs + sc.loadStats.weldMs)} ms · BVH {Math.round(sc.loadStats.bvhMs)} ms
          </span>
        ))}
      </span>
    </div>
  );
}

function EmptyState({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="bg-white rounded-xl shadow-lg p-8 max-w-md text-center pointer-events-auto" data-testid="empty-state">
        <FolderOpen className="w-8 h-8 mx-auto text-blue-600 mb-3" />
        <h3 className="font-semibold text-gray-800 mb-1">Open intraoral scans</h3>
        <p className="text-sm text-gray-500 mb-4">STL, PLY or OBJ (with its texture image). Drop up to four files here, e.g. upper and lower, or visit A and visit B.</p>
        <button type="button" onClick={onOpen} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700" data-testid="open-files">Choose files</button>
        <p className="text-[11px] text-gray-400 mt-3">Files are read in this browser. Nothing is uploaded.</p>
      </div>
    </div>
  );
}

export interface WorkbenchProps {
  /** Files resolved by the page (study mode). Local mode passes nothing. */
  initialFiles?: IncomingFile[] | null;
  backTo?: string;
  title?: ReactNode;
}

export default function Workbench({ initialFiles, backTo = '/', title }: WorkbenchProps) {
  const scans = useWorkbench((s) => s.scans);
  const layout = useWorkbench((s) => s.layout);
  const link = useWorkbench((s) => s.linkCameras);
  const panes = useWorkbench((s) => s.panes);
  const tool = useWorkbench((s) => s.tool);
  const set = useWorkbench((s) => s.set);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const loadedInitial = useRef(false);
  const openPicker = useCallback(() => fileRef.current?.click(), []);

  useHotkeys(openPicker);
  useLassoHandler();

  useEffect(() => () => { resetEngine(); resetWorkbench(); }, []);
  useEffect(() => {
    if (initialFiles && initialFiles.length && !loadedInitial.current) {
      loadedInitial.current = true;
      void loadFiles(initialFiles);
    }
  }, [initialFiles]);

  const anyScan = SLOTS.some((s) => scans[s]);
  const allReady = SLOTS.filter((s) => scans[s]?.status === 'ready');
  const leftSlots = layout === 'side' ? panes.left : allReady;

  const onFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    void loadFiles(pairLocalFiles(Array.from(list)));
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-100 text-gray-800 overflow-hidden" data-testid="ios-workbench">
      <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Link to={backTo} className="text-gray-500 hover:text-gray-800" title="Back"><ArrowLeft className="w-5 h-5" /></Link>
          <h2 className="font-semibold text-gray-800 whitespace-nowrap">IOS workbench</h2>
          {title && <span className="text-sm text-gray-500 truncate">{title}</span>}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-gray-100 rounded-lg p-0.5" role="group" aria-label="Layout">
            {LAYOUTS.map((l) => (
              <button key={l.id} type="button" data-testid={`layout-${l.id}`} title={`${l.label} (${l.key})`}
                onClick={() => { set({ layout: l.id }); useWorkbench.getState().requestFrame(); }}
                className={`px-2.5 py-1 text-xs font-medium rounded-md ${layout === l.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}>
                {l.label}
              </button>
            ))}
          </div>
          {layout === 'side' && (
            <button type="button" onClick={() => set({ linkCameras: !link })} data-testid="link-cameras" title="Link cameras (L)"
              className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border ${link ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-200'}`}>
              {link ? <Link2 className="w-3.5 h-3.5" /> : <Link2Off className="w-3.5 h-3.5" />} {link ? 'Linked' : 'Unlinked'}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={openPicker} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700" data-testid="open-files-header" title="Open files (O)">
            <FolderOpen className="w-4 h-4" /> Open
          </button>
          <button type="button" onClick={() => set({ showHelp: true })} className="text-gray-500 hover:text-gray-800" title="Shortcuts (?)" data-testid="help-button"><HelpCircle className="w-5 h-5" /></button>
        </div>
        <input ref={fileRef} type="file" multiple accept=".stl,.ply,.obj,.jpg,.jpeg,.png" className="hidden" data-testid="file-input"
          onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
      </header>

      <div className="flex-1 flex min-h-0 relative"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles(e.dataTransfer.files); }}>
        {/* tool rail */}
        <div className="absolute left-3 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-2">
          {TOOLS.map((t) => (
            <button key={t.id} type="button" data-testid={`tool-${t.id}`} title={`${t.label} (${t.key})`} disabled={!anyScan}
              onClick={() => { set({ tool: tool === t.id ? 'none' : t.id, pending: [], lasso: null }); useWorkbench.getState().patchAlignment({ picking: null }); }}
              className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 ${tool === t.id ? 'bg-blue-600 text-white shadow-lg' : 'bg-white text-gray-600 hover:bg-gray-50 shadow-md'}`}>
              <t.icon className="w-5 h-5" />
            </button>
          ))}
        </div>

        <div className="flex-1 flex min-w-0 pl-16" data-testid="panes">
          <Pane id="left" slots={leftSlots} label={layout === 'side' ? `Scan ${panes.left.join(', ')}` : undefined} />
          {layout === 'side' && <div className="w-px bg-gray-300" />}
          {layout === 'side' && <Pane id="right" slots={panes.right} label={`Scan ${panes.right.join(', ')}`} />}
        </div>

        {anyScan && (
          <aside className="w-80 shrink-0 m-3 ml-0 bg-white rounded-xl shadow-lg p-4 overflow-y-auto z-10" data-testid="side-panel">
            <ScansPanel />
            {tool !== 'none' && <div className="border-t border-gray-100 pt-3"><ToolPanel tool={tool} /></div>}
            {tool === 'none' && <p className="text-[11px] text-gray-500">Pick a tool on the left, or press <kbd className="px-1 bg-gray-100 rounded">?</kbd> for shortcuts.</p>}
          </aside>
        )}
        {!anyScan && <EmptyState onOpen={openPicker} />}
        {dragging && <div className="absolute inset-0 z-40 border-4 border-dashed border-blue-400 bg-blue-50/40 pointer-events-none flex items-center justify-center text-blue-700 font-medium">Drop scan files</div>}
      </div>
      <StatusBar />
      <Notice />
      <HelpOverlay />
    </div>
  );
}
