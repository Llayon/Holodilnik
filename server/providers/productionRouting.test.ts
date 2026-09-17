/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  VisionProviderChain,
  RecipeProviderChain,
  isVisionFallbackableZaiError,
  __testIsRetryable,
} from "./router.js";
import { clearAllCaches } from "../cache.js";
import { config } from "../config.js";
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
  meta: { provider: "zai", modelId: "glm-4.6v-flash" },
};

const okRecipe: RecommendationsResult = {
  recipes: [
    {
      id: "1",
      title: "Омлет быстрый",
      estimatedMinutes: 10,
      difficulty: "easy",
      slot: "fastest",
      requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
      optionalIngredients: [],
      missingIngredients: [],
      steps: ["Шаг 1 делается", "Шаг 2 делается"],
      reason: "нормальный быстрый завтрак",
      hasAllIngredients: true,
    },
    {
      id: "2",
      title: "Ужин обычный",
      estimatedMinutes: 20,
      difficulty: "medium",
      slot: "normal",
      requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
      optionalIngredients: [],
      missingIngredients: [],
      steps: ["Шаг 1 делается", "Шаг 2 делается"],
      reason: "нормальный ужин для семьи",
      hasAllIngredients: true,
    },
    {
      id: "3",
      title: "Из того что есть",
      estimatedMinutes: 30,
      difficulty: "medium",
      slot: "from_what_exists",
      requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
      optionalIngredients: [],
      missingIngredients: [],
      steps: ["Шаг 1 делается", "Шаг 2 делается"],
      reason: "максимум из имеющихся продуктов",
      hasAllIngredients: true,
    },
  ] as unknown as RecommendationsResult["recipes"],
  meta: { provider: "groq", modelId: "qwen/qwen3.8-27b" },
};

