import { describe, it, expect } from "vitest";
import { normalizeIngredient, getDisplayName, SUGGESTIBLE_INGREDIENTS } from "./normalization.js";

describe("normalizeIngredient", () => {
  it("normalizes english plural to canonical", () => {
    expect(normalizeIngredient("tomatoes").canonicalName).toBe("tomato");
    expect(normalizeIngredient("eggs").canonicalName).toBe("egg");
    expect(normalizeIngredient("sweet pepper").canonicalName).toBe("bell_pepper");
  });

  it("normalizes russian to canonical", () => {
    expect(normalizeIngredient("Помидоры").canonicalName).toBe("tomato");
    expect(normalizeIngredient("яйца").canonicalName).toBe("egg");
    expect(normalizeIngredient("болгарский перец").canonicalName).toBe("bell_pepper");
  });

  it("keeps separate display name", () => {
    const r = normalizeIngredient("tomatoes");
    expect(r.displayName).toBe("Помидоры");
    expect(r.canonicalName).toBe("tomato");
  });

  it("handles unknown ingredient fallback", () => {
    const r = normalizeIngredient("dragonfruit");
    expect(r.canonicalName).toBe("dragonfruit");
    expect(r.displayName).toBe("Dragonfruit");
  });

  it("suggestible list has russian display names", () => {
    for (const s of SUGGESTIBLE_INGREDIENTS) {
      expect(s.displayName).toBeTruthy();
      expect(s.canonicalName).toBeTruthy();
      expect(getDisplayName(s.canonicalName)).toBe(s.displayName);
    }
  });

  it("regression: Yellow tomato / Cherry_tomato / Cutlet never expose snake_case to UI", () => {
    expect(normalizeIngredient("Yellow tomato").displayName).toBe("Жёлтые помидоры");
    expect(normalizeIngredient("Yellow tomato").canonicalName).toBe("yellow_tomato");
    expect(getDisplayName("yellow_tomato")).toBe("Жёлтые помидоры");
    expect(getDisplayName("yellow_tomato")).not.toContain("_");

    expect(normalizeIngredient("Cherry_tomato").displayName).toBe("Помидоры черри");
    expect(normalizeIngredient("Cherry_tomato").canonicalName).toBe("cherry_tomato");
    expect(getDisplayName("cherry_tomato")).toBe("Помидоры черри");

    expect(normalizeIngredient("Cutlet").displayName).toBe("Котлета");
    expect(normalizeIngredient("Cutlet").canonicalName).toBe("cutlet");
    expect(getDisplayName("cutlet")).toBe("Котлета");

    // snake underscore should not appear in any display fallback
    expect(normalizeIngredient("cherry_tomato").displayName).not.toContain("_");
    expect(normalizeIngredient("yellow_tomato").displayName).not.toContain("_");
    expect(normalizeIngredient("cutlet").displayName).not.toContain("_");
  });

  it("unknown snake_case is humanized, not raw", () => {
    const r = normalizeIngredient("some_unknown_ingredient");
    expect(r.displayName).toBe("Some Unknown Ingredient");
    expect(r.displayName).not.toContain("_");
    expect(getDisplayName("some_unknown_ingredient")).toBe("Some Unknown Ingredient");
    expect(getDisplayName("some_unknown_ingredient")).not.toContain("_");
  });

  it("variant alias maps correctly", () => {
    expect(normalizeIngredient("yellow tomato").canonicalName).toBe("yellow_tomato");
    expect(normalizeIngredient("cherry tomato").canonicalName).toBe("cherry_tomato");
    expect(normalizeIngredient("котлета").canonicalName).toBe("cutlet");
    expect(normalizeIngredient("котлеты").canonicalName).toBe("cutlet");
    expect(normalizeIngredient("помидоры черри").canonicalName).toBe("cherry_tomato");
    expect(normalizeIngredient("жёлтые помидоры").canonicalName).toBe("yellow_tomato");
  });
});
