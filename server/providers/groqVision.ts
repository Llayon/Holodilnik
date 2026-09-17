import Groq from "groq-sdk";
import type { VisionProvider } from "./types.js";
import type { FridgeAnalysisResult } from "../../shared/types.js";
import { fridgeAnalysisSchema } from "../../shared/schemas.js";
import { normalizeIngredient } from "../../shared/normalization.js";
import {
  config,
  GROQ_MODEL_ID,
  GROQ_VISION_MAX_COMPLETION_TOKENS,
  VISION_PROMPT_VERSION,
} from "../config.js";

const VISION_PROMPT = `
Ты — эксперт по распознаванию продуктов в холодильнике по фото.
Проанализируй изображение холодильника и верни СТРОГО JSON.

Правила (критичны):
- Определяй ТОЛЬКО еду и ингредиенты, которые визуально подтверждены.
- НЕ выдумывай содержимое непрозрачных контейнеров, закрытых пакетов, кастрюль с крышкой.
- НЕ добавляй продукты "потому что они обычно есть в холодильнике".
- Упакованную еду определяй только если упаковка/этикетка или содержимое дают достаточные визуальные доказательства.
- Если сомневаешься — помести элемент в uncertainItems, а не в ingredients.
- Предпочитай пропуск сомнительному угадыванию.
- Не раскрывай chain-of-thought.
- Отвечай на русском для displayName, но canonicalName делай на английском в snake_case (например: tomato, bell_pepper, sour_cream).
- Для томатов различай: обычный tomato, черри cherry_tomato, жёлтый yellow_tomato — но не выдумывай вариант, только если визуально отличимо.
- Для котлет используй canonicalName cutlet.

Вернуть JSON вида:
{
  "ingredients": [
    { "canonicalName": "tomato", "displayName": "Помидоры", "quantityGuess": 3, "confidence": 0.91, "visibility": "clear" }
  ],
  "uncertainItems": [
    { "canonicalName": "yogurt", "displayName": "Йогурт", "reason": "непрозрачный контейнер" }
  ]
}

visibility:
- "clear" — отчётливо видно
- "partial" — частично видно/обрезано
- "uncertain" — слабо различимо

confidence: 0..1

Не возвращай прозу, только JSON.
`.trim();

