import { useMemo, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { useWorkbench, activeVersion, type Slot } from '../store';
import { nextMeasurementId } from '../actions';
import { Btn, Section, Stat } from '../kit';
import { profileExtent, profileGap, type Profile2D } from '../../core/section';
import type { Vec3 } from '../../core/types';
import { invertRigid, transformPoint } from '../../core/mat4';

const W = 280, H = 200, PAD = 18;

function nearestOnProfiles(x: number, y: number, profiles: { slot: Slot; profiles: Profile2D[] }[]): { x: number; y: number; slot: Slot } | null {
  let best: { x: number; y: number; slot: Slot } | null = null, bd = Infinity;
  for (const p of profiles) for (const pr of p.profiles) for (const [px, py] of pr.points) {
    const d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = { x: px, y: py, slot: p.slot }; }
  }
  return best;
}

export function SectionPanel() {
  const section = useWorkbench((s) => s.section);
  const scans = useWorkbench((s) => s.scans);
  const add = useWorkbench((s) => s.addMeasurement);
  const pending = useWorkbench((s) => s.pending);
  const [pts, setPts] = useState<{ x: number; y: number; slot: Slot }[]>([]);
  const profiles = section.profiles ?? [];
  const all = profiles.flatMap((p) => p.profiles);
  const ext = useMemo(() => profileExtent(all), [all]);
  const span = Math.max(ext.width, ext.height, 1e-3) * 1.1;
  const cx = (ext.minX + ext.maxX) / 2, cy = (ext.minY + ext.maxY) / 2;
  const scale = Math.min((W - 2 * PAD) / span, (H - 2 * PAD) / span);
  const sx = (x: number) => W / 2 + (x - cx) * scale;
  const sy = (y: number) => H / 2 - (y - cy) * scale;
  const gap = profiles.length >= 2 ? profileGap(profiles[1].profiles, profiles[0].profiles) : null;
  const toCase = (x: number, y: number): Vec3 => {
    const b = section.basis!;
    return [b.origin[0] + x * b.u[0] + y * b.v[0], b.origin[1] + x * b.u[1] + y * b.v[1], b.origin[2] + x * b.u[2] + y * b.v[2]];
  };
  const dist = pts.length === 2 ? Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) : null;

  const saveDistance = () => {
    if (pts.length !== 2 || !section.basis) return;
    const slot = pts[0].slot;
    const sc = scans[slot];
    const v = activeVersion(sc);
    if (!sc || !v) return;
    // section points are in the case frame; store them in the scan's native frame
    const inv = invertRigid(sc.matrix);
    const native = pts.map((p) => transformPoint(inv, toCase(p.x, p.y)));
    add({
      id: nextMeasurementId(), kind: 'section-distance', slot, versionId: v.id, versionSha256: v.outputSha256,
      points: native, value: dist!, unit: 'mm', method: 'cross-section-2d', createdAt: new Date().toISOString(),
      meta: { plane: section.plane, profilePoints: pts.map((p) => [p.x, p.y]) },
    });
    setPts([]);
  };

  return (
    <div data-testid="section-panel">
      <Section title="Cross-section">
        <p className="text-[11px] text-gray-500">Click two points on a scan: the section plane passes through them along your view direction. All visible scans are cut, so visit A/B profiles overlay.</p>
        {pending.length === 1 && <p className="text-[11px] text-blue-700 mt-1">One point picked — click the second.</p>}
        {section.running && <p className="text-[11px] text-gray-500 mt-1 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Cutting…</p>}
      </Section>
      {profiles.length > 0 && (
        <Section title="2D profile (mm)">
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="bg-white border border-gray-200 rounded cursor-crosshair" data-testid="section-profile"
            onClick={(e) => {
              const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * H;
              const x = (px - W / 2) / scale + cx, y = -(py - H / 2) / scale + cy;
              const hit = nearestOnProfiles(x, y, profiles);
              if (hit) setPts((cur) => (cur.length >= 2 ? [hit] : [...cur, hit]));
            }}>
            {/* 1 mm grid */}
            {Array.from({ length: Math.ceil(span) + 1 }, (_, i) => Math.floor(ext.minX - span * 0.05) + i).map((g) => (
              <line key={`gx${g}`} x1={sx(g)} x2={sx(g)} y1={0} y2={H} stroke="#f1f5f9" />
            ))}
            {Array.from({ length: Math.ceil(span) + 1 }, (_, i) => Math.floor(ext.minY - span * 0.05) + i).map((g) => (
              <line key={`gy${g}`} y1={sy(g)} y2={sy(g)} x1={0} x2={W} stroke="#f1f5f9" />
            ))}
            {profiles.map((p) => p.profiles.map((pr, i) => (
              <polyline key={`${p.slot}${i}`} fill="none" stroke={scans[p.slot]?.color ?? '#111'} strokeWidth={1.6}
                points={(pr.closed ? [...pr.points, pr.points[0]] : pr.points).map(([x, y]) => `${sx(x)},${sy(y)}`).join(' ')} />
            )))}
            {pts.map((p, i) => <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={3} fill="#1d4ed8" />)}
            {pts.length === 2 && <line x1={sx(pts[0].x)} y1={sy(pts[0].y)} x2={sx(pts[1].x)} y2={sy(pts[1].y)} stroke="#1d4ed8" strokeWidth={1.2} />}
            {/* 1 mm scale bar */}
            <line x1={8} x2={8 + scale} y1={H - 8} y2={H - 8} stroke="#111827" strokeWidth={2} />
            <text x={10 + scale} y={H - 5} fontSize={9} fill="#111827">1 mm</text>
          </svg>
          <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-gray-600">
            {profiles.map((p) => <span key={p.slot} className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: scans[p.slot]?.color }} />Scan {p.slot}</span>)}
          </div>
          {profiles.map((p) => {
            const e = profileExtent(p.profiles);
            return <Stat key={p.slot} label={`Scan ${p.slot} width × height`} value={`${e.width.toFixed(2)} × ${e.height.toFixed(2)} mm`} />;
          })}
          {gap && <Stat label={`Gap scan ${profiles[1].slot} → ${profiles[0].slot} (mean / max)`} value={`${gap.mean.toFixed(3)} / ${gap.max.toFixed(3)} mm`} testId="section-gap" />}
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-xs font-mono" data-testid="section-distance">{dist !== null ? `${dist.toFixed(3)} mm` : 'Click two profile points to measure'}</span>
            <Btn onClick={saveDistance} disabled={dist === null} testId="section-save"><Plus className="w-3.5 h-3.5" /> Save</Btn>
          </div>
        </Section>
      )}
    </div>
  );
}
