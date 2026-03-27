// app/api/ai/route.ts
import { NextRequest, NextResponse } from "next/server";

/** Orden de preferencia: Sonnet 4.5 -> Haiku 4.5 -> Haiku 3.5 */
const candidateModels = [
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  "claude-3-5-haiku-20241022",
] as const;

type CandidateModel = typeof candidateModels[number];

type RawAnthropicMessage = {
  content?: Array<{ text?: string }>;
};

function getHeaders() {
  const key = process.env.ANTHROPIC_API_KEY;
  return {
    key,
    headers: {
      "content-type": "application/json",
      "x-api-key": key || "",
      "anthropic-version": "2023-06-01",
    } as Record<string, string>,
  };
}

function buildPayload(text: string) {
  return {
    max_tokens: 1200,
    messages: [
      {
        role: "user",
        content: `Eres un analista emocional para estudiantes universitarios.
Devuelve SOLO JSON válido (sin markdown, sin comentarios) con este EXACTO esquema:

{
  "emotions": [
    {"emotion": "ansiedad", "intensity": 7, "confidence": 0.83, "phrases": ["...","..."]}
  ],
  "primary": "ansiedad",
  "mood_vector": {"valence": 0.32, "arousal": 0.74},
  "triggers": ["..."],
  "body_signals": ["..."],
  "cognitive_patterns": ["..."],
  "protective_factors": ["..."],
  "summary": "máx 180 caracteres, tono empático y no clínico",
  "suggestions_quick": ["Tip 1", "Tip 2"],
  "suggestions_practice": [
    {"title": "Respiración box", "minutes": 3, "steps": ["Paso 1","Paso 2","Paso 3"]}
  ],
  "red_flags": {"self_harm": false, "crisis": false, "reason": ""},
  "citations": []
}

Reglas:
- Emociones válidas: ansiedad, calma, alegria, tristeza, enojo, frustracion, neutra
- "intensity": 1..10, "confidence": 0..1
- Máx 3 emociones; máx 2 frases por emoción (<=60 chars)
- Máx 2 suggestions_quick y 1 suggestions_practice (3–5 min)
- Evita diagnósticos clínicos. Solo orientación de bienestar.
- Entrega SOLO el JSON, sin \`\`\`, sin texto extra.

Texto:
"${text}"`
      },
    ],
  };
}

async function tryModelsInOrder(
  payload: any,
  headers: Record<string, string>
): Promise<{ usedModel: CandidateModel; json: RawAnthropicMessage }> {
  for (const model of candidateModels) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...payload, model }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.log(
          `⚠️ ${model} -> ${res.status} ${res.statusText}: ${text.slice(0, 180)}`
        );
        continue;
      }

      const json = (await res.json()) as RawAnthropicMessage;
      console.log(`✅ Usando modelo: ${model}`);
      return { usedModel: model, json };
    } catch (e) {
      console.log(`⚠️ ${model} -> excepción`, e);
    }
  }
  throw new Error("No hay modelos disponibles con tu API key.");
}

/** Extrae el primer bloque JSON de un string o devuelve null */
function extractFirstJsonBlock(s: string): any | null {
  if (!s) return null;
  const match = s.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** Sanitiza y recorta campos para evitar valores fuera de rango */
function sanitizeResponse(raw: any) {
  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));

  const emotions = Array.isArray(raw?.emotions) ? raw.emotions.slice(0, 3) : [];
  const safeEmotions = emotions.map((e: any) => ({
    emotion:
      (["ansiedad", "calma", "alegria", "tristeza", "enojo", "frustracion", "neutra"] as const).includes(
        e?.emotion
      )
        ? e.emotion
        : "neutra",
    intensity: clamp(e?.intensity ?? 5, 1, 10),
    confidence: clamp(e?.confidence ?? 0.7, 0, 1),
    phrases: Array.isArray(e?.phrases) ? e.phrases.slice(0, 2) : [],
  }));

  const primary =
    (["ansiedad", "calma", "alegria", "tristeza", "enojo", "frustracion", "neutra"] as const).includes(
      raw?.primary
    )
      ? raw.primary
      : safeEmotions[0]?.emotion ?? "neutra";

  const mood_vector = {
    valence: clamp(raw?.mood_vector?.valence ?? 0.5, 0, 1),
    arousal: clamp(raw?.mood_vector?.arousal ?? 0.5, 0, 1),
  };

  const arr = (x: any) => (Array.isArray(x) ? x : []);
  const str = (x: any, max = 180) =>
    typeof x === "string" ? x.slice(0, max) : "";

  const response = {
    emotions: safeEmotions,
    primary,
    mood_vector,
    triggers: arr(raw?.triggers).slice(0, 6),
    body_signals: arr(raw?.body_signals).slice(0, 6),
    cognitive_patterns: arr(raw?.cognitive_patterns).slice(0, 6),
    protective_factors: arr(raw?.protective_factors).slice(0, 6),
    summary: str(raw?.summary, 180),
    suggestions_quick: arr(raw?.suggestions_quick).slice(0, 2),
    suggestions_practice: arr(raw?.suggestions_practice)
      .slice(0, 1)
      .map((p: any) => ({
        title: str(p?.title, 60) || "Práctica breve",
        minutes: Math.max(1, Math.min(10, Number(p?.minutes) || 3)),
        steps: arr(p?.steps).slice(0, 5),
      })),
    red_flags: {
      self_harm: !!raw?.red_flags?.self_harm,
      crisis: !!raw?.red_flags?.crisis,
      reason: str(raw?.red_flags?.reason, 120),
    },
    citations: arr(raw?.citations).slice(0, 4),
  };

  return response;
}

export async function POST(req: NextRequest) {
  console.log("=== INICIO /api/ai ===");
  const { key, headers } = getHeaders();
  console.log("🔑 API Key:", key ? "SÍ ✅" : "NO ❌");
  if (key) console.log("🔑 Pre:", key.slice(0, 20) + "...");

  try {
    const { text } = await req.json();
    const preview = typeof text === "string" ? text.slice(0, 120) : "";
    console.log("📝 Texto:", preview + (text?.length > 120 ? "..." : ""));

    if (!text || typeof text !== "string" || text.trim().length < 20) {
      return NextResponse.json(
        { error: "Texto insuficiente (mínimo 20 caracteres)" },
        { status: 400 }
      );
    }

    if (!key) {
      return NextResponse.json(
        { error: "Missing ANTHROPIC_API_KEY" },
        { status: 500 }
      );
    }

    const payload = buildPayload(text);
    const { usedModel, json } = await tryModelsInOrder(payload, headers);

    // La API devuelve algo tipo: { content: [{ text: "...(JSON o texto)..." }], ... }
    const content = json?.content?.[0]?.text ?? "";
    const parsed = extractFirstJsonBlock(content);
    if (!parsed) {
      console.log(" No se encontró JSON en la respuesta bruta");
      return NextResponse.json(
        { error: "No JSON found in upstream response" },
        { status: 502 }
      );
    }

    const sanitized = sanitizeResponse(parsed);
    console.log(" OK ->", usedModel);
    console.log("=== FIN /api/ai ===");

    return NextResponse.json({
      usedModel,
      ...sanitized,
    });
  } catch (err: any) {
    console.error("❌ EXCEPTION /api/ai:", err?.message || err);
    return NextResponse.json(
      { error: "Exception", message: err?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
