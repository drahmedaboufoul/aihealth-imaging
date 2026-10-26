/*
 * ImagingReportDialog — write/finalize a radiology report on a study.
 *
 * Imaging revival A2. Stores into imaging_reports (one report per study here).
 * A template (imaging_report_templates) seeds findings/impression. Draft is
 * editable; Finalize stamps reported_by/reported_at and locks the wording from
 * accidental template re-seeding.
 *
 * Staff write directly (imaging_reports is RLS-scoped to authenticated staff);
 * clinic_id is set on insert to satisfy the tenant write-check.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { useBrand } from '@/hooks/useBrand';
import { Loader2, X, FileText, CheckCircle2, Save, Sparkles } from 'lucide-react';
import { FINDING_TYPE_LABELS } from '@/components/viewers/cbctAiFindings';

// study_type → report-template modality
const TYPE_TO_TEMPLATE_MODALITY = {
  cbct: 'CBCT', panoramic: 'OPG', periapical: 'PA', bitewing: 'PA',
};

/**
 * Build report Findings/Impression text from the study's AI read
 * (ai_analysis.cbct_reader) and the clinician review of it
 * (ai_analysis.clinician_review). Dismissed findings are dropped; findings
 * not yet reviewed carry an explicit verify marker; clinician-added findings
 * are included and labelled. Provenance goes at the end of the findings.
 */
export function buildAiReportSeed(reader, review) {
  const decisions = review?.decisions || {};
  const lines = [];
  let confirmed = 0;
  let dismissed = 0;
  (reader?.findings || []).forEach((f, i) => {
    const d = decisions[i];
    if (d?.status === 'dismissed') { dismissed += 1; return; }
    if (d?.status === 'confirmed') confirmed += 1;
    const where = f.tooth ? `Tooth ${f.tooth}` : (f.region || 'Region');
    const type = FINDING_TYPE_LABELS[f.type] || f.type;
    const note = d?.note ? ` — ${d.note}` : '';
    const marker = d?.status === 'confirmed' ? '' : ' [AI flag — verify]';
    lines.push(`- ${where} — ${type} (${f.severity}): ${f.description}${note}${marker}`);
  });
  (review?.added || []).forEach((f) => {
    const where = f.tooth ? `Tooth ${f.tooth}` : (f.region || 'Region');
    const type = FINDING_TYPE_LABELS[f.type] || f.type;
    lines.push(`- ${where} — ${type} (${f.severity}): ${f.description} [clinician finding]`);
  });
  if (!lines.length) lines.push('- No clearly visible findings flagged by the assistive reading.');
  const provenance = [
    `AI-assisted reading${reader?.version ? ` (reader v${reader.version})` : ''} — verified by the treating clinician.`,
    review?.reviewed_at
      ? `Reviewed${review.reviewed_by ? ` by ${review.reviewed_by}` : ''} on ${new Date(review.reviewed_at).toLocaleDateString()}: ${confirmed} confirmed, ${dismissed} dismissed.`
      : 'Findings not yet reviewed in the viewer — verify each item before finalizing.',
  ].join(' ');
  return {
    findings: `${lines.join('\n')}\n\n${provenance}`,
    impression: (review?.impression || reader?.summary || '').trim(),
  };
}

