import type { FridgeAnalysisResult, RecommendationsResult } from "../../shared/types.js";

export type ApiMode = "mock" | "gemini" | "groq" | "unknown";

export interface ApiError {
  message: string;
  code: string;
  status: number;
}

export async function checkHealth(): Promise<{
  provider: string;
  mockMode: boolean;
  modelId: string;
  vision?: { primary: string; fallback: string; geminiAvailable: boolean; groqAvailable: boolean };
  recipes?: { primary: string; fallback: string; groqAvailable: boolean; geminiAvailable: boolean };
  models?: { gemini: string; groq: string };
}> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error("health check failed");
  return res.json();
}

export async function analyzeFridge(params: { imageBase64: string; mimeType: string }): Promise<{
  data: FridgeAnalysisResult;
  meta: { provider: ApiMode; modelId: string; cached?: boolean };
}> {
  const res = await fetch("/api/fridge/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw {
      message: json.error || "Ошибка анализа",
      code: json.code || "UNKNOWN",
      status: res.status,
    } as ApiError;
  }

  // json.data or fallback
  const data = json.data ?? json;
  const meta = json.meta ?? { provider: "unknown", modelId: "unknown" };
  return { data, meta };
}

export async function getRecommendations(params: {
  ingredients: Array<{ canonicalName: string; displayName: string }>;
}): Promise<{
  data: RecommendationsResult;
  meta: { provider: ApiMode; modelId: string; cached?: boolean };
}> {
  const res = await fetch("/api/recommendations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw {
      message: json.error || "Ошибка рекомендаций",
      code: json.code || "UNKNOWN",
      status: res.status,
    } as ApiError;
  }

  const data = json.data ?? json;
  const meta = json.meta ?? { provider: "unknown", modelId: "unknown" };
  return { data, meta };
}

export function isApiError(e: unknown): e is ApiError {
  return typeof e === "object" && e !== null && "code" in e && "status" in e;
}

export function humanizeApiError(e: unknown): string {
  if (isApiError(e)) {
    switch (e.code) {
      case "IMAGE_TOO_LARGE":
        return "Фото слишком большое (максимум 8 МБ). Попробуйте другое.";
      case "INVALID_IMAGE":
        return "Не похоже на фото. Попробуйте другое изображение.";
      case "UNSUPPORTED_MIME":
        return (
          e.message ||
          "HEIC не поддерживается — откройте фото в галерее и сохраните как JPEG, затем загрузите снова."
        );
      case "NO_FOOD_DETECTED":
        return "Не нашёл еду на фото. Попробуйте снять ближе или с лучшим светом.";
      case "RATE_LIMITED":
        return e.message || "Превышен лимит запросов — подождите 20-30 секунд и попробуйте снова.";
      case "INVALID_PROVIDER_RESPONSE":
        return "Не удалось распознать содержимое — попробуйте ещё раз.";
      case "PROVIDER_ERROR":
        return (
          e.message ||
          "Ошибка анализа изображения — попробуйте другое фото (JPEG/PNG, хорошее освещение)"
        );
      default:
        return e.message || "Что-то пошло не так. Попробуйте ещё раз.";
    }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
