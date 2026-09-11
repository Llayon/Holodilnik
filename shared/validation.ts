import { PANTRY_SET } from "./pantry.js";
import type { Recipe, RecipeIngredientRef } from "./types.js";
import { recipeSchema, fridgeAnalysisSchema } from "./schemas.js";

/**
 * Validates and normalizes recipe against available ingredients.
 * Returns validated recipe with missingIngredients and hasAllIngredients computed.
 */
export function validateRecipeAvailability(
  recipe: Omit<Recipe, "missingIngredients" | "hasAllIngredients"> & {
    missingIngredients?: RecipeIngredientRef[];
    hasAllIngredients?: boolean;
  },
  availableCanonicals: Set<string>,
): Recipe {
  const missing: RecipeIngredientRef[] = [];

  for (const ing of recipe.requiredIngredients) {
    const canonical = ing.canonicalName.toLowerCase().replace(/\s+/g, "_");
    if (!availableCanonicals.has(canonical) && !PANTRY_SET.has(canonical)) {
      missing.push(ing);
    }
  }

  // Also check optional? Not needed - optional missing is okay, don't count as missing.

  const hasAll = missing.length === 0;

  return {
    ...recipe,
    optionalIngredients: recipe.optionalIngredients ?? [],
    missingIngredients: missing,
    hasAllIngredients: hasAll,
  } as Recipe;
}

/**
 * Validates that recommendations contain exactly 3 recipes with distinct slots.
 */
export function validateRecommendationsSlots(recipes: Recipe[]): {
  valid: boolean;
  error?: string;
} {
  if (recipes.length !== 3) {
    return { valid: false, error: `Expected exactly 3 recipes, got ${recipes.length}` };
  }
  const slots = recipes.map((r) => r.slot);
  const unique = new Set(slots);
  if (unique.size !== 3) {
    return { valid: false, error: `Expected 3 distinct slots, got ${slots.join(", ")}` };
  }
  const requiredSlots = ["fastest", "normal", "from_what_exists"];
  for (const s of requiredSlots) {
    if (!slots.includes(s as never)) {
      return { valid: false, error: `Missing required slot: ${s}` };
    }
  }
  return { valid: true };
}

export function parseAndValidateFridgeAnalysis(data: unknown) {
  return fridgeAnalysisSchema.parse(data);
}

export function parseAndValidateRecipe(data: unknown) {
  return recipeSchema.parse(data);
}

/**
 * Simple runtime check for image base64 validity
 */
export function isValidBase64Image(data: string): boolean {
  if (!data || data.length < 100) return false;
  // Check if it's base64-ish (only base64 chars)
  // Allow data URL prefix
  const base64Part = data.includes(",") ? data.split(",")[1] : data;
  const base64Regex = /^[A-Za-z0-9+/=_-]+$/;
  return base64Regex.test(base64Part.slice(0, 200));
}

export function getValidationErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
