import { useEffect, useState } from 'react';
import { Lasso, Scissors, Droplet, Layers, Sparkles } from 'lucide-react';
import { useWorkbench, activeVersion, type Slot } from '../store';
import { applyEditTo } from '../actions';
import { Btn, Field, NumInput, Section, SlotSelect, Stat } from '../kit';
import { invertRigid, transformDirection, transformPoint } from '../../core/mat4';

export function EditPanel() {
  const scans = useWorkbench((s) => s.scans);
  const section = useWorkbench((s) => s.section);
  const trimPreview = useWorkbench((s) => s.trimPreview);
  const busy = useWorkbench((s) => s.busy);
  const set = useWorkbench((s) => s.set);
  const first = (Object.keys(scans) as Slot[]).find((k) => scans[k]?.status === 'ready') ?? 'A';
  const target = useWorkbench((s) => s.editTarget);
  const visibleOnly = useWorkbench((s) => s.lassoVisibleOnly);
  const setTarget = (slot: Slot) => set({ editTarget: slot, trimPreview: null });
  const setVisibleOnly = (b: boolean) => set({ lassoVisibleOnly: b });
  const sc = scans[target];
  const v = activeVersion(sc);
  const [maxEdges, setMaxEdges] = useState(100);
  const [keepRim, setKeepRim] = useState(true);
  const [targetTris, setTargetTris] = useState(0);
  const [method, setMethod] = useState<'taubin' | 'laplacian'>('taubin');
  const [iterations, setIterations] = useState(5);
  const [lambda, setLambda] = useState(0.5);
  const [fixBoundary, setFixBoundary] = useState(true);
  const [planeKeep, setPlaneKeep] = useState<'positive' | 'negative'>('positive');

  useEffect(() => { if (!scans[target] && scans[first]) set({ editTarget: first }); }, [scans, target, first, set]);
  useEffect(() => { if (v) setTargetTris(Math.max(4, Math.round(v.triangles / 2))); }, [v?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const disabled = !v || !!busy;
  const planeInScan = section.plane && sc ? section.plane : null;

  return (
    <div data-testid="edit-panel">
      <Section title="Edit target">
        <Field label="Scan"><SlotSelect value={target} onChange={setTarget} testId="edit-target" /></Field>
        {v && <p className="text-[11px] text-gray-500">Edits start from the active version <b>{v.id}</b> and create a new version. The original is never changed.</p>}
      </Section>

      <Section title="Trim by lasso">
        <Field label="Visible surface only"><input type="checkbox" checked={visibleOnly} onChange={(e) => setVisibleOnly(e.target.checked)} /></Field>
        {!trimPreview && (
          <div className="flex gap-1.5">
            {(['left', 'right'] as const).map((p) => (
              <Btn key={p} onClick={() => set({ lasso: { purpose: 'trim', points: [], pane: p }, trimPreview: null })} disabled={disabled} testId={`trim-lasso-${p}`}>
                <Lasso className="w-3.5 h-3.5" /> Draw in {p} pane
              </Btn>
            ))}
          </div>
        )}
        {trimPreview && trimPreview.slot === target && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2">
            <Stat label="Selected triangles" value={trimPreview.triangles.toLocaleString('en-GB')} testId="trim-selected" />
            <Stat label="Selected area" value={`${trimPreview.area.toFixed(2)} mm²`} />
            <div className="flex gap-1.5 mt-1.5">
              <Btn variant="danger" disabled={disabled || trimPreview.triangles === 0} testId="trim-delete"
                onClick={async () => { await applyEditTo(target, { op: 'trim-lasso', params: { lasso: trimPreview.lasso, mode: 'delete-inside' } }); set({ trimPreview: null }); }}>
                Delete selection
              </Btn>
              <Btn disabled={disabled || trimPreview.triangles === 0}
                onClick={async () => { await applyEditTo(target, { op: 'trim-lasso', params: { lasso: trimPreview.lasso, mode: 'keep-inside' } }); set({ trimPreview: null }); }}>
                Keep only selection
              </Btn>
              <Btn variant="ghost" onClick={() => set({ trimPreview: null })}>Cancel</Btn>
            </div>
          </div>
        )}
      </Section>

      <Section title="Trim by plane">
        {planeInScan ? (
          <>
            <p className="text-[11px] text-gray-500 mb-1">Uses the current cross-section plane.</p>
            <Field label="Keep side">
              <select value={planeKeep} onChange={(e) => setPlaneKeep(e.target.value as 'positive' | 'negative')} className="rounded border border-gray-200 px-1 py-0.5 text-[11px]">
                <option value="positive">Side A of the plane</option>
                <option value="negative">Side B of the plane</option>
              </select>
            </Field>
            <Btn disabled={disabled} testId="trim-plane"
              onClick={() => {
                // the plane is stored in the case frame; convert to the scan's own frame
                const inv = invertRigid(sc!.matrix);
                const origin = transformPoint(inv, section.plane!.origin);
                const normal = transformDirection(inv, section.plane!.normal);
                void applyEditTo(target, { op: 'trim-plane', params: { plane: { origin, normal }, keep: planeKeep } });
              }}>
              <Scissors className="w-3.5 h-3.5" /> Trim at plane
            </Btn>
          </>
        ) : <p className="text-[11px] text-gray-500">Define a plane first with the Section tool (S).</p>}
      </Section>

      <Section title="Fill small holes">
        <Field label="Max hole size"><NumInput value={maxEdges} onChange={(x) => setMaxEdges(Math.round(x))} step={10} min={3} max={2000} suffix="edges" testId="fill-max" /></Field>
        <Field label="Keep the open scan border"><input type="checkbox" checked={keepRim} onChange={(e) => setKeepRim(e.target.checked)} /></Field>
        <Btn disabled={disabled} testId="fill-holes" onClick={() => void applyEditTo(target, { op: 'fill-holes', params: { maxEdges, keepLargestBoundary: keepRim } })}>
          <Droplet className="w-3.5 h-3.5" /> Fill holes
        </Btn>
      </Section>

      <Section title="Decimate">
        <Field label="Target triangles"><NumInput value={targetTris} onChange={(x) => setTargetTris(Math.round(x))} step={10000} min={4} testId="decimate-target" width="w-24" /></Field>
        {v && <p className="text-[11px] text-gray-500">Currently {v.triangles.toLocaleString('en-GB')} triangles.</p>}
        <Btn disabled={disabled || !v || targetTris >= v.triangles} testId="decimate" onClick={() => void applyEditTo(target, { op: 'decimate', params: { targetTriangles: targetTris } })}>
          <Layers className="w-3.5 h-3.5" /> Decimate
        </Btn>
      </Section>

      <Section title="Smooth">
        <Field label="Method">
          <select value={method} onChange={(e) => setMethod(e.target.value as 'taubin' | 'laplacian')} className="rounded border border-gray-200 px-1 py-0.5 text-[11px]">
            <option value="taubin">Taubin (keeps volume)</option>
            <option value="laplacian">Laplacian</option>
          </select>
        </Field>
        <Field label="Iterations"><NumInput value={iterations} onChange={(x) => setIterations(Math.round(x))} step={1} min={1} max={200} /></Field>
        <Field label="Step (λ)"><NumInput value={lambda} onChange={setLambda} step={0.05} min={0.05} max={1} /></Field>
        <Field label="Hold border fixed"><input type="checkbox" checked={fixBoundary} onChange={(e) => setFixBoundary(e.target.checked)} /></Field>
        <Btn disabled={disabled} testId="smooth" onClick={() => void applyEditTo(target, { op: 'smooth', params: { method, iterations, lambda, fixBoundary } })}>
          <Sparkles className="w-3.5 h-3.5" /> Smooth
        </Btn>
      </Section>
    </div>
  );
}
