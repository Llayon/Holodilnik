import crypto from "node:crypto";
import {
  VISION_PROMPT_VERSION,
  ZAI_VISION_PROMPT_VERSION,
  RECIPE_PROMPT_VERSION,
} from "./config.js";
import type { FridgeAnalysisResult, RecommendationsResult } from "../shared/types.js";

type VisionCacheValue = FridgeAnalysisResult;
type RecipeCacheValue = RecommendationsResult;

// Simple in-memory caches. Sufficient for dev quota saving.
// In-memory ensures tests never depend on persistent file state.
// Provider/model + prompt version are part of key to prevent stale evaluations.
// No API keys are stored in cache keys or values.

const visionCache = new Map<string, VisionCacheValue>();
const recipeCache = new Map<string, RecipeCacheValue>();

const MAX_ENTRIES = 100;

function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function getVisionPromptVersion(provider: string): string {
  if (provider === "zai") return ZAI_VISION_PROMPT_VERSION;
  return VISION_PROMPT_VERSION;
}

function stableVisionKey(params: {
  imageBase64: string;
  provider: string;
  modelId: string;
}): string {
  const base64 = params.imageBase64.includes(",")
    ? params.imageBase64.split(",")[1]
    : params.imageBase64;
  // Normalize: trim whitespace
  const normalized = base64.trim();
  // Hash raw bytes (decode base64) for true byte identity; fallback to string hash if invalid base64
  let hash: string;
  try {
    const bytes = Buffer.from(normalized, "base64");
    // Re-encode to ensure canonical base64 (strip padding differences? keep bytes hash)
    hash = sha256Hex(bytes);
  } catch {
    hash = sha256Hex(normalized);
  }
  const promptVersion = getVisionPromptVersion(params.provider);
  return `vision:${params.provider}:${params.modelId}:${promptVersion}:${hash}`;
}

function stableRecipeKey(params: {
  canonicalNames: string[];
  provider: string;
  modelId: string;
}): string {
  const sorted = [...params.canonicalNames]
    .map((c) => c.toLowerCase().replace(/\s+/g, "_").trim())
    .filter(Boolean)
    .sort();
  // Pantry state is implicit in provider/model+version, but include literal for future-proofing
  const pantryMarker = "pantry:salt,black_pepper,vegetable_oil";
  const joined = sorted.join(",") + "|" + pantryMarker;
  const hash = sha256Hex(joined);
  return `recipe:${params.provider}:${params.modelId}:${RECIPE_PROMPT_VERSION}:${hash}`;
}

export function getVisionCache(params: {
  imageBase64: string;
  provider: string;
  modelId: string;
}): VisionCacheValue | undefined {
  const key = stableVisionKey(params);
  const v = visionCache.get(key);
  return v ? (JSON.parse(JSON.stringify(v)) as VisionCacheValue) : undefined;
}

export function setVisionCache(
  params: { imageBase64: string; provider: string; modelId: string },
  value: VisionCacheValue,
): void {
  const key = stableVisionKey(params);
  if (visionCache.size >= MAX_ENTRIES) {
    // evict oldest (Map insertion order)
    const first = visionCache.keys().next().value;
    if (first) visionCache.delete(first);
  }
  visionCache.set(key, JSON.parse(JSON.stringify(value)) as VisionCacheValue);
}

export function getRecipeCache(params: {
  canonicalNames: string[];
  provider: string;
  modelId: string;
}): RecipeCacheValue | undefined {
  const key = stableRecipeKey(params);
  const v = recipeCache.get(key);
  return v ? (JSON.parse(JSON.stringify(v)) as RecipeCacheValue) : undefined;
}

export function setRecipeCache(
  params: { canonicalNames: string[]; provider: string; modelId: string },
  value: RecipeCacheValue,
): void {
  const key = stableRecipeKey(params);
  if (recipeCache.size >= MAX_ENTRIES) {
    const first = recipeCache.keys().next().value;
    if (first) recipeCache.delete(first);
  }
  recipeCache.set(key, JSON.parse(JSON.stringify(value)) as RecipeCacheValue);
}

// For testing stability and dev reset
export function clearAllCaches(): void {
  visionCache.clear();
  recipeCache.clear();
}

export function getCacheStats(): { visionSize: number; recipeSize: number } {
  return { visionSize: visionCache.size, recipeSize: recipeCache.size };
}

// Export key generators for unit testing
export const _internal = {
  stableVisionKey,
  stableRecipeKey,
  sha256Hex,
};
