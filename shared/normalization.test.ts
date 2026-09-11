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
});
