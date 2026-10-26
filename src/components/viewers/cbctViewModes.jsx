/*
 * cbctViewModes — presentational building blocks for the DentalX-style top
 * view-mode tab bar in CBCTVolumeViewer: the tab bar itself, the Gallery grid,
 * the Compare picker/empty-state, and the "Coming soon — Phase 2" scaffold
 * panels (Implant, TMJ, Cephalometric).
 *
 * Pure presentation (no cornerstone, no volume math) so it stays cheap to test
 * and re-render. The heavy MPR/3D-PANO panes live in the parent and are toggled
 * with CSS visibility (never unmounted) to preserve the cornerstone canvases.
 */
import {
  Grid2x2, GalleryHorizontal, Columns2, Bone, Activity, Ruler,
  Download, Layers, Construction,
} from 'lucide-react';

// Tab definitions. `ready` modes are fully implemented; the rest are scaffolds.
export const VIEW_MODES = [
  { id: 'mpr', label: 'MPR', Icon: Grid2x2, ready: true },
  { id: 'pano', label: '3D Pano', Icon: Layers, ready: true },
  { id: 'gallery', label: 'Gallery', Icon: GalleryHorizontal, ready: true },
  { id: 'compare', label: 'Compare', Icon: Columns2, ready: true },
  { id: 'implant', label: 'Implant', Icon: Bone, ready: true },
  { id: 'tmj', label: 'TMJ', Icon: Activity, ready: true },
  { id: 'ceph', label: 'Cephalometric', Icon: Ruler, ready: true },
];

export function ViewModeTabs({ mode, onChange }) {
  return (
    <div className="flex items-stretch gap-1 px-2 py-1 bg-neutral-900 border-b border-neutral-800 overflow-x-auto">
      {VIEW_MODES.map(({ id, label, Icon, ready }) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            title={ready ? label : `${label} — coming soon`}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
              active
                ? 'bg-amber-500 text-black'
                : 'text-neutral-300 hover:bg-neutral-800'
            }`}
          >
            <Icon className="h-4 w-4" />
            <span>{label}</span>
            {!ready && (
              <span className={`ml-0.5 text-[8px] uppercase tracking-wide rounded px-1 ${active ? 'bg-black/20' : 'bg-neutral-700 text-neutral-300'}`}>
                soon
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Gallery ────────────────────────────────────────────────────────────────
export function GalleryPanel({ shots = [], onRemove }) {
  if (!shots.length) {
    return (
      <EmptyState
        Icon={GalleryHorizontal}
        title="No captures yet"
        body="Use Capture on the left rail (or the per-pane shutter) to snapshot a view. Captures from this session appear here."
      />
    );
  }
  return (
    <div className="h-full overflow-auto p-4 bg-neutral-950">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {shots.map((s) => (
          <figure key={s.id} className="bg-black rounded-md overflow-hidden border border-neutral-800 group relative">
            <img src={s.url} alt={s.label} className="w-full h-40 object-contain bg-black" />
            <figcaption className="flex items-center justify-between px-2 py-1 text-[11px] text-neutral-400 bg-neutral-900">
              <span className="truncate">{s.label}</span>
              <span className="flex items-center gap-1">
                <a href={s.url} download={`${s.label}.png`} title="Download" className="p-1 rounded hover:bg-neutral-700 text-neutral-300">
                  <Download className="h-3.5 w-3.5" />
                </a>
                {onRemove && (
                  <button type="button" title="Remove" onClick={() => onRemove(s.id)} className="p-1 rounded hover:bg-neutral-700 text-neutral-300">×</button>
                )}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

// ── Compare ────────────────────────────────────────────────────────────────
// Lets the user pick a second study (CBCT or intraoral 3D scan) to set beside
// the current one. With nothing selected, Compare shows the current study in
// a same-volume dual viewport. Extra per-layout controls (orientation, sync
// toggles, overlay/side switch…) render as children after the select.
export function ComparePicker({ studies = [], currentStudyId, selectedId, onSelect, loading, children }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-neutral-900 border-b border-neutral-800 flex-wrap">
      <span className="text-[11px] text-neutral-400">Compare current study with:</span>
      <select
        value={selectedId || ''}
        onChange={(e) => onSelect(e.target.value || null)}
        aria-label="Compare study"
        className="text-xs bg-neutral-800 text-neutral-200 rounded px-2 py-1 border border-neutral-700 max-w-[45%]"
      >
        <option value="">{loading ? 'Loading studies…' : '— Same study (dual viewport) —'}</option>
        {studies
          .filter((s) => s.id !== currentStudyId)
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
      </select>
      {children}
    </div>
  );
}

// ── Scaffold panels (Phase 2) ───────────────────────────────────────────────
export function ScaffoldPanel({ mode }) {
  const meta = {
    implant: {
      Icon: Bone,
      title: 'Implant planning',
      body: 'Place and angulate virtual implants on the MPR/pano, with bone-density (HU) sampling along the drill axis, nerve-canal safety margins, and a per-implant report.',
      bullets: ['Virtual implant library + sizing', 'Inferior alveolar nerve tracing & 2 mm safety zone', 'Bone density (HU) along the osteotomy', 'Surgical-guide export'],
    },
    tmj: {
      Icon: Activity,
      title: 'TMJ — dual condyle',
      body: 'Bilateral temporomandibular joint layout: corrected sagittal + coronal cuts through each condyle, open/closed comparison, and condylar measurements.',
      bullets: ['Left & right condyle paired views', 'Condyle-corrected sagittal/coronal', 'Joint-space measurement', 'Open vs closed compare'],
    },
    ceph: {
      Icon: Ruler,
      title: 'Cephalometric tracing',
      body: 'Generate a lateral/PA cephalogram from the volume, place standard landmarks (Sella, Nasion, A/B point, …) and compute Steiner/Downs/Ricketts analyses.',
      bullets: ['Lateral & PA ceph reconstruction', 'Landmark placement', 'Steiner / Downs / Ricketts analyses', 'Superimposition over time'],
    },
  }[mode] || { Icon: Construction, title: 'Coming soon', body: '', bullets: [] };

  const { Icon, title, body, bullets } = meta;
  return (
    <div className="h-full w-full flex items-center justify-center bg-neutral-950 p-6">
      <div className="max-w-lg w-full bg-neutral-900 border border-neutral-800 rounded-xl p-6 text-center">
        <div className="mx-auto w-12 h-12 rounded-full bg-amber-500/15 flex items-center justify-center mb-4">
          <Icon className="h-6 w-6 text-amber-400" />
        </div>
        <div className="inline-block text-[10px] uppercase tracking-wider text-amber-400 bg-amber-500/10 rounded-full px-2 py-0.5 mb-2">
          Coming soon — Phase 2
        </div>
        <h2 className="text-lg font-semibold text-neutral-100 mb-2">{title}</h2>
        <p className="text-sm text-neutral-400 mb-4">{body}</p>
        {bullets.length > 0 && (
          <ul className="text-left text-xs text-neutral-300 space-y-1.5 inline-block">
            {bullets.map((b) => (
              <li key={b} className="flex items-start gap-2">
                <span className="text-amber-400 mt-0.5">›</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ Icon = Construction, title, body }) {
  return (
    <div className="h-full w-full flex items-center justify-center bg-neutral-950 p-6">
      <div className="max-w-sm text-center">
        <Icon className="h-10 w-10 text-neutral-600 mx-auto mb-3" />
        <h3 className="text-neutral-200 font-medium mb-1">{title}</h3>
        {body && <p className="text-neutral-500 text-sm">{body}</p>}
      </div>
    </div>
  );
}
