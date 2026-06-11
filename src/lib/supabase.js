/*
 * Supabase client.
 * Phase 1: shares the EMR's Supabase project.
 * This means a user authenticated to the EMR is already authenticated here
 * once cookies are scoped to a shared parent domain (e.g. *.aihealth.app).
 *
 * Phase 3 will swap to a dedicated imaging-side project.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL) {
  throw new Error('Missing VITE_SUPABASE_URL — set it in .env.local');
}

if (!SUPABASE_ANON_KEY) {
  throw new Error('Missing VITE_SUPABASE_ANON_KEY — set it in .env.local');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
