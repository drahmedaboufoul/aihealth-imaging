/*
 * cbctAiFindings — presentational components for the assistive AI CBCT reader
 * (Phase 1): the clinician-verification banner, the findings side panel, and
 * the referenced-view lightbox.
 *
 * Pure presentation — the parent (CBCTVolumeViewer) owns view generation, the
 * ai-read-cbct invocation and all state. ASSISTIVE ONLY: every surface here
 * repeats that findings must be verified by the treating clinician; nothing
 * writes to the chart.
 *
 * Clinician review: the AI reading is a DRAFT the doctor amends — each finding
 * is confirmed or dismissed (with an optional note), the doctor can add
 * findings the AI missed and record an overall impression. The review is
 * persisted by the parent on ai_analysis.clinician_review, keyed to the
 * reading it reviewed via reader_created_at (a re-run marks it stale).
 */
import { useState, useEffect, useMemo } from 'react';
import {
  Sparkles, RefreshCw, X, Loader2, AlertTriangle, Eye, Check, Ban, Plus, Trash2, Save,
} from 'lucide-react';

// FDI permanent dentition, laid out anatomically (patient's right on the left).
const FDI_ROWS = [
  ['18', '17', '16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26', '27', '28'],
  ['48', '47', '46', '45', '44', '43', '42', '41', '31', '32', '33', '34', '35', '36', '37', '38'],
];
const SEVERITY_RANK = { high: 3, moderate: 2, low: 1 };

/** All FDI tooth numbers referenced by a finding's tooth field ("38", "34, 35", "13/23"). */
export const parseFdiTeeth = (tooth) =>
  (typeof tooth === 'string' ? tooth.match(/\d{2}/g) || [] : []).filter((t) => {
    const q = Number(t[0]);
    const n = Number(t[1]);
    return q >= 1 && q <= 4 && n >= 1 && n <= 8;
  });

export const SEVERITY_STYLES = {
  high: 'bg-red-500/15 text-red-300 border-red-500/40',
  moderate: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  low: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
};

export const FINDING_TYPE_LABELS = {
  impaction: 'Impaction',
  caries_suspect: 'Caries suspect',
  periapical_radiolucency: 'Periapical radiolucency',
  retained_root: 'Retained root',
  sinus_involvement: 'Sinus involvement',
  missing_tooth: 'Missing tooth',
  supernumerary: 'Supernumerary',
  bone_loss: 'Bone loss',
  other: 'Other',
};

const VIEW_LABEL_NAMES = {
  panoramic: 'Panoramic (OPG)',
  coronal_mid: 'Coronal (mid-dentition)',
  sagittal_mid: 'Sagittal (mid-dentition)',
  mip_frontal: 'Frontal MIP',
};
export const viewLabelName = (label) =>
  VIEW_LABEL_NAMES[label] || (label?.startsWith('axial_') ? `Axial slab ${label.split('_')[1]}` : label);

/** Persistent assistive-use banner — shown whenever an AI reading is on screen. */
export function AiAssistBanner() {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-[11px]">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>AI-assisted reading — must be verified by the treating clinician. Not a diagnosis.</span>
    </div>
  );
}

