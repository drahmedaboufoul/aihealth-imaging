/*
 * PNG snapshot of the 3D panes with a true-scale bar (orthographic view),
 * the active map legend and a DRAFT label when the result is not accepted.
 * No patient name, study id or file name is drawn.
 */
import { useWorkbench } from './store';
import { getPane } from './sceneRegistry';
import { CONTACT_COLORS, deviationColor, hex } from '../core/colormap';
import { imageExportName, isoDate } from '../core/naming';
import { download } from './actions';

function niceLength(mmTarget: number): number {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
  return steps.reduce((best, s) => (Math.abs(s - mmTarget) < Math.abs(best - mmTarget) ? s : best), steps[0]);
}

export function renderSnapshot(): HTMLCanvasElement | null {
  const s = useWorkbench.getState();
  const ids: Array<'left' | 'right'> = s.layout === 'side' ? ['left', 'right'] : ['left'];
  const canvases = ids.map((id) => getPane(id)).filter(Boolean).map((h) => ({ h: h!, c: h!.capture() }));
  if (canvases.length === 0) return null;
  const footer = 64;
  const W = canvases.reduce((w, x) => w + x.c.width, 0);
  const H = Math.max(...canvases.map((x) => x.c.height)) + footer;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const g = out.getContext('2d')!;
  g.fillStyle = '#f3f4f6';
  g.fillRect(0, 0, W, H);
  let x0 = 0;
  const dpr = canvases[0].c.width / Math.max(1, canvases[0].c.clientWidth || canvases[0].c.width);
  for (const { h, c } of canvases) {
    g.drawImage(c, x0, 0);
    // scale bar: orthographic, so 1 mm = zoom CSS px everywhere in the view
    const pxPerMm = h.camera.zoom * dpr;
    const len = niceLength((c.width * 0.18) / pxPerMm);
    const barPx = len * pxPerMm;
    const bx = x0 + 16 * dpr, by = c.height - 16 * dpr;
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(bx - 6 * dpr, by - 18 * dpr, barPx + 60 * dpr, 26 * dpr);
    g.fillStyle = '#111827';
    g.fillRect(bx, by - 4 * dpr, barPx, 4 * dpr);
    g.font = `${12 * dpr}px system-ui, sans-serif`;
    g.fillText(`${len} mm`, bx + barPx + 6 * dpr, by);
    x0 += c.width;
  }
  // footer: legend + labels
  const fy = H - footer;
  g.fillStyle = '#ffffff';
  g.fillRect(0, fy, W, footer);
  g.fillStyle = '#374151';
  g.font = `${13 * dpr}px system-ui, sans-serif`;
  let label = `IOS workbench · ${isoDate()}`;
  let draft = false;
  if (s.mapView === 'deviation' && s.deviation.stats) {
    const d = s.deviation;
    label += ` · deviation of scan ${d.test} vs ${d.ref} (mm)`;
    draft = d.basis?.alignment === 'draft';
    const lw = Math.min(360 * dpr, W * 0.4), lx = W - lw - 20 * dpr, ly = fy + 12 * dpr;
    for (let i = 0; i < lw; i++) {
      const v = -d.range + (2 * d.range * i) / lw;
      g.fillStyle = hex(deviationColor(v, d.range, d.tolerance));
      g.fillRect(lx + i, ly, 1, 14 * dpr);
    }
    g.fillStyle = '#374151';
    g.font = `${11 * dpr}px system-ui, sans-serif`;
    g.fillText(`−${d.range}`, lx, ly + 30 * dpr);
    g.fillText('0', lx + lw / 2 - 3 * dpr, ly + 30 * dpr);
    g.fillText(`+${d.range} mm`, lx + lw - 40 * dpr, ly + 30 * dpr);
    g.fillText(`green ±${d.tolerance} mm`, lx + lw / 2 + 14 * dpr, ly + 30 * dpr);
  } else if (s.mapView === 'contact' && s.contact.summary) {
    const c = s.contact;
    label += ` · contacts upper ${c.upper} / lower ${c.lower}`;
    draft = c.status !== 'accepted';
    const t = c.thresholds;
    const rows: Array<[keyof typeof CONTACT_COLORS, string]> = [['contact', `< ${t.contact} mm`], ['near', `${t.contact}–${t.near} mm`], ['close', `${t.near}–${t.close} mm`]];
    let lx = W - 360 * dpr;
    for (const [k, txt] of rows) {
      g.fillStyle = hex(CONTACT_COLORS[k]);
      g.fillRect(lx, fy + 16 * dpr, 14 * dpr, 14 * dpr);
      g.fillStyle = '#374151';
      g.font = `${11 * dpr}px system-ui, sans-serif`;
      g.fillText(txt, lx + 18 * dpr, fy + 27 * dpr);
      lx += 110 * dpr;
    }
  }
  g.fillStyle = '#374151';
  g.font = `${13 * dpr}px system-ui, sans-serif`;
  g.fillText(label, 16 * dpr, fy + 26 * dpr);
  if (draft) {
    g.fillStyle = '#b45309';
    g.font = `bold ${13 * dpr}px system-ui, sans-serif`;
    g.fillText('DRAFT — automatic result, not accepted', 16 * dpr, fy + 48 * dpr);
  } else if (s.mapView === 'contact' && s.contact.accepted) {
    g.fillStyle = '#047857';
    g.fillText(`Accepted by ${s.contact.accepted.by}`, 16 * dpr, fy + 48 * dpr);
  }
  return out;
}

export function exportPng(): void {
  const s = useWorkbench.getState();
  const canvas = renderSnapshot();
  if (!canvas) { s.notify('error', 'Nothing to capture yet.'); return; }
  const kind = s.mapView === 'deviation' ? 'deviation' : s.mapView === 'contact' ? 'contacts' : 'view';
  canvas.toBlob((blob) => {
    if (!blob) { useWorkbench.getState().notify('error', 'Snapshot failed.'); return; }
    download(blob, imageExportName(kind), 'image/png');
  }, 'image/png');
}
