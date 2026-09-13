import { describe, it, expect, vi, beforeEach } from "vitest";
import { VisionProviderChain, RecipeProviderChain, __testIsRetryable } from "./router.js";
import { clearAllCaches } from "../cache.js";
import type { FridgeAnalysisResult, RecommendationsResult } from "../../shared/types.js";

function makeVisionProvider(
  name: string,
  impl: (p: { imageBase64: string; mimeType: string }) => Promise<FridgeAnalysisResult>,
) {
  return {
    name: name as never,
    modelId: `${name}-model`,
    analyzeFridgeImage: impl,
  };
}
function makeRecipeProvider(
  name: string,
  impl: (p: {
    ingredients: Array<{ canonicalName: string; displayName: string }>;
  }) => Promise<RecommendationsResult>,
) {
  return {
    name: name as never,
    modelId: `${name}-model`,
    generateRecommendations: impl,
  };
}

const okVision: FridgeAnalysisResult = {
  ingredients: [
    { canonicalName: "egg", displayName: "Яйца", confidence: 0.9, visibility: "clear" },
  ],
  uncertainItems: [],
  meta: { provider: "gemini", modelId: "gemini-3.8-flash" },
};

const okRecipe: RecommendationsResult = {
  recipes: [
    {
      id: "1",
      title: "А",
      estimatedMinutes: 10,
      difficulty: "easy",
      slot: "fastest",
      requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
      optionalIngredients: [],
      missingIngredients: [],
      steps: ["Шаг 1 делается", "Шаг 2 делается"],
      reason: "р",
      hasAllIngredients: true,
    },
    {
      id: "2",
      title: "Б",
      estimatedMinutes: 20,
      difficulty: "medium",
      slot: "normal",
      requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
      optionalIngredients: [],
      missingIngredients: [],
      steps: ["Шаг 1 делается", "Шаг 2 делается"],
      reason: "р",
      hasAllIngredients: true,
    },
    {
      id: "3",
      title: "В",
      estimatedMinutes: 30,
      difficulty: "medium",
      slot: "from_what_exists",
      requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
      optionalIngredients: [],
      missingIngredients: [],
      steps: ["Шаг 1 делается", "Шаг 2 делается"],
      reason: "р",
      hasAllIngredients: true,
    },
  ] as unknown as RecommendationsResult["recipes"],
  meta: { provider: "groq", modelId: "qwen/qwen3.8-27b" },
};

describe("retryable detection", () => {
  it("429 is retryable", () =>
    expect(__testIsRetryable(new Error("429 quota exceeded"))).toBe(true));
  it("503 is retryable", () => expect(__testIsRetryable(new Error("503 unavailable"))).toBe(true));
  it("quota is retryable", () =>
    expect(__testIsRetryable(new Error("quota exceeded RESOURCE_EXHAUSTED"))).toBe(true));
  it("invalid payload is not retryable", () =>
    expect(__testIsRetryable(new Error("400 INVALID_ARGUMENT bad image"))).toBe(false));
  it("schema bug is not retryable", () =>
    expect(__testIsRetryable(new Error("Invalid JSON parse"))).toBe(false));
  it("400 alone is not retryable", () =>
    expect(__testIsRetryable(new Error("Invalid JSON"))).toBe(false));
});

describe("VisionProviderChain", () => {
  beforeEach(() => clearAllCaches());

  it("gemini success -> groq not called", async () => {
    const groq = makeVisionProvider("groq", async () => {
      throw new Error("should not be called");
    });
    const gemini = makeVisionProvider("gemini", async () => okVision);
    const chain = new VisionProviderChain({ primary: gemini as never, fallback: groq as never });
    const res = await chain.analyze({ imageBase64: "aaaa", mimeType: "image/jpeg" });
    expect(res.provider).toBe("gemini");
    expect(res.result).toEqual(okVision);
  });

  it("gemini 429 -> groq called once", async () => {
    const groqMock = vi.fn(async () => ({
      ...okVision,
      meta: { provider: "groq" as const, modelId: "qwen/qwen3.8-27b" },
    }));
    const groq = makeVisionProvider("groq", groqMock as never);
    const gemini = makeVisionProvider("gemini", async () => {
      throw new Error("429 quota exceeded");
    });
    const chain = new VisionProviderChain({ primary: gemini as never, fallback: groq as never });
    const res = await chain.analyze({ imageBase64: "bbbb", mimeType: "image/jpeg" });
    expect(res.provider).toBe("groq");
    expect(groqMock).toHaveBeenCalledTimes(1);
  });

  it("gemini non-retryable error -> groq not called", async () => {
    const groqMock = vi.fn(async () => okVision);
    const groq = makeVisionProvider("groq", groqMock as never);
    const gemini = makeVisionProvider("gemini", async () => {
      throw new Error("Invalid JSON parse error");
    });
    const chain = new VisionProviderChain({ primary: gemini as never, fallback: groq as never });
    await expect(chain.analyze({ imageBase64: "cccc", mimeType: "image/jpeg" })).rejects.toThrow(
      /Invalid JSON/,
    );
    expect(groqMock).not.toHaveBeenCalled();
  });

  it("both providers fail -> controlled error", async () => {
    const gemini = makeVisionProvider("gemini", async () => {
      throw new Error("429 gemini quota");
    });
    const groq = makeVisionProvider("groq", async () => {
      throw new Error("503 groq unavailable");
    });
    const chain = new VisionProviderChain({ primary: gemini as never, fallback: groq as never });
    await expect(chain.analyze({ imageBase64: "dddd", mimeType: "image/jpeg" })).rejects.toThrow(
      /503|429/,
    );
  });

  it("no infinite fallback - at most one retry", async () => {
    let gemCalls = 0;
    let groqCalls = 0;
    const gemini = makeVisionProvider("gemini", async () => {
      gemCalls++;
      throw new Error("429 quota");
    });
    const groq = makeVisionProvider("groq", async () => {
      groqCalls++;
      throw new Error("429 also");
    });
    const chain = new VisionProviderChain({ primary: gemini as never, fallback: groq as never });
    await expect(chain.analyze({ imageBase64: "eeee", mimeType: "image/jpeg" })).rejects.toThrow();
    expect(gemCalls).toBe(1);
    expect(groqCalls).toBe(1);
  });

  it("uses cache - second call does not invoke provider", async () => {
    let calls = 0;
    const gemini = makeVisionProvider("gemini", async () => {
      calls++;
      return okVision;
    });
    const chain = new VisionProviderChain({ primary: gemini as never, fallback: undefined });
    const p = { imageBase64: "ffff", mimeType: "image/jpeg" };
    const r1 = await chain.analyze(p);
    expect(calls).toBe(1);
    expect(r1.cached).toBe(false);
    const r2 = await chain.analyze(p);
    expect(calls).toBe(1);
    expect(r2.cached).toBe(true);
  });
});

