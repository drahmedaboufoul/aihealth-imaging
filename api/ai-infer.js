/**
 * /api/ai-infer — AI inference trigger, hosted on the imaging viewer's
 * Vercel project so the call is same-origin from the viewer.
 *
 * The EMR project has Vercel Deployment Protection (SSO wall) enabled,
 * which blocked cross-origin fetches from the viewer with a 401 before
 * our handler could even run. Hosting this route on the same Vercel
 * project as the viewer eliminates the cross-origin hop and the SSO
 * wall in one move.
 *
 * Validates the caller's Supabase JWT can read the imaging_studies row
 * (RLS enforces clinic scoping), then forwards to the AI inference
 * service using a server-side internal key.
 *
 * Required Vercel env vars on aihealth-imaging (503 when any is missing;
 * no VITE_ fallbacks server-side):
 *   - AI_INFERENCE_URL
 *   - INFERENCE_INTERNAL_KEY
 *   - SUPABASE_URL
 *   - SUPABASE_ANON_KEY
 * Optional: ALLOWED_ORIGINS (CORS allowlist, see _cors.js)
 *
 * Supported models: nerve-canal, teeth-segment, landmarks-ceph, arch-curve
 */

import { createClient } from '@supabase/supabase-js';
import { applyCors } from './_cors.js';

export const config = { runtime: 'nodejs', maxDuration: 120 };

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const INFERENCE_URL = process.env.AI_INFERENCE_URL;
const INFERENCE_KEY = process.env.INFERENCE_INTERNAL_KEY;

const VALID_MODELS = new Set(['nerve-canal', 'teeth-segment', 'landmarks-ceph', 'arch-curve']);

export default async function handler(req, res) {
  const corsOk = applyCors(req, res, { headers: 'Content-Type, Authorization' });
  if (req.method === 'OPTIONS') return res.status(corsOk ? 204 : 403).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!INFERENCE_URL || !INFERENCE_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(503).json({ error: 'AI inference service not configured' });
  }

  const { study_id, model } = req.body || {};
  if (!study_id || typeof study_id !== 'string') return res.status(400).json({ error: 'Missing study_id' });
  if (!model || !VALID_MODELS.has(model))         return res.status(400).json({ error: 'Invalid model name' });

  const auth = req.headers.authorization || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: 'Missing Authorization bearer token' });

  // Project anon key as the apikey; the caller's JWT as the bearer so RLS
  // evaluates as that user.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: study, error } = await userClient
    .from('imaging_studies')
    .select('id, nifti_status')
    .eq('id', study_id)
    .maybeSingle();
  if (error || !study) return res.status(403).json({ error: 'Study not accessible' });

  if (study.nifti_status !== 'ready') {
    console.warn(`[ai-infer] nifti_status=${study.nifti_status}; running anyway (placeholder ok)`);
  }

  const url = `${INFERENCE_URL.replace(/\/$/, '')}/infer/${model}`;
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key': INFERENCE_KEY,
      },
      body: JSON.stringify({ study_id }),
    });
    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: body?.detail || `Inference returned ${upstream.status}` });
    }
    return res.status(200).json(body);
  } catch (e) {
    console.error('[ai-infer] forward failed:', e);
    return res.status(502).json({ error: 'Inference service unreachable' });
  }
}
