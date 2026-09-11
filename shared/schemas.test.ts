import { describe, it, expect } from "vitest";
import { fridgeAnalysisSchema, recommendationsSchema } from "./schemas.js";

describe("fridgeAnalysisSchema", () => {
  it("validates correct payload", () => {
    const ok = {
      ingredients: [
        {
          canonicalName: "tomato",
          displayName: "Помидоры",
          confidence: 0.91,
          visibility: "clear",
          quantityGuess: 3,
        },
      ],
      uncertainItems: [],
    };
    expect(() => fridgeAnalysisSchema.parse(ok)).not.toThrow();
  });

  it("rejects confidence out of range", () => {
    const bad = {
      ingredients: [
        { canonicalName: "tomato", displayName: "Помидоры", confidence: 1.5, visibility: "clear" },
      ],
      uncertainItems: [],
    };
    expect(() => fridgeAnalysisSchema.parse(bad)).toThrow();
  });

  it("rejects invalid visibility", () => {
    const bad = {
      ingredients: [
        {
          canonicalName: "tomato",
          displayName: "Помидоры",
          confidence: 0.5,
          visibility: "unknown",
        },
      ],
      uncertainItems: [],
    };
    expect(() => fridgeAnalysisSchema.parse(bad)).toThrow();
  });
});

describe("recommendationsSchema", () => {
  it("requires exactly 3 recipes", () => {
    const base = {
      id: "1",
      title: "Омлет",
      estimatedMinutes: 10,
      difficulty: "easy",
      slot: "fastest",
      requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
      steps: ["Шаг 1 делается", "Шаг 2 делается"],
      reason: "быстро",
    };
    const ok = {
      recipes: [
        base,
        { ...base, id: "2", slot: "normal" },
        { ...base, id: "3", slot: "from_what_exists" },
      ],
    };
    expect(() => recommendationsSchema.parse(ok)).not.toThrow();

    const bad = { recipes: [base, { ...base, id: "2", slot: "normal" }] };
    expect(() => recommendationsSchema.parse(bad as unknown as { recipes: unknown[] })).toThrow();
  });
});
