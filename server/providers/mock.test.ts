import { describe, it, expect } from "vitest";
import { MockVisionProvider } from "./mockVision.js";
import { MockRecipeProvider } from "./mockRecipe.js";

describe("MockVisionProvider", () => {
  it("returns deterministic mock analysis", async () => {
    const p = new MockVisionProvider();
    const res = await p.analyzeFridgeImage({ imageBase64: "AAAA", mimeType: "image/jpeg" });
    expect(res.ingredients.length).toBeGreaterThan(0);
    expect(res.ingredients.some((i: { canonicalName: string }) => i.canonicalName === "egg")).toBe(
      true,
    );
    expect(res.meta?.provider).toBe("mock");
  });
});

describe("MockRecipeProvider", () => {
  it("returns exactly 3 recipes", async () => {
    const p = new MockRecipeProvider();
    const res = await p.generateRecommendations({
      ingredients: [
        { canonicalName: "egg", displayName: "Яйца" },
        { canonicalName: "tomato", displayName: "Помидоры" },
      ],
    });
    expect(res.recipes).toHaveLength(3);
    const slots = res.recipes.map((r: { slot: string }) => r.slot);
    expect(new Set(slots).size).toBe(3);
  });

  it("computes missing ingredients correctly", async () => {
    const p = new MockRecipeProvider();
    const res = await p.generateRecommendations({
      ingredients: [{ canonicalName: "egg", displayName: "Яйца" }],
    });
    // MOCK_RECIPES require chicken, zucchini etc. So some should be missing
    const hasMissing = res.recipes.some(
      (r: { missingIngredients: unknown[] }) => r.missingIngredients.length > 0,
    );
    expect(hasMissing).toBe(true);
    // hasAllIngredients should be consistent
    for (const r of res.recipes as Array<{
      hasAllIngredients: boolean;
      missingIngredients: unknown[];
    }>) {
      expect(r.hasAllIngredients).toBe(r.missingIngredients.length === 0);
    }
  });
});
