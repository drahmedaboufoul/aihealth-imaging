import { useMemo } from 'react';
import { Loader2, Play } from 'lucide-react';
import { useWorkbench } from '../store';
import { computeDeviationMap } from '../actions';
import { Btn, Field, NumInput, Section, SlotSelect, Stat, StatusBadge, mm, pct } from '../kit';
import { deviationColor, hex } from '../../core/colormap';
import { histogram } from '../../core/deviation';

export function DeviationLegend({ range, tolerance }: { range: number; tolerance: number }) {
  const stops = useMemo(() => Array.from({ length: 41 }, (_, i) => {
    const v = -range + (2 * range * i) / 40;
    return `${hex(deviationColor(v, range, tolerance))} ${(i / 40) * 100}%`;
  }).join(', '), [range, tolerance]);
  return (
    <div data-testid="deviation-legend">
      <div className="h-3 rounded" style={{ background: `linear-gradient(to right, ${stops})` }} />
      <div className="flex justify-between text-[10px] font-mono text-gray-600 mt-0.5">
        <span>−{range.toFixed(2)}</span><span>−{tolerance.toFixed(2)}</span><span>0</span><span>+{tolerance.toFixed(2)}</span><span>+{range.toFixed(2)} mm</span>
      </div>
      <div className="flex justify-between text-[10px] text-gray-500"><span>inside reference</span><span>outside reference</span></div>
    </div>
  );
}

export function DeviationHistogram({ values, range, tolerance }: { values: Float32Array; range: number; tolerance: number }) {
  const bins = 40;
  const h = useMemo(() => histogram(values, -range, range, bins), [values, range]);
  const max = Math.max(1, ...Array.from(h.counts));
  const W = 260, H = 70;
  const bw = W / bins;
  const x = (v: number) => ((v + range) / (2 * range)) * W;
  return (
    <div data-testid="deviation-histogram">
      <svg width="100%" viewBox={`0 0 ${W} ${H + 12}`} className="block">
        <rect x={x(-tolerance)} y={0} width={x(tolerance) - x(-tolerance)} height={H} fill="rgba(34,197,94,0.12)" />
        {Array.from(h.counts).map((c, i) => {
          const mid = -range + (i + 0.5) * (2 * range / bins);
          const bh = (c / max) * (H - 2);
          return <rect key={i} x={i * bw + 0.5} y={H - bh} width={bw - 1} height={bh} fill={hex(deviationColor(mid, range, tolerance))} />;
        })}
        <line x1={x(0)} x2={x(0)} y1={0} y2={H} stroke="#374151" strokeWidth={0.5} strokeDasharray="2 2" />
        <text x={0} y={H + 10} fontSize={8} fill="#6b7280">−{range}</text>
        <text x={W / 2} y={H + 10} fontSize={8} fill="#6b7280" textAnchor="middle">0 mm</text>
        <text x={W} y={H + 10} fontSize={8} fill="#6b7280" textAnchor="end">+{range}</text>
      </svg>
      <div className="flex justify-between text-[10px] text-gray-500">
        <span>below −{range}: {h.below.toLocaleString('en-GB')}</span>
        <span>no counterpart: {h.noData.toLocaleString('en-GB')}</span>
        <span>above +{range}: {h.above.toLocaleString('en-GB')}</span>
      </div>
    </div>
  );
}

