import { GoogleGenAI } from "@google/genai";
import type { VisionProvider } from "./types.js";
import type { FridgeAnalysisResult } from "../../shared/types.js";
import { fridgeAnalysisSchema, getFridgeJsonSchema } from "../../shared/schemas.js";
import { normalizeIngredient } from "../../shared/normalization.js";
import { config } from "../config.js";

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

export class GeminiVisionProvider implements VisionProvider {
  readonly name = "gemini" as const;
  readonly modelId = config.modelId;
  private client: GoogleGenAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? config.geminiApiKey;
    if (!key) throw new Error("GEMINI_API_KEY is required for GeminiVisionProvider");
    this.client = new GoogleGenAI({ apiKey: key });
  }

  async analyzeFridgeImage(params: {
    imageBase64: string;
    mimeType: string;
  }): Promise<FridgeAnalysisResult> {
    const base64Data = params.imageBase64.includes(",")
      ? params.imageBase64.split(",")[1]
      : params.imageBase64;
    let mimeType = params.mimeType || "image/jpeg";

    // HEIC/HEIF not reliably supported by Gemini, normalize to jpeg with warning
    // Client sends file.type; iPhone may send heic. Try to treat as jpeg if possible, else fallback
    if (mimeType === "image/heic" || mimeType === "image/heif") {
      console.warn(
        `[geminiVision] HEIC/HEIF received, treating as image/jpeg for Gemini (may fail)`,
      );
      mimeType = "image/jpeg";
    }

    const jsonSchema = getFridgeJsonSchema();
    const base64Bytes = Math.ceil((base64Data.length * 3) / 4);
    console.log(
      `[geminiVision] request mime=${mimeType} bytes=${base64Bytes} model=${this.modelId}`,
    );

    const callStructured = async () => {
      return this.client.models.generateContent({
        model: this.modelId,
        contents: [
          {
            role: "user",
            parts: [
              { text: VISION_PROMPT },
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
        } as unknown as Record<string, unknown>,
      });
    };

    const callFallback = async () => {
      console.warn("[geminiVision] structured call failed, retrying without schema");
      const fallbackPrompt =
        VISION_PROMPT + "\nВерни ТОЛЬКО валидный JSON без markdown, без пояснений.";
      return this.client.models.generateContent({
        model: this.modelId,
        contents: [
          {
            role: "user",
            parts: [
              { text: fallbackPrompt },
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
        } as unknown as Record<string, unknown>,
      });
    };

    let response: Awaited<ReturnType<typeof this.client.models.generateContent>>;
    try {
      try {
        response = await callStructured();
      } catch (structuredErr) {
        const msg = structuredErr instanceof Error ? structuredErr.message : String(structuredErr);
        console.error("[geminiVision] structured failed:", msg);
        // If invalid argument due to schema, try fallback; if quota/rate limit, rethrow immediately
        if (
          msg.includes("429") ||
          msg.includes("RESOURCE_EXHAUSTED") ||
          msg.toLowerCase().includes("quota") ||
          msg.includes("503") ||
          msg.toLowerCase().includes("unavailable")
        ) {
          throw structuredErr;
        }
        // For INVALID_ARGUMENT, try fallback once
        if (msg.includes("400") || msg.includes("INVALID_ARGUMENT")) {
          response = await callFallback();
        } else {
          throw structuredErr;
        }
      }

      let text = response.text ?? "";
      if (!text) {
        // fallback for SDK variants where text is in candidates
        const cand =
          (
            response as unknown as {
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            }
          ).candidates?.[0]?.content?.parts
            ?.map((p) => p.text)
            .join("") ?? "";
        text = cand;
      }
      if (!text) {
        throw new Error("Empty response from Gemini");
      }
      // Strip markdown code fences if present (fallback mode may return ```json ... ```)
      const stripped = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();
      text = stripped;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Invalid JSON from Gemini: ${text.slice(0, 500)}`);
      }

      // Validate with zod
      const validated = fridgeAnalysisSchema.parse(parsed);

      // Normalize ingredients through our layer to ensure canonical consistency
      const normalizedIngredients = validated.ingredients.map((ing) => {
        const norm = normalizeIngredient(ing.canonicalName);
        return {
          canonicalName: norm.canonicalName,
          displayName: norm.displayName, // prefer normalized Russian
          quantityGuess: ing.quantityGuess ?? null,
          confidence: ing.confidence,
          visibility: ing.visibility,
        };
      });

      const normalizedUncertain = validated.uncertainItems.map((u) => {
        const norm = normalizeIngredient(u.canonicalName);
        return {
          canonicalName: norm.canonicalName,
          displayName: norm.displayName,
          reason: u.reason,
        };
      });

      return {
        ingredients: normalizedIngredients,
        uncertainItems: normalizedUncertain,
        meta: { provider: "gemini", modelId: this.modelId },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const full =
        err instanceof Error && (err as unknown as { stack?: string }).stack
          ? (err as unknown as { stack?: string }).stack
          : message;
      console.error("[geminiVision] final error:", full?.slice(0, 2000));
      // Preserve original message for status mapping (429 etc)
      throw new Error(`Gemini vision failed: ${message}`);
    }
  }
}
