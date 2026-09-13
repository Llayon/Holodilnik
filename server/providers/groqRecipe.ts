import Groq from "groq-sdk";
import type { RecipeProvider } from "./types.js";
import type { RecommendationsResult, Recipe } from "../../shared/types.js";
import { recommendationsSchema } from "../../shared/schemas.js";
import {
  validateRecipeAvailability,
  validateRecommendationsSlots,
} from "../../shared/validation.js";
import { PANTRY_SET } from "../../shared/pantry.js";
import { config, GROQ_MODEL_ID, RECIPE_PROMPT_VERSION } from "../config.js";
import { normalizeIngredient } from "../../shared/normalization.js";

const RECIPE_PROMPT = (ingredientsList: string): string =>
  `
Ты — помощник по кулинарии. Даны ингредиенты из холодильника (подтверждены пользователем).

Доступные ингредиенты:
${ingredientsList}

Базовые pantry staples (считай что есть всегда, не указывай как missing):
- соль (salt)
- чёрный перец (black_pepper)
- растительное масло (vegetable_oil)

Задача: предложи РОВНО 3 блюда, каждое под свой слот:

1. slot="fastest" — САМОЕ БЫСТРОЕ (до 15 минут, минимум усилий)
2. slot="normal" — НОРМАЛЬНЫЙ УЖИН (20-35 минут, сбалансированное блюдо)
3. slot="from_what_exists" — ИЗ ТОГО, ЧТО ЕСТЬ (максимально использует именно доступные продукты, без докупок)

Правила:
- Используй ТОЛЬКО доступные ингредиенты + pantry. НЕ требуй cream, cheese, rice, pasta, soy sauce и т.п. если их нет в списке.
- Если рецепт требует ингредиент, которого нет в списке и это не pantry — либо пометь его как missing (но тогда hasAllIngredients=false), либо не используй этот рецепт.
- Каждый рецепт: id (unique), title (коротко, аппетитно, на русском), estimatedMinutes, difficulty (easy/medium), slot, requiredIngredients (с canonicalName snake_case англ + displayName русский + amount), optionalIngredients, steps (2-7 шагов, кратко, без SEO воды), reason (почему подходит под слот).
- Шаги — короткие, практичные.
- НЕ добавляй прозу вне JSON.
- Верни СТРОГО JSON вида: { "recipes": [ ...3 recipes... ] }

Важно: requiredIngredients должен содержать только реально нужные ингредиенты. Если всё есть — hasAllIngredients будет true автоматически (сервер вычислит). Не пытайся обмануть — сервер проверит наличие.
`.trim();

function getRecipeJsonSchema() {
  return {
    type: "object",
    properties: {
      recipes: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            estimatedMinutes: { type: "integer", minimum: 5, maximum: 180 },
            difficulty: { type: "string", enum: ["easy", "medium"] },
            slot: { type: "string", enum: ["fastest", "normal", "from_what_exists"] },
            requiredIngredients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  canonicalName: { type: "string" },
                  displayName: { type: "string" },
                  amount: { type: "string" },
                },
                required: ["canonicalName", "displayName"],
                additionalProperties: false,
              },
            },
            optionalIngredients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  canonicalName: { type: "string" },
                  displayName: { type: "string" },
                  amount: { type: "string" },
                },
                required: ["canonicalName", "displayName"],
                additionalProperties: false,
              },
            },
            steps: {
              type: "array",
              items: { type: "string" },
            },
            reason: { type: "string" },
          },
          required: [
            "id",
            "title",
            "estimatedMinutes",
            "difficulty",
            "slot",
            "requiredIngredients",
            "steps",
            "reason",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["recipes"],
    additionalProperties: false,
  };
}

export class GroqRecipeProvider implements RecipeProvider {
  readonly name = "groq" as const;
  readonly modelId = GROQ_MODEL_ID;
  readonly promptVersion = RECIPE_PROMPT_VERSION;
  private client: Groq;

  constructor(apiKey?: string) {
    const key = apiKey ?? config.groqApiKey;
    if (!key) throw new Error("GROQ_API_KEY is required for GroqRecipeProvider");
    this.client = new Groq({ apiKey: key });
  }

