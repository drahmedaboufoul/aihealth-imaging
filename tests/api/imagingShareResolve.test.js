import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeReq, makeRes, makeFakeSupabase } from './helpers';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

const FUTURE = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 3600 * 1000).toISOString();

function invite(overrides = {}) {
  return {
    id: 'inv-1',
    study_id: 'study-1',
    expires_at: FUTURE,
    revoked_at: null,
    view_count: 0,
    max_views: 5,
    permission: 'view',
    invited_email: 'dr@example.com',
    source: 'email',
    ...overrides,
  };
}

function study(overrides = {}) {
  return {
    id: 'study-1',
    study_type: 'cbct_scan',
    study_date: '2026-05-01',
    description: 'Pre-op CBCT',
    status: 'ready',
    nifti_status: null,
    nifti_storage_path: null,
    viewer_annotations: null,
    patient_id: 'pat-1',
    customers: { name: 'Jane Doe' },
    ...overrides,
  };
}

/** Import a fresh handler instance with env + supabase mock configured. */
async function loadHandler({ env = {}, fake } = {}) {
  vi.resetModules();
  vi.stubEnv('SUPABASE_URL', env.SUPABASE_URL ?? 'https://supabase.test');
  vi.stubEnv('VITE_SUPABASE_URL', env.VITE_SUPABASE_URL ?? '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY ?? 'service-key');
  const { createClient } = await import('@supabase/supabase-js');
  if (fake) createClient.mockReturnValue(fake.client);
  const { default: handler } = await import('../../api/imaging-share-resolve.js');
  return { handler, createClient };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe('imaging-share-resolve — request validation', () => {
  it('answers OPTIONS preflight with 204 and CORS headers', async () => {
    const { handler } = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers['Access-Control-Allow-Methods']).toContain('POST');
  });

  it('rejects non-POST methods with 405', async () => {
    const { handler } = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 503 when service env vars are missing', async () => {
    const { handler } = await loadHandler({
      env: { SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' },
    });
    const res = makeRes();
    await handler(makeReq({ body: { token: 'tok' } }), res);
    expect(res.statusCode).toBe(503);
  });

  it('returns 400 for a missing or non-string token', async () => {
    const { handler } = await loadHandler();
    for (const body of [{}, { token: 123 }, null]) {
      const res = makeRes();
      await handler(makeReq({ body }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/token/i);
    }
  });
});

describe('imaging-share-resolve — token gate', () => {
  it('404s an unknown token', async () => {
    const fake = makeFakeSupabase({ results: { imaging_share_invites: { data: null, error: null } } });
    const { handler } = await loadHandler({ fake });
    const res = makeRes();
    await handler(makeReq({ body: { token: 'nope' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('Invite not found');
  });

  it('403s a revoked invite', async () => {
    const fake = makeFakeSupabase({
      results: { imaging_share_invites: { data: invite({ revoked_at: PAST }), error: null } },
    });
    const { handler } = await loadHandler({ fake });
    const res = makeRes();
    await handler(makeReq({ body: { token: 'tok' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Invite was revoked');
  });

  it('403s an expired invite', async () => {
    const fake = makeFakeSupabase({
      results: { imaging_share_invites: { data: invite({ expires_at: PAST }), error: null } },
    });
    const { handler } = await loadHandler({ fake });
    const res = makeRes();
    await handler(makeReq({ body: { token: 'tok' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Invite expired');
  });

  it('403s once the view limit is reached', async () => {
    const fake = makeFakeSupabase({
      results: { imaging_share_invites: { data: invite({ view_count: 5, max_views: 5 }), error: null } },
    });
    const { handler } = await loadHandler({ fake });
    const res = makeRes();
    await handler(makeReq({ body: { token: 'tok' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('View limit reached');
  });

  it('404s when the study row is gone', async () => {
    const fake = makeFakeSupabase({
      results: {
        imaging_share_invites: { data: invite(), error: null },
        imaging_studies: { data: null, error: null },
      },
    });
    const { handler } = await loadHandler({ fake });
    const res = makeRes();
    await handler(makeReq({ body: { token: 'tok' } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('Study not found');
  });
});

describe('imaging-share-resolve — happy path', () => {
  const files = [
    { id: 'f1', storage_path: 'study-1/001.dcm', original_filename: '001.dcm', sop_instance_uid: '1.1', file_kind: 'dicom', file_size: 1000 },
    { id: 'f2', storage_path: 'study-1/002.dcm', original_filename: null, sop_instance_uid: '1.2', file_kind: 'dicom', file_size: 1001 },
  ];

  it('returns the study summary, signed files, and bumped view count', async () => {
    const fake = makeFakeSupabase({
      results: {
        imaging_share_invites: { data: invite(), error: null },
        imaging_studies: { data: study(), error: null },
        imaging_files: { data: files, error: null },
      },
    });
    const { handler, createClient } = await loadHandler({ fake });
    const res = makeRes();
    await handler(makeReq({ body: { token: 'tok' } }), res);

    expect(createClient).toHaveBeenCalledWith(
      'https://supabase.test',
      'service-key',
      expect.objectContaining({ auth: expect.any(Object) }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.study).toEqual({
      id: 'study-1',
      study_type: 'cbct_scan',
      study_date: '2026-05-01',
      description: 'Pre-op CBCT',
      patient_name: 'Jane Doe',
    });
    expect(res.body.view_count).toBe(1);
    expect(res.body.permission).toBe('view');
    expect(res.body.files).toHaveLength(2);
    expect(res.body.files[0].url).toBe('https://signed.test/imaging/study-1/001.dcm');
    // Falls back to the storage key basename when original_filename is null
    expect(res.body.files[1].fileName).toBe('002.dcm');
    expect(res.body.niftiUrl).toBeNull(); // nifti not ready
    // Signed against the imaging bucket with a 1h TTL
    expect(fake.calls.signed[0]).toEqual({ bucket: 'imaging', path: 'study-1/001.dcm', ttl: 3600 });
  });

  it('records the view: increments view_count and stamps accepted_at on first view', async () => {
    const fake = makeFakeSupabase({
      results: {
        imaging_share_invites: { data: invite({ view_count: 0 }), error: null },
        imaging_studies: { data: study(), error: null },
        imaging_files: { data: files, error: null },
      },
    });
    const { handler } = await loadHandler({ fake });
    await handler(makeReq({ body: { token: 'tok' } }), makeRes());
    expect(fake.calls.updates).toHaveLength(1);
    expect(fake.calls.updates[0].table).toBe('imaging_share_invites');
    expect(fake.calls.updates[0].payload.view_count).toBe(1);
    expect(typeof fake.calls.updates[0].payload.accepted_at).toBe('string');
  });

  it('does not overwrite accepted_at on repeat views', async () => {
    const fake = makeFakeSupabase({
      results: {
        imaging_share_invites: { data: invite({ view_count: 2 }), error: null },
        imaging_studies: { data: study(), error: null },
        imaging_files: { data: files, error: null },
      },
    });
    const { handler } = await loadHandler({ fake });
    const res = makeRes();
    await handler(makeReq({ body: { token: 'tok' } }), res);
    expect(res.body.view_count).toBe(3);
    expect(fake.calls.updates[0].payload.accepted_at).toBeUndefined();
  });

  it('filters out files whose signing failed instead of failing the request', async () => {
    const fake = makeFakeSupabase({
      results: {
        imaging_share_invites: { data: invite(), error: null },
        imaging_studies: { data: study(), error: null },
        imaging_files: { data: files, error: null },
      },
      signUrl: (bucket, path) => (
        path.endsWith('001.dcm')
          ? { data: { signedUrl: `https://signed.test/${bucket}/${path}` }, error: null }
          : { data: null, error: { message: 'denied' } }
      ),
    });
    const { handler } = await loadHandler({ fake });
    const res = makeRes();
    await handler(makeReq({ body: { token: 'tok' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].fileName).toBe('001.dcm');
  });

  it('signs the converted NIfTI from the derived bucket when ready', async () => {
    const fake = makeFakeSupabase({
      results: {
        imaging_share_invites: { data: invite(), error: null },
        imaging_studies: {
          data: study({ nifti_status: 'ready', nifti_storage_path: 'study-1/vol.nii.gz' }),
          error: null,
        },
        imaging_files: { data: [], error: null },
      },
    });
    const { handler } = await loadHandler({ fake });
    const res = makeRes();
    await handler(makeReq({ body: { token: 'tok' } }), res);
    expect(res.body.niftiUrl).toBe('https://signed.test/imaging-derived/study-1/vol.nii.gz');
    expect(fake.calls.signed.some((s) => s.bucket === 'imaging-derived')).toBe(true);
  });
});
