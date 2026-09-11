import type { FridgeAnalysisResult, Recipe, RecommendationsResult } from "./types.js";

export const MOCK_FRIDGE_ANALYSIS: FridgeAnalysisResult = {
  ingredients: [
    {
      canonicalName: "egg",
      displayName: "Яйца",
      quantityGuess: 6,
      confidence: 0.97,
      visibility: "clear",
    },
    {
      canonicalName: "tomato",
      displayName: "Помидоры",
      quantityGuess: 3,
      confidence: 0.91,
      visibility: "clear",
    },
    {
      canonicalName: "cheese",
      displayName: "Сыр",
      quantityGuess: 1,
      confidence: 0.88,
      visibility: "clear",
    },
    {
      canonicalName: "chicken",
      displayName: "Курица",
      quantityGuess: 1,
      confidence: 0.93,
      visibility: "clear",
    },
    {
      canonicalName: "zucchini",
      displayName: "Кабачок",
      quantityGuess: 2,
      confidence: 0.9,
      visibility: "clear",
    },
    {
      canonicalName: "sour_cream",
      displayName: "Сметана",
      quantityGuess: 1,
      confidence: 0.85,
      visibility: "partial",
    },
  ],
  uncertainItems: [
    {
      canonicalName: "yogurt",
      displayName: "Йогурт",
      reason: "непрозрачный контейнер",
    },
    {
      canonicalName: "greens",
      displayName: "Зелень",
      reason: "частично видно",
    },
  ],
  meta: {
    provider: "mock",
    modelId: "mock",
  },
};

export const MOCK_RECIPES: [Recipe, Recipe, Recipe] = [
  {
    id: "mock-1",
    title: "Омлет с помидорами и сыром",
    estimatedMinutes: 10,
    difficulty: "easy",
    slot: "fastest",
    requiredIngredients: [
      { canonicalName: "egg", displayName: "Яйца", amount: "3 шт" },
      { canonicalName: "tomato", displayName: "Помидоры", amount: "1 шт" },
      { canonicalName: "cheese", displayName: "Сыр", amount: "50 г" },
    ],
    optionalIngredients: [{ canonicalName: "greens", displayName: "Зелень", amount: "по вкусу" }],
    missingIngredients: [],
    steps: [
      "Взбей яйца с щепоткой соли и перца.",
      "Нарежь помидор кубиками, натри сыр.",
      "Разогрей сковороду с маслом, вылей яйца.",
      "Через минуту добавь помидоры и сыр, сложи омлет пополам.",
      "Жарь ещё 2 минуты до готовности.",
    ],
    reason: "Готовится за 10 минут из того, что уже есть",
    hasAllIngredients: true,
  },
  {
    id: "mock-2",
    title: "Курица с кабачком в сметанном соусе",
    estimatedMinutes: 25,
    difficulty: "medium",
    slot: "normal",
    requiredIngredients: [
      { canonicalName: "chicken", displayName: "Курица", amount: "400 г" },
      { canonicalName: "zucchini", displayName: "Кабачок", amount: "1 шт" },
      { canonicalName: "sour_cream", displayName: "Сметана", amount: "150 г" },
      { canonicalName: "onion", displayName: "Лук", amount: "1 шт" },
    ],
    optionalIngredients: [{ canonicalName: "garlic", displayName: "Чеснок", amount: "1 зубчик" }],
    // onion missing example? But we state Всё есть only if available. For mock, assume onion is available via? Let's mark as missing to demonstrate logic
    // Actually make it has missing to test UI, but spec says 2nd card should show?
    // Keep all available for demo, but we have chicken, zucchini, sour_cream - onion not in fridge list -> should be missing.
    // Let's properly compute missing later, but hardcode for mock display.
    missingIngredients: [],
    steps: [
      "Нарежь курицу кусочками, кабачок — кубиками, лук — полукольцами.",
      "Обжарь курицу 5 минут до золотистости, добавь лук.",
      "Добавь кабачок, жарь ещё 5 минут.",
      "Влей сметану, посоли, поперчи, туши 10 минут на слабом огне.",
      "Подавай с зеленью, если есть.",
    ],
    reason: "Сбалансированный ужин — белок, овощи и соус",
    hasAllIngredients: true,
  },
  {
    id: "mock-3",
    title: "Запеканка из кабачка с сыром и яйцом",
    estimatedMinutes: 35,
    difficulty: "medium",
    slot: "from_what_exists",
    requiredIngredients: [
      { canonicalName: "zucchini", displayName: "Кабачок", amount: "2 шт" },
      { canonicalName: "egg", displayName: "Яйца", amount: "2 шт" },
      { canonicalName: "cheese", displayName: "Сыр", amount: "80 г" },
      { canonicalName: "sour_cream", displayName: "Сметана", amount: "2 ст. л." },
    ],
    optionalIngredients: [],
    missingIngredients: [],
    steps: [
      "Натри кабачок на крупной тёрке, отожми лишнюю влагу.",
      "Смешай с яйцами, половиной тёртого сыра и сметаной, посоли.",
      "Выложи в форму, посыпь оставшимся сыром.",
      "Запекай 25 минут при 180°C до золотистой корочки.",
    ],
    reason: "Использует максимум из холодильника — ничего докупать не нужно",
    hasAllIngredients: true,
  },
];

export const MOCK_RECOMMENDATIONS: RecommendationsResult = {
  recipes: MOCK_RECIPES,
  meta: {
    provider: "mock",
    modelId: "mock",
  },
};

// For dynamic mock: generate based on available ingredients
export function generateMockRecommendations(availableCanonicals: string[]): RecommendationsResult {
  // For simplicity, return same MOCK_RECIPES but recompute missing
  const availableSet = new Set(
    availableCanonicals.map((c) => c.toLowerCase().replace(/\s+/g, "_")),
  );
  // Add pantry
  availableSet.add("salt");
  availableSet.add("black_pepper");
  availableSet.add("vegetable_oil");

  const validated: [Recipe, Recipe, Recipe] = MOCK_RECIPES.map((r) => {
    const missing = r.requiredIngredients.filter((ing) => !availableSet.has(ing.canonicalName));
    return {
      ...r,
      missingIngredients: missing,
      hasAllIngredients: missing.length === 0,
    };
  }) as [Recipe, Recipe, Recipe];

  return {
    recipes: validated,
    meta: { provider: "mock", modelId: "mock" },
  };
}
