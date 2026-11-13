import { describe, it, expect } from 'vitest';
import {
  crossBorderAiDecision,
  CROSS_BORDER_AI_DISABLED_MESSAGE,
} from '../supabase/functions/ai-read-radiograph/crossBorderPolicy';

const envOf = (vars: Record<string, string | undefined>) => (name: string) => vars[name];

describe('ai-read-radiograph outside-AI policy (deny by default)', () => {
  it('refuses with a 403 JSON body when nothing is configured', () => {
    const decision = crossBorderAiDecision(envOf({}));
    expect(decision).toEqual({
      allowed: false,
      status: 403,
      body: { error: CROSS_BORDER_AI_DISABLED_MESSAGE, code: 'CROSS_BORDER_AI_DISABLED' },
    });
  });

  it.each(['', 'false', 'TRUE', 'True', '1', 'yes', 'on', 'true-ish'])(
    'refuses for ALLOW_CROSS_BORDER_AI=%j (only the exact string "true" opts in)',
    (value) => {
      expect(crossBorderAiDecision(envOf({ ALLOW_CROSS_BORDER_AI: value })).allowed).toBe(false);
    },
  );

  it('no longer treats a missing DISABLE_CROSS_BORDER_AI as permission', () => {
    expect(crossBorderAiDecision(envOf({ DISABLE_CROSS_BORDER_AI: 'false' })).allowed).toBe(false);
  });

  it('allows only after the explicit opt-in', () => {
    expect(crossBorderAiDecision(envOf({ ALLOW_CROSS_BORDER_AI: 'true' }))).toEqual({ allowed: true });
    expect(crossBorderAiDecision(envOf({ ALLOW_CROSS_BORDER_AI: ' true ' }))).toEqual({ allowed: true });
  });

  it('lets the legacy kill switch override an opt-in', () => {
    const decision = crossBorderAiDecision(envOf({ ALLOW_CROSS_BORDER_AI: 'true', DISABLE_CROSS_BORDER_AI: 'true' }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.status).toBe(403);
  });

  it('is wired into the edge function before any image is read or sent', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../supabase/functions/ai-read-radiograph/index.ts', import.meta.url), 'utf8');
    const decisionAt = src.indexOf('crossBorderAiDecision((name) => Deno.env.get(name))');
    expect(decisionAt).toBeGreaterThan(0);
    expect(decisionAt).toBeLessThan(src.indexOf('await req.json()'));
    expect(decisionAt).toBeLessThan(src.indexOf('callAnthropic(ANTHROPIC_API_KEY'));
    // Fail closed on a missing anon key instead of an empty-string client.
    expect(src).not.toMatch(/ANON_KEY \|\| ""/);
    expect(src).toMatch(/!SUPABASE_URL \|\| !ANON_KEY \|\| !ANTHROPIC_API_KEY/);
  });
});
