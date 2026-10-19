import { useState } from 'react';
import { ShieldCheck, Copy } from 'lucide-react';
import { useWorkbench, SLOTS } from '../store';
import { exportMesh, setActiveVersion } from '../actions';
import { Btn, Section } from '../kit';
import { verifyLineage } from '../../core/versions';
import { canonicalJson } from '../../core/hash';

function short(params: Record<string, unknown>): string {
  const p = { ...params } as Record<string, unknown>;
  if (p.lasso && typeof p.lasso === 'object') p.lasso = `polygon ${((p.lasso as { polygon?: unknown[] }).polygon ?? []).length} pts`;
  if (Array.isArray(p.matrix)) p.matrix = 'rigid 4x4';
  const text = canonicalJson(p);
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

export function VersionsPanel() {
  const scans = useWorkbench((s) => s.scans);
  const [check, setCheck] = useState<Record<string, string>>({});
  const present = SLOTS.filter((s) => scans[s]?.status === 'ready');
  return (
    <div data-testid="versions-panel">
      {present.length === 0 && <p className="text-xs text-gray-500">Open a scan to see its versions.</p>}
      {present.map((slot) => {
        const sc = scans[slot]!;
        return (
          <Section key={slot} title={`Scan ${slot} versions`} right={
            <Btn variant="ghost" testId={`verify-${slot}`} title="Check parents and parameter hashes"
              onClick={async () => {
                const r = await verifyLineage(sc.versions);
                setCheck((c) => ({ ...c, [slot]: r.ok ? 'Lineage verified' : r.problems.join('; ') }));
              }}>
              <ShieldCheck className="w-3.5 h-3.5" /> Verify
            </Btn>
          }>
            {check[slot] && <p className={`text-[11px] mb-1 ${check[slot] === 'Lineage verified' ? 'text-emerald-700' : 'text-red-600'}`} data-testid={`verify-result-${slot}`}>{check[slot]}</p>}
            <ol className="space-y-1.5">
              {[...sc.versions].reverse().map((v) => {
                const active = v.id === sc.activeVersionId;
                return (
                  <li key={v.id} data-testid={`version-${v.id}`}
                    className={`rounded-md border p-2 text-[11px] ${active ? 'border-blue-400 bg-blue-50/50' : 'border-gray-200'}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-800">{v.id}</span>
                      <span className={`px-1 rounded ${v.op === 'original' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-700'}`}>{v.op === 'original' ? 'original · immutable' : v.op}</span>
                      <span className="text-gray-500 ml-auto">{v.triangles.toLocaleString('en-GB')} tri</span>
                    </div>
                    <div className="mt-0.5 text-gray-500">parent: {v.parentId ?? '—'} · {new Date(v.createdAt).toLocaleTimeString('en-GB')}</div>
                    {v.op !== 'original' && <div className="mt-0.5 font-mono text-gray-600 break-all">{short(v.params)}</div>}
                    {v.stats && Number.isFinite(v.stats.maxChangeMm) && (
                      <div className="mt-0.5 text-gray-600">surface change vs parent: max {v.stats.maxChangeMm.toFixed(3)} mm · RMS {v.stats.rmsChangeMm.toFixed(3)} mm</div>
                    )}
                    <div className="mt-0.5 flex items-center gap-1 font-mono text-gray-700" title={v.outputSha256}>
                      SHA-256 {v.outputSha256.slice(0, 16)}…
                      <button type="button" className="text-gray-400 hover:text-gray-700" title="Copy SHA-256"
                        onClick={() => void navigator.clipboard?.writeText(v.outputSha256)}><Copy className="w-3 h-3" /></button>
                    </div>
                    {v.sourceFileSha256 && <div className="font-mono text-gray-500" title={v.sourceFileSha256}>source file SHA-256 {v.sourceFileSha256.slice(0, 16)}…</div>}
                    <div className="mt-1 flex gap-1">
                      {!active && <Btn variant="ghost" onClick={() => setActiveVersion(slot, v.id)} testId={`show-${v.id}`}>Show</Btn>}
                      <Btn variant="ghost" onClick={() => void exportMesh(slot, v.id, 'stl')} testId={`export-stl-${v.id}`}>STL</Btn>
                      <Btn variant="ghost" onClick={() => void exportMesh(slot, v.id, 'ply')} testId={`export-ply-${v.id}`}>PLY</Btn>
                    </div>
                  </li>
                );
              })}
            </ol>
          </Section>
        );
      })}
      <p className="text-[10px] text-gray-500">Versions live in this browser session only. Persisting them to the clinic system (scan_versions) is a later milestone.</p>
    </div>
  );
}
