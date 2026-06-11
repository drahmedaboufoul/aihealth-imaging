import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeReq, makeRes, makeFakeSupabase } from './helpers';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));

/** Import a fresh handler with env + supabase mock + upstream fetch stub. */
async function loadHandler({ env = {}, fake, fetchImpl } = {}) {
  vi.resetModules();
  vi.stubEnv('SUPABASE_URL', env.SUPABASE_URL ?? 'https://supabase.test');
  vi.stubEnv('AI_INFERENCE_URL', env.AI_INFERENCE_URL ?? 'https://infer.test');
  vi.stubEnv('INFERENCE_INTERNAL_KEY', env.INFERENCE_INTERNAL_KEY ?? 'internal-key');
  const { createClient } = await import('@supabase/supabase-js');
  if (fake) createClient.mockReturnValue(fake.client);
  if (fetchImpl) vi.stubGlobal('fetch', fetchImpl);
  const { default: handler } = await import('../../api/ai-infer.js');
  return { handler, createClient };
}

function accessibleStudy() {
  return makeFakeSupabase({
    results: { imaging_studies: { data: { id: 'study-1', nifti_status: 'ready' }, error: null } },
  });
}

function okUpstream(body = { job_id: 'job-1', status: 'queued' }) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

const AUTHED = { authorization: 'Bearer user-jwt' };

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('ai-infer — request validation', () => {
  it('answers OPTIONS preflight with 204 and CORS headers', async () => {
    const { handler } = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ method: 'OPTIONS' }), res);
    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Headers']).toContain('Authorization');
  });

  it('rejects non-POST methods with 405', async () => {
    const { handler } = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ method: 'PUT' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 503 when the inference service is not configured', async () => {
    const { handler } = await loadHandler({ env: { AI_INFERENCE_URL: '', INFERENCE_INTERNAL_KEY: '' } });
    const res = makeRes();
    await handler(makeReq({ body: { study_id: 's', model: 'nerve-canal' } }), res);
    expect(res.statusCode).toBe(503);
  });

  it('returns 400 for a missing study_id', async () => {
    const { handler } = await loadHandler();
    const res = makeRes();
    await handler(makeReq({ body: { model: 'nerve-canal' }, headers: AUTHED }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Missing study_id');
  });

  it('whitelists model names', async () => {
    const { handler } = await loadHandler();
    for (const model of ['rm -rf', 'gpt-x', '', undefined, 'nerve-canal2']) {
      const res = makeRes();
      await handler(makeReq({ body: { study_id: 's1', model }, headers: AUTHED }), res);
      expect(res.statusCode, String(model)).toBe(400);
      expect(res.body.error).toBe('Invalid model name');
    }
  });

  it('accepts every supported model name', async () => {
    for (const model of ['nerve-canal', 'teeth-segment', 'landmarks-ceph', 'arch-curve']) {
      const fake = accessibleStudy();
      const fetchImpl = okUpstream();
      const { handler } = await loadHandler({ fake, fetchImpl });
      const res = makeRes();
      await handler(makeReq({ body: { study_id: 's1', model }, headers: AUTHED }), res);
      expect(res.statusCode, model).toBe(200);
      expect(fetchImpl).toHaveBeenCalledWith(
        `https://infer.test/infer/${model}`,
        expect.any(Object),
      );
    }
  });

  it('requires a Bearer token', async () => {
    const { handler } = await loadHandler();
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'user-jwt' }]) {
      const res = makeRes();
      await handler(makeReq({ body: { study_id: 's1', model: 'nerve-canal' }, headers }), res);
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('ai-infer — RLS gate', () => {
  it('builds the user-scoped client from the caller JWT', async () => {
    const fake = accessibleStudy();
    const { handler, createClient } = await loadHandler({ fake, fetchImpl: okUpstream() });
    await handler(makeReq({ body: { study_id: 's1', model: 'nerve-canal' }, headers: AUTHED }), makeRes());
    expect(createClient).toHaveBeenCalledWith(
      'https://supabase.test',
      'user-jwt',
      expect.objectContaining({
        global: { headers: { Authorization: 'Bearer user-jwt' } },
      }),
    );
  });

  it('403s when the study is not visible to the caller', async () => {
    const fake = makeFakeSupabase({
      results: { imaging_studies: { data: null, error: null } },
    });
    const { handler } = await loadHandler({ fake, fetchImpl: okUpstream() });
    const res = makeRes();
    await handler(makeReq({ body: { study_id: 's1', model: 'nerve-canal' }, headers: AUTHED }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Study not accessible');
  });

  it('403s on an RLS error as well', async () => {
    const fake = makeFakeSupabase({
      results: { imaging_studies: { data: null, error: { message: 'permission denied' } } },
    });
    const { handler } = await loadHandler({ fake, fetchImpl: okUpstream() });
    const res = makeRes();
    await handler(makeReq({ body: { study_id: 's1', model: 'nerve-canal' }, headers: AUTHED }), res);
    expect(res.statusCode).toBe(403);
  });
});

describe('ai-infer — upstream forwarding', () => {
  it('forwards to INFERENCE_URL/infer/<model> with the internal key', async () => {
    const fake = accessibleStudy();
    const fetchImpl = okUpstream();
    const { handler } = await loadHandler({ fake, fetchImpl });
    const res = makeRes();
    await handler(makeReq({ body: { study_id: 's1', model: 'teeth-segment' }, headers: AUTHED }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ job_id: 'job-1', status: 'queued' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://infer.test/infer/teeth-segment');
    expect(init.method).toBe('POST');
    expect(init.headers['x-internal-key']).toBe('internal-key');
    expect(JSON.parse(init.body)).toEqual({ study_id: 's1' });
  });

  it('strips a trailing slash from AI_INFERENCE_URL', async () => {
    const fake = accessibleStudy();
    const fetchImpl = okUpstream();
    const { handler } = await loadHandler({
      env: { AI_INFERENCE_URL: 'https://infer.test/' },
      fake,
      fetchImpl,
    });
    await handler(makeReq({ body: { study_id: 's1', model: 'nerve-canal' }, headers: AUTHED }), makeRes());
    expect(fetchImpl.mock.calls[0][0]).toBe('https://infer.test/infer/nerve-canal');
  });

  it('passes upstream error status and detail through', async () => {
    const fake = accessibleStudy();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({ detail: 'volume not converted' }),
    }));
    const { handler } = await loadHandler({ fake, fetchImpl });
    const res = makeRes();
    await handler(makeReq({ body: { study_id: 's1', model: 'nerve-canal' }, headers: AUTHED }), res);
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toBe('volume not converted');
  });

  it('reports the upstream status when the error body is not JSON', async () => {
    const fake = accessibleStudy();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => { throw new Error('not json'); },
    }));
    const { handler } = await loadHandler({ fake, fetchImpl });
    const res = makeRes();
    await handler(makeReq({ body: { study_id: 's1', model: 'nerve-canal' }, headers: AUTHED }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Inference returned 500');
  });

  it('502s when the inference service is unreachable', async () => {
    const fake = accessibleStudy();
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const { handler } = await loadHandler({ fake, fetchImpl });
    const res = makeRes();
    await handler(makeReq({ body: { study_id: 's1', model: 'nerve-canal' }, headers: AUTHED }), res);
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/unreachable/);
    expect(res.body.error).toMatch(/ECONNREFUSED/);
  });
});