  async generateRecommendations(params: {
    ingredients: Array<{ canonicalName: string; displayName: string }>;
  }): Promise<RecommendationsResult> {
    const listStr = params.ingredients
      .map((i) => {
        const norm = normalizeIngredient(i.canonicalName);
        // Ensure displayName is human readable
        const disp = norm.displayName || i.displayName;
        return `- ${disp} (${norm.canonicalName})`;
      })
      .join("\n");
    const prompt = RECIPE_PROMPT(listStr);

    console.log(
      `[groqRecipe] request ingredients=${params.ingredients.length} model=${this.modelId} version=${this.promptVersion}`,
    );

    const schema = getRecipeJsonSchema();

    const tryCall = async (useStrict: boolean) => {
      return (
        this.client.chat.completions.create as unknown as (
          args: unknown,
        ) => Promise<Groq.Chat.ChatCompletion>
      )({
        model: this.modelId,
        messages: [{ role: "user", content: prompt }],
        reasoning_effort: "none",
        reasoning_format: "hidden",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "recommendations",
            strict: useStrict,
            schema,
          },
        },
        temperature: 0.7,
        max_completion_tokens: 2500,
      });
    };

    try {
      let completion: Groq.Chat.ChatCompletion;
      try {
        completion = await tryCall(true);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = extractStatus(e);
        console.warn(`[groqRecipe] strict failed status=${status} msg=${msg.slice(0, 500)}`);
        if (status === 429 || status === 503 || msg.includes("429") || msg.includes("503")) {
          throw e;
        }
        if (status === 400 || msg.includes("400") || msg.toLowerCase().includes("strict")) {
          console.warn("[groqRecipe] retrying best-effort");
          completion = await tryCall(false);
        } else {
          throw e;
        }
      }

      const content = completion.choices?.[0]?.message?.content ?? "";
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
        const m = stripped.match(/\{[\s\S]*\}/);
        if (m) parsed = JSON.parse(m[0]);
        else throw new Error(`Invalid JSON from Groq: ${stripped.slice(0, 500)}`);
      }

      const validated = recommendationsSchema.parse(parsed);

      // Re-normalize ingredient refs to ensure displayName not snake_case
      const availableSet = new Set<string>([
        ...params.ingredients.map((i) => i.canonicalName.toLowerCase().replace(/\s+/g, "_")),
        ...Array.from(PANTRY_SET),
      ]);

      const recipes: Recipe[] = validated.recipes.map((r) => {
        const normalizedRequired = r.requiredIngredients.map((ing) => {
          const norm = normalizeIngredient(ing.canonicalName);
          // If model gave garbage displayName snake, use normalized
          const disp = CANONICAL_DISPLAY_LOOKUP(ing, norm);
          return { canonicalName: norm.canonicalName, displayName: disp, amount: ing.amount };
        });
        const normalizedOptional = (r.optionalIngredients ?? []).map((ing) => {
          const norm = normalizeIngredient(ing.canonicalName);
          const disp = CANONICAL_DISPLAY_LOOKUP(ing, norm);
          return { canonicalName: norm.canonicalName, displayName: disp, amount: ing.amount };
        });

        return validateRecipeAvailability(
          {
            id: r.id,
            title: r.title,
            estimatedMinutes: r.estimatedMinutes,
            difficulty: r.difficulty,
            slot: r.slot,
            requiredIngredients: normalizedRequired,
            optionalIngredients: normalizedOptional,
            steps: r.steps,
            reason: r.reason,
          },
          availableSet,
        ) as Recipe;
      });

      const slotCheck = validateRecommendationsSlots(recipes);
      if (!slotCheck.valid) {
        throw new Error(`Invalid slot distribution: ${slotCheck.error}`);
      }

      const order: Record<string, number> = { fastest: 0, normal: 1, from_what_exists: 2 };
      recipes.sort((a, b) => (order[a.slot] ?? 99) - (order[b.slot] ?? 99));

      return {
        recipes: recipes as [Recipe, Recipe, Recipe],
        meta: { provider: "groq", modelId: this.modelId },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = extractStatus(err);
      const enriched = status ? `${status} ${msg}` : msg;
      console.error("[groqRecipe] error:", enriched.slice(0, 2000));
      throw new Error(`Groq recipe generation failed: ${enriched}`);
    }
  }
}

function CANONICAL_DISPLAY_LOOKUP(
  ing: { canonicalName: string; displayName: string },
  norm: { displayName: string; canonicalName: string },
): string {
  // If model's displayName contains underscore or looks like snake, prefer normalized
  if (
    ing.displayName.includes("_") ||
    ing.displayName.toLowerCase() === ing.canonicalName.toLowerCase()
  ) {
    return norm.displayName;
  }
  // If normalized is Title case English but model gave Russian, prefer model Russian if not snake
  // Heuristic: if model display contains Cyrillic, use it (more likely correct Russian)
  const hasCyrillic = /[а-яё]/i.test(ing.displayName);
  if (hasCyrillic && !ing.displayName.includes("_")) {
    return ing.displayName;
  }
  return norm.displayName;
}

function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const anyErr = err as Record<string, unknown>;
  if (typeof anyErr.status === "number") return anyErr.status as number;
  if (typeof anyErr.statusCode === "number") return anyErr.statusCode as number;
  const errObj = (anyErr.error as Record<string, unknown> | undefined) ?? anyErr;
  if (errObj && typeof errObj.status === "number") return errObj.status as number;
  const msg = anyErr.message as string | undefined;
  if (msg) {
    if (/\b429\b/.test(msg)) return 429;
    if (/\b503\b/.test(msg)) return 503;
    if (/\b400\b/.test(msg)) return 400;
  }
  return undefined;
}
