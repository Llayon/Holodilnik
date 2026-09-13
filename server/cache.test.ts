import { describe, it, expect, beforeEach } from "vitest";
import {
  getVisionCache,
  setVisionCache,
  getRecipeCache,
  setRecipeCache,
  clearAllCaches,
  _internal,
} from "./cache.js";
import type { FridgeAnalysisResult, RecommendationsResult } from "../shared/types.js";

const sampleVision: FridgeAnalysisResult = {
  ingredients: [
    { canonicalName: "tomato", displayName: "Помидоры", confidence: 0.9, visibility: "clear" },
  ],
  uncertainItems: [],
  meta: { provider: "groq", modelId: "qwen/qwen3.8-27b" },
};

const sampleRecipe: RecommendationsResult = {
  recipes: [
    {
      id: "1",
      title: "Тест",
      estimatedMinutes: 10,
      difficulty: "easy",
      slot: "fastest",
      requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
      optionalIngredients: [],
      missingIngredients: [],
      steps: ["Шаг 1 делается", "Шаг 2 делается"],
      reason: "быстро",
      hasAllIngredients: true,
    },
    {
      id: "2",
      title: "Тест2",
      estimatedMinutes: 20,
      difficulty: "medium",
      slot: "normal",
      requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
      optionalIngredients: [],
      missingIngredients: [],
      steps: ["Шаг 1 делается", "Шаг 2 делается"],
      reason: "норм",
      hasAllIngredients: true,
    },
    {
      id: "3",
      title: "Тест3",
      estimatedMinutes: 30,
      difficulty: "medium",
      slot: "from_what_exists",
      requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
      optionalIngredients: [],
      missingIngredients: [],
      steps: ["Шаг 1 делается", "Шаг 2 делается"],
      reason: "из того что есть",
      hasAllIngredients: true,
    },
  ] as unknown as RecommendationsResult["recipes"],
  meta: { provider: "groq", modelId: "qwen/qwen3.8-27b" },
};

describe("cache key stability", () => {
  beforeEach(() => clearAllCaches());

  it("vision key stable for same base64, same provider/model", () => {
    const k1 = _internal.stableVisionKey({
      imageBase64: "aaaa",
      provider: "gemini",
      modelId: "gemini-3.8-flash",
    });
    const k2 = _internal.stableVisionKey({
      imageBase64: "aaaa",
      provider: "gemini",
      modelId: "gemini-3.8-flash",
    });
    expect(k1).toBe(k2);
  });

  it("vision key differs on provider/model isolation", () => {
    const kGem = _internal.stableVisionKey({
      imageBase64: "aaaa",
      provider: "gemini",
      modelId: "gemini-3.8-flash",
    });
    const kGroq = _internal.stableVisionKey({
      imageBase64: "aaaa",
      provider: "groq",
      modelId: "qwen/qwen3.8-27b",
    });
    expect(kGem).not.toBe(kGroq);
  });

  it("vision key handles data URL prefix normalization", () => {
    const raw = "aaaa";
    const withPrefix = "data:image/jpeg;base64,aaaa";
    const k1 = _internal.stableVisionKey({
      imageBase64: raw,
      provider: "groq",
      modelId: "qwen/qwen3.8-27b",
    });
    const k2 = _internal.stableVisionKey({
      imageBase64: withPrefix,
      provider: "groq",
      modelId: "qwen/qwen3.8-27b",
    });
    expect(k1).toBe(k2);
  });

  it("recipe key stable for sorted canonicals regardless of order", () => {
    const k1 = _internal.stableRecipeKey({
      canonicalNames: ["tomato", "egg"],
      provider: "groq",
      modelId: "qwen/qwen3.8-27b",
    });
    const k2 = _internal.stableRecipeKey({
      canonicalNames: ["egg", "tomato"],
      provider: "groq",
      modelId: "qwen/qwen3.8-27b",
    });
    expect(k1).toBe(k2);
  });

  it("recipe key differs per provider/model isolation", () => {
    const kGroq = _internal.stableRecipeKey({
      canonicalNames: ["egg"],
      provider: "groq",
      modelId: "qwen/qwen3.8-27b",
    });
    const kGem = _internal.stableRecipeKey({
      canonicalNames: ["egg"],
      provider: "gemini",
      modelId: "gemini-3.8-flash",
    });
    expect(kGroq).not.toBe(kGem);
  });

  it("vision cache set/get roundtrip", () => {
    setVisionCache(
      { imageBase64: "bbbb", provider: "groq", modelId: "qwen/qwen3.8-27b" },
      sampleVision,
    );
    const got = getVisionCache({
      imageBase64: "bbbb",
      provider: "groq",
      modelId: "qwen/qwen3.8-27b",
    });
    expect(got).toEqual(sampleVision);
  });

  it("recipe cache set/get roundtrip", () => {
    setRecipeCache(
      { canonicalNames: ["egg", "tomato"], provider: "groq", modelId: "qwen/qwen3.8-27b" },
      sampleRecipe,
    );
    const got = getRecipeCache({
      canonicalNames: ["tomato", "egg"],
      provider: "groq",
      modelId: "qwen/qwen3.8-27b",
    });
    expect(got).toEqual(sampleRecipe);
  });

  it("cache never contains api keys in keys", () => {
    const k = _internal.stableVisionKey({
      imageBase64: "secret",
      provider: "groq",
      modelId: "qwen/qwen3.8-27b",
    });
    expect(k).not.toContain("GROQ_API_KEY");
    expect(k).not.toContain("GEMINI");
    const kr = _internal.stableRecipeKey({
      canonicalNames: ["egg"],
      provider: "groq",
      modelId: "qwen/qwen3.8-27b",
    });
    expect(kr).not.toContain("API_KEY");
  });

  it("clearAllCaches empties", () => {
    setVisionCache(
      { imageBase64: "x", provider: "groq", modelId: "qwen/qwen3.8-27b" },
      sampleVision,
    );
    expect(
      getVisionCache({ imageBase64: "x", provider: "groq", modelId: "qwen/qwen3.8-27b" }),
    ).toBeDefined();
    clearAllCaches();
    expect(
      getVisionCache({ imageBase64: "x", provider: "groq", modelId: "qwen/qwen3.8-27b" }),
    ).toBeUndefined();
  });
});
