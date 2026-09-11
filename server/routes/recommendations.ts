import { Router } from "express";
import { config, isMockMode } from "../config.js";
import { recommendationsRequestSchema } from "../../shared/schemas.js";
import { MockRecipeProvider } from "../providers/mockRecipe.js";
import { GeminiRecipeProvider } from "../providers/geminiRecipe.js";

const router = Router();

function getRecipeProvider() {
  if (isMockMode()) {
    return new MockRecipeProvider();
  }
  return new GeminiRecipeProvider(config.geminiApiKey);
}

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

    const provider = getRecipeProvider();
    const result = await provider.generateRecommendations({ ingredients });

    // Validate exactly 3
    if (result.recipes.length !== 3) {
      return res.status(502).json({
        error: "Invalid recommendations count",
        code: "INVALID_PROVIDER_RESPONSE",
      });
    }

    return res.json({ data: result, meta: { provider: provider.name, modelId: provider.modelId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[recommendations] error:", message);

    if (
      message.includes("quota") ||
      message.includes("429") ||
      message.includes("RESOURCE_EXHAUSTED")
    ) {
      return res.status(429).json({
        error: "Превышен лимит запросов, попробуйте позже",
        code: "RATE_LIMITED",
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