function FindingCard({ finding, onShowView, decision, onDecide, onNote }) {
  const sev = SEVERITY_STYLES[finding.severity] || SEVERITY_STYLES.low;
  const pct = Math.round((Number(finding.confidence) || 0) * 100);
  const status = decision?.status;
  const dismissed = status === 'dismissed';
  const confirmed = status === 'confirmed';
  return (
    <li className={`rounded-md border p-2.5 ${
      confirmed ? 'border-emerald-500/50 bg-emerald-500/5'
        : dismissed ? 'border-neutral-800 bg-neutral-900/40 opacity-60'
          : 'border-neutral-800 bg-neutral-900'
    }`}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-100 text-[11px] font-semibold">
          {finding.tooth ? `Tooth ${finding.tooth}` : finding.region || 'Region'}
        </span>
        <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 text-[10px] uppercase tracking-wide">
          {FINDING_TYPE_LABELS[finding.type] || finding.type}
        </span>
        <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide ${sev}`}>
          {finding.severity}
        </span>
        <span className="ml-auto text-[10px] text-neutral-400" title="Model confidence that the finding is real">
          {pct}% conf.
        </span>
      </div>
      {finding.tooth && finding.region && (
        <div className="text-[10px] text-neutral-500 mt-1">{finding.region}</div>
      )}
      <p className={`text-xs mt-1.5 leading-snug ${dismissed ? 'text-neutral-500 line-through' : 'text-neutral-300'}`}>
        {finding.description}
      </p>
      {Array.isArray(finding.view_refs) && finding.view_refs.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap mt-1.5">
          <Eye className="h-3 w-3 text-neutral-500" />
          {finding.view_refs.map((label) => (
            <button
              key={label}
              type="button"
              title={`Show ${viewLabelName(label)}`}
              onClick={() => onShowView?.(label)}
              className="px-1.5 py-0.5 rounded bg-neutral-800 text-[10px] text-amber-300 hover:bg-neutral-700"
            >
              {viewLabelName(label)}
            </button>
          ))}
        </div>
      )}
      {onDecide && (
        <div className="flex items-center gap-1.5 mt-2">
          <button
            type="button"
            onClick={() => onDecide(confirmed ? null : 'confirmed')}
            className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] ${
              confirmed
                ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300'
                : 'border-neutral-700 text-neutral-400 hover:border-emerald-500/50 hover:text-emerald-300'
            }`}
          >
            <Check className="h-3 w-3" /> Confirm
          </button>
          <button
            type="button"
            onClick={() => onDecide(dismissed ? null : 'dismissed')}
            className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] ${
              dismissed
                ? 'bg-red-500/15 border-red-500/50 text-red-300'
                : 'border-neutral-700 text-neutral-400 hover:border-red-500/50 hover:text-red-300'
            }`}
          >
            <Ban className="h-3 w-3" /> Dismiss
          </button>
          {!status && <span className="ml-auto text-[10px] text-amber-400/80">pending review</span>}
        </div>
      )}
      {onNote && status && (
        <input
          type="text"
          value={decision?.note || ''}
          onChange={(e) => onNote(e.target.value)}
          placeholder={dismissed ? 'Why dismissed (optional)…' : 'Clinical note (optional)…'}
          className="mt-1.5 w-full bg-neutral-800/70 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-amber-500/60"
        />
      )}
    </li>
  );
}

/**
 * FDI tooth chart linked to the findings list. Teeth referenced by any
 * non-dismissed finding are tinted by their worst severity; clicking a
 * flagged tooth filters the cards to that tooth.
 */
function ToothChart({ toothMap, selected, onSelect }) {
  const cellTone = (info) => {
    if (!info) return 'border-neutral-800 text-neutral-600';
    if (info.severity === 'high') return 'bg-red-500/25 border-red-500/70 text-red-200';
    if (info.severity === 'moderate') return 'bg-amber-500/25 border-amber-500/70 text-amber-200';
    return 'bg-emerald-500/20 border-emerald-500/60 text-emerald-200';
  };
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900 p-2">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">
        Teeth flagged {selected ? `— showing ${selected}` : ''}
      </div>
      {FDI_ROWS.map((row, ri) => (
        <div key={ri} className={`flex justify-center gap-[3px] ${ri ? 'mt-1' : ''}`}>
          {row.map((t, ci) => {
            const info = toothMap[t];
            return (
              <button
                key={t}
                type="button"
                disabled={!info}
                title={info ? `Tooth ${t}: ${info.count} finding${info.count === 1 ? '' : 's'} — click to filter` : `Tooth ${t}`}
                onClick={() => onSelect(selected === t ? null : t)}
                className={`w-[22px] h-6 rounded border text-[9px] font-mono leading-none ${cellTone(info)} ${
                  selected === t ? 'ring-2 ring-sky-400' : ''
                } ${info ? 'cursor-pointer hover:brightness-125' : 'cursor-default'} ${ci === 8 ? 'ml-1.5' : ''}`}
              >
                {t}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Mini-form to record a finding the AI missed. Same vocabulary as the reader. */
function AddFindingForm({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [tooth, setTooth] = useState('');
  const [type, setType] = useState('other');
  const [severity, setSeverity] = useState('low');
  const [description, setDescription] = useState('');
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded border border-dashed border-neutral-700 text-[11px] text-neutral-400 hover:border-amber-500/50 hover:text-amber-300"
      >
        <Plus className="h-3 w-3" /> Add a finding the AI missed
      </button>
    );
  }
  const submit = () => {
    if (!description.trim()) return;
    onAdd({
      tooth: tooth.trim() || null,
      region: '',
      type,
      severity,
      description: description.trim(),
    });
    setTooth(''); setType('other'); setSeverity('low'); setDescription('');
    setOpen(false);
  };
  return (
    <div className="rounded-md border border-amber-500/40 bg-neutral-900 p-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <input
          type="text" value={tooth} onChange={(e) => setTooth(e.target.value)}
          placeholder="Tooth (FDI)"
          className="w-20 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-amber-500/60"
        />
        <select
          value={type} onChange={(e) => setType(e.target.value)}
          className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-1.5 py-1 text-[11px] text-neutral-200 focus:outline-none"
        >
          {Object.entries(FINDING_TYPE_LABELS).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
        <select
          value={severity} onChange={(e) => setSeverity(e.target.value)}
          className="bg-neutral-800 border border-neutral-700 rounded px-1.5 py-1 text-[11px] text-neutral-200 focus:outline-none"
        >
          <option value="low">low</option>
          <option value="moderate">moderate</option>
          <option value="high">high</option>
        </select>
      </div>
      <textarea
        value={description} onChange={(e) => setDescription(e.target.value)}
        placeholder="What you see and where…" rows={2}
        className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-amber-500/60 resize-none"
      />
      <div className="flex items-center gap-1.5 justify-end">
        <button type="button" onClick={() => setOpen(false)}
          className="px-2 py-1 rounded text-[11px] text-neutral-400 hover:bg-neutral-800">Cancel</button>
        <button type="button" onClick={submit} disabled={!description.trim()}
          className="px-2 py-1 rounded bg-amber-500 text-black text-[11px] font-semibold hover:bg-amber-400 disabled:opacity-50">
          Add finding
        </button>
      </div>
    </div>
  );
}

/**
 * Findings side panel. `result` is ai_analysis.cbct_reader:
 *   { findings, summary, limitations, model, created_at, version }
 *
 * Review props (all optional — panel stays read-only without them):
 *   review        ai_analysis.clinician_review draft
 *                 { reader_created_at, decisions: {i: {status, note}}, added: [...],
 *                   impression, reviewed_by, reviewed_at }
 *   onDecide(i, status|null), onDecisionNote(i, note), onAddFinding(f),
 *   onRemoveAdded(i), onImpression(text), onSaveReview(), reviewSaving, reviewMsg
 */
export function AiFindingsPanel({
  result, busy, busyNote, error, costNote, onRun, onClose, onShowView,
  review, onDecide, onDecisionNote, onAddFinding, onRemoveAdded, onImpression,
  onSaveReview, reviewSaving, reviewMsg,
}) {
  const reviewable = !!(result && onDecide);
  const decisions = review?.decisions || {};
  const findingCount = result?.findings?.length || 0;
  const decidedCount = result?.findings?.filter((_, i) => decisions[i]?.status).length || 0;
  const confirmedCount = result?.findings?.filter((_, i) => decisions[i]?.status === 'confirmed').length || 0;
  // A review made against an earlier reading must not silently apply to a new
  // one — the decisions are positional. Flag it and let the doctor redo.
  const reviewStale = !!(review && result?.created_at && review.reader_created_at
    && review.reader_created_at !== result.created_at);

  // Tooth chart: worst severity per FDI tooth across non-dismissed AI findings
  // and clinician-added ones; clicking a flagged tooth filters the cards.
  const [toothFilter, setToothFilter] = useState(null);
  useEffect(() => { setToothFilter(null); }, [result?.created_at]);
  const toothMap = useMemo(() => {
    const map = {};
    const add = (tooth, severity) => {
      for (const t of parseFdiTeeth(tooth)) {
        const prev = map[t];
        const worse = !prev || (SEVERITY_RANK[severity] || 0) > (SEVERITY_RANK[prev.severity] || 0);
        map[t] = { severity: worse ? severity : prev.severity, count: (prev?.count || 0) + 1 };
      }
    };
    (result?.findings || []).forEach((f, i) => {
      if (decisions[i]?.status !== 'dismissed') add(f.tooth, f.severity);
    });
    (review?.added || []).forEach((f) => add(f.tooth, f.severity));
    return map;
  }, [result, review, decisions]);
  const matchesTooth = (f) => !toothFilter || parseFdiTeeth(f.tooth).includes(toothFilter);
  return (
    <div className="h-full w-full flex flex-col bg-neutral-950/95 border-l border-neutral-800">
      <div className="flex items-center gap-2 px-3 py-2 bg-neutral-900 border-b border-neutral-800">
        <Sparkles className="h-4 w-4 text-amber-400" />
        <span className="text-xs font-semibold text-neutral-100">AI Read — findings</span>
        <div className="ml-auto flex items-center gap-1">
          {/* AI tokens: price and the clinic's balance (metered clinics only). */}
          {costNote && <span className="mr-1 text-[10px] text-neutral-400" title="AI tokens">{costNote}</span>}
          <button
            type="button"
            title={result ? 'Re-run the AI reading' : 'Run the AI reading'}
            onClick={onRun}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 rounded bg-amber-500 text-black text-[11px] font-semibold hover:bg-amber-400 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {result ? 'Re-run' : 'Run'}
          </button>
          {onClose && (
            <button type="button" title="Close findings panel" onClick={onClose}
              className="p-1 rounded text-neutral-400 hover:bg-neutral-800">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* The persistent clinician-verification banner is pinned by the parent
          viewer above the stage; the panel keeps the reminder in its copy. */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {busy && (
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
            {busyNote || 'Generating views and reading the study…'}
          </div>
        )}
        {error && !busy && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2.5 text-xs text-red-300">
            {error}
          </div>
        )}
        {!busy && !error && !result && (
          <p className="text-xs text-neutral-500">
            Press <span className="text-amber-300">Run</span> to generate the AI view set (panoramic, axial
            slabs, coronal/sagittal) from this volume and request an assistive reading. Findings are
            suggestions only — the treating clinician confirms or dismisses each one.
          </p>
        )}

        {result && !busy && (
          <>
            {reviewStale && (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-[11px] text-amber-300">
                A saved review exists for an <strong>earlier</strong> reading of this study. The reading has
                since been re-run — re-review the findings below before saving.
              </div>
            )}

            {result.summary && (
              <div className="rounded-md border border-neutral-800 bg-neutral-900 p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">Summary</div>
                <p className="text-xs text-neutral-300 leading-snug">{result.summary}</p>
              </div>
            )}

            {(findingCount > 0 || review?.added?.length > 0) && (
              <ToothChart toothMap={toothMap} selected={toothFilter} onSelect={setToothFilter} />
            )}

            <div>
              <div className="flex items-baseline gap-2 mb-1.5 flex-wrap">
                <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                  Findings ({findingCount})
                </div>
                {reviewable && findingCount > 0 && (
                  <span className={`text-[10px] ${decidedCount === findingCount ? 'text-emerald-400' : 'text-amber-400/80'}`}>
                    {decidedCount}/{findingCount} reviewed · {confirmedCount} confirmed
                  </span>
                )}
                {toothFilter && (
                  <button
                    type="button"
                    onClick={() => setToothFilter(null)}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/50 text-sky-300 hover:bg-sky-500/25"
                  >
                    Tooth {toothFilter} × clear
                  </button>
                )}
              </div>
              {result.findings?.length ? (
                <ul className="space-y-2">
                  {result.findings.map((f, i) => (matchesTooth(f) ? (
                    <FindingCard
                      key={i}
                      finding={f}
                      onShowView={onShowView}
                      decision={reviewable ? decisions[i] : undefined}
                      onDecide={reviewable ? (status) => onDecide(i, status) : undefined}
                      onNote={reviewable ? (note) => onDecisionNote?.(i, note) : undefined}
                    />
                  ) : null))}
                </ul>
              ) : (
                <p className="text-xs text-neutral-500">
                  No clearly visible findings flagged. This does not rule out pathology — clinician review of
                  the full volume is still required.
                </p>
              )}
            </div>

            {reviewable && (
              <div className="space-y-2">
                {review?.added?.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1.5">
                      Clinician-added findings ({review.added.length})
                    </div>
                    <ul className="space-y-2">
                      {review.added.map((f, i) => (matchesTooth(f) ? (
                        <li key={i} className="rounded-md border border-sky-500/40 bg-neutral-900 p-2.5">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-100 text-[11px] font-semibold">
                              {f.tooth ? `Tooth ${f.tooth}` : 'Region'}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 text-[10px] uppercase tracking-wide">
                              {FINDING_TYPE_LABELS[f.type] || f.type}
                            </span>
                            <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide ${SEVERITY_STYLES[f.severity] || SEVERITY_STYLES.low}`}>
                              {f.severity}
                            </span>
                            <button
                              type="button" title="Remove this finding"
                              onClick={() => onRemoveAdded?.(i)}
                              className="ml-auto p-0.5 rounded text-neutral-500 hover:text-red-300 hover:bg-neutral-800"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                          <p className="text-xs text-neutral-300 mt-1.5 leading-snug">{f.description}</p>
                        </li>
                      ) : null))}
                    </ul>
                  </div>
                )}
                {onAddFinding && <AddFindingForm onAdd={onAddFinding} />}

                {onImpression && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
                      Clinician impression
                    </div>
                    <textarea
                      value={review?.impression || ''}
                      onChange={(e) => onImpression(e.target.value)}
                      placeholder="Your overall impression of this study (goes on the report)…"
                      rows={2}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-amber-500/60 resize-none"
                    />
                  </div>
                )}

                {onSaveReview && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={onSaveReview}
                      disabled={reviewSaving}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-emerald-600 text-white text-[11px] font-semibold hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {reviewSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      Save review
                    </button>
                    {reviewMsg && <span className="text-[10px] text-neutral-400 truncate">{reviewMsg}</span>}
                  </div>
                )}
                {review?.reviewed_at && !reviewStale && (
                  <div className="text-[10px] text-neutral-600">
                    Last reviewed {new Date(review.reviewed_at).toLocaleString()}
                    {review.reviewed_by ? ` by ${review.reviewed_by}` : ''}
                  </div>
                )}
              </div>
            )}

            {result.limitations && (
              <div className="rounded-md border border-neutral-800 bg-neutral-900 p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-1">Limitations</div>
                <p className="text-[11px] text-neutral-400 leading-snug">{result.limitations}</p>
              </div>
            )}

            <div className="text-[10px] text-neutral-600">
              {result.model && <span>Model: {result.model}</span>}
              {result.created_at && (
                <span> · {new Date(result.created_at).toLocaleString()}</span>
              )}
              {result.version && <span> · reader v{result.version}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Lightbox for the referenced AI input view. `view` = { label, url }. */
export function AiViewLightbox({ view, onClose }) {
  if (!view) return null;
  return (
    <div
      className="absolute inset-0 z-40 bg-black/85 flex flex-col items-center justify-center p-6"
      onClick={onClose}
      role="presentation"
    >
      <div className="text-xs text-amber-300 mb-2 font-semibold">{viewLabelName(view.label)}</div>
      <img
        src={view.url}
        alt={`AI input view: ${viewLabelName(view.label)}`}
        className="max-h-[80%] max-w-[90%] object-contain rounded border border-neutral-700 bg-black"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        onClick={onClose}
        className="mt-3 px-3 py-1.5 rounded bg-neutral-800 text-neutral-200 text-xs hover:bg-neutral-700"
      >
        Close
      </button>
    </div>
  );
}
