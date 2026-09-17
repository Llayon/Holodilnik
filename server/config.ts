import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

export const GROQ_MODEL_ID = "qwen/qwen3.8-27b" as const;
// Groq vision output budget: small structured JSON only. Kept conservative
// (<=1000) because the Groq on_demand tier rejected 2000 OTPM in prod smoke
// (2026-09-17). Recipe budget (2500) is separate and unchanged.
export const GROQ_VISION_MAX_COMPLETION_TOKENS = 800 as const;
export const GEMINI_MODEL_ID = "gemini-3.8-flash" as const;
export const ZAI_MODEL_ID = "glm-4.6v-flash" as const;
export const ZAI_API_BASE = "https://api.z.ai/api/paas/v4" as const;
export const VISION_PROMPT_VERSION = "v1" as const;
export const ZAI_VISION_PROMPT_VERSION = "zai-vision-v1" as const;
export const RECIPE_PROMPT_VERSION = "v1" as const;

// Production vision policy (single source of truth):
// PRIMARY = Z.AI GLM-4.6V-Flash, FALLBACK = Groq qwen/qwen3.8-27b.
// Gemini is NOT part of the ordinary anonymous production chain
// (kept for dev / benchmark / explicit ?provider=gemini).
export const VISION_PRIMARY = "zai" as const;
export const VISION_FALLBACK = "groq" as const;

// Recipes remain Groq primary → Gemini fallback, but the Gemini fallback
// can be disabled in public production to preserve scarce free quota.
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: parseInt(process.env.PORT ?? "3001", 10),
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  zaiApiKey: process.env.ZAI_API_KEY ?? "",
  mockMode: process.env.MOCK_MODE === "true",
  modelId: GEMINI_MODEL_ID,
  groqModelId: GROQ_MODEL_ID,
  zaiModelId: ZAI_MODEL_ID,
  zaiApiBase: ZAI_API_BASE,
  // Production ceiling: 300 KB decoded bytes (client target ~200KB, hard <=300KB).
  // Base64 inflation (~33%) keeps request under Vercel's 4.5 MB limit (~400KB b64).
  maxImageBytes: 300 * 1024, // 300KB
  // Production vision policy (env-overridable, defaults to ZAI -> Groq).
  visionPrimary: (process.env.VISION_PRIMARY ?? VISION_PRIMARY) as string,
  visionFallback: (process.env.VISION_FALLBACK ?? VISION_FALLBACK) as string,
  // Z.AI production timeout: fail fast (~10s) then fallback to Groq.
  // No long 2s→5s→8s retry chain in the user path.
  zaiTimeoutMs: parsePositiveInt(process.env.ZAI_TIMEOUT_MS, 10000),
  groqTimeoutMs: parsePositiveInt(process.env.GROQ_TIMEOUT_MS, 15000),
  // Recipe fallback switch: when false (default for public prototype),
  // anonymous production recipe chain is Groq-only (no silent Gemini quota burn).
  // Set ENABLE_GEMINI_PRODUCTION_FALLBACK=true to re-enable Groq→Gemini in prod.
  enableGeminiProductionFallback: process.env.ENABLE_GEMINI_PRODUCTION_FALLBACK === "true",
  // Anonymous prototype rate limits (per 24h UTC bucket, env-overridable).
  visionDeviceDailyLimit: parsePositiveInt(process.env.VISION_DEVICE_DAILY_LIMIT, 5),
  visionIpDailyLimit: parsePositiveInt(process.env.VISION_IP_DAILY_LIMIT, 20),
  recipeDeviceDailyLimit: parsePositiveInt(process.env.RECIPE_DEVICE_DAILY_LIMIT, 20),
  recipeIpDailyLimit: parsePositiveInt(process.env.RECIPE_IP_DAILY_LIMIT, 50),
};

function isValidKey(key: string): boolean {
  if (!key) return false;
  // Reject obvious placeholders or non-ASCII keys (Groq/ZAI keys are ASCII)
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(key)) return false;
  if (key.includes("твой") || key.includes("YOUR") || key.toLowerCase().includes("placeholder"))
    return false;
  if (key.trim().length < 20) return false;
  return true;
}

export function isGeminiAvailable(): boolean {
  if (config.mockMode) return false;
  return isValidKey(config.geminiApiKey);
}

export function isGroqAvailable(): boolean {
  if (config.mockMode) return false;
  return isValidKey(config.groqApiKey);
}

export function isZaiAvailable(): boolean {
  if (config.mockMode) return false;
  return isValidKey(config.zaiApiKey);
}

export function isMockMode(): boolean {
  // Dynamic env check so tests can force mock via process.env.MOCK_MODE.
  if (process.env.MOCK_MODE === "true") return true;
  if (config.mockMode) return true;
  // Mock only if no provider has a key (any of gemini/groq/zai keeps live mode)
  if (!config.geminiApiKey && !config.groqApiKey && !config.zaiApiKey) return true;
  // If keys exist but all invalid placeholders, still mock to avoid ByteString crashes
  if (!isGeminiAvailable() && !isGroqAvailable() && !isZaiAvailable()) return true;
  return false;
}

export function logConfig(): void {
  console.log(
    `[config] gemini=${GEMINI_MODEL_ID} groq=${GROQ_MODEL_ID} zai=${ZAI_MODEL_ID} mockMode=${isMockMode()} port=${config.port} visionPrimary=${config.visionPrimary} visionFallback=${config.visionFallback} recipesPrimary=groq geminiProdFallback=${config.enableGeminiProductionFallback}`,
  );
  console.log(
    `[config] geminiAvailable=${isGeminiAvailable()} groqAvailable=${isGroqAvailable()} zaiAvailable=${isZaiAvailable()} mockModeFlag=${config.mockMode}`,
  );
  if (!config.geminiApiKey) {
    console.log("[config] GEMINI_API_KEY not set -> Gemini vision primary unavailable");
  }
  if (!isGroqAvailable()) {
    if (!config.groqApiKey) {
      console.log(
        "[config] GROQ_API_KEY not set -> Groq recipes primary unavailable (will fallback)",
      );
    } else {
      console.log(
        "[config] GROQ_API_KEY looks invalid (non-ASCII or placeholder) -> treating as unavailable, check .env.local is gsk_... ASCII",
      );
    }
  }
  if (!isZaiAvailable()) {
    if (!config.zaiApiKey) {
      console.log("[config] ZAI_API_KEY not set -> Z.AI benchmark vision unavailable");
    } else {
      console.log("[config] ZAI_API_KEY looks invalid -> check .env.local is Z.AI key ASCII");
    }
  }
  if (!isGeminiAvailable() && config.geminiApiKey) {
    console.log("[config] GEMINI_API_KEY looks invalid -> check .env.local");
  }
  if (isMockMode()) {
    console.log("[config] No valid provider keys -> running in MOCK mode");
  }
}
