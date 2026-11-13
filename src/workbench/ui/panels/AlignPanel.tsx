import { useState } from 'react';
import { Undo2, Crosshair, Play, Loader2 } from 'lucide-react';
import { useWorkbench } from '../store';
import { acceptAlignment, applyLandmarks, bakeAlignment, runIcp, startLandmarkPicking, undoAlignment } from '../actions';
import { AcceptBox, Btn, Field, NumInput, Section, SlotSelect, Stat, StatusBadge } from '../kit';
import { invertRigid, multiply, rotationAngleDeg, translationLength } from '../../core/mat4';

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values), min = Math.min(...values);
  const w = 120, h = 28;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / Math.max(1e-12, max - min)) * (h - 2) - 1}`).join(' ');
  return <svg width={w} height={h} className="text-blue-600"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} /></svg>;
}

export function AlignPanel() {
  const a = useWorkbench((s) => s.alignment);
  const scans = useWorkbench((s) => s.scans);
  const patch = useWorkbench((s) => s.patchAlignment);
  const [maxCorr, setMaxCorr] = useState(2);
  const [samples, setSamples] = useState(6000);
  const [outlierK, setOutlierK] = useState(3);
  const [maxIt, setMaxIt] = useState(60);
  const [advanced, setAdvanced] = useState(false);
  const fixed = scans[a.fixed], moving = scans[a.moving];
  const rel = fixed && moving ? multiply(invertRigid(fixed.matrix), moving.matrix) : null;
  const canRun = !!fixed && !!moving && fixed.status === 'ready' && moving.status === 'ready' && a.fixed !== a.moving;

  return (
    <div data-testid="align-panel">
      <Section title="Two-scan alignment" right={<StatusBadge status={a.status} accepted={a.accepted} testId="align-status" />}>
        <Field label="Fixed (reference)"><SlotSelect value={a.fixed} onChange={(s) => patch({ fixed: s, history: [], status: 'none', accepted: undefined, landmarksFixed: [], landmarksMoving: [] })} testId="align-fixed" /></Field>
        <Field label="Moving"><SlotSelect value={a.moving} onChange={(s) => patch({ moving: s, history: [], status: 'none', accepted: undefined, landmarksFixed: [], landmarksMoving: [] })} testId="align-moving" exclude={a.fixed} /></Field>
      </Section>

      <Section title="1 · Landmark pre-alignment (optional)">
        <p className="text-[11px] text-gray-500 mb-1.5">Click the same three spots on each scan (e.g. both distal molars and an incisor). Needed when the scans start far apart.</p>
        <div className="flex gap-1.5 mb-1">
          <Btn onClick={() => startLandmarkPicking('fixed')} variant={a.picking === 'fixed' ? 'primary' : 'secondary'} disabled={!canRun} testId="lm-fixed">
            <Crosshair className="w-3.5 h-3.5" /> Fixed {a.landmarksFixed.length}/3
          </Btn>
          <Btn onClick={() => startLandmarkPicking('moving')} variant={a.picking === 'moving' ? 'primary' : 'secondary'} disabled={!canRun} testId="lm-moving">
            <Crosshair className="w-3.5 h-3.5" /> Moving {a.landmarksMoving.length}/3
          </Btn>
          <Btn onClick={applyLandmarks} disabled={a.landmarksFixed.length < 3 || a.landmarksMoving.length < 3} testId="lm-apply">Apply</Btn>
        </div>
        {a.picking && <p className="text-[11px] text-blue-700">Picking on scan {a.picking === 'fixed' ? a.fixed : a.moving} — left-click the surface.</p>}
        {a.landmarkRms !== undefined && <Stat label="Landmark residual RMS" value={`${a.landmarkRms.toFixed(2)} mm`} />}
      </Section>

      <Section title="2 · ICP refinement" right={<button type="button" className="text-[11px] text-blue-600" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide' : 'Advanced'}</button>}>
        {advanced && (
          <div className="mb-1.5">
            <Field label="Max pair distance" hint="Pairs farther apart are ignored"><NumInput value={maxCorr} onChange={setMaxCorr} step={0.5} min={0.1} max={20} suffix="mm" /></Field>
            <Field label="Outlier rejection" hint="Ignore pairs beyond k x median distance"><NumInput value={outlierK} onChange={setOutlierK} step={0.5} min={1} max={10} suffix="x median" /></Field>
            <Field label="Sample points"><NumInput value={samples} onChange={(v) => setSamples(Math.round(v))} step={1000} min={500} max={50000} /></Field>
            <Field label="Max iterations"><NumInput value={maxIt} onChange={(v) => setMaxIt(Math.round(v))} step={10} min={1} max={500} /></Field>
          </div>
        )}
        <div className="flex gap-1.5">
          <Btn variant="primary" disabled={!canRun || a.running} testId="run-icp"
            onClick={() => runIcp({ maxCorrespondence: maxCorr, sampleCount: samples, outlierK, maxIterations: maxIt, method: 'point-to-plane' })}>
            {a.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run ICP
          </Btn>
          <Btn onClick={undoAlignment} disabled={a.history.length < 2} title="Undo (Ctrl+Z)" testId="align-undo"><Undo2 className="w-3.5 h-3.5" /> Undo</Btn>
        </div>
        {a.lastIcp && (
          <div className="mt-2 rounded-md bg-gray-50 border border-gray-200 p-2" data-testid="icp-report">
            <Stat label="RMS (point-to-plane)" value={`${a.lastIcp.rms.toFixed(4)} mm`} testId="icp-rms" />
            <Stat label="RMS (point-to-point)" value={`${a.lastIcp.rmsPointToPoint.toFixed(4)} mm`} />
            <Stat label="Iterations" value={a.lastIcp.iterations} testId="icp-iterations" />
            <Stat label="Converged" value={a.lastIcp.converged ? 'yes' : `no (${a.lastIcp.reason})`} />
            <Stat label="Inliers" value={`${(a.lastIcp.inlierFraction * 100).toFixed(1)}% of ${a.lastIcp.samples}`} />
            <Stat label="Time" value={`${Math.round(a.lastIcp.elapsedMs)} ms`} />
            <div className="mt-1 flex items-center justify-between text-[10px] text-gray-500"><span>RMS per iteration</span><Sparkline values={a.lastIcp.history} /></div>
          </div>
        )}
        {rel && a.history.length > 0 && (
          <div className="mt-1.5">
            <Stat label="Moving vs start: rotation" value={`${rotationAngleDeg(multiply(invertRigid(a.history[0].matrix), moving!.matrix)).toFixed(2)}°`} />
            <Stat label="Moving vs start: translation" value={`${translationLength(multiply(invertRigid(a.history[0].matrix), moving!.matrix)).toFixed(3)} mm`} />
          </div>
        )}
        {a.history.length > 0 && (
          <ol className="mt-1.5 text-[11px] text-gray-600 list-decimal pl-4" data-testid="align-history">
            {a.history.map((h, i) => <li key={i}>{h.summary}</li>)}
          </ol>
        )}
      </Section>

      <AcceptBox status={a.status} what="alignment" testPrefix="align" onAccept={(n) => void acceptAlignment(n)} />
      {a.status === 'accepted' && (
        <div className="mt-2">
          <Btn onClick={() => void bakeAlignment()} testId="align-bake" title="Creates a new version of the moving scan in the fixed scan's frame; the original is untouched">
            Save aligned copy as new version
          </Btn>
        </div>
      )}
    </div>
  );
}
