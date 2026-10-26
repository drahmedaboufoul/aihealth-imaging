/*
 * aiTokens — the viewer's side of AI token billing (tables from kyour's
 * ai_token_wallets migration). Shows a study's clinic balance and each AI
 * action's price, and turns the AI functions' 402 replies into plain messages.
 *
 * Until the migration is applied the tables don't exist: everything here then
 * returns null and the viewer behaves exactly as before.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/** Readable message from a supabase.functions.invoke error (reads the JSON body of 4xx/5xx replies). */
export async function functionErrorMessage(fnErr, fallback) {
  try {
    const body = await fnErr?.context?.json?.();
    if (body?.error) return body.error;
  } catch { /* not JSON */ }
  return fnErr?.message || fallback;
}

/**
 * Balance and prices for the clinic that owns a study.
 * @returns {{ wallet: {balance:number, metered:boolean}|null, prices: Record<string, number>, refresh: () => void }}
 */
export function useAiTokens(studyId) {
  const [state, setState] = useState({ wallet: null, prices: {} });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!studyId) return undefined;
    let alive = true;
    (async () => {
      const { data: study } = await supabase.from('imaging_studies').select('clinic_id').eq('id', studyId).maybeSingle();
      const [{ data: wallet, error: wErr }, { data: prices, error: pErr }] = await Promise.all([
        study?.clinic_id
          ? supabase.from('ai_token_wallets').select('balance, metered').eq('clinic_id', study.clinic_id).maybeSingle()
          : Promise.resolve({ data: null }),
        supabase.from('ai_token_prices').select('action, tokens').eq('active', true),
      ]);
      if (!alive || wErr || pErr) return;
      setState({
        wallet: wallet ?? null,
        prices: Object.fromEntries((prices || []).map((p) => [p.action, p.tokens])),
      });
    })();
    return () => { alive = false; };
  }, [studyId, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, refresh };
}

/** "10 tokens · 42 left" for a metered clinic, null when AI is included. */
export function tokenCostNote(tokens, action) {
  if (!tokens?.wallet?.metered) return null;
  const cost = tokens.prices[action];
  return `${cost ?? '?'} tokens · ${tokens.wallet.balance} left`;
}
