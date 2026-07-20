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

/** True when an AI inference response is synthetic placeholder output. */
export function isSimulatedAiResult(body) {
  const state = body?.model_state;
  return state === 'placeholder' || state === 'synthetic' || state === 'simulated';
}
