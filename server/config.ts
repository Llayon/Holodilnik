import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

export const GROQ_MODEL_ID = "qwen/qwen3.8-27b" as const;
export const GEMINI_MODEL_ID = "gemini-3.8-flash" as const;
export const VISION_PROMPT_VERSION = "v1" as const;
export const RECIPE_PROMPT_VERSION = "v1" as const;

export const config = {
  port: parseInt(process.env.PORT ?? "3001", 10),
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  mockMode: process.env.MOCK_MODE === "true",
  modelId: GEMINI_MODEL_ID,
  groqModelId: GROQ_MODEL_ID,
  maxImageBytes: 8 * 1024 * 1024, // 8MB
};

function isValidKey(key: string): boolean {
  if (!key) return false;
  // Reject obvious placeholders or non-ASCII keys (Groq keys are gsk_... ASCII)
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

export function isMockMode(): boolean {
  if (config.mockMode) return true;
  // Mock only if neither provider has a key
  if (!config.geminiApiKey && !config.groqApiKey) return true;
  return false;
}

export function logConfig(): void {
  console.log(
    `[config] gemini=${GEMINI_MODEL_ID} groq=${GROQ_MODEL_ID} mockMode=${isMockMode()} port=${config.port} visionPrimary=gemini recipesPrimary=groq`,
  );
  console.log(
    `[config] geminiAvailable=${isGeminiAvailable()} groqAvailable=${isGroqAvailable()} mockModeFlag=${config.mockMode}`,
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
  if (!isGeminiAvailable() && config.geminiApiKey) {
    console.log("[config] GEMINI_API_KEY looks invalid -> check .env.local");
  }
  if (isMockMode()) {
    console.log("[config] No valid provider keys -> running in MOCK mode");
  }
}
