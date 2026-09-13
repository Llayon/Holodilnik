import { Router } from "express";
import { recommendationsRequestSchema } from "../../shared/schemas.js";
import { RecipeProviderChain } from "../providers/router.js";

const router = Router();

router.post("/", async (req, res) => {
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
    const { result, provider, modelId, cached } = await chain.generate({ ingredients });

    // Validate exactly 3
    if (result.recipes.length !== 3) {
      return res.status(502).json({
        error: "Invalid recommendations count",
        code: "INVALID_PROVIDER_RESPONSE",
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
    console.error("[recommendations] error:", message);

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
