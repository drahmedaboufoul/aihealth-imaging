import { describe, expect, it, vi } from 'vitest';
import {
  buildLingshuMessages,
  callLingshu,
  extractLingshuStructured,
  readLingshuConfig,
  LINGSHU_DEFAULT_MODEL,
} from '../supabase/functions/ai-read-radiograph/lingshu.ts';

const env = (vars: Record<string, string>) => (n: string) => vars[n];

describe('readLingshuConfig', () => {
  it('returns null unless both URL and key are set', () => {
    expect(readLingshuConfig(env({}))).toBeNull();
    expect(readLingshuConfig(env({ LINGSHU_BASE_URL: 'https://gpu.example/v1' }))).toBeNull();
    expect(readLingshuConfig(env({ LINGSHU_API_KEY: 'k' }))).toBeNull();
  });

  it('refuses a plain-HTTP endpoint because patient images travel to it', () => {
    expect(readLingshuConfig(env({ LINGSHU_BASE_URL: 'http://gpu.example/v1', LINGSHU_API_KEY: 'k' }))).toBeNull();
  });

  it('defaults the model, trims the trailing slash, and is not in the UAE unless told', () => {
    const cfg = readLingshuConfig(env({ LINGSHU_BASE_URL: 'https://gpu.example/v1/', LINGSHU_API_KEY: 'k' }));
    expect(cfg).toEqual({ baseUrl: 'https://gpu.example/v1', apiKey: 'k', model: LINGSHU_DEFAULT_MODEL, inUae: false });
    const uae = readLingshuConfig(env({
      LINGSHU_BASE_URL: 'https://gpu.example/v1', LINGSHU_API_KEY: 'k',
      LINGSHU_MODEL: 'Lingshu-32B-AWQ', LINGSHU_DATA_RESIDENCY_UAE: 'true',
    }));
    expect(uae?.model).toBe('Lingshu-32B-AWQ');
    expect(uae?.inUae).toBe(true);
  });
});

describe('buildLingshuMessages', () => {
  const prompt = 'Be careful.\nAlways answer by calling the report_radiograph_findings tool with valid structured data.';
  const msgs = buildLingshuMessages(prompt, 'AAAA', 'image/png', 'panoramic', ['caries', 'other'], ['low', 'high']);

  it('swaps the tool instruction for a JSON schema', () => {
    const sys = msgs[0].content as string;
    expect(sys).not.toMatch(/report_radiograph_findings tool/);
    expect(sys).toMatch(/"findings"/);
    expect(sys).toContain('["caries","other"]');
  });

  it('sends the image as a data URL with the study type', () => {
    const parts = msgs[1].content as Array<Record<string, any>>;
    expect(parts[0].image_url.url).toBe('data:image/png;base64,AAAA');
    expect(parts[1].text).toMatch(/PANORAMIC/);
  });
});

describe('callLingshu', () => {
  it('posts an OpenAI-style request with the bearer key', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await callLingshu({ baseUrl: 'https://gpu.example/v1', apiKey: 'secret', model: 'lingshu-32b', inUae: false }, [], fetchImpl as any);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('https://gpu.example/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer secret');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('lingshu-32b');
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('extractLingshuStructured', () => {
  const wrap = (content: unknown) => ({ choices: [{ message: { content } }] });

  it('parses plain and fenced JSON', () => {
    expect(extractLingshuStructured(wrap('{"findings":[],"summary":"ok"}'))).toEqual({ findings: [], summary: 'ok' });
    expect(extractLingshuStructured(wrap('Here:\n```json\n{"findings":[],"summary":"x"}\n```'))?.summary).toBe('x');
  });

  it('accepts content-part arrays', () => {
    expect(extractLingshuStructured(wrap([{ type: 'text', text: '{"summary":"y"}' }]))).toEqual({ summary: 'y' });
  });

  it('returns null for missing or broken output', () => {
    expect(extractLingshuStructured({})).toBeNull();
    expect(extractLingshuStructured(wrap('no json here'))).toBeNull();
    expect(extractLingshuStructured(wrap('{"findings": [}'))).toBeNull();
  });
});
