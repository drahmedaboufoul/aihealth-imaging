/*
 * featureFlags — temporary kill-switches for incomplete or unsafe features.
 * Each flag must say WHY it exists and what flips when it's removed.
 */

/**
 * ENABLE_PLACEHOLDER_AI_MODELS (audit finding #2)
 *
 * The Phase-4 segmentation endpoints (nerve-canal, teeth-segment,
 * landmarks-ceph, arch-curve) are wired to a placeholder inference service
 * that returns SYNTHETIC output (`model_state: 'placeholder'`, confidence 0).
 * Synthetic geometry must never be mistaken for a clinical result, so these
 * models are hidden in production builds. Flip to true ONLY for local dev of
 * the inference pipeline — even then, results are labelled SIMULATED and are
 * never auto-applied to clinical overlays.
 */
export const ENABLE_PLACEHOLDER_AI_MODELS = false;

// Build-time opt-ins: only the exact string "true" enables a flag, so a
// missing, empty or misspelled value always leaves the feature OFF.
export const envFlag = (value) => String(value ?? '').trim() === 'true';

/**
 * ENABLE_THIRD_PARTY_AI (M0 safety)
 *
 * The radiograph and CBCT "AI read" actions send the on-screen patient image
 * to an outside AI provider (ai-read-radiograph / ai-read-cbct edge
 * functions). OFF unless the build sets VITE_ENABLE_THIRD_PARTY_AI=true;
 * when off the buttons and panels are not rendered. The server-side
 * functions are deny-by-default as well — this flag only controls the UI.
 */
export const ENABLE_THIRD_PARTY_AI = envFlag(import.meta.env.VITE_ENABLE_THIRD_PARTY_AI);

/**
 * ENABLE_VIEWER_ROOMS (M0 safety)
 *
 * Live co-viewing ("Go live" / follow) uses a PUBLIC Supabase Realtime
 * channel named after the study, joinable with the anon key. OFF unless the
 * build sets VITE_ENABLE_VIEWER_ROOMS=true. Do not re-enable until M1 moves
 * rooms to a private Realtime channel with an RLS policy on
 * realtime.messages and a server-issued room id (not the study UUID).
 */
export const ENABLE_VIEWER_ROOMS = envFlag(import.meta.env.VITE_ENABLE_VIEWER_ROOMS);

/** Whether the outside-AI read controls may be shown for this session. */
export function canShowThirdPartyAi({ readOnly, hasStudy = true } = {}) {
  return ENABLE_THIRD_PARTY_AI && !readOnly && !!hasStudy;
}

/** True when an AI inference response is synthetic placeholder output. */
export function isSimulatedAiResult(body) {
  const state = body?.model_state;
  return state === 'placeholder' || state === 'synthetic' || state === 'simulated';
}
