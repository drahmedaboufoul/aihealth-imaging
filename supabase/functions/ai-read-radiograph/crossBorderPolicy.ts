// Outside-AI policy for ai-read-radiograph (M0 safety).
//
// Patient radiographs may only be sent to a third-party AI provider outside
// the clinic's data-residency region when the operator has EXPLICITLY opted
// in with ALLOW_CROSS_BORDER_AI=true. Anything else — unset, empty, "false",
// a typo — refuses the call. The legacy DISABLE_CROSS_BORDER_AI=true kill
// switch still wins over an opt-in.
//
// Pure (no Deno globals) so it is unit-tested from the repo's vitest suite.

export type EnvGetter = (name: string) => string | undefined;

export type CrossBorderDecision =
  | { allowed: true }
  | { allowed: false; status: 403; body: { error: string; code: "CROSS_BORDER_AI_DISABLED" } };

export const CROSS_BORDER_AI_DISABLED_MESSAGE =
  "Outside AI reading is turned off for this deployment. Patient images are not sent to third-party AI services.";

export function crossBorderAiDecision(getEnv: EnvGetter): CrossBorderDecision {
  const optedIn = (getEnv("ALLOW_CROSS_BORDER_AI") ?? "").trim() === "true";
  const killSwitch = (getEnv("DISABLE_CROSS_BORDER_AI") ?? "").trim() === "true";
  if (optedIn && !killSwitch) return { allowed: true };
  return {
    allowed: false,
    status: 403,
    body: { error: CROSS_BORDER_AI_DISABLED_MESSAGE, code: "CROSS_BORDER_AI_DISABLED" },
  };
}
