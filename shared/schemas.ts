import { z } from "zod";

// Fridge analysis schemas (for Gemini Structured Outputs and validation)

export const visibilitySchema = z.enum(["clear", "partial", "uncertain"]);

export const detectedIngredientSchema = z.object({
  canonicalName: z.string().min(1).describe("Canonical ingredient ID, e.g. tomato, egg, chicken"),
  displayName: z.string().min(1).describe("Localized display name in Russian, e.g. Помидоры"),
  quantityGuess: z.number().nullable().optional().describe("Estimated quantity, null if unclear"),
  confidence: z.number().min(0).max(1).describe("Confidence 0..1"),
  visibility: visibilitySchema.describe("Whether item is clearly visible"),
});

export const uncertainItemSchema = z.object({
  canonicalName: z.string().min(1),
  displayName: z.string().min(1),
  reason: z.string().optional(),
});

export const fridgeAnalysisSchema = z.object({
  ingredients: z.array(detectedIngredientSchema).min(0).max(30),
  uncertainItems: z.array(uncertainItemSchema).min(0).max(20),
});

// Recipe schemas

export const recipeSlotSchema = z.enum(["fastest", "normal", "from_what_exists"]);
export const difficultySchema = z.enum(["easy", "medium"]);

export const recipeIngredientRefSchema = z.object({
  canonicalName: z.string().min(1),
  displayName: z.string().min(1),
  amount: z.string().optional(),
});

export const recipeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(3).max(80),
  estimatedMinutes: z.number().int().min(5).max(180),
  difficulty: difficultySchema,
  slot: recipeSlotSchema,
  requiredIngredients: z.array(recipeIngredientRefSchema).min(1).max(15),
  optionalIngredients: z.array(recipeIngredientRefSchema).optional().default([]),
  steps: z.array(z.string().min(5).max(300)).min(2).max(10),
  reason: z.string().min(5).max(200),
});

export const recommendationsSchema = z.object({
  recipes: z.array(recipeSchema).length(3),
});

// API request validation

export const analyzeRequestSchema = z.object({
  imageBase64: z
    .string()
    .min(10)
    .describe("Base64 image data (without data: prefix) or with prefix"),
  mimeType: z.string().optional().default("image/jpeg"),
});

export const recommendationsRequestSchema = z.object({
  ingredients: z
    .array(
      z.object({
        canonicalName: z.string().min(1),
        displayName: z.string().min(1),
      }),
    )
    .min(1)
    .max(50),
});

// Helpers to generate JSON Schema for Gemini
// Zod 4 provides z.toJSONSchema()

export function getFridgeJsonSchema(): unknown {
  // Use z.toJSONSchema if available
  // Fallback to manual schema if not
  try {
    if (typeof (z as unknown as { toJSONSchema?: unknown }).toJSONSchema === "function") {
      return (z as unknown as { toJSONSchema: (s: unknown) => unknown }).toJSONSchema(
        fridgeAnalysisSchema,
      );
    }
  } catch {
    // ignore
  }
  // Manual fallback
  return {
    type: "object",
    properties: {
      ingredients: {
        type: "array",
        items: {
          type: "object",
          properties: {
            canonicalName: { type: "string", description: "Canonical ingredient ID" },
            displayName: { type: "string", description: "Display name in Russian" },
            quantityGuess: { type: ["number", "null"], description: "Estimated quantity" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            visibility: { type: "string", enum: ["clear", "partial", "uncertain"] },
          },
          required: ["canonicalName", "displayName", "confidence", "visibility"],
          additionalProperties: false,
        },
      },
      uncertainItems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            canonicalName: { type: "string" },
            displayName: { type: "string" },
            reason: { type: "string" },
          },
          required: ["canonicalName", "displayName"],
          additionalProperties: false,
        },
      },
    },
    required: ["ingredients", "uncertainItems"],
    additionalProperties: false,
  };
}

export function getRecommendationsJsonSchema(): unknown {
  try {
    if (typeof (z as unknown as { toJSONSchema?: unknown }).toJSONSchema === "function") {
      return (z as unknown as { toJSONSchema: (s: unknown) => unknown }).toJSONSchema(
        z.object({
          recipes: z.array(recipeSchema).length(3),
        }),
      );
    }
  } catch {
    // ignore
  }
  return {
    type: "object",
    properties: {
      recipes: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            estimatedMinutes: { type: "integer", minimum: 5, maximum: 180 },
            difficulty: { type: "string", enum: ["easy", "medium"] },
            slot: { type: "string", enum: ["fastest", "normal", "from_what_exists"] },
            requiredIngredients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  canonicalName: { type: "string" },
                  displayName: { type: "string" },
                  amount: { type: "string" },
                },
                required: ["canonicalName", "displayName"],
                additionalProperties: false,
              },
            },
            optionalIngredients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  canonicalName: { type: "string" },
                  displayName: { type: "string" },
                  amount: { type: "string" },
                },
                required: ["canonicalName", "displayName"],
                additionalProperties: false,
              },
            },
            steps: {
              type: "array",
              items: { type: "string" },
            },
            reason: { type: "string" },
          },
          required: [
            "id",
            "title",
            "estimatedMinutes",
            "difficulty",
            "slot",
            "requiredIngredients",
            "steps",
            "reason",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["recipes"],
    additionalProperties: false,
  };
}
