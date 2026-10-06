export const CLINICAL_MEDIA_SIGNED_URL_EXPIRY_SECONDS = 10 * 60;

export function isLiveImagingStudy(study, clinic) {
  return Boolean(
    study
    && !study.archived_at
    && study.status !== 'archived'
    && clinic?.is_active === true
    && !clinic?.suspended_at,
  );
}

export function imagingInviteMatchesStudy(invite, study) {
  return Boolean(
    invite?.study_id
    && invite?.clinic_id
    && study?.id
    && study?.clinic_id
    && invite.study_id === study.id
    && invite.clinic_id === study.clinic_id,
  );
}

// Patient-owned portal links require today's release decision. Explicit clinician
// invitations have their own recipient authorization and need not be patient-visible.
export const patientReleaseAllowsInvite = (invite, study) => invite?.source !== 'patient' || study?.is_visible_to_patient === true;

export function sourceArtifactsMatchFiles(study, files, ids, artifacts) {
  if (!Array.isArray(files) || !files.length || !Array.isArray(artifacts)
      || new Set(ids).size !== ids.length || ids.length !== files.length || artifacts.length !== files.length
      || new Set(files.map(f => f.id)).size !== files.length
      || new Set(files.map(f => f.storage_path)).size !== files.length
      || new Set(artifacts.map(a => a.id)).size !== artifacts.length) return false;
  return files.every(f => artifacts.filter(a => ids.includes(a.id)
    && a.source_table === 'imaging_files' && a.source_id === f.id && a.source_slot === 'primary'
    && a.artifact_kind === 'source_file' && a.clinic_id === study.clinic_id && a.patient_id === study.patient_id
    && a.encounter_id === study.encounter_id && a.filing_scope === study.filing_scope
    && (study.encounter_id != null || study.filing_scope === 'patient_external')
    && f.clinic_id === study.clinic_id && f.asset_role === 'source' && f.storage_bucket === 'imaging'
    && a.storage_bucket === f.storage_bucket && a.storage_path === f.storage_path
    && /^[0-9a-f]{64}$/.test(f.sha256 || '') && a.sha256 === f.sha256).length === 1);
}
