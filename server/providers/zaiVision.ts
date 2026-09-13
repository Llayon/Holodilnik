import type { VisionProvider } from "./types.js";
import type { FridgeAnalysisResult } from "../../shared/types.js";
import { fridgeAnalysisSchema } from "../../shared/schemas.js";
import { normalizeIngredient } from "../../shared/normalization.js";
import { config, ZAI_MODEL_ID, ZAI_VISION_PROMPT_VERSION, ZAI_API_BASE } from "../config.js";

const ZAI_VISION_PROMPT = `
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

function getZaiJsonSchema() {
  // For potential strict schema support; currently Z.AI vision may not support strict, but we provide schema for json_object fallback validation
  return {
    type: "object",
    properties: {
      ingredients: {
        type: "array",
        items: {
          type: "object",
          properties: {
            canonicalName: { type: "string" },
            displayName: { type: "string" },
            quantityGuess: { anyOf: [{ type: "number" }, { type: "null" }] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            visibility: { type: "string", enum: ["clear", "partial", "uncertain"] },
          },
          required: ["canonicalName", "displayName", "confidence", "visibility"],
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
            reason: { type: "string" },
          },
          required: ["canonicalName", "displayName"],
          additionalProperties: false,
        },
      },
    },
    required: ["ingredients", "uncertainItems"],
    additionalProperties: false,
  };
}

export class ZaiVisionProvider implements VisionProvider {
  readonly name = "zai" as const;
  readonly modelId = ZAI_MODEL_ID;
  readonly promptVersion = ZAI_VISION_PROMPT_VERSION;
  private apiKey: string;
  private apiBase: string;

  constructor(apiKey?: string, apiBase?: string) {
    const key = apiKey ?? config.zaiApiKey;
    if (!key) throw new Error("ZAI_API_KEY is required for ZaiVisionProvider");
    this.apiKey = key;
    this.apiBase = apiBase ?? config.zaiApiBase ?? ZAI_API_BASE;
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
      console.warn("[zaiVision] HEIC/HEIF received, treating as image/jpeg (may fail)");
      mimeType = "image/jpeg";
    }
    const bytes = Math.ceil((base64Data.length * 3) / 4);
    console.log(
      `[zaiVision] request mime=${mimeType} bytes=${bytes} model=${this.modelId} version=${this.promptVersion} base=${this.apiBase}`,
    );

    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    // Build messages: Z.AI expects image_url with url field containing data URL or https URL
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: ZAI_VISION_PROMPT },
          { type: "image_url" as const, image_url: { url: dataUrl } },
        ],
      },
    ];

    // Try with json_object first (strongest mode we can attempt without strict schema)
    // If API returns 1214 invalid parameter, retry without response_format
    const tryCall = async (withJsonObject: boolean) => {
      const body: Record<string, unknown> = {
        model: this.modelId,
        messages,
        temperature: 0.2,
        max_tokens: 2000,
      };
      if (withJsonObject) {
        body.response_format = { type: "json_object" };
      }
      // Disable thinking for efficiency; per docs thinking type disabled
      // For glm-4.6v-flash, thinking is optional, default disabled; we explicitly disable to save tokens
      // body.thinking = { type: "disabled" }; // uncomment if needed, but omit to keep minimal

      const res = await fetch(`${this.apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Invalid JSON from Z.AI HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      if (!res.ok) {
        // Z.AI error body contains {code, message} or {error:{code,message}}
        const errObj = json as Record<string, unknown>;
        const code =
          (errObj.code as number | undefined) ??
          ((errObj.error as Record<string, unknown> | undefined)?.code as number | undefined);
        const msg =
          (errObj.message as string | undefined) ??
          ((errObj.error as Record<string, unknown> | undefined)?.message as string | undefined) ??
          text;
        const err = new Error(`${res.status} ZAI error code ${code ?? res.status}: ${msg}`);
        // Attach code for mapping
        (err as unknown as { status?: number; code?: number }).status = res.status;
        (err as unknown as { code?: number }).code = code;
        // Preserve raw for debugging but not secret
        throw err;
      }
      return json as {
        choices?: Array<{ message?: { content?: string } }>;
        id?: string;
        model?: string;
        usage?: unknown;
      };
    };

    let raw: Awaited<ReturnType<typeof tryCall>>;
    try {
      try {
        raw = await tryCall(true);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const lower = msg.toLowerCase();
        // If invalid parameter for response_format, retry without it
        if (
          msg.includes("1214") ||
          lower.includes("response_format") ||
          lower.includes("invalid api parameter")
        ) {
          console.warn("[zaiVision] json_object not supported, retrying without response_format");
          raw = await tryCall(false);
        } else {
          throw e;
        }
      }

      const content = raw.choices?.[0]?.message?.content ?? "";
      if (!content) throw new Error("Empty response from Z.AI");

      const stripped = content
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripped);
      } catch {
        const m = stripped.match(/\{[\s\S]*\}/);
        if (m) parsed = JSON.parse(m[0]);
        else throw new Error(`Invalid JSON from Z.AI: ${stripped.slice(0, 500)}`);
      }

      const validated = fridgeAnalysisSchema.parse(parsed);

      const seen = new Set<string>();
      const normalizedIngredients = validated.ingredients
        .map((ing) => {
          const norm = normalizeIngredient(ing.canonicalName);
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
          if (seen.has(u.canonicalName)) return false;
          seenUncertain.add(u.canonicalName);
          return true;
        });

      return {
        ingredients: normalizedIngredients,
        uncertainItems: normalizedUncertain,
        meta: { provider: "zai", modelId: this.modelId },
      };
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      if (rawMsg.includes("ByteString")) {
        console.error(
          "[zaiVision] invalid ZAI_API_KEY (non-ASCII/placeholder):",
          rawMsg.slice(0, 500),
        );
        throw new Error(
          "ZAI vision failed: 401 Invalid ZAI_API_KEY (contains non-ASCII or placeholder), check .env.local",
        );
      }
      const status = extractStatus(err);
      const code = extractZaiCode(err);
      const enriched = `${status ?? ""} ${code ? `code ${code}` : ""} ${rawMsg}`.trim();
      console.error("[zaiVision] final error:", enriched.slice(0, 2000));
      throw new Error(`ZAI vision failed: ${enriched}`);
    }
  }
}

function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const anyErr = err as Record<string, unknown>;
  if (typeof anyErr.status === "number") return anyErr.status as number;
  const msg = anyErr.message as string | undefined;
  if (msg) {
    const m = msg.match(/\b(429|401|400|500|503)\b/);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function extractZaiCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const anyErr = err as Record<string, unknown>;
  if (typeof anyErr.code === "number") return anyErr.code as number;
  const msg = anyErr.message as string | undefined;
  if (msg) {
    const m = msg.match(/code\s*(1302|1303|1304|1305|1308|131[0-9]|1113)/);
    if (m) return parseInt(m[1], 10);
    const m2 = msg.match(/\b130[0-9]\b/);
    if (m2) return parseInt(m2[0], 10);
  }
  return undefined;
}

// Export for testing
export const _zaiInternals = {
  getZaiJsonSchema,
  ZAI_VISION_PROMPT,
};
