// ai-read-radiograph — assistive AI reader for 2D dental radiographs
// (periapical / bitewing / panoramic / cephalometric / photo).
//
// The DICOM viewer captures the currently displayed frame as a PNG, base64s
// it, and POSTs it here with an optional study_id. We forward one image to
// Claude vision with a forced structured tool that returns RANKED findings,
// each carrying a normalized bounding box (x,y,w,h in 0..1 of the image) so
// the viewer can draw numbered boxes over the radiograph — the DentalX
// "AI diagnosis" pattern, built natively.
//
// ASSISTIVE ONLY — flags for clinician review, never an autonomous diagnosis.
//
// Auth: verify_jwt = true at the gateway (only signed-in clinic staff reach
// here). When a study_id is supplied we additionally RLS-check that the caller
// can read the study and persist the reading to imaging_studies.ai_analysis
// .radiograph_reader; without a study_id we still return findings (the caller
// already sees the image) but skip persistence.
//
// Mirrors the model / forced-tool / retry conventions of the EMR's
// ai-read-cbct so both AI surfaces behave identically.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PRIMARY_MODEL = "claude-opus-4-5";
const FALLBACK_MODEL = "claude-sonnet-4-6";
const READER_VERSION = "1.0";
const MAX_IMAGE_B64_CHARS = 7_000_000; // ~5 MB decoded — Anthropic per-image cap
const DISCLAIMER =
  "AI-assisted reading — must be verified by the treating clinician. Not a diagnosis.";

const FINDING_TYPES = [
  "caries",
  "periapical_radiolucency",
  "bone_loss",
  "calculus",
  "defective_restoration",
  "impaction",
  "retained_root",
  "widened_pdl",
  "furcation_involvement",
  "root_resorption",
  "other",
] as const;
const SEVERITIES = ["low", "moderate", "high"] as const;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const REPORT_TOOL = {
  name: "report_radiograph_findings",
  description: "Report ranked assistive findings on a 2D dental radiograph for clinician review.",
  input_schema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        description:
          "Discrete flagged observations, MOST confident first. Empty array when nothing is clearly abnormal.",
        items: {
          type: "object",
          properties: {
            tooth: {
              type: ["string", "null"],
              description: "FDI tooth number (e.g. '36') or null when not tooth-specific.",
            },
            type: { type: "string", enum: [...FINDING_TYPES] },
            severity: { type: "string", enum: [...SEVERITIES] },
            confidence: { type: "number", description: "0.0–1.0 confidence that the finding is real." },
            description: { type: "string", description: "What is visible and why it was flagged (1 sentence)." },
            box: {
              type: "object",
              description:
                "Tight bounding box around the finding, normalized to the image: x,y = top-left, " +
                "w,h = size, all in 0..1 where (0,0) is the top-left of the image.",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
              },
              required: ["x", "y", "w", "h"],
            },
          },
          required: ["type", "severity", "confidence", "description", "box"],
        },
      },
      summary: {
        type: "string",
        description:
          "1–2 sentence clinically focused impression. State the actionable findings, or that none were seen. " +
          "Do not restate image caveats or list normal structures.",
      },
    },
    required: ["findings", "summary"],
  },
};