export default function ImagingReportDialog({ study, clinicId, userId, onClose, onSaved }) {
  const { t } = useTranslation();
  const { brand } = useBrand();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [report, setReport] = useState(null); // existing row, if any
  const [aiRead, setAiRead] = useState(null); // { reader, review } from ai_analysis
  const [form, setForm] = useState({ template_id: '', findings: '', impression: '', recommendations: '' });

  const isFinal = report?.status === 'final';

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: tpls }, { data: existing }, { data: studyRow }] = await Promise.all([
        supabase.from('imaging_report_templates').select('id, name, modality, default_findings, default_impression').eq('active', true),
        supabase.from('imaging_reports').select('*').eq('study_id', study.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('imaging_studies').select('ai_analysis').eq('id', study.id).maybeSingle(),
      ]);
      setTemplates(tpls || []);
      const reader = studyRow?.ai_analysis?.cbct_reader;
      if (reader && Array.isArray(reader.findings)) {
        setAiRead({ reader, review: studyRow?.ai_analysis?.clinician_review || null });
      }
      if (existing) {
        setReport(existing);
        setForm({
          template_id: existing.template_id || '',
          findings: existing.findings || '',
          impression: existing.impression || '',
          recommendations: existing.recommendations || '',
        });
      } else {
        // Preselect a template matching the study modality.
        const wantMod = TYPE_TO_TEMPLATE_MODALITY[study.study_type];
        const match = (tpls || []).find((x) => x.modality === wantMod);
        if (match) {
          setForm({
            template_id: match.id,
            findings: match.default_findings || '',
            impression: match.default_impression || '',
            recommendations: '',
          });
        }
      }
      setLoading(false);
    })();
  }, [study.id, study.study_type]);

  const applyTemplate = (id) => {
    const tpl = templates.find((x) => x.id === id);
    // Only seed empty fields so we never clobber typed text.
    setForm((f) => ({
      ...f,
      template_id: id,
      findings: f.findings.trim() ? f.findings : (tpl?.default_findings || ''),
      impression: f.impression.trim() ? f.impression : (tpl?.default_impression || ''),
    }));
  };

  const applyAiSeed = () => {
    if (!aiRead) return;
    const seed = buildAiReportSeed(aiRead.reader, aiRead.review);
    // Replacing typed/template text is destructive — ask first.
    if ((form.findings.trim() || form.impression.trim())
      // eslint-disable-next-line no-alert
      && !window.confirm(t('emrPages.imgreport.ai_seed_replace', 'Replace the current Findings and Impression with the AI-read draft?'))) {
      return;
    }
    setForm((f) => ({ ...f, findings: seed.findings, impression: seed.impression || f.impression }));
  };

  const persist = async (status) => {
    if (status === 'final' && !form.impression.trim()) {
      alert(t('emrPages.imgreport.need_impression', 'An impression is required to finalize the report.'));
      return;
    }
    setSaving(true);
    const base = {
      study_id: study.id,
      clinic_id: clinicId,
      patient_id: study.patient_id,
      template_id: form.template_id || null,
      modality: study.study_type,
      findings: form.findings.trim() || null,
      impression: form.impression.trim() || null,
      recommendations: form.recommendations.trim() || null,
      status,
    };
    if (status === 'final') { base.reported_by = userId || null; base.reported_at = new Date().toISOString(); }

    let error;
    if (report?.id) {
      ({ error } = await supabase.from('imaging_reports').update(base).eq('id', report.id));
    } else {
      ({ error } = await supabase.from('imaging_reports').insert({ ...base, created_by: userId || null }));
    }
    setSaving(false);
    if (error) { alert(t('emrPages.imgreport.save_failed', { msg: error.message, defaultValue: 'Save failed: {{msg}}' })); return; }
    onSaved?.(status);
  };

  const C = brand;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: '100%', maxWidth: 640, maxHeight: '92vh', overflowY: 'auto', padding: 20, fontFamily: "'Poppins', system-ui, sans-serif" }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: C.brown, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FileText size={16} style={{ color: C.gold }} /> {t('emrPages.imgreport.title', 'Radiology report')}
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.muted }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 16 }}>
          {study.customers?.name || ''}{study.study_type ? ` · ${study.study_type}` : ''}
          {isFinal && <span style={{ marginLeft: 8, color: '#065F46', fontWeight: 600 }}>· {t('emrPages.imgreport.finalized', 'Finalized')}</span>}
        </div>

        {loading ? (
          <div style={{ padding: 28, textAlign: 'center', color: C.muted }}><Loader2 size={18} className="animate-spin inline" /></div>
        ) : (
          <>
            <label style={lbl(C)}>{t('emrPages.imgreport.template', 'Template')}</label>
            <select value={form.template_id} onChange={(e) => applyTemplate(e.target.value)} disabled={isFinal} style={inp(C)}>
              <option value="">{t('emrPages.imgreport.no_template', '— No template —')}</option>
              {templates.map((tp) => <option key={tp.id} value={tp.id}>{tp.name} ({tp.modality})</option>)}
            </select>

            {aiRead && !isFinal && (
              <div style={{ marginTop: 14, padding: '8px 10px', borderRadius: 6, border: '1px solid ' + C.line, background: C.cream, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Sparkles size={13} style={{ color: C.gold, flexShrink: 0 }} />
                <span style={{ fontSize: 11.5, color: C.brown, flex: 1, minWidth: 180 }}>
                  {aiRead.review?.reviewed_at
                    ? t('emrPages.imgreport.ai_seed_reviewed', 'This study has a clinician-reviewed AI reading.')
                    : t('emrPages.imgreport.ai_seed_unreviewed', 'This study has an AI reading (not yet reviewed in the viewer).')}
                </span>
                <button type="button" onClick={applyAiSeed}
                  style={{ padding: '5px 10px', fontSize: 11, fontWeight: 600, background: C.brown, color: C.cream, border: 'none', borderRadius: 5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <Sparkles size={11} /> {t('emrPages.imgreport.ai_seed_btn', 'Draft from AI read')}
                </button>
              </div>
            )}

            <div style={{ height: 14 }} />
            <label style={lbl(C)}>{t('emrPages.imgreport.findings', 'Findings')}</label>
            <textarea value={form.findings} onChange={(e) => setForm({ ...form, findings: e.target.value })} disabled={isFinal} rows={5}
              placeholder={t('emrPages.imgreport.findings_ph', 'Describe what is seen…')} style={{ ...inp(C), resize: 'vertical' }} />

            <div style={{ height: 14 }} />
            <label style={lbl(C)}>{t('emrPages.imgreport.impression', 'Impression')}</label>
            <textarea value={form.impression} onChange={(e) => setForm({ ...form, impression: e.target.value })} disabled={isFinal} rows={3}
              placeholder={t('emrPages.imgreport.impression_ph', 'Diagnostic conclusion…')} style={{ ...inp(C), resize: 'vertical' }} />

            <div style={{ height: 14 }} />
            <label style={lbl(C)}>{t('emrPages.imgreport.recommendations', 'Recommendations (optional)')}</label>
            <textarea value={form.recommendations} onChange={(e) => setForm({ ...form, recommendations: e.target.value })} disabled={isFinal} rows={2}
              placeholder={t('emrPages.imgreport.recommendations_ph', 'Suggested follow-up…')} style={{ ...inp(C), resize: 'vertical' }} />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              {isFinal ? (
                <span style={{ fontSize: 12, color: '#065F46', display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'center' }}>
                  <CheckCircle2 size={14} /> {t('emrPages.imgreport.report_final', 'Report finalized — read only.')}
                </span>
              ) : (
                <>
                  <button onClick={() => persist('draft')} disabled={saving} style={{ ...btn('transparent', C), border: '1px solid ' + C.line, color: C.brown }}>
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} {t('emrPages.imgreport.save_draft', 'Save draft')}
                  </button>
                  <button onClick={() => persist('final')} disabled={saving} style={btn(C.brown, C)}>
                    <CheckCircle2 size={12} /> {t('emrPages.imgreport.finalize', 'Finalize')}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const lbl = (C) => ({ display: 'block', fontSize: 10, fontWeight: 600, color: C.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' });
const inp = (C) => ({ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid ' + C.line, borderRadius: 6, color: C.brown, fontFamily: 'inherit', outline: 'none', background: '#fff' });
const btn = (bg, C) => ({ padding: '7px 14px', fontSize: 12, fontWeight: 600, background: bg, color: bg === 'transparent' ? C.brown : C.cream, border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6 });
