import type { RecipeProvider } from "./types.js";
import type { RecommendationsResult } from "../../shared/types.js";
import { generateMockRecommendations } from "../../shared/mockData.js";

export class MockRecipeProvider implements RecipeProvider {
  readonly name = "mock" as const;
  readonly modelId = "mock";

  async generateRecommendations(params: {
    ingredients: Array<{ canonicalName: string; displayName: string }>;
  }): Promise<RecommendationsResult> {
    await new Promise((r) => setTimeout(r, 600));
    const canonicals = params.ingredients.map((i) => i.canonicalName);
    return generateMockRecommendations(canonicals);
  }
}
