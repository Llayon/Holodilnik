import { GoogleGenAI } from "@google/genai";
import type { RecipeProvider } from "./types.js";
import type { RecommendationsResult, Recipe } from "../../shared/types.js";
import { recommendationsSchema, getRecommendationsJsonSchema } from "../../shared/schemas.js";
import {
  validateRecipeAvailability,
  validateRecommendationsSlots,
} from "../../shared/validation.js";
import { PANTRY_SET } from "../../shared/pantry.js";
import { config } from "../config.js";

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

export class GeminiRecipeProvider implements RecipeProvider {
  readonly name = "gemini" as const;
  readonly modelId = config.modelId;
  private client: GoogleGenAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? config.geminiApiKey;
    if (!key) throw new Error("GEMINI_API_KEY is required for GeminiRecipeProvider");
    this.client = new GoogleGenAI({ apiKey: key });
  }

  async generateRecommendations(params: {
    ingredients: Array<{ canonicalName: string; displayName: string }>;
  }): Promise<RecommendationsResult> {
    const listStr = params.ingredients
      .map((i) => `- ${i.displayName} (${i.canonicalName})`)
      .join("\n");
    const prompt = RECIPE_PROMPT(listStr);

    const jsonSchema = getRecommendationsJsonSchema();

    try {
      const response = await this.client.models.generateContent({
        model: this.modelId,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
        } as unknown as Record<string, unknown>,
      });

      const text = response.text ?? "";
      if (!text) throw new Error("Empty response from Gemini");

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Invalid JSON from Gemini: ${text.slice(0, 500)}`);
      }

      const validated = recommendationsSchema.parse(parsed);

      // Post-validation: recompute availability deterministically
      const availableSet = new Set<string>([
        ...params.ingredients.map((i) => i.canonicalName.toLowerCase().replace(/\s+/g, "_")),
        ...Array.from(PANTRY_SET),
      ]);

      const recipes: Recipe[] = validated.recipes.map((r) =>
        validateRecipeAvailability(
          {
            id: r.id,
            title: r.title,
            estimatedMinutes: r.estimatedMinutes,
            difficulty: r.difficulty,
            slot: r.slot,
            requiredIngredients: r.requiredIngredients,
            optionalIngredients: r.optionalIngredients ?? [],
            steps: r.steps,
            reason: r.reason,
          },
          availableSet,
        ),
      ) as Recipe[];

      // Ensure exactly 3 and slots distinct, otherwise throw
      const slotCheck = validateRecommendationsSlots(recipes);
      if (!slotCheck.valid) {
        throw new Error(`Invalid slot distribution: ${slotCheck.error}`);
      }

      // Sort by slot order for consistent UI
      const order: Record<string, number> = { fastest: 0, normal: 1, from_what_exists: 2 };
      recipes.sort((a, b) => (order[a.slot] ?? 99) - (order[b.slot] ?? 99));

      return {
        recipes: recipes as [Recipe, Recipe, Recipe],
        meta: { provider: "gemini", modelId: this.modelId },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Gemini recipe generation failed: ${message}`);
    }
  }
}
