/**
 * Shared domain types
 */

export type Visibility = "clear" | "partial" | "uncertain";

export interface DetectedIngredient {
  canonicalName: string;
  displayName: string;
  quantityGuess?: number | null;
  confidence: number; // 0..1
  visibility: Visibility;
}

export interface UncertainItem {
  canonicalName: string;
  displayName: string;
  reason?: string;
}

export type ProviderName = "mock" | "gemini" | "groq";

export interface FridgeAnalysisResult {
  ingredients: DetectedIngredient[];
  uncertainItems: UncertainItem[];
  // meta for debug, not shown to user
  meta?: {
    provider: ProviderName;
    modelId?: string;
  };
}

export type RecipeDifficulty = "easy" | "medium";
export type RecipeSlot = "fastest" | "normal" | "from_what_exists";

export interface RecipeIngredientRef {
  canonicalName: string;
  displayName: string;
  amount?: string; // e.g., "2 шт", "200 г"
}

export interface Recipe {
  id: string;
  title: string;
  estimatedMinutes: number;
  difficulty: RecipeDifficulty;
  slot: RecipeSlot;
  requiredIngredients: RecipeIngredientRef[];
  optionalIngredients?: RecipeIngredientRef[];
  missingIngredients: RecipeIngredientRef[];
  steps: string[];
  reason: string; // why fits slot
  hasAllIngredients: boolean;
}

export interface RecommendationsResult {
  recipes: [Recipe, Recipe, Recipe]; // exactly 3
  meta?: {
    provider: ProviderName;
    modelId?: string;
  };
}

export interface ApiErrorBody {
  error: string;
  code: string;
  details?: unknown;
}

// For frontend flow steps
export type AppStep =
  "landing" | "photo" | "analyzing" | "ingredients" | "recommendations" | "recipe";

export const SLOT_LABELS: Record<RecipeSlot, string> = {
  fastest: "САМОЕ БЫСТРОЕ",
  normal: "НОРМАЛЬНЫЙ УЖИН",
  from_what_exists: "ИЗ ТОГО, ЧТО ЕСТЬ",
};

export const SLOT_DESCRIPTIONS: Record<RecipeSlot, string> = {
  fastest: "Быстро и просто — минимум времени у плиты",
  normal: "Сбалансированный ужин на каждый день",
  from_what_exists: "Максимум из того, что уже в холодильнике",
};
