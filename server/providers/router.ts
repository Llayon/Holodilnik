import type { VisionProvider, RecipeProvider } from "./types.js";
import { MockVisionProvider } from "./mockVision.js";
import { MockRecipeProvider } from "./mockRecipe.js";
import { GeminiVisionProvider } from "./geminiVision.js";
import { GeminiRecipeProvider } from "./geminiRecipe.js";
import { GroqVisionProvider } from "./groqVision.js";
import { GroqRecipeProvider } from "./groqRecipe.js";
import { ZaiVisionProvider } from "./zaiVision.js";
import {
  isGeminiAvailable,
  isGroqAvailable,
  isZaiAvailable,
  isMockMode,
  config,
} from "../config.js";
import { getVisionCache, setVisionCache, getRecipeCache, setRecipeCache } from "../cache.js";

export interface VisionChainResult {
  result: import("../../shared/types.js").FridgeAnalysisResult;
  provider: string;
  modelId: string;
  cached: boolean;
}

export interface RecipeChainResult {
  result: import("../../shared/types.js").RecommendationsResult;
  provider: string;
  modelId: string;
  cached: boolean;
}

// Z.AI transient/rate-limit business codes that must trigger fast Groq fallback.
// See https://docs.z.ai/api-reference/api-code
const ZAI_FALLBACK_CODES = new Set([1302, 1303, 1304, 1305, 1308, 1113]);

function containsZaiFallbackCode(msg: string): boolean {
  const m = msg.match(/\b(1302|1303|1304|1305|1308|1113)\b/);
  return !!m && ZAI_FALLBACK_CODES.has(parseInt(m[1], 10));
}

function isRetryableProviderError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  // Retryable: quota/429, 503/unavailable, network/timeout
  if (
    msg.includes("429") ||
    lower.includes("quota") ||
    lower.includes("resource_exhausted") ||
    msg.includes("503") ||
    msg.includes("500") ||
    lower.includes("unavailable") ||
    lower.includes("high demand") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("temporarily") ||
    lower.includes("overloaded") ||
    lower.includes("etimedout") ||
    lower.includes("econnrefused") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("timeout") ||
    lower.includes("aborted") ||
    lower.includes("abort")
  ) {
    return true;
  }
  if (containsZaiFallbackCode(msg)) return true;
  // Do NOT fallback for invalid payload, unsupported image, schema bug etc.
  // Those typically contain 400 / INVALID_ARGUMENT / Invalid JSON / parse etc. but not quota
  // Explicitly non-retryable codes:
  if (msg.includes("400") && lower.includes("invalid_argument")) {
    // This is often bad image; don't fallback to waste other provider? But spec says valid fallback for 429/503 only.
    // However Gemini handles 400 fallback internally; router should not fallback for 400 image errors
    return false;
  }
  if (
    lower.includes("invalid image") ||
    lower.includes("unsupported mime") ||
    lower.includes("schema") ||
    lower.includes("parse")
  ) {
    // If our own validation bug, don't mask with fallback
    // But we need to be careful: provider-side JSON parse error is 502 in routes - should not retry fallback?
    // Spec says invalid structured response should map to UI banners, not fallback.
    // So treat such as non-retryable.
    // However we already treat 429 etc above, so remaining 502-ish maybe not retryable
    return false;
  }
  // By default, if message contains 500, 502, 429, 503 we already handle; otherwise not retryable
  // To avoid hiding bugs, default to non-retryable unless explicitly retryable
  return false;
}

/**
 * Whether a ZAI primary failure should fall back to Groq once.
 * Production policy: GLM → Groq only, no loops.
 * Fallback triggers: 429 / ZAI 1302-1308 / 1113 / 5xx / timeout / network /
 *   empty response / malformed provider JSON (Invalid JSON from Z.AI etc).
 * Does NOT fallback for request-validation errors (those are handled before
 * the chain: INVALID_IMAGE, UNSUPPORTED_MIME, IMAGE_TOO_LARGE).
 */