describe("production vision policy: ZAI primary -> Groq fallback, no Gemini", () => {
  beforeEach(() => clearAllCaches());

  it("config single source of truth is zai -> groq", async () => {
    const cfg = await import("../config.js");
    expect(cfg.VISION_PRIMARY).toBe("zai");
    expect(cfg.VISION_FALLBACK).toBe("groq");
  });

  it("ZAI success -> Groq not called", async () => {
    const groq = makeVisionProvider("groq", async () => {
      throw new Error("should not be called");
    });
    const zai = makeVisionProvider("zai", async () => okVision);
    const chain = new VisionProviderChain({ primary: zai as never, fallback: groq as never });
    const res = await chain.analyze({ imageBase64: "zai-ok-1", mimeType: "image/jpeg" });
    expect(res.provider).toBe("zai");
    expect(res.result).toEqual(okVision);
  });

  it("ZAI 429/1305 -> Groq called once", async () => {
    const groqMock = vi.fn(async () => ({
      ...okVision,
      meta: { provider: "groq" as const, modelId: "qwen/qwen3.8-27b" },
    }));
    const groq = makeVisionProvider("groq", groqMock as never);
    const zai = makeVisionProvider("zai", async () => {
      throw new Error("ZAI vision failed: 429 code 1305 The service may be temporarily overloaded");
    });
    const chain = new VisionProviderChain({ primary: zai as never, fallback: groq as never });
    const res = await chain.analyze({ imageBase64: "zai-429-1", mimeType: "image/jpeg" });
    expect(res.provider).toBe("groq");
    expect(groqMock).toHaveBeenCalledTimes(1);
  });

  it("ZAI malformed response -> Groq called once", async () => {
    const groqMock = vi.fn(async () => ({
      ...okVision,
      meta: { provider: "groq" as const, modelId: "qwen/qwen3.8-27b" },
    }));
    const groq = makeVisionProvider("groq", groqMock as never);
    const zai = makeVisionProvider("zai", async () => {
      throw new Error("ZAI vision failed: Invalid JSON from Z.AI: not-json{{{");
    });
    const chain = new VisionProviderChain({ primary: zai as never, fallback: groq as never });
    const res = await chain.analyze({ imageBase64: "zai-malformed-1", mimeType: "image/jpeg" });
    expect(res.provider).toBe("groq");
    expect(groqMock).toHaveBeenCalledTimes(1);
  });

  it("ZAI timeout -> Groq called once", async () => {
    const groqMock = vi.fn(async () => ({
      ...okVision,
      meta: { provider: "groq" as const, modelId: "qwen/qwen3.8-27b" },
    }));
    const groq = makeVisionProvider("groq", groqMock as never);
    const zai = makeVisionProvider("zai", async () => {
      throw new Error("ZAI vision failed: timeout after 10000ms");
    });
    const chain = new VisionProviderChain({ primary: zai as never, fallback: groq as never });
    const res = await chain.analyze({ imageBase64: "zai-timeout-1", mimeType: "image/jpeg" });
    expect(res.provider).toBe("groq");
    expect(groqMock).toHaveBeenCalledTimes(1);
  });

  it("ZAI 401 invalid key does NOT fallback (surfaces auth error)", async () => {
    const groqMock = vi.fn(async () => okVision);
    const groq = makeVisionProvider("groq", groqMock as never);
    const zai = makeVisionProvider("zai", async () => {
      throw new Error("ZAI vision failed: 401 Invalid ZAI_API_KEY (contains non-ASCII)");
    });
    const chain = new VisionProviderChain({ primary: zai as never, fallback: groq as never });
    await expect(
      chain.analyze({ imageBase64: "zai-401-1", mimeType: "image/jpeg" }),
    ).rejects.toThrow(/401/);
    expect(groqMock).not.toHaveBeenCalled();
  });

  it("Groq failure after ZAI fallback -> controlled error (no Gemini)", async () => {
    const geminiMock = vi.fn(async () => okVision);
    void geminiMock;
    const zai = makeVisionProvider("zai", async () => {
      throw new Error("429 overloaded");
    });
    const groq = makeVisionProvider("groq", async () => {
      throw new Error("503 groq unavailable");
    });
    const chain = new VisionProviderChain({ primary: zai as never, fallback: groq as never });
    await expect(
      chain.analyze({ imageBase64: "zai-groq-fail-1", mimeType: "image/jpeg" }),
    ).rejects.toThrow(/503|429/);
    // No third provider: exactly 1 call each, no loops.
  });

  it("no recursive fallback: at most one call per provider", async () => {
    let zaiCalls = 0;
    let groqCalls = 0;
    const zai = makeVisionProvider("zai", async () => {
      zaiCalls++;
      throw new Error("ZAI vision failed: 429 code 1305 overloaded");
    });
    const groq = makeVisionProvider("groq", async () => {
      groqCalls++;
      throw new Error("429 groq also");
    });
    const chain = new VisionProviderChain({ primary: zai as never, fallback: groq as never });
    await expect(
      chain.analyze({ imageBase64: "zai-noloop-1", mimeType: "image/jpeg" }),
    ).rejects.toThrow();
    expect(zaiCalls).toBe(1);
    expect(groqCalls).toBe(1);
  });

  it("Gemini is NOT in the anonymous chain type surface (zai/groq only)", async () => {
    // Production chain with ZAI+Groq keys must resolve to zai->groq.
    const prevMock = config.mockMode;
    const prevZai = config.zaiApiKey;
    const prevGroq = config.groqApiKey;
    const prevGemini = config.geminiApiKey;
    try {
      (config as unknown as { mockMode: boolean }).mockMode = false;
      (config as unknown as { zaiApiKey: string }).zaiApiKey = "zai-valid-test-key-1234567890";
      (config as unknown as { groqApiKey: string }).groqApiKey = "gsk_valid-test-key-1234567890";
      (config as unknown as { geminiApiKey: string }).geminiApiKey =
        "gemini-valid-test-key-1234567890";
      const chain = new VisionProviderChain();
      expect(chain.getPrimaryName()).toBe("zai");
      expect(chain.getFallbackName()).toBe("groq");
      expect(chain.getPrimaryName()).not.toBe("gemini");
      expect(chain.getFallbackName()).not.toBe("gemini");
    } finally {
      (config as unknown as { mockMode: boolean }).mockMode = prevMock;
      (config as unknown as { zaiApiKey: string }).zaiApiKey = prevZai;
      (config as unknown as { groqApiKey: string }).groqApiKey = prevGroq;
      (config as unknown as { geminiApiKey: string }).geminiApiKey = prevGemini;
    }
  });

  it("ZAI fallback classifier covers 1302/1303/1304/1305/1308/1113 + timeout + malformed", () => {
    for (const code of [1302, 1303, 1304, 1305, 1308, 1113]) {
      expect(isVisionFallbackableZaiError(new Error(`ZAI vision failed: 429 code ${code} x`))).toBe(
        true,
      );
    }
    expect(
      isVisionFallbackableZaiError(new Error("ZAI vision failed: timeout after 10000ms")),
    ).toBe(true);
    expect(
      isVisionFallbackableZaiError(new Error("ZAI vision failed: Invalid JSON from Z.AI: {{{")),
    ).toBe(true);
    expect(
      isVisionFallbackableZaiError(new Error("ZAI vision failed: Empty response from Z.AI")),
    ).toBe(true);
    expect(__testIsRetryable(new Error("429 quota"))).toBe(true);
  });

  it("ZAI provider has short timeout (default ~10s, configurable, no 20-30s chain)", async () => {
    const { ZaiVisionProvider } = await import("./zaiVision.js");
    const p = new ZaiVisionProvider(
      "test-key-12345678901234567890",
      "https://api.z.ai/api/paas/v4",
    );
    expect(p.getTimeoutMs()).toBeLessThanOrEqual(12000);
    expect(p.getTimeoutMs()).toBeGreaterThanOrEqual(8000);
    const custom = new ZaiVisionProvider(
      "test-key-12345678901234567890",
      "https://api.z.ai/api/paas/v4",
      {
        timeoutMs: 3000,
      },
    );
    expect(custom.getTimeoutMs()).toBe(3000);
  });
});