function getGroqJsonSchema() {
  // Strict schema for Groq structured outputs: all properties must be in required for strict:true
  // quantityGuess and reason are optional in app logic but must be required in strict schema (allow null/empty)
  return {
    type: "object",
    properties: {
      ingredients: {
        type: "array",
        items: {
          type: "object",
          properties: {
            canonicalName: { type: "string", description: "Canonical ingredient ID snake_case" },
            displayName: { type: "string", description: "Display name in Russian" },
            quantityGuess: {
              type: ["number", "null"],
              description: "Estimated quantity, null if unclear",
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            visibility: { type: "string", enum: ["clear", "partial", "uncertain"] },
          },
          required: ["canonicalName", "displayName", "quantityGuess", "confidence", "visibility"],
          additionalProperties: false,
        },
      },
      uncertainItems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            canonicalName: { type: "string" },
            displayName: { type: "string" },
            reason: { type: "string", description: "Reason why uncertain, empty if none" },
          },
          required: ["canonicalName", "displayName", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["ingredients", "uncertainItems"],
    additionalProperties: false,
  };
}

export class GroqVisionProvider implements VisionProvider {
  readonly name = "groq" as const;
  readonly modelId = GROQ_MODEL_ID;
  readonly promptVersion = VISION_PROMPT_VERSION;
  private client: Groq;

  constructor(apiKey?: string) {
    const key = apiKey ?? config.groqApiKey;
    if (!key) throw new Error("GROQ_API_KEY is required for GroqVisionProvider");
    this.client = new Groq({ apiKey: key });
  }

  async analyzeFridgeImage(params: {
    imageBase64: string;
    mimeType: string;
  }): Promise<FridgeAnalysisResult> {
    const base64Data = params.imageBase64.includes(",")
      ? params.imageBase64.split(",")[1]
      : params.imageBase64;
    let mimeType = params.mimeType || "image/jpeg";
    if (mimeType === "image/heic" || mimeType === "image/heif") {
      console.warn("[groqVision] HEIC/HEIF received, treating as image/jpeg (may fail)");
      mimeType = "image/jpeg";
    }

    const bytes = Math.ceil((base64Data.length * 3) / 4);
    console.log(
      `[groqVision] request mime=${mimeType} bytes=${bytes} model=${this.modelId} version=${this.promptVersion}`,
    );

    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    const baseMessages: Groq.Chat.ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: VISION_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ];

    const strictSchema = getGroqJsonSchema();

    const tryCall = async (useStrict: boolean) => {
      // reasoning_effort none for efficient non-thinking behavior
      return (
        this.client.chat.completions.create as unknown as (
          args: unknown,
        ) => Promise<Groq.Chat.ChatCompletion>
      )({
        model: this.modelId,
        messages: baseMessages,
        reasoning_effort: "none",
        reasoning_format: "hidden",
        response_format: useStrict
          ? {
              type: "json_schema",
              json_schema: {
                name: "fridge_analysis",
                strict: true,
                schema: strictSchema,
              },
            }
          : {
              type: "json_schema",
              json_schema: {
                name: "fridge_analysis",
                strict: false,
                schema: strictSchema,
              },
            },
        temperature: 0.2,
        max_completion_tokens: GROQ_VISION_MAX_COMPLETION_TOKENS,
      });
    };

    let completion: Groq.Chat.ChatCompletion;
    try {
      try {
        completion = await tryCall(true);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = extractStatus(e);
        console.warn(`[groqVision] strict mode failed status=${status} msg=${msg.slice(0, 500)}`);
        // If strict gives 400 invalid schema, fallback to best-effort
        // Do NOT fallback for 429/503 - those should propagate for router fallback
        if (
          status === 429 ||
          status === 503 ||
          msg.includes("429") ||
          msg.includes("503") ||
          msg.toLowerCase().includes("rate")
        ) {
          throw e;
        }
        if (status === 400 || msg.includes("400") || msg.toLowerCase().includes("strict")) {
          console.warn("[groqVision] retrying with best-effort json_schema");
          completion = await tryCall(false);
        } else {
          throw e;
        }
      }

      const content = completion.choices?.[0]?.message?.content ?? "";
      // Capture rate limit headers if exposed via SDK (some SDKs expose via headers)
      const headers = (completion as unknown as { headers?: unknown })?.headers;
      if (headers) {
        console.log("[groqVision] headers", JSON.stringify(headers).slice(0, 500));
      }

      if (!content) throw new Error("Empty response from Groq");

      const stripped = content
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripped);
      } catch {
        // Try json_object mode fallback: treat stripped as possibly containing prose before json
        const jsonMatch = stripped.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error(`Invalid JSON from Groq: ${stripped.slice(0, 500)}`);
        }
      }

      const validated = fridgeAnalysisSchema.parse(parsed);

      // Normalize + dedup
      const seen = new Set<string>();
      const normalizedIngredients = validated.ingredients
        .map((ing) => {
          const norm = normalizeIngredient(ing.canonicalName);
          // Prefer normalized display, but keep original display if model gave better Russian?
          // Use norm.displayName (which may be cherry variant) — already handled
          // But if model's displayName looks Russian and not snake, prefer it if it differs from humanized fallback?
          // For now use norm.displayName
          return {
            canonicalName: norm.canonicalName,
            displayName: norm.displayName,
            quantityGuess: ing.quantityGuess ?? null,
            confidence: ing.confidence,
            visibility: ing.visibility,
          };
        })
        .filter((ing) => {
          if (seen.has(ing.canonicalName)) return false;
          seen.add(ing.canonicalName);
          return true;
        });

      const seenUncertain = new Set<string>();
      const normalizedUncertain = validated.uncertainItems
        .map((u) => {
          const norm = normalizeIngredient(u.canonicalName);
          return {
            canonicalName: norm.canonicalName,
            displayName: norm.displayName,
            reason: u.reason,
          };
        })
        .filter((u) => {
          if (seenUncertain.has(u.canonicalName)) return false;
          // also dedup if already in ingredients
          if (seen.has(u.canonicalName)) return false;
          seenUncertain.add(u.canonicalName);
          return true;
        });

      return {
        ingredients: normalizedIngredients,
        uncertainItems: normalizedUncertain,
        meta: { provider: "groq", modelId: this.modelId },
      };
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes("ByteString")) {
        console.error(
          "[groqVision] invalid GROQ_API_KEY (non-ASCII/placeholder):",
          raw.slice(0, 500),
        );
        throw new Error(
          "Groq vision failed: 401 Invalid GROQ_API_KEY (contains non-ASCII or placeholder like твой_ключ), check .env.local is gsk_... ASCII",
        );
      }
      const message = raw;
      const status = extractStatus(err);
      const enriched = status ? `${status} ${message}` : message;
      console.error("[groqVision] final error:", enriched.slice(0, 2000));
      throw new Error(`Groq vision failed: ${enriched}`);
    }
  }
}

function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const anyErr = err as Record<string, unknown>;
  if (typeof anyErr.status === "number") return anyErr.status as number;
  if (typeof anyErr.statusCode === "number") return anyErr.statusCode as number;
  const errObj = (anyErr.error as Record<string, unknown> | undefined) ?? anyErr;
  if (errObj && typeof errObj.status === "number") return errObj.status as number;
  // Check message for status code
  const msg = anyErr.message as string | undefined;
  if (msg) {
    const m429 = msg.match(/\b429\b/);
    if (m429) return 429;
    const m503 = msg.match(/\b503\b/);
    if (m503) return 503;
    const m400 = msg.match(/\b400\b/);
    if (m400) return 400;
  }
  return undefined;
}
