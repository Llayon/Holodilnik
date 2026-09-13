import type {
  FridgeAnalysisResult,
  RecommendationsResult,
  ProviderName,
} from "../../shared/types.js";

export interface VisionProvider {
  readonly name: ProviderName;
  readonly modelId: string;
  analyzeFridgeImage(params: {
    imageBase64: string;
    mimeType: string;
  }): Promise<FridgeAnalysisResult>;
}

export interface RecipeProvider {
  readonly name: ProviderName;
  readonly modelId: string;
  generateRecommendations(params: {
    ingredients: Array<{ canonicalName: string; displayName: string }>;
  }): Promise<RecommendationsResult>;
}
