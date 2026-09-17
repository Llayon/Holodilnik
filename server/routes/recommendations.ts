import { Router } from "express";
import crypto from "node:crypto";
import { config } from "../config.js";
import { recommendationsRequestSchema } from "../../shared/schemas.js";
import { RecipeProviderChain } from "../providers/router.js";
import { getRecipeCache } from "../cache.js";
import {
  DEVICE_HEADER,
  checkLimits,
  getClientIp,
  limitExceededResponse,
  parseDeviceId,
  recordUsage,
} from "../rateLimit.js";

const router = Router();

router.post("/", async (req, res) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const startedAt = Date.now();
  let primaryName = "unknown";
  try {
    const parsed = recommendationsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request payload",
        code: "INVALID_PAYLOAD",
        details: parsed.error.flatten(),
      });
    }

    const { ingredients } = parsed.data;

    if (ingredients.length === 0) {
      return res.status(400).json({
        error: "Ingredients list empty",
        code: "EMPTY_INGREDIENTS",
      });
    }

    const chain = new RecipeProviderChain();
    primaryName = chain.getPrimaryName();

    // Anonymous abuse protection (after validation, before provider).
    // Cached identical ingredient sets do NOT consume allowance: check cache
    // first and return without touching counters.
    const ip = getClientIp(req);
    const deviceId = parseDeviceId(req.headers[DEVICE_HEADER]);
    const canonicals = ingredients.map((i) => i.canonicalName);
    const primaryModelId =
      primaryName === "groq"
        ? config.groqModelId
        : primaryName === "gemini"
          ? config.modelId
          : "mock";
    const cachedHit = getRecipeCache({
      canonicalNames: canonicals,
      provider: primaryName,
      modelId: primaryModelId,
    });
    if (cachedHit) {
      if (cachedHit.recipes.length !== 3) {
        return res.status(502).json({
          error: "Invalid recommendations count",
          code: "INVALID_PROVIDER_RESPONSE",
        });
      }
      console.log(
        `[recipes] rid=${requestId} attempted=${primaryName} succeeded=${primaryName} fallback=false cached=true latency=${Date.now() - startedAt}ms`,
      );
      return res.json({
        data: cachedHit,
        meta: {
          provider: primaryName,
          modelId: primaryModelId,
          cached: true,
          primary: chain.getPrimaryName(),
          fallback: chain.getFallbackName(),
        },
      });
    }

    let limits;
    try {
      limits = await checkLimits("recipe", { ip, deviceId });
    } catch (storeErr) {
      const storeMsg = storeErr instanceof Error ? storeErr.message : String(storeErr);
      console.error(
        `[recipes] rid=${requestId} rate_limit_store_unavailable msg=${storeMsg.slice(0, 200)}`,
      );
      return res.status(503).json({
        error: "Сервис временно недоступен, попробуйте позже",
        code: "RATE_LIMIT_UNAVAILABLE",
      });
    }
    if (!limits.allowed) {
      const exceeded = limitExceededResponse();
      console.log(
        `[recipes] rid=${requestId} rate_limited reason=${limits.reason} latency=${Date.now() - startedAt}ms`,
      );
      return res.status(exceeded.status).json(exceeded.body);
    }

    const { result, provider, modelId, cached } = await chain.generate({ ingredients });

    // Validate exactly 3
    if (result.recipes.length !== 3) {
      return res.status(502).json({
        error: "Invalid recommendations count",
        code: "INVALID_PROVIDER_RESPONSE",
      });
    }

    if (!cached) {
      try {
        await recordUsage("recipe", { ip, deviceId });
      } catch (storeErr) {
        console.error(
          `[recipes] rid=${requestId} record_usage_failed msg=${String(storeErr).slice(0, 200)}`,
        );
      }
    }
    console.log(
      `[recipes] rid=${requestId} attempted=${primaryName} succeeded=${provider} fallback=${provider !== primaryName} cached=${cached} latency=${Date.now() - startedAt}ms`,
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
    console.error(
      `[recipes] rid=${requestId} attempted=${primaryName} error latency=${Date.now() - startedAt}ms msg=${message.slice(0, 300)}`,
    );

    if (message.includes("RATE_LIMIT_STORE_UNAVAILABLE")) {
      return res.status(503).json({
        error: "Сервис временно недоступен, попробуйте позже",
        code: "RATE_LIMIT_UNAVAILABLE",
      });
    }

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
        error: "Превышен лимит запросов — подождите 20-30 секунд",
        code: "RATE_LIMITED",
        details: process.env.NODE_ENV !== "production" ? message : undefined,
      });
    }

    return res.status(502).json({
      error: "Ошибка генерации рекомендаций",
      code: "PROVIDER_ERROR",
      details: process.env.NODE_ENV !== "production" ? message : undefined,
    });
  }
});

export default router;