export function isVisionFallbackableZaiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (isRetryableProviderError(err)) return true;
  // Malformed / empty provider response from GLM → Groq once (spec §4).
  if (
    lower.includes("invalid json from z.ai") ||
    lower.includes("invalid json from zai") ||
    lower.includes("empty response from z.ai") ||
    lower.includes("empty response") ||
    (lower.includes("invalid json") && lower.includes("zai")) ||
    msg.includes("ZAI vision failed")
  ) {
    // ZAI vision failed wraps all ZAI errors; but exclude auth/config errors
    // (401 invalid key, missing key) which should surface, not fallback-loop.
    if (msg.includes("401") || lower.includes("invalid zai_api_key")) return false;
    if (lower.includes("zai_api_key is required")) return false;
    return true;
  }
  return false;
}

/**
 * Vision chain: ZAI (GLM-4.6V-Flash) primary, Groq fallback.
 * Gemini is NOT part of the anonymous production chain (dev/benchmark only
 * via explicit ?provider=gemini).
 * If mock mode forced, uses mock only.
 */
export class VisionProviderChain {
  private primary: VisionProvider;
  private fallback?: VisionProvider;

  constructor(opts?: { primary?: VisionProvider; fallback?: VisionProvider }) {
    if (opts?.primary) {
      this.primary = opts.primary;
      this.fallback = opts.fallback;
      return;
    }

    if (isMockMode()) {
      this.primary = new MockVisionProvider();
      this.fallback = undefined;
      return;
    }

    const zaiAvail = isZaiAvailable();
    const groqAvail = isGroqAvailable();

    if (zaiAvail) {
      this.primary = new ZaiVisionProvider();
      if (groqAvail) this.fallback = new GroqVisionProvider();
    } else if (groqAvail) {
      this.primary = new GroqVisionProvider();
      this.fallback = undefined;
    } else if (isGeminiAvailable()) {
      // No ZAI/Groq keys (e.g. dev with only Gemini): allow Gemini as
      // last-resort primary so local dev still works, but production
      // anonymous routing never reaches here when ZAI+Groq keys exist.
      this.primary = new GeminiVisionProvider(config.geminiApiKey);
      this.fallback = undefined;
    } else {
      this.primary = new MockVisionProvider();
    }
  }

  getPrimaryName(): string {
    return this.primary.name;
  }
  getFallbackName(): string | undefined {
    return this.fallback?.name;
  }

  async analyze(params: { imageBase64: string; mimeType: string }): Promise<VisionChainResult> {
    // Check cache for primary first
    const cachedPrimary = getVisionCache({
      imageBase64: params.imageBase64,
      provider: this.primary.name,
      modelId: this.primary.modelId,
    });
    if (cachedPrimary) {
      return {
        result: cachedPrimary,
        provider: this.primary.name,
        modelId: this.primary.modelId,
        cached: true,
      };
    }

    const startedAt = Date.now();
    const primaryName = this.primary.name;
    try {
      const res = await this.primary.analyzeFridgeImage(params);
      setVisionCache(
        {
          imageBase64: params.imageBase64,
          provider: this.primary.name,
          modelId: this.primary.modelId,
        },
        res,
      );
      return {
        result: res,
        provider: this.primary.name,
        modelId: this.primary.modelId,
        cached: false,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const shouldFallback =
        this.fallback &&
        (primaryName === "zai" ? isVisionFallbackableZaiError(err) : isRetryableProviderError(err));
      if (!this.fallback || !shouldFallback) {
        throw err;
      }
      console.warn(
        `[visionChain] primary ${this.primary.name} failed (${latencyMs}ms), trying fallback ${this.fallback.name}`,
      );
      // Check cache for fallback
      const cachedFallback = getVisionCache({
        imageBase64: params.imageBase64,
        provider: this.fallback.name,
        modelId: this.fallback.modelId,
      });
      if (cachedFallback) {
        return {
          result: cachedFallback,
          provider: this.fallback.name,
          modelId: this.fallback.modelId,
          cached: true,
        };
      }
      const res2 = await this.fallback.analyzeFridgeImage(params);
      setVisionCache(
        {
          imageBase64: params.imageBase64,
          provider: this.fallback.name,
          modelId: this.fallback.modelId,
        },
        res2,
      );
      return {
        result: res2,
        provider: this.fallback.name,
        modelId: this.fallback.modelId,
        cached: false,
      };
    }
  }
}

/**
 * Recipe chain: Groq primary, Gemini fallback (fallback disabled in public
 * production by default via ENABLE_GEMINI_PRODUCTION_FALLBACK=false to
 * preserve scarce Gemini quota).
 */
export class RecipeProviderChain {
  private primary: RecipeProvider;
  private fallback?: RecipeProvider;