const SYSTEM_PROMPT =
  `You are an expert dental radiology ASSISTANT embedded in a clinic 2D radiograph viewer. ` +
  `Your role is strictly ASSISTIVE: you FLAG possible findings for the treating clinician to verify — you never ` +
  `diagnose, never recommend treatment, and your output is always reviewed by a clinician before any use.\n\n` +
  `You are shown ONE 2D dental radiograph (periapical, bitewing, panoramic, or cephalometric). Report ONLY ` +
  `clinically actionable pathology or anomalies visible on it. A clinician is reading alongside you; do not pad the ` +
  `report with normal anatomy or a tooth-by-tooth inventory.\n\n` +
  `Core rules:\n` +
  `1. FLAG, don't diagnose. Describe what is visible ("radiolucency at the apex of 36") rather than asserting a disease.\n` +
  `2. Prefer FALSE NEGATIVES over confabulation: report only findings CLEARLY visible. If unsure whether something is ` +
  `real, artifact, or noise, OMIT it. When in doubt, leave it out.\n` +
  `3. Every finding MUST include a TIGHT bounding box normalized to the image (x,y,w,h in 0..1, origin top-left). ` +
  `Place the box snugly around the specific structure you are flagging, not the whole tooth or arch.\n` +
  `4. Rank findings by confidence, most confident first.\n` +
  `5. Use FDI two-digit tooth numbering (11–48). Use null for tooth when the finding is regional (e.g. generalized bone loss).\n` +
  `6. severity reflects how urgently a clinician should look (low | moderate | high); confidence (0.0–1.0) reflects how sure you are it is real.\n` +
  `7. Do NOT flag absent third molars (18, 28, 38, 48) — congenital absence or prior removal is normal, not a pathology.\n` +
  `8. If nothing is clearly abnormal, return an EMPTY findings array with a one-line summary — that is a valid, common answer.\n` +
  `Always answer by calling the report_radiograph_findings tool with valid structured data.`;

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : parseFloat(String(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// Coerce model output into the strict contract: clamp confidence + box to
// [0,1], enforce enums, keep boxes inside the frame, drop unusable findings,
// and re-sort by confidence so the numbering is stable.
export function normalizeResult(raw: Record<string, unknown>) {
  const findingsIn = Array.isArray(raw.findings) ? raw.findings : [];
  const findings = findingsIn
    .filter((f) => f && typeof f === "object")
    .map((f) => {
      const o = f as Record<string, unknown>;
      const b = (o.box && typeof o.box === "object" ? o.box : {}) as Record<string, unknown>;
      let x = clamp01(b.x);
      let y = clamp01(b.y);
      let w = clamp01(b.w);
      let h = clamp01(b.h);
      // Keep the box inside the frame; drop degenerate boxes.
      if (x + w > 1) w = 1 - x;
      if (y + h > 1) h = 1 - y;
      const type = (FINDING_TYPES as readonly string[]).includes(o.type as string) ? (o.type as string) : "other";
      const severity = (SEVERITIES as readonly string[]).includes(o.severity as string) ? (o.severity as string) : "low";
      const toothRaw = typeof o.tooth === "string" ? o.tooth.trim() : null;
      return {
        tooth: toothRaw || null,
        type,
        severity,
        confidence: clamp01(o.confidence),
        description: typeof o.description === "string" ? o.description : "",
        box: { x, y, w, h },
        _valid: w > 0.001 && h > 0.001 && (typeof o.description === "string" && o.description.length > 0),
      };
    })
    .filter((f) => f._valid)
    .map(({ _valid, ...f }) => f)
    .sort((a, b) => b.confidence - a.confidence);
  return {
    findings,
    summary: typeof raw.summary === "string" ? raw.summary : "",
  };
}

export function extractStructured(data: unknown): Record<string, unknown> | null {
  const content = (data as { content?: Array<Record<string, unknown>> })?.content;
  if (!Array.isArray(content)) return null;
  const toolUse = content.find((b) => b?.type === "tool_use");
  if (toolUse && typeof toolUse.input === "object" && toolUse.input !== null) {
    return toolUse.input as Record<string, unknown>;
  }
  const text = content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function callAnthropic(apiKey: string, model: string, imageB64: string, mediaType: string, studyType: string) {
  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text:
        `Study type: ${String(studyType || "radiograph").toUpperCase()}. ` +
        `Below is one 2D dental radiograph. Review it and report ranked assistive findings via ` +
        `report_radiograph_findings, each with a tight normalized bounding box.`,
    },
    { type: "image", source: { type: "base64", media_type: mediaType, data: imageB64 } },
  ];
  return await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 3072,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
      tools: [REPORT_TOOL],
      tool_choice: { type: "tool", name: REPORT_TOOL.name },
    }),
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!SUPABASE_URL || !ANTHROPIC_API_KEY) {
      return jsonResponse({ error: "Server not configured (missing SUPABASE_URL / ANTHROPIC_API_KEY)" }, 503);
    }

    const body = await req.json().catch(() => null);
    const study_id: string | undefined = body?.study_id || undefined;
    const study_type: string = typeof body?.study_type === "string" ? body.study_type : "radiograph";
    const image: string = (body?.image || "").replace(/^data:[^,]+,/, "");
    const mediaType: string = typeof body?.mediaType === "string" ? body.mediaType : "image/png";
    if (!image) return jsonResponse({ error: "image (base64 PNG) required" }, 400);
    if (image.length > MAX_IMAGE_B64_CHARS) return jsonResponse({ error: "Image exceeds size limit" }, 413);

    // Optional study authorization: RLS-scope the read to the caller.
    let study: { id: string; clinic_id: string; patient_id: string } | null = null;
    if (study_id) {
      const authHeader = req.headers.get("Authorization") || "";
      const userClient = createClient(SUPABASE_URL, ANON_KEY || "", {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await userClient
        .from("imaging_studies")
        .select("id, clinic_id, patient_id")
        .eq("id", study_id)
        .maybeSingle();
      if (error || !data) return jsonResponse({ error: "Study not accessible" }, 403);
      study = data;
    }

    // Run the vision reading: primary model, fall back on non-429 error, one
    // valid-JSON retry nudge folded into the second attempt.
    let resp = await callAnthropic(ANTHROPIC_API_KEY, PRIMARY_MODEL, image, mediaType, study_type);
    let usedModel = PRIMARY_MODEL;
    if (!resp.ok && resp.status !== 429) {
      resp = await callAnthropic(ANTHROPIC_API_KEY, FALLBACK_MODEL, image, mediaType, study_type);
      usedModel = FALLBACK_MODEL;
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return jsonResponse({ error: `Anthropic error ${resp.status}`, detail: txt.slice(0, 300) }, resp.status === 429 ? 429 : 502);
    }
    const structured = extractStructured(await resp.json());
    if (!structured) return jsonResponse({ error: "Model returned no valid structured findings" }, 502);

    const result = normalizeResult(structured);
    const radiograph_reader = {
      version: READER_VERSION,
      model: usedModel,
      created_at: new Date().toISOString(),
      ...result,
      disclaimer: DISCLAIMER,
    };

    // Persist + audit only when we have an authorized study.
    if (study && SERVICE_KEY) {
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: fresh } = await admin
        .from("imaging_studies").select("ai_analysis").eq("id", study.id).maybeSingle();
      const merged = {
        ...((fresh?.ai_analysis && typeof fresh.ai_analysis === "object") ? fresh.ai_analysis : {}),
        radiograph_reader,
      };
      await admin.from("imaging_studies")
        .update({ ai_analysis: merged, ai_analyzed: true, updated_at: new Date().toISOString() })
        .eq("id", study.id);
      try {
        await admin.from("imaging_ai_inferences").insert({
          study_id: study.id,
          patient_id: study.patient_id,
          clinic_id: study.clinic_id,
          model_name: usedModel,
          findings: radiograph_reader,
          overall_confidence: result.findings.length
            ? result.findings.reduce((s, f) => s + f.confidence, 0) / result.findings.length
            : null,
          input_image_count: 1,
          inference_run_at: new Date().toISOString(),
        });
      } catch (_) { /* audit row is best-effort */ }
    }

    return jsonResponse({ status: "ok", radiograph_reader, persisted: !!study });
  } catch (err) {
    console.error("[ai-read-radiograph] error:", err);
    return jsonResponse({ error: (err as Error)?.message || "Unknown error" }, 500);
  }
});
