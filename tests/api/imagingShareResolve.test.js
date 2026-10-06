import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeReq, makeRes } from './helpers';
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
const token = 'a'.repeat(48);
const future = () => new Date(Date.now() + 3600000).toISOString();
const hash = 'a'.repeat(64);
function fixture() {
  const study = { id: 's1', clinic_id: 'c1', patient_id: 'p1', encounter_id: null,
    filing_scope: 'patient_external', study_type: 'other', status: 'captured', archived_at: null,
    is_visible_to_patient: true, customers: { name: 'Synthetic Example' } };
  const files = [1, 2].map(n => ({ id: `f${n}`, clinic_id: 'c1', storage_bucket: 'imaging',
    storage_path: `c1/s1/${n}.dcm`, original_filename: `${n}.dcm`, sha256: hash, asset_role: 'source',
    file_kind: 'dicom', series_instance_uid: '1.2.3', sop_instance_uid: `1.2.3.${n}`,
    instance_number: n, dicom_acquisition: { numberOfFrames: n } }));
  return {
    imaging_studies: study,
    imaging_share_invites: { id: 'i1', study_id: 's1', clinic_id: 'c1', source: 'patient',
      view_count: 0, max_views: 2, revoked_at: null, expires_at: future(), permission: 'view' },
    clinics: { id: 'c1', is_active: true, suspended_at: null },
    imaging_files: files,
    clinical_media_artifacts: files.map(f => ({ id: `a${f.id}`, source_table: 'imaging_files',
      source_id: f.id, source_slot: 'primary', artifact_kind: 'source_file', clinic_id: 'c1', patient_id: 'p1',
      encounter_id: null, filing_scope: 'patient_external', storage_bucket: 'imaging', storage_path: f.storage_path, sha256: hash })),
    patient_external_imaging_intakes: [{ study_id: 's1', clinic_id: 'c1', patient_id: 'p1', session: {
      study_id: 's1', clinic_id: 'c1', patient_id: 'p1', encounter_id: null, filing_scope: 'patient_external',
      status: 'completed', finalized_count: 2, item_count: 2 } }],
  };
}
async function run({ mutate, sign, batchTransform, rpc, claimFails, method = 'POST', body = { token }, afterClaim } = {}) {
  vi.resetModules();
  vi.stubEnv('SUPABASE_URL', 'https://synthetic.invalid');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-test-value');
  const rows = fixture(); mutate?.(rows);
  const calls = { signed: [], batches: [], filters: [], rpc: [] };
  const client = {
    from(table) {
      let patch, ids;
      const result = () => {
        if (patch) {
          if (claimFails) return { data: null, error: null };
          Object.assign(rows[table], patch);
          const data = { ...rows[table] };
          afterClaim?.(rows);
          return { data, error: null };
        }
        return { data: structuredClone(table === 'clinical_media_artifacts' && ids ? rows[table].filter(a => ids.includes(a.id)) : rows[table] ?? null), error: null };
      };
      const q = {
        select: () => q, update: p => { patch = p; return q; },
        eq: (k, v) => { calls.filters.push([table, 'eq', k, v]); return q; },
        in: (k, v) => { ids = v; calls.filters.push([table, 'in', k, v]); return q; },
        is: (k, v) => { calls.filters.push([table, 'is', k, v]); return q; },
        gt: (k, v) => { calls.filters.push([table, 'gt', k, v]); return q; },
        maybeSingle: async () => result(), then: (a, b) => Promise.resolve(result()).then(a, b),
      }; return q;
    },
    rpc: async (name, args) => {
      calls.rpc.push([name, args]);
      return rpc?.(name, rows, calls) ?? { data: rows.clinical_media_artifacts.map(a => a.id), error: null };
    },
    storage: { from: bucket => ({
      createSignedUrls: async (paths, ttl) => {
        calls.batches.push(paths);
        const data = paths.map(path => {
          calls.signed.push({ bucket, path, ttl });
          const result = sign?.(rows, path) ?? { data: { signedUrl: `https://signed.invalid/${path}` }, error: null };
          return { path, signedUrl: result.data?.signedUrl, error: result.error };
        });
        return { data: batchTransform?.(data) ?? data, error: null };
      },
      createSignedUrl: async (path, ttl) => {
      calls.signed.push({ bucket, path, ttl });
      return sign?.(rows, path) ?? { data: { signedUrl: `https://signed.invalid/${path}` }, error: null };
    } }) },
  };
  const { createClient } = await import('@supabase/supabase-js'); createClient.mockReturnValue(client);
  const { default: handler } = await import('../../api/imaging-share-resolve');
  const res = makeRes(); await handler(makeReq({ method, body }), res);
  return { res, calls, rows };
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('share resolution release and immutable manifest authorization', () => {
  it('returns complete patient-level DICOM source metadata and short-lived URLs without needing an encounter', async () => {
    const { res, calls } = await run();
    expect(res.statusCode).toBe(200);
    expect(res.body.files).toHaveLength(2);
    expect(res.body.files[1]).toMatchObject({ fileId: 'f2', seriesInstanceUid: '1.2.3', instanceNumber: 2, dicomAcquisition: { numberOfFrames: 2 } });
    expect(res.body.files[0]).not.toHaveProperty('sha256');
    expect(res.body.view_count).toBe(1);
    expect(Date.parse(res.body.signed_urls_expires_at)).toBeGreaterThan(Date.now());
    expect(calls.signed.every(c => c.ttl === 600)).toBe(true);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(calls.filters).toContainEqual(['imaging_share_invites', 'eq', 'view_count', 0]);
    expect(calls.filters).toContainEqual(['imaging_share_invites', 'eq', 'max_views', 2]);
    expect(calls.filters).toContainEqual(['imaging_share_invites', 'is', 'revoked_at', null]);
  });
  it.each([
    ['archived study', r => { r.imaging_studies.archived_at = future(); }],
    ['suspended clinic', r => { r.clinics.suspended_at = future(); }],
    ['inactive clinic', r => { r.clinics.is_active = false; }],
    ['wrong invite clinic', r => { r.imaging_share_invites.clinic_id = 'other'; }],
    ['unreleased patient study', r => { r.imaging_studies.is_visible_to_patient = false; }],
  ])('blocks %s before signing', async (_, mutate) => {
    const { res, calls } = await run({ mutate }); expect(res.statusCode).toBe(410); expect(calls.signed).toHaveLength(0);
  });
  it('preserves explicit clinician invitations when patient visibility is off', async () => {
    const { res } = await run({ mutate: r => { r.imaging_share_invites.source = 'email'; r.imaging_studies.is_visible_to_patient = false; } });
    expect(res.statusCode).toBe(200);
  });
  it.each([
    ['missing source', r => r.imaging_files.pop()],
    ['extra source', r => r.imaging_files.push({ ...r.imaging_files[0], id: 'extra' })],
    ['duplicate source', r => { r.imaging_files[1] = { ...r.imaging_files[0] }; }],
    ['wrong hash', r => { r.clinical_media_artifacts[0].sha256 = 'b'.repeat(64); }],
    ['wrong patient', r => { r.clinical_media_artifacts[0].patient_id = 'other'; }],
    ['wrong scope', r => { r.clinical_media_artifacts[0].filing_scope = 'encounter'; }],
    ['wrong path', r => { r.clinical_media_artifacts[0].storage_path = 'elsewhere'; }],
    ['incomplete intake', r => { r.patient_external_imaging_intakes[0].session.status = 'uploading'; }],
    ['null encounter outside explicit scope', r => { r.imaging_studies.filing_scope = 'encounter'; r.clinical_media_artifacts.forEach(a => { a.filing_scope = 'encounter'; }); }],
  ])('rejects %s rather than returning a partial series', async (_, mutate) => {
    const { res, calls } = await run({ mutate }); expect(res.statusCode).toBe(409); expect(calls.signed).toHaveLength(0);
  });
  it('blocks unresolved provenance RPC', async () => {
    const { res, calls } = await run({ rpc: () => ({ data: null, error: { message: 'unreconciled' } }) });
    expect(res.statusCode).toBe(409); expect(calls.signed).toHaveLength(0);
  });
  it('rejects duplicate artifact IDs despite equal counts', async () => {
    const { res, calls } = await run({ rpc: () => ({ data: ['af1', 'af1'], error: null }) });
    expect(res.statusCode).toBe(409); expect(calls.signed).toHaveLength(0);
  });
  it('allows a correctly scoped encounter study', async () => {
    const { res } = await run({ mutate: r => {
      Object.assign(r.imaging_studies, { filing_scope: 'encounter', encounter_id: 'e1' });
      r.clinical_media_artifacts.forEach(a => Object.assign(a, { filing_scope: 'encounter', encounter_id: 'e1' }));
    } }); expect(res.statusCode).toBe(200);
  });
  it('blocks a lost final-view claim before minting URLs', async () => {
    const { res, calls } = await run({ claimFails: true }); expect(res.statusCode).toBe(403); expect(calls.signed).toHaveLength(0);
  });
  it('blocks withdrawal between claim and signing', async () => {
    const { res, calls } = await run({ afterClaim: r => { r.imaging_studies.is_visible_to_patient = false; } });
    expect(res.statusCode).toBe(410); expect(calls.signed).toHaveLength(0);
  });
  it.each(['revoke', 'hide', 'archive', 'suspend', 'source'])('does not disclose signed URLs after concurrent %s', async kind => {
    const { res } = await run({ sign: r => {
      if (kind === 'revoke') r.imaging_share_invites.revoked_at = future();
      if (kind === 'hide') r.imaging_studies.is_visible_to_patient = false;
      if (kind === 'archive') r.imaging_studies.archived_at = future();
      if (kind === 'suspend') r.clinics.suspended_at = future();
      if (kind === 'source') r.clinical_media_artifacts[0].id = 'different';
    } }); expect(res.statusCode).toBe(410); expect(res.body.files).toBeUndefined();
  });
  it('fails closed when any source signing fails', async () => {
    const { res } = await run({ sign: (_r, path) => path.endsWith('2.dcm') ? { data: null, error: {} } : undefined });
    expect(res.statusCode).toBe(502); expect(res.body.files).toBeUndefined();
  });
  it('never signs an unverified derived NIfTI', async () => {
    const { res, calls } = await run({ mutate: r => Object.assign(r.imaging_studies, { nifti_status: 'ready', nifti_storage_path: 'unverified.nii' }),
      rpc: (name, r) => name === 'clinical_media_current_cbct_nifti_artifact' ? { data: null, error: {} } : { data: r.clinical_media_artifacts.map(a => a.id), error: null } });
    expect(res.statusCode).toBe(200); expect(res.body.niftiUrl).toBeNull(); expect(calls.signed.every(c => c.bucket === 'imaging')).toBe(true);
  });
  it.each([{}, { token: 'short' }, { token: 1 }])('validates tokens before querying %j', async body => {
    const { res, calls } = await run({ body }); expect(res.statusCode).toBe(400); expect(calls.signed).toHaveLength(0);
  });
  it.each(['revoked', 'expired', 'invalid-expiry', 'exhausted'])('rejects %s invitation', async state => {
    const { res, calls } = await run({ mutate: r => {
      if (state === 'revoked') r.imaging_share_invites.revoked_at = future();
      if (state === 'expired') r.imaging_share_invites.expires_at = new Date(0).toISOString();
      if (state === 'invalid-expiry') r.imaging_share_invites.expires_at = 'bad';
      if (state === 'exhausted') r.imaging_share_invites.view_count = 2;
    } }); expect(res.statusCode).toBe(403); expect(calls.signed).toHaveLength(0);
  });
  it('answers CORS preflight', async () => { const { res } = await run({ method: 'OPTIONS' }); expect(res.statusCode).toBe(204); });
  it('rejects unsupported methods', async () => { const { res } = await run({ method: 'GET' }); expect(res.statusCode).toBe(405); });
});


describe('CBCT remains pinned to the database-selected diagnostic sources', () => {
  const cbct = r => {
    Object.assign(r.imaging_studies, { study_type: 'cbct', encounter_id: 'e1', filing_scope: 'encounter' });
    r.clinical_media_artifacts.forEach(a => Object.assign(a, { encounter_id: 'e1', filing_scope: 'encounter' }));
  };
  const diagnostic = r => r.imaging_files.map(f => ({ ...f, file_id: f.id, artifact_id: `a${f.id}` }));
  it('signs only the database-authorized diagnostic files', async () => {
    const { res } = await run({ mutate: cbct, rpc: (name, r) => ({ data: name === 'clinical_media_cbct_diagnostic_files' ? diagnostic(r) : null, error: null }) });
    expect(res.statusCode).toBe(200); expect(res.body.files).toHaveLength(2);
  });
  it('blocks an unreconciled diagnostic source set', async () => {
    const { res, calls } = await run({ mutate: cbct, rpc: () => ({ data: [], error: null }) });
    expect(res.statusCode).toBe(409); expect(calls.signed).toHaveLength(0);
  });
  it('blocks equal-count substitution after the view claim', async () => {
    const { res, calls } = await run({ mutate: cbct, rpc: (_name, r, calls) => ({ data: diagnostic(r).map(f => calls.rpc.length > 1 ? { ...f, storage_path: 'changed' } : f), error: null }) });
    expect(res.statusCode).toBe(410); expect(calls.signed).toHaveLength(0);
  });
});


it('authorizes a 317-instance synthetic MR manifest in bounded artifact query batches', async () => {
  const { res, calls } = await run({ mutate: r => {
    const source = r.imaging_files[0], artifact = r.clinical_media_artifacts[0];
    r.imaging_files = Array.from({ length: 317 }, (_, i) => ({ ...source, id: `f${i}`, storage_path: `c1/s1/${i}.dcm`, sop_instance_uid: `1.2.${i}` }));
    r.clinical_media_artifacts = r.imaging_files.map(f => ({ ...artifact, id: `a${f.id}`, source_id: f.id, storage_path: f.storage_path }));
    Object.assign(r.patient_external_imaging_intakes[0].session, { item_count: 317, finalized_count: 317 });
  } });
  expect(res.statusCode).toBe(200); expect(res.body.files).toHaveLength(317);
  const batches = calls.filters.filter(([table, op]) => table === 'clinical_media_artifacts' && op === 'in');
  expect(batches.map(batch => batch[3].length)).toEqual([100,100,100,17]);
  expect(calls.batches.map(batch => batch.length)).toEqual([100,100,100,17]);
});


it.each([
  ['missing', data => data.slice(1)],
  ['extra', data => [...data, { path: 'extra', signedUrl: 'https://signed.invalid/extra' }]],
  ['duplicate', data => [data[0], data[0]]],
  ['substituted', data => [{ ...data[0], path: 'other' }, data[1]]],
])('rejects %s batch-signing response paths', async (_name, batchTransform) => {
  const { res } = await run({ batchTransform }); expect(res.statusCode).toBe(502); expect(res.body.files).toBeUndefined();
});
it('binds reordered batch-signing results by path rather than array position', async () => {
  const { res } = await run({ batchTransform: data => [...data].reverse() });
  expect(res.statusCode).toBe(200);
  expect(res.body.files[0]).toMatchObject({ fileId: 'f1', url: 'https://signed.invalid/c1/s1/1.dcm' });
});
