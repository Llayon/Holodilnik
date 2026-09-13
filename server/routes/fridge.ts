import { Router } from "express";
import { config, isMockMode, isGeminiAvailable, isGroqAvailable } from "../config.js";
import { analyzeRequestSchema } from "../../shared/schemas.js";
import { VisionProviderChain } from "../providers/router.js";

const router = Router();

router.post("/analyze", async (req, res) => {
  let effectiveMime = "image/jpeg";
  try {
    const parsed = analyzeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request payload",
        code: "INVALID_PAYLOAD",
        details: parsed.error.flatten(),
      });
    }

    const { imageBase64, mimeType } = parsed.data;

    // Size check
    const base64Part = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
    const bytes = Math.ceil((base64Part.length * 3) / 4);
    if (bytes > config.maxImageBytes) {
      return res.status(413).json({
        error: "Image too large (max 8MB)",
        code: "IMAGE_TOO_LARGE",
      });
    }

    if (bytes < 500) {
      return res.status(400).json({
        error: "Invalid image data",
        code: "INVALID_IMAGE",
      });
    }

    // Basic mime validation
    const allowedMimes = ["image/jpeg", "image/png", "image/webp"];
    effectiveMime = mimeType || "image/jpeg";
    // Detect HEIC via mime or base64 content (ftyp)
    const isHeicMime = effectiveMime === "image/heic" || effectiveMime === "image/heif";
    let isHeicContent = false;
    try {
      const header = Buffer.from(base64Part.slice(0, 32), "base64").toString("ascii");
      if (header.includes("ftyp")) isHeicContent = true;
    } catch {
      // ignore
    }
    if (isHeicMime || isHeicContent) {
      return res.status(400).json({
        error:
          "HEIC не поддерживается — откройте фото в галерее iPhone → Поделиться → Сохранить как JPEG, затем загрузите",
        code: "UNSUPPORTED_MIME",
      });
    }
    if (!allowedMimes.includes(effectiveMime) && !effectiveMime.startsWith("image/")) {
      return res.status(400).json({
        error: "Unsupported image type",
        code: "UNSUPPORTED_MIME",
      });
    }

    const chain = new VisionProviderChain();
    const { result, provider, modelId, cached } = await chain.analyze({
      imageBase64: base64Part,
      mimeType: effectiveMime,
    });

    // If provider returned empty, treat as no recognizable food
    if (result.ingredients.length === 0 && result.uncertainItems.length === 0) {
      return res.status(422).json({
        error: "No recognizable food found",
        code: "NO_FOOD_DETECTED",
        data: result,
      });
    }

    return res.json({
      data: result,
      meta: {
        provider,
        modelId,
        cached,
        primary: chain.getPrimaryName(),
        fallback: chain.getFallbackName(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[fridge/analyze] error:", message);

    // Map known errors
    const lower = message.toLowerCase();
    if (
      lower.includes("quota") ||
      message.includes("429") ||
      message.includes("RESOURCE_EXHAUSTED") ||
      message.includes("503") ||
      lower.includes("unavailable") ||
      lower.includes("high demand")
    ) {
      return res.status(429).json({
        error: "Превышен лимит запросов — подождите 20-30 секунд и попробуйте снова",
        code: "RATE_LIMITED",
        details: process.env.NODE_ENV !== "production" ? message : undefined,
      });
    }
    if (message.includes("Invalid JSON") || message.includes("parse")) {
      return res.status(502).json({
        error: "Не удалось распознать изображение, попробуйте ещё раз",
        code: "INVALID_PROVIDER_RESPONSE",
      });
    }
    if (message.includes("INVALID_ARGUMENT")) {
      console.error("[fridge/analyze] INVALID_ARGUMENT details:", message);
      // Check if likely HEIC or corrupted image
      const isMaybeHeic = effectiveMime === "image/jpeg" && message.includes("400");
      return res.status(502).json({
        error: isMaybeHeic
          ? "Модель не смогла обработать фото — попробуйте JPEG/PNG (HEIC с iPhone не поддерживается, конвертируйте в галерее)"
          : "Ошибка анализа изображения — неверный формат запроса к модели",
        code: "PROVIDER_ERROR",
        details: process.env.NODE_ENV !== "production" ? message : undefined,
      });
    }

    return res.status(502).json({
      error: "Ошибка анализа изображения",
      code: "PROVIDER_ERROR",
      details: process.env.NODE_ENV !== "production" ? message : undefined,
    });
  }
});

router.get("/status", (_req, res) => {
  res.json({
    provider: isMockMode()
      ? "mock"
      : isGeminiAvailable()
        ? "gemini"
        : isGroqAvailable()
          ? "groq"
          : "mock",
    modelId: config.modelId,
    mockMode: isMockMode(),
    vision: {
      primary: "gemini",
      fallback: "groq",
      geminiAvailable: isGeminiAvailable(),
      groqAvailable: isGroqAvailable(),
    },
  });
});

export default router;
