import { Router } from "express";
import crypto from "node:crypto";
import {
  config,
  isMockMode,
  isGeminiAvailable,
  isGroqAvailable,
  isZaiAvailable,
  isPlatformIntegrationEnabled,
} from "../config.js";
import { analyzeRequestSchema } from "../../shared/schemas.js";
import { requestPlatformSession } from "./platform.js";
import { handleAuthenticatedScan } from "./fridgeAuth.js";
import { VisionProviderChain } from "../providers/router.js";
import { ZaiVisionProvider } from "../providers/zaiVision.js";
import { GeminiVisionProvider } from "../providers/geminiVision.js";
import { GroqVisionProvider } from "../providers/groqVision.js";
import { MockVisionProvider } from "../providers/mockVision.js";
import { getVisionCache } from "../cache.js";
import {
  DEVICE_HEADER,
  checkLimits,
  getClientIp,
  limitExceededResponse,
  parseDeviceId,
  recordUsage,
} from "../rateLimit.js";

const router = Router();

router.post("/analyze", async (req, res) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const startedAt = Date.now();
  let effectiveMime = "image/jpeg";
  let providerAttempted = "unknown";
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

    // Size check — measure decoded binary bytes, not base64 string length.
    // Hard ceiling 300KB (see server/config.ts). Client target ~200KB.
    // Base64 inflation (~33%) still keeps request < Vercel 4.5 MB limit.
    const base64Part = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
    let bytes: number;
    try {
      bytes = Buffer.from(base64Part.trim(), "base64").length;
      // Detect invalid base64 that decodes to 0 or mismatched size due to whitespace?
      // Fallback to estimate if Buffer gave 0 but string non-empty.
      if (bytes === 0 && base64Part.trim().length > 0) {
        bytes = Math.ceil((base64Part.trim().length * 3) / 4);
      }
    } catch {
      bytes = Math.ceil((base64Part.trim().length * 3) / 4);
    }
    if (bytes > config.maxImageBytes) {
      return res.status(413).json({
        error:
          "Фото слишком большое — пожалуйста, выберите другое или дайте приложению сжать его до ≤300 КБ",
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

    // Dev-only explicit provider selection (benchmark, not production routing)
    // In production this is intentionally unavailable — query/body provider is ignored.
    // Privacy: image bytes are transient in request memory only and never persisted
    // (not to filesystem /tmp / Blob / DB / cache / logs). See cache.ts for
    // hash-only caching.
    const requestedProvider = (
      (req.query.provider as string | undefined) ?? (req.body?.provider as string | undefined)
    )?.toLowerCase();
    const isDev = process.env.NODE_ENV !== "production";
    // Explicitly block provider override in production (return 404 so it is not enumerable)
    if (
      !isDev &&
      requestedProvider &&
      ["gemini", "groq", "zai", "mock"].includes(requestedProvider)
    ) {
      return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    }
    if (
      isDev &&
      requestedProvider &&
      ["gemini", "groq", "zai", "mock"].includes(requestedProvider)
    ) {
      // Direct provider for benchmark harness
      let directProvider;
      if (requestedProvider === "zai") {
        if (!isZaiAvailable()) {
          return res.status(503).json({
            error: "Z.AI provider not available (missing ZAI_API_KEY)",
            code: "PROVIDER_NOT_AVAILABLE",
          });
        }
        directProvider = new ZaiVisionProvider();
      } else if (requestedProvider === "groq") {
        if (!isGroqAvailable())
          return res
            .status(503)
            .json({ error: "Groq not available", code: "PROVIDER_NOT_AVAILABLE" });
        directProvider = new GroqVisionProvider();
      } else if (requestedProvider === "gemini") {
        if (!isGeminiAvailable())
          return res
            .status(503)
            .json({ error: "Gemini not available", code: "PROVIDER_NOT_AVAILABLE" });
        directProvider = new GeminiVisionProvider();
      } else {
        directProvider = new MockVisionProvider();
      }
      const result = await directProvider.analyzeFridgeImage({
        imageBase64: base64Part,
        mimeType: effectiveMime,
      });
      if (result.ingredients.length === 0 && result.uncertainItems.length === 0) {
        return res
          .status(422)
          .json({ error: "No recognizable food found", code: "NO_FOOD_DETECTED", data: result });
      }
      return res.json({
        data: result,
        meta: {
          provider: directProvider.name,
          modelId: directProvider.modelId,
          cached: false,
          requestedProvider,
        },
      });
    }

    // Authenticated scans (Gauntlet 2): a present Platform cookie means the
    // caller opted into the credit flow — fail closed on session errors,
    // never silently downgrade to the anonymous path (credit bypass).
    // No cookie → legacy anonymous prototype flow (web by design).
    if (isPlatformIntegrationEnabled() && requestPlatformSession(req)) {
      providerAttempted = "platform";
      return handleAuthenticatedScan(req, res, {
        base64Part,
        effectiveMime,
        clientRequestId: parsed.data.requestId,
        requestLogId: requestId,
        startedAt,
      });
    }

    const chain = new VisionProviderChain();
    providerAttempted = chain.getPrimaryName();

    // Cache-first: identical image/provider/model/prompt returns without
    // consuming provider quota — and without consuming scan allowance.
    // Privacy: cache key is SHA-256(image bytes)+provider/model/prompt,
    // never raw bytes (see server/cache.ts).
    const primaryModelId =
      chain.getPrimaryName() === "zai"
        ? config.zaiModelId
        : chain.getPrimaryName() === "groq"
          ? config.groqModelId
          : config.modelId;
    const cachedHit = getVisionCache({
      imageBase64: base64Part,
      provider: chain.getPrimaryName(),
      modelId: primaryModelId,
    });
    if (cachedHit) {
      console.log(
        `[vision] rid=${requestId} attempted=${providerAttempted} succeeded=${providerAttempted} fallback=false cached=true latency=${Date.now() - startedAt}ms`,
      );
      if (cachedHit.ingredients.length === 0 && cachedHit.uncertainItems.length === 0) {
        return res.status(422).json({
          error: "No recognizable food found",
          code: "NO_FOOD_DETECTED",
          data: cachedHit,
        });
      }
      return res.json({
        data: cachedHit,
        meta: {
          provider: chain.getPrimaryName(),
          modelId: primaryModelId,
          cached: true,
          primary: chain.getPrimaryName(),
          fallback: chain.getFallbackName(),
        },
      });
    }

    // Anonymous abuse protection (after validation + cache check, before provider call).
    // Malformed / oversized payloads above already returned without counting.
    // Fail-closed: if the durable store is unavailable in production, return
    // 503 instead of serving unlimited requests.
    const ip = getClientIp(req);
    const deviceId = parseDeviceId(req.headers[DEVICE_HEADER]);
    let limits;
    try {
      limits = await checkLimits("vision", { ip, deviceId });
    } catch (storeErr) {
      const storeMsg = storeErr instanceof Error ? storeErr.message : String(storeErr);
      console.error(
        `[vision] rid=${requestId} rate_limit_store_unavailable msg=${storeMsg.slice(0, 200)}`,
      );
      return res.status(503).json({
        error: "Сервис временно недоступен, попробуйте позже",
        code: "RATE_LIMIT_UNAVAILABLE",
      });
    }
    if (!limits.allowed) {
      const exceeded = limitExceededResponse();
      console.log(
        `[vision] rid=${requestId} rate_limited reason=${limits.reason} latency=${Date.now() - startedAt}ms`,
      );
      return res.status(exceeded.status).json(exceeded.body);
    }

    // Peek cache again via chain result flag for observability; chain handles
    // fallback-cache internally.
    const { result, provider, modelId, cached } = await chain.analyze({
      imageBase64: base64Part,
      mimeType: effectiveMime,
    });

    // If provider returned empty, treat as no recognizable food.
    // This still used provider quota, so it consumes allowance below.
    // recordUsage failure after a successful provider call must not discard
    // the result (quota already spent); log and continue.
    if (result.ingredients.length === 0 && result.uncertainItems.length === 0) {
      if (!cached) {
        try {
          await recordUsage("vision", { ip, deviceId });
        } catch (storeErr) {
          console.error(
            `[vision] rid=${requestId} record_usage_failed msg=${String(storeErr).slice(0, 200)}`,
          );
        }
      }
      console.log(
        `[vision] rid=${requestId} attempted=${providerAttempted} succeeded=${provider} fallback=${provider !== providerAttempted} cached=${cached} latency=${Date.now() - startedAt}ms empty=true`,
      );
      return res.status(422).json({
        error: "No recognizable food found",
        code: "NO_FOOD_DETECTED",
        data: result,
      });
    }

    // Success (or cached): cached identical results do NOT consume allowance.
    if (!cached) {
      try {
        await recordUsage("vision", { ip, deviceId });
      } catch (storeErr) {
        console.error(
          `[vision] rid=${requestId} record_usage_failed msg=${String(storeErr).slice(0, 200)}`,
        );
      }
    }
    console.log(
      `[vision] rid=${requestId} attempted=${providerAttempted} succeeded=${provider} fallback=${provider !== providerAttempted} cached=${cached} latency=${Date.now() - startedAt}ms`,
    );

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
    // Never log image bytes / device / IP.
    console.error(
      `[vision] rid=${requestId} attempted=${providerAttempted} error_class=${classifyVisionError(message)} latency=${Date.now() - startedAt}ms msg=${message.slice(0, 300)}`,
    );

    // Fail-closed: durable store unavailable in production.
    if (message.includes("RATE_LIMIT_STORE_UNAVAILABLE")) {
      return res.status(503).json({
        error: "Сервис временно недоступен, попробуйте позже",
        code: "RATE_LIMIT_UNAVAILABLE",
      });
    }

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

function classifyVisionError(message: string): string {
  const lower = message.toLowerCase();
  if (message.includes("429") || lower.includes("quota") || /\b130[23458]\b/.test(message))
    return "rate_limited";
  if (lower.includes("timeout") || lower.includes("abort")) return "timeout";
  if (message.includes("503") || lower.includes("overloaded") || lower.includes("unavailable"))
    return "unavailable";
  if (message.includes("Invalid JSON") || lower.includes("empty response")) return "malformed";
  if (message.includes("401") || lower.includes("invalid")) return "auth_or_invalid";
  return "provider_error";
}

router.get("/status", (_req, res) => {
  res.json({
    provider: isMockMode()
      ? "mock"
      : isZaiAvailable()
        ? "zai"
        : isGroqAvailable()
          ? "groq"
          : isGeminiAvailable()
            ? "gemini"
            : "mock",
    modelId: config.zaiModelId,
    mockMode: isMockMode(),
    vision: {
      primary: "zai",
      fallback: "groq",
      geminiAvailable: isGeminiAvailable(),
      groqAvailable: isGroqAvailable(),
      zaiAvailable: isZaiAvailable(),
      benchmarkProviders: ["gemini", "groq", "zai"],
    },
  });
});

export default router;