describe("RecipeProviderChain", () => {
  beforeEach(() => clearAllCaches());

  it("groq success -> gemini not called", async () => {
    const gemini = makeRecipeProvider("gemini", async () => {
      throw new Error("should not be called");
    });
    const groq = makeRecipeProvider("groq", async () => okRecipe);
    const chain = new RecipeProviderChain({ primary: groq as never, fallback: gemini as never });
    const res = await chain.generate({
      ingredients: [{ canonicalName: "egg", displayName: "Яйца" }],
    });
    expect(res.provider).toBe("groq");
  });

  it("groq 429 -> gemini called once", async () => {
    const gemMock = vi.fn(async () => okRecipe);
    const gemini = makeRecipeProvider("gemini", gemMock as never);
    const groq = makeRecipeProvider("groq", async () => {
      throw new Error("429 groq quota");
    });
    const chain = new RecipeProviderChain({ primary: groq as never, fallback: gemini as never });
    const res = await chain.generate({
      ingredients: [{ canonicalName: "egg", displayName: "Яйца" }],
    });
    expect(res.provider).toBe("gemini");
    expect(gemMock).toHaveBeenCalledTimes(1);
  });

  it("groq non-retryable -> gemini not called", async () => {
    const gemMock = vi.fn(async () => okRecipe);
    const gemini = makeRecipeProvider("gemini", gemMock as never);
    const groq = makeRecipeProvider("groq", async () => {
      throw new Error("Invalid JSON bad");
    });
    const chain = new RecipeProviderChain({ primary: groq as never, fallback: gemini as never });
    await expect(
      chain.generate({ ingredients: [{ canonicalName: "egg", displayName: "Яйца" }] }),
    ).rejects.toThrow();
    expect(gemMock).not.toHaveBeenCalled();
  });

  it("both fail -> error", async () => {
    const groq = makeRecipeProvider("groq", async () => {
      throw new Error("429 groq");
    });
    const gemini = makeRecipeProvider("gemini", async () => {
      throw new Error("503 gemini");
    });
    const chain = new RecipeProviderChain({ primary: groq as never, fallback: gemini as never });
    await expect(
      chain.generate({ ingredients: [{ canonicalName: "egg", displayName: "Яйца" }] }),
    ).rejects.toThrow();
  });

  it("no infinite loop", async () => {
    let c1 = 0,
      c2 = 0;
    const groq = makeRecipeProvider("groq", async () => {
      c1++;
      throw new Error("429");
    });
    const gemini = makeRecipeProvider("gemini", async () => {
      c2++;
      throw new Error("429");
    });
    const chain = new RecipeProviderChain({ primary: groq as never, fallback: gemini as never });
    await expect(
      chain.generate({ ingredients: [{ canonicalName: "egg", displayName: "Яйца" }] }),
    ).rejects.toThrow();
    expect(c1).toBe(1);
    expect(c2).toBe(1);
  });
});

describe("chain primary selection defaults", () => {
  it("vision primary is gemini when both available (mocked via injection)", async () => {
    // This test documents intended routing without needing env keys; we check via explicit chain
    const gem = makeVisionProvider("gemini", async () => okVision);
    const groq = makeVisionProvider("groq", async () => okVision);
    const chain = new VisionProviderChain({ primary: gem as never, fallback: groq as never });
    expect(chain.getPrimaryName()).toBe("gemini");
    expect(chain.getFallbackName()).toBe("groq");
  });
  it("recipe primary is groq", async () => {
    const gem = makeRecipeProvider("gemini", async () => okRecipe);
    const groq = makeRecipeProvider("groq", async () => okRecipe);
    const chain = new RecipeProviderChain({ primary: groq as never, fallback: gem as never });
    expect(chain.getPrimaryName()).toBe("groq");
    expect(chain.getFallbackName()).toBe("gemini");
  });
});
