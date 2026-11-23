// Lingshu second-opinion reader for ai-read-radiograph.
//
// Lingshu-32B (lingshu-medical-mllm/Lingshu-32B) is an open-weight medical
// vision-language model. We host it ourselves on a rented GPU behind an
// OpenAI-compatible server (vLLM `serve`), so this module only speaks the
// OpenAI chat-completions shape. It is a SECOND OPINION next to the Claude
// reader: its result is stored under its own key and never replaces Claude's.
//
// Pure module (no Deno globals) so it can be unit-tested under Vitest.
//
// Configuration (Edge function secrets):
//   LINGSHU_BASE_URL   e.g. https://<gpu-host>/v1   (required, https only)
//   LINGSHU_API_KEY    bearer key the vLLM server was started with (required)
//   LINGSHU_MODEL      served model name (default "lingshu-32b")
//   LINGSHU_DATA_RESIDENCY_UAE  "true" only when the GPU is hosted in the UAE;
//                      otherwise DISABLE_CROSS_BORDER_AI also blocks Lingshu.

export const LINGSHU_DEFAULT_MODEL = "lingshu-32b";
export const LINGSHU_TIMEOUT_MS = 90_000;

export type LingshuConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  inUae: boolean;
};

export function readLingshuConfig(env: (name: string) => string | undefined): LingshuConfig | null {
  const baseUrl = (env("LINGSHU_BASE_URL") || "").trim().replace(/\/+$/, "");
  const apiKey = (env("LINGSHU_API_KEY") || "").trim();
  if (!baseUrl || !apiKey) return null;
  // Patient images travel to this host: refuse plain HTTP.
  if (!/^https:\/\//i.test(baseUrl)) return null;
  return {
    baseUrl,
    apiKey,
    model: (env("LINGSHU_MODEL") || "").trim() || LINGSHU_DEFAULT_MODEL,
    inUae: env("LINGSHU_DATA_RESIDENCY_UAE") === "true",
  };
}

/** Lingshu has no tool calling; ask for the same report as plain JSON. */
export function buildLingshuMessages(
  systemPrompt: string,
  imageB64: string,
  mediaType: string,
  studyType: string,
  findingTypes: readonly string[],
  severities: readonly string[],
) {
  const schemaText =
    `Answer with ONE JSON object and nothing else, in this shape:\n` +
    `{"findings":[{"tooth":"36" or null,"type":one of ${JSON.stringify(findingTypes)},` +
    `"severity":one of ${JSON.stringify(severities)},"confidence":0.0-1.0,` +
    `"description":"one sentence","box":{"x":0-1,"y":0-1,"w":0-1,"h":0-1}}],` +
    `"summary":"1-2 sentences"}\n` +
    `Boxes are normalized to the image with (0,0) at the top-left. Use an empty findings array when nothing is clearly abnormal.`;
  const system = systemPrompt.replace(
    /Always answer by calling the report_radiograph_findings tool with valid structured data\.?/,
    "",
  ).trim();
  return [
    { role: "system", content: `${system}\n\n${schemaText}` },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:${mediaType};base64,${imageB64}` } },
        {
          type: "text",
          text:
            `Study type: ${String(studyType || "radiograph").toUpperCase()}. ` +
            `Review this one 2D dental radiograph and return the JSON report.`,
        },
      ],
    },
  ];
}

export async function callLingshu(
  cfg: LingshuConfig,
  messages: unknown[],
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LINGSHU_TIMEOUT_MS);
  try {
    return await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        max_tokens: 2048,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the JSON report out of an OpenAI-style chat completion. */
export function extractLingshuStructured(data: unknown): Record<string, unknown> | null {
  const choices = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = Array.isArray(choices) ? choices[0]?.message?.content : null;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
        ? (p as { text: string }).text
        : "")).join("\n")
      : "";
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}
