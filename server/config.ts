import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

export const config = {
  port: parseInt(process.env.PORT ?? "3001", 10),
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  mockMode: process.env.MOCK_MODE === "true" || !process.env.GEMINI_API_KEY,
  modelId: "gemini-3.8-flash" as const,
  maxImageBytes: 8 * 1024 * 1024, // 8MB
};

export function isMockMode(): boolean {
  // If no key, force mock
  if (!config.geminiApiKey) return true;
  return config.mockMode;
}

export function logConfig(): void {
  console.log(`[config] model=${config.modelId} mockMode=${isMockMode()} port=${config.port}`);
  if (!config.geminiApiKey) {
    console.log("[config] GEMINI_API_KEY not set -> running in MOCK mode");
  }
}