export function DeviationPanel() {
  const d = useWorkbench((s) => s.deviation);
  const patch = useWorkbench((s) => s.patchDeviation);
  const mapView = useWorkbench((s) => s.mapView);
  const set = useWorkbench((s) => s.set);
  const alignment = useWorkbench((s) => s.alignment);
  const involved = (alignment.fixed === d.ref && alignment.moving === d.test) || (alignment.fixed === d.test && alignment.moving === d.ref);
  return (
    <div data-testid="deviation-panel">
      <Section title="Deviation map (mm)" right={d.basis && d.basis.alignment !== 'none' ? <StatusBadge status={d.basis.alignment} accepted={d.basis.alignment === 'accepted' ? alignment.accepted : undefined} /> : undefined}>
        <Field label="Reference"><SlotSelect value={d.ref} onChange={(s) => patch({ ref: s, values: undefined, stats: undefined, basis: undefined })} testId="dev-ref" /></Field>
        <Field label="Compared scan (coloured)"><SlotSelect value={d.test} onChange={(s) => patch({ test: s, values: undefined, stats: undefined, basis: undefined })} testId="dev-test" exclude={d.ref} /></Field>
        <Field label="Search radius" hint="Farther than this = no counterpart (grey)"><NumInput value={d.maxDistance} onChange={(v) => patch({ maxDistance: v })} step={0.25} min={0.05} max={10} suffix="mm" /></Field>
        {involved && alignment.status === 'draft' && <p className="text-[11px] text-amber-700 mt-1">Uses the current DRAFT alignment. Accept it in Align before relying on these numbers.</p>}
        {involved && alignment.status === 'none' && <p className="text-[11px] text-gray-500 mt-1">The scans have not been aligned in this session; the map assumes they share a frame.</p>}
        <div className="mt-1.5 flex gap-1.5">
          <Btn variant="primary" onClick={() => void computeDeviationMap()} disabled={d.running || d.ref === d.test} testId="run-deviation">
            {d.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Compute
          </Btn>
          {d.values && (
            <Btn onClick={() => set({ mapView: mapView === 'deviation' ? 'none' : 'deviation' })} testId="toggle-deviation">
              {mapView === 'deviation' ? 'Hide map' : 'Show map'}
            </Btn>
          )}
        </div>
      </Section>
      {d.values && d.stats && (
        <>
          <Section title="Colour scale">
            <Field label="Range ±"><NumInput value={d.range} onChange={(v) => patch({ range: Math.max(v, d.tolerance + 0.01) })} step={0.05} min={0.05} max={5} suffix="mm" testId="dev-range" /></Field>
            <Field label="Tolerance ± (green)">
              <span className="inline-flex gap-1">
                {[0.05, 0.1, 0.2].map((t) => (
                  <button key={t} type="button" onClick={() => patch({ tolerance: t, range: Math.max(d.range, t + 0.01) })} data-testid={`dev-tol-${t}`}
                    className={`px-1.5 py-0.5 rounded text-[11px] ${d.tolerance === t ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}>±{t}</button>
                ))}
              </span>
            </Field>
            <div className="mt-1.5"><DeviationLegend range={d.range} tolerance={d.tolerance} /></div>
          </Section>
          <Section title="Histogram"><DeviationHistogram values={d.values} range={d.range} tolerance={d.tolerance} /></Section>
          <Section title="Statistics" testId="deviation-stats">
            <Stat label="Mean (signed)" value={mm(d.stats.mean)} testId="dev-mean" />
            <Stat label="Mean |deviation|" value={mm(d.stats.meanAbs, 3).replace('+', '')} />
            <Stat label="RMS" value={mm(d.stats.rms, 3).replace('+', '')} testId="dev-rms" />
            <Stat label="Std deviation" value={mm(d.stats.std, 3).replace('+', '')} />
            <Stat label="Min / max" value={`${mm(d.stats.min)} / ${mm(d.stats.max)}`} />
            <Stat label="P5 / P95" value={`${mm(d.stats.p05)} / ${mm(d.stats.p95)}`} />
            {d.stats.bands.map((b) => <Stat key={b.tolerance} label={`Within ±${b.tolerance} mm (area)`} value={pct(b.areaFraction)} testId={`dev-band-${b.tolerance}`} />)}
            <Stat label="No counterpart" value={pct(d.stats.noData / Math.max(1, d.stats.vertices))} />
            <p className="text-[10px] text-gray-500 mt-1">Hover the coloured scan for a point readout. {d.basis ? `Computed in ${Math.round(d.basis.elapsedMs)} ms on ${d.stats.vertices.toLocaleString('en-GB')} vertices.` : ''}</p>
          </Section>
        </>
      )}
    </div>
  );
}
