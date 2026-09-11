import { describe, it, expect } from "vitest";
import { validateRecipeAvailability, validateRecommendationsSlots } from "./validation.js";
import type { Recipe } from "./types.js";

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "r1",
    title: "Тест",
    estimatedMinutes: 15,
    difficulty: "easy",
    slot: "fastest",
    requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца", amount: "2 шт" }],
    optionalIngredients: [],
    missingIngredients: [],
    steps: ["Шаг 1", "Шаг 2 делается долго"],
    reason: "тест",
    hasAllIngredients: true,
    ...overrides,
  } as Recipe;
}

describe("validateRecipeAvailability", () => {
  it("marks missing ingredients not in pantry", () => {
    const recipe = makeRecipe({
      requiredIngredients: [
        { canonicalName: "egg", displayName: "Яйца" },
        { canonicalName: "chicken", displayName: "Курица" },
      ],
    });
    const available = new Set(["egg", "salt"]);
    const result = validateRecipeAvailability(recipe, available);
    expect(result.missingIngredients).toHaveLength(1);
    expect(result.missingIngredients[0].canonicalName).toBe("chicken");
    expect(result.hasAllIngredients).toBe(false);
  });

  it("pantry staples are not considered missing", () => {
    const recipe = makeRecipe({
      requiredIngredients: [
        { canonicalName: "egg", displayName: "Яйца" },
        { canonicalName: "salt", displayName: "Соль" },
        { canonicalName: "black_pepper", displayName: "Перец" },
        { canonicalName: "vegetable_oil", displayName: "Масло" },
      ],
    });
    const available = new Set(["egg"]);
    const result = validateRecipeAvailability(recipe, available);
    expect(result.missingIngredients).toHaveLength(0);
    expect(result.hasAllIngredients).toBe(true);
  });

  it("hasAll true when all required available", () => {
    const recipe = makeRecipe();
    const available = new Set(["egg"]);
    const result = validateRecipeAvailability(recipe, available);
    expect(result.hasAllIngredients).toBe(true);
  });

  it("never reports Всё есть when missing exists", () => {
    const recipe = makeRecipe({
      requiredIngredients: [{ canonicalName: "cream", displayName: "Сливки" }],
    });
    const available = new Set(["egg"]);
    const result = validateRecipeAvailability(recipe, available);
    expect(result.hasAllIngredients).toBe(false);
    expect(result.missingIngredients.length).toBeGreaterThan(0);
  });
});

describe("validateRecommendationsSlots", () => {
  it("validates exactly 3 distinct slots", () => {
    const recipes = [
      makeRecipe({ id: "1", slot: "fastest" }),
      makeRecipe({ id: "2", slot: "normal" }),
      makeRecipe({ id: "3", slot: "from_what_exists" }),
    ] as Recipe[];
    expect(validateRecommendationsSlots(recipes).valid).toBe(true);
  });

  it("fails when not 3 recipes", () => {
    const recipes = [makeRecipe({ slot: "fastest" }), makeRecipe({ slot: "normal" })] as Recipe[];
    expect(validateRecommendationsSlots(recipes).valid).toBe(false);
  });

  it("fails when duplicate slots", () => {
    const recipes = [
      makeRecipe({ id: "1", slot: "fastest" }),
      makeRecipe({ id: "2", slot: "fastest" }),
      makeRecipe({ id: "3", slot: "normal" }),
    ] as Recipe[];
    expect(validateRecommendationsSlots(recipes).valid).toBe(false);
  });

  it("fails when missing required slot", () => {
    const recipes = [
      makeRecipe({ id: "1", slot: "fastest" }),
      makeRecipe({ id: "2", slot: "normal" }),
      makeRecipe({ id: "3", slot: "normal" }),
    ] as Recipe[];
    const res = validateRecommendationsSlots(recipes);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/distinct|Missing/);
  });
});