  constructor(opts?: { primary?: RecipeProvider; fallback?: RecipeProvider }) {
    if (opts?.primary) {
      this.primary = opts.primary;
      this.fallback = opts.fallback;
      return;
    }
    if (isMockMode()) {
      this.primary = new MockRecipeProvider();
      this.fallback = undefined;
      return;
    }
    const geminiAvail = isGeminiAvailable();
    const groqAvail = isGroqAvailable();
    const isProd = process.env.NODE_ENV === "production";
    const geminiFallbackAllowed = !isProd || config.enableGeminiProductionFallback;

    if (groqAvail) {
      this.primary = new GroqRecipeProvider(config.groqApiKey);
      if (geminiAvail && geminiFallbackAllowed)
        this.fallback = new GeminiRecipeProvider(config.geminiApiKey);
    } else if (geminiAvail) {
      this.primary = new GeminiRecipeProvider(config.geminiApiKey);
      this.fallback = undefined;
    } else {
      this.primary = new MockRecipeProvider();
    }
  }

  getPrimaryName(): string {
    return this.primary.name;
  }
  getFallbackName(): string | undefined {
    return this.fallback?.name;
  }

  async generate(params: {
    ingredients: Array<{ canonicalName: string; displayName: string }>;
  }): Promise<RecipeChainResult> {
    const canonicals = params.ingredients.map((i) => i.canonicalName);
    const cachedPrimary = getRecipeCache({
      canonicalNames: canonicals,
      provider: this.primary.name,
      modelId: this.primary.modelId,
    });
    if (cachedPrimary) {
      return {
        result: cachedPrimary,
        provider: this.primary.name,
        modelId: this.primary.modelId,
        cached: true,
      };
    }
    try {
      const res = await this.primary.generateRecommendations(params);
      setRecipeCache(
        { canonicalNames: canonicals, provider: this.primary.name, modelId: this.primary.modelId },
        res,
      );
      return {
        result: res,
        provider: this.primary.name,
        modelId: this.primary.modelId,
        cached: false,
      };
    } catch (err) {
      if (!this.fallback || !isRetryableProviderError(err)) {
        throw err;
      }
      console.warn(
        `[recipeChain] primary ${this.primary.name} failed retryable, trying fallback ${this.fallback.name}`,
      );
      const cachedFallback = getRecipeCache({
        canonicalNames: canonicals,
        provider: this.fallback.name,
        modelId: this.fallback.modelId,
      });
      if (cachedFallback) {
        return {
          result: cachedFallback,
          provider: this.fallback.name,
          modelId: this.fallback.modelId,
          cached: true,
        };
      }
      const res2 = await this.fallback.generateRecommendations(params);
      setRecipeCache(
        {
          canonicalNames: canonicals,
          provider: this.fallback.name,
          modelId: this.fallback.modelId,
        },
        res2,
      );
      return {
        result: res2,
        provider: this.fallback.name,
        modelId: this.fallback.modelId,
        cached: false,
      };
    }
  }
}

// Helpers for injection in tests
export function __testIsRetryable(err: unknown): boolean {
  return isRetryableProviderError(err);
}
