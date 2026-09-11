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
    const mimeType = params.mimeType || "image/jpeg";

    const jsonSchema = getFridgeJsonSchema();

    try {
      const response = await this.client.models.generateContent({
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
          // Gemini 3.8 Flash supports thinkingLevel low/medium/high, use low for vision speed
          thinkingConfig: { thinkingLevel: "low" },
        } as unknown as Record<string, unknown>,
      });

      const text = response.text ?? "";
      if (!text) {
        throw new Error("Empty response from Gemini");
      }

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
      // Wrap for caller
      throw new Error(`Gemini vision failed: ${message}`);
    }
  }
}
