import { Loader2, Play } from 'lucide-react';
import { useWorkbench, type ContactSideSummary } from '../store';
import { acceptContactMap, computeContactMap, showContactView } from '../actions';
import { AcceptBox, Btn, Field, NumInput, Section, SlotSelect, Stat, StatusBadge } from '../kit';
import { CONTACT_COLORS, hex } from '../../core/colormap';

function Side({ title, s, testId }: { title: string; s: ContactSideSummary; testId: string }) {
  return (
    <div className="rounded-md bg-gray-50 border border-gray-200 p-2" data-testid={testId}>
      <div className="text-[11px] font-semibold text-gray-700 mb-0.5">{title}</div>
      <Stat label="Contact area (< contact)" value={`${s.areaContact.toFixed(2)} mm²`} testId={`${testId}-contact`} />
      <Stat label="Near area" value={`${s.areaNear.toFixed(2)} mm²`} />
      <Stat label="Close area" value={`${s.areaClose.toFixed(2)} mm²`} />
      <Stat label="Contact patches" value={s.contactPatches} />
      <Stat label="Deepest overlap" value={Number.isFinite(s.deepest) ? `${s.deepest.toFixed(3)} mm` : '—'} />
    </div>
  );
}

export function ContactLegend({ t }: { t: { contact: number; near: number; close: number } }) {
  const rows: Array<[keyof typeof CONTACT_COLORS, string]> = [
    ['contact', `Contact (< ${t.contact} mm, overlapping)`],
    ['near', `Near (${t.contact}–${t.near} mm)`],
    ['close', `Close (${t.near}–${t.close} mm)`],
  ];
  return (
    <div className="space-y-0.5" data-testid="contact-legend">
      {rows.map(([k, label]) => (
        <div key={k} className="flex items-center gap-2 text-[11px] text-gray-700">
          <span className="w-3.5 h-3.5 rounded-sm border border-black/10" style={{ background: hex(CONTACT_COLORS[k]) }} />{label}
        </div>
      ))}
    </div>
  );
}

export function ContactPanel() {
  const c = useWorkbench((s) => s.contact);
  const patch = useWorkbench((s) => s.patchContact);
  const mapView = useWorkbench((s) => s.mapView);
  const set = useWorkbench((s) => s.set);
  const reset = { upperValues: undefined, lowerValues: undefined, summary: undefined, basis: undefined, status: 'none' as const, accepted: undefined };
  return (
    <div data-testid="contact-panel">
      <Section title="Occlusal contacts / clearance" right={<StatusBadge status={c.status} accepted={c.accepted} testId="contact-status" />}>
        <p className="text-[11px] text-gray-500 mb-1">Works with any two meshes. Say which one is the upper arch.</p>
        <Field label="Upper arch"><SlotSelect value={c.upper} onChange={(s) => patch({ upper: s, ...reset })} testId="contact-upper" /></Field>
        <Field label="Lower arch"><SlotSelect value={c.lower} onChange={(s) => patch({ lower: s, ...reset })} testId="contact-lower" exclude={c.upper} /></Field>
      </Section>
      <Section title="Thresholds">
        <Field label="Contact below"><NumInput value={c.thresholds.contact} onChange={(v) => patch({ thresholds: { ...c.thresholds, contact: v }, ...reset })} step={0.01} min={-1} max={c.thresholds.near} suffix="mm" /></Field>
        <Field label="Near below"><NumInput value={c.thresholds.near} onChange={(v) => patch({ thresholds: { ...c.thresholds, near: v }, ...reset })} step={0.01} min={c.thresholds.contact} max={c.thresholds.close} suffix="mm" /></Field>
        <Field label="Close below"><NumInput value={c.thresholds.close} onChange={(v) => patch({ thresholds: { ...c.thresholds, close: v }, ...reset })} step={0.05} min={c.thresholds.near} max={3} suffix="mm" /></Field>
        <div className="mt-1.5"><ContactLegend t={c.thresholds} /></div>
        <div className="mt-2 flex gap-1.5">
          <Btn variant="primary" onClick={() => void computeContactMap()} disabled={c.running || c.upper === c.lower} testId="run-contacts">
            {c.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Compute
          </Btn>
          {c.summary && (
            <Btn onClick={() => set({ mapView: mapView === 'contact' ? 'none' : 'contact' })}>{mapView === 'contact' ? 'Hide map' : 'Show map'}</Btn>
          )}
          {c.summary && <Btn onClick={showContactView} title="Upper and lower side by side, each seen from the other arch" testId="contact-view">Occlusal views</Btn>}
        </div>
      </Section>
      {c.summary && (
        <Section title="Result">
          <div className="space-y-1.5">
            <Side title={`Upper (scan ${c.upper})`} s={c.summary.upper} testId="contact-upper-summary" />
            <Side title={`Lower (scan ${c.lower})`} s={c.summary.lower} testId="contact-lower-summary" />
          </div>
          {c.summary.warnings.map((w) => <p key={w} className="text-[11px] text-amber-700 mt-1">{w}</p>)}
          <p className="text-[10px] text-gray-500 mt-1">Areas are surface estimates (vertex areas). Search radius {c.summary.searchRadius.toFixed(2)} mm · {Math.round(c.summary.elapsedMs)} ms.</p>
          <AcceptBox status={c.status} what="contact map" testPrefix="contact" onAccept={(n) => void acceptContactMap(n)} />
        </Section>
      )}
    </div>
  );
}