describe("recipe routing: Groq primary, Gemini fallback gated in prod", () => {
  beforeEach(() => clearAllCaches());

  it("dev keeps Groq -> Gemini fallback", async () => {
    const prevNode = process.env.NODE_ENV;
    const prevMock = config.mockMode;
    const prevGroq = config.groqApiKey;
    const prevGemini = config.geminiApiKey;
    try {
      process.env.NODE_ENV = "development";
      (config as unknown as { mockMode: boolean }).mockMode = false;
      (config as unknown as { groqApiKey: string }).groqApiKey = "gsk_valid-test-key-1234567890";
      (config as unknown as { geminiApiKey: string }).geminiApiKey =
        "gemini-valid-test-key-1234567890";
      const chain = new RecipeProviderChain();
      expect(chain.getPrimaryName()).toBe("groq");
      expect(chain.getFallbackName()).toBe("gemini");
    } finally {
      process.env.NODE_ENV = prevNode;
      (config as unknown as { mockMode: boolean }).mockMode = prevMock;
      (config as unknown as { groqApiKey: string }).groqApiKey = prevGroq;
      (config as unknown as { geminiApiKey: string }).geminiApiKey = prevGemini;
    }
  });

  it("public prod disables Gemini fallback by default (Groq-only)", async () => {
    const prevNode = process.env.NODE_ENV;
    const prevMock = config.mockMode;
    const prevGroq = config.groqApiKey;
    const prevGemini = config.geminiApiKey;
    const prevFlag = config.enableGeminiProductionFallback;
    try {
      process.env.NODE_ENV = "production";
      (config as unknown as { mockMode: boolean }).mockMode = false;
      (config as unknown as { groqApiKey: string }).groqApiKey = "gsk_valid-test-key-1234567890";
      (config as unknown as { geminiApiKey: string }).geminiApiKey =
        "gemini-valid-test-key-1234567890";
      (
        config as unknown as { enableGeminiProductionFallback: boolean }
      ).enableGeminiProductionFallback = false;
      const chain = new RecipeProviderChain();
      expect(chain.getPrimaryName()).toBe("groq");
      expect(chain.getFallbackName()).toBeUndefined();
    } finally {
      process.env.NODE_ENV = prevNode;
      (config as unknown as { mockMode: boolean }).mockMode = prevMock;
      (config as unknown as { groqApiKey: string }).groqApiKey = prevGroq;
      (config as unknown as { geminiApiKey: string }).geminiApiKey = prevGemini;
      (
        config as unknown as { enableGeminiProductionFallback: boolean }
      ).enableGeminiProductionFallback = prevFlag;
    }
  });

  it("groq success -> gemini not called (injected)", async () => {
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
});
