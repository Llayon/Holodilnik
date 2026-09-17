import { describe, it, expect, vi, beforeEach } from "vitest";
import { GroqVisionProvider } from "./groqVision.js";
import { GroqRecipeProvider } from "./groqRecipe.js";

// Mock groq-sdk
vi.mock("groq-sdk", () => {
  return {
    default: class MockGroq {
      apiKey: string;
      chat: { completions: { create: ReturnType<typeof vi.fn> } };
      constructor(opts: { apiKey: string }) {
        this.apiKey = opts.apiKey;
        this.chat = { completions: { create: vi.fn() } };
      }
    },
  };
});

function mockVisionResponse(payload: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(payload) } }],
  };
}

function setVisionMock(provider: GroqVisionProvider, fn: unknown) {
  (
    provider as unknown as { client: { chat: { completions: { create: unknown } } } }
  ).client.chat.completions.create = fn as never;
}
function setRecipeMock(provider: GroqRecipeProvider, fn: unknown) {
  (
    provider as unknown as { client: { chat: { completions: { create: unknown } } } }
  ).client.chat.completions.create = fn as never;
}

describe("GroqVisionProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps valid structured response to normalized ingredients", async () => {
    const provider = new GroqVisionProvider("test-key");
    const fakePayload = {
      ingredients: [
        {
          canonicalName: "Cherry_tomato",
          displayName: "Помидоры черри",
          confidence: 0.9,
          visibility: "clear",
          quantityGuess: 2,
        },
        { canonicalName: "Cutlet", displayName: "Котлета", confidence: 0.88, visibility: "clear" },
      ],
      uncertainItems: [{ canonicalName: "yogurt", displayName: "Йогурт", reason: "container" }],
    };
    setVisionMock(provider, vi.fn().mockResolvedValue(mockVisionResponse(fakePayload)));

    const res = await provider.analyzeFridgeImage({ imageBase64: "aaaa", mimeType: "image/jpeg" });
    expect(res.ingredients.some((i) => i.canonicalName === "cherry_tomato")).toBe(true);
    expect(res.ingredients.some((i) => i.canonicalName === "cutlet")).toBe(true);
    const cherry = res.ingredients.find((i) => i.canonicalName === "cherry_tomato");
    expect(cherry?.displayName).toBe("Помидоры черри");
    const cutlet = res.ingredients.find((i) => i.canonicalName === "cutlet");
    expect(cutlet?.displayName).toBe("Котлета");
    expect(res.meta?.provider).toBe("groq");
  });

  it("validates response against schema locally - throws on invalid JSON shape", async () => {
    const provider = new GroqVisionProvider("test-key");
    const badPayload = {
      ingredients: [
        { canonicalName: "tomato", displayName: "Помидоры", confidence: 5, visibility: "clear" },
      ],
      uncertainItems: [],
    };
    setVisionMock(provider, vi.fn().mockResolvedValue(mockVisionResponse(badPayload)));
    await expect(
      provider.analyzeFridgeImage({ imageBase64: "aaaa", mimeType: "image/jpeg" }),
    ).rejects.toThrow();
  });

  it("dedupes equivalent items", async () => {
    const provider = new GroqVisionProvider("test-key");
    const dupPayload = {
      ingredients: [
        { canonicalName: "tomato", displayName: "Помидоры", confidence: 0.9, visibility: "clear" },
        { canonicalName: "tomato", displayName: "Помидоры", confidence: 0.85, visibility: "clear" },
      ],
      uncertainItems: [],
    };
    setVisionMock(provider, vi.fn().mockResolvedValue(mockVisionResponse(dupPayload)));
    const res = await provider.analyzeFridgeImage({ imageBase64: "aaaa", mimeType: "image/jpeg" });
    expect(res.ingredients).toHaveLength(1);
  });

  it("maps 429 error to retryable string", async () => {
    const provider = new GroqVisionProvider("test-key");
    const err = Object.assign(new Error("429 rate limit exceeded"), { status: 429 });
    setVisionMock(provider, vi.fn().mockRejectedValue(err));
    await expect(
      provider.analyzeFridgeImage({ imageBase64: "aaaa", mimeType: "image/jpeg" }),
    ).rejects.toThrow(/429/);
  });

  it("maps 503 error to retryable string", async () => {
    const provider = new GroqVisionProvider("test-key");
    const err = Object.assign(new Error("503 Service Unavailable"), { status: 503 });
    setVisionMock(provider, vi.fn().mockRejectedValue(err));
    await expect(
      provider.analyzeFridgeImage({ imageBase64: "aaaa", mimeType: "image/jpeg" }),
    ).rejects.toThrow(/503/);
  });

  it("uses strict schema first, fallback to best-effort on 400", async () => {
    const provider = new GroqVisionProvider("test-key");
    const fakePayload = {
      ingredients: [
        { canonicalName: "egg", displayName: "Яйца", confidence: 0.9, visibility: "clear" },
      ],
      uncertainItems: [],
    };
    const strictError = Object.assign(new Error("400 strict mode incompatible"), { status: 400 });
    const mockCreate = vi
      .fn()
      .mockRejectedValueOnce(strictError)
      .mockResolvedValueOnce(mockVisionResponse(fakePayload));
    setVisionMock(provider, mockCreate);
    const res = await provider.analyzeFridgeImage({ imageBase64: "aaaa", mimeType: "image/jpeg" });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(res.ingredients[0].canonicalName).toBe("egg");
  });

  it("does not fallback for 429 - propagates immediately", async () => {
    const provider = new GroqVisionProvider("test-key");
    const err429 = Object.assign(new Error("429 quota"), { status: 429 });
    const mockCreate = vi.fn().mockRejectedValue(err429);
    setVisionMock(provider, mockCreate);
    await expect(
      provider.analyzeFridgeImage({ imageBase64: "aaaa", mimeType: "image/jpeg" }),
    ).rejects.toThrow(/429/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe("GroqRecipeProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  function mockRecipeResponse(recipes: unknown[]) {
    return { choices: [{ message: { content: JSON.stringify({ recipes }) } }] };
  }

  it("maps valid recipe response and recomputes missing", async () => {
    const provider = new GroqRecipeProvider("test-key");
    const payload = [
      {
        id: "r1",
        title: "Омлет",
        estimatedMinutes: 10,
        difficulty: "easy",
        slot: "fastest",
        requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца", amount: "2 шт" }],
        steps: ["Шаг 1 делается", "Шаг 2 делается"],
        reason: "быстрое блюдо",
      },
      {
        id: "r2",
        title: "Курица с рисом",
        estimatedMinutes: 25,
        difficulty: "medium",
        slot: "normal",
        requiredIngredients: [{ canonicalName: "chicken", displayName: "Курица" }],
        steps: ["Шаг 1 делается", "Шаг 2 делается"],
        reason: "нормальный ужин для семьи",
      },
      {
        id: "r3",
        title: "Запеканка с сыром",
        estimatedMinutes: 35,
        difficulty: "medium",
        slot: "from_what_exists",
        requiredIngredients: [{ canonicalName: "zucchini", displayName: "Кабачок" }],
        steps: ["Шаг 1 делается", "Шаг 2 делается"],
        reason: "из того что есть в холодильнике",
      },
    ];
    setRecipeMock(provider, vi.fn().mockResolvedValue(mockRecipeResponse(payload)));
    const res = await provider.generateRecommendations({
      ingredients: [
        { canonicalName: "egg", displayName: "Яйца" },
        { canonicalName: "chicken", displayName: "Курица" },
      ],
    });
    expect(res.recipes).toHaveLength(3);
    const third = res.recipes.find((r) => r.slot === "from_what_exists");
    expect(third?.hasAllIngredients).toBe(false);
    expect(third?.missingIngredients.some((m) => m.canonicalName === "zucchini")).toBe(true);
    expect(res.meta?.provider).toBe("groq");
  });

  it("never says Всё есть when missing", async () => {
    const provider = new GroqRecipeProvider("test-key");
    const payload = [
      {
        id: "r1",
        title: "Тестовый омлет",
        estimatedMinutes: 10,
        difficulty: "easy",
        slot: "fastest",
        requiredIngredients: [{ canonicalName: "cream", displayName: "Сливки" }],
        steps: ["Шаг 1 делается", "Шаг 2 делается"],
        reason: "тестовая причина для проверки слота быстрого блюда",
      },
      {
        id: "r2",
        title: "Тестовая курица",
        estimatedMinutes: 20,
        difficulty: "medium",
        slot: "normal",
        requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
        steps: ["Шаг 1 делается", "Шаг 2 делается"],
        reason: "тестовая причина для нормального ужина",
      },
      {
        id: "r3",
        title: "Тестовая запеканка",
        estimatedMinutes: 30,
        difficulty: "medium",
        slot: "from_what_exists",
        requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
        steps: ["Шаг 1 делается", "Шаг 2 делается"],
        reason: "тестовая причина из того что есть",
      },
    ];
    setRecipeMock(provider, vi.fn().mockResolvedValue(mockRecipeResponse(payload)));
    const res = await provider.generateRecommendations({
      ingredients: [{ canonicalName: "egg", displayName: "Яйца" }],
    });
    const fastest = res.recipes.find((r) => r.slot === "fastest");
    expect(fastest?.hasAllIngredients).toBe(false);
    expect(fastest?.missingIngredients.length).toBeGreaterThan(0);
  });

  it("validates 3 distinct slots - throws on duplicate", async () => {
    const provider = new GroqRecipeProvider("test-key");
    const dupSlot = [
      {
        id: "r1",
        title: "Омлет быстрый",
        estimatedMinutes: 10,
        difficulty: "easy",
        slot: "fastest",
        requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
        steps: ["Шаг 1 делается", "Шаг 2 делается"],
        reason: "быстрое блюдо для проверки слотов",
      },
      {
        id: "r2",
        title: "Омлет второй",
        estimatedMinutes: 10,
        difficulty: "easy",
        slot: "fastest",
        requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
        steps: ["Шаг 1 делается", "Шаг 2 делается"],
        reason: "еще одно быстрое блюдо дублирующее слот",
      },
      {
        id: "r3",
        title: "Ужин обычный",
        estimatedMinutes: 10,
        difficulty: "easy",
        slot: "normal",
        requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
        steps: ["Шаг 1 делается", "Шаг 2 делается"],
        reason: "нормальный ужин для проверки дублирования слотов",
      },
    ];
    setRecipeMock(provider, vi.fn().mockResolvedValue(mockRecipeResponse(dupSlot)));
    await expect(
      provider.generateRecommendations({
        ingredients: [{ canonicalName: "egg", displayName: "Яйца" }],
      }),
    ).rejects.toThrow(/slot/);
  });

  it("maps 429 for recipes", async () => {
    const provider = new GroqRecipeProvider("test-key");
    const err = Object.assign(new Error("429 groq rate limit"), { status: 429 });
    setRecipeMock(provider, vi.fn().mockRejectedValue(err));
    await expect(
      provider.generateRecommendations({
        ingredients: [{ canonicalName: "egg", displayName: "Яйца" }],
      }),
    ).rejects.toThrow(/429/);
  });

  it("sanitizes snake_case displayName fallback", async () => {
    const provider = new GroqRecipeProvider("test-key");
    const payload = [
      {
        id: "r1",
        title: "Салат с черри",
        estimatedMinutes: 10,
        difficulty: "easy",
        slot: "fastest",
        requiredIngredients: [
          { canonicalName: "cherry_tomato", displayName: "cherry_tomato", amount: "2 шт" },
        ],
        steps: ["Шаг 1 делается", "Шаг 2 делается"],
        reason: "тестовая причина для проверки санитизации отображаемого имени",
      },
      {
        id: "r2",
        title: "Омлет классический",
        estimatedMinutes: 20,
        difficulty: "medium",
        slot: "normal",
        requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
        steps: ["Шаг 1 делается", "Шаг 2 делается"],
        reason: "второй рецепт для проверки санитизации",
      },
      {
        id: "r3",
        title: "Запеканка из яиц",
        estimatedMinutes: 30,
        difficulty: "medium",
        slot: "from_what_exists",
        requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
        steps: ["Шаг 1 делается", "Шаг 2 делается"],
        reason: "третий рецепт для проверки санитизации",
      },
    ];
    setRecipeMock(provider, vi.fn().mockResolvedValue(mockRecipeResponse(payload)));
    const res = await provider.generateRecommendations({
      ingredients: [{ canonicalName: "cherry_tomato", displayName: "Помидоры черри" }],
    });
    const first = res.recipes.find((r) => r.slot === "fastest");
    expect(first?.requiredIngredients[0].displayName).toBe("Помидоры черри");
    expect(first?.requiredIngredients[0].displayName).not.toContain("_");
  });
});

describe("Groq output-token budgets (vision decoupled from recipes)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("vision sends the conservative vision-specific budget (<=1000)", async () => {
    const { GROQ_VISION_MAX_COMPLETION_TOKENS } = await import("../config.js");
    expect(GROQ_VISION_MAX_COMPLETION_TOKENS).toBe(800);
    const provider = new GroqVisionProvider("test-key");
    const createMock = vi
      .fn()
      .mockResolvedValue(mockVisionResponse({ ingredients: [], uncertainItems: [] }));
    setVisionMock(provider, createMock);
    await provider.analyzeFridgeImage({ imageBase64: "aaaa", mimeType: "image/jpeg" });
    expect(createMock).toHaveBeenCalledTimes(1);
    const args = createMock.mock.calls[0][0] as { max_completion_tokens: number };
    expect(args.max_completion_tokens).toBe(GROQ_VISION_MAX_COMPLETION_TOKENS);
    expect(args.max_completion_tokens).toBeLessThanOrEqual(1000);
  });

  it("recipe provider retains its existing 2500 budget", async () => {
    const provider = new GroqRecipeProvider("test-key");
    const createMock = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              recipes: [
                {
                  id: "r1",
                  title: "Омлет быстрый",
                  estimatedMinutes: 10,
                  difficulty: "easy",
                  slot: "fastest",
                  requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
                  steps: ["Шаг 1 делается", "Шаг 2 делается"],
                  reason: "быстрое блюдо на завтрак",
                },
                {
                  id: "r2",
                  title: "Ужин обычный",
                  estimatedMinutes: 20,
                  difficulty: "medium",
                  slot: "normal",
                  requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
                  steps: ["Шаг 1 делается", "Шаг 2 делается"],
                  reason: "нормальный ужин для семьи",
                },
                {
                  id: "r3",
                  title: "Из того что есть",
                  estimatedMinutes: 30,
                  difficulty: "medium",
                  slot: "from_what_exists",
                  requiredIngredients: [{ canonicalName: "egg", displayName: "Яйца" }],
                  steps: ["Шаг 1 делается", "Шаг 2 делается"],
                  reason: "максимум из имеющихся продуктов",
                },
              ],
            }),
          },
        },
      ],
    });
    setRecipeMock(provider, createMock);
    await provider.generateRecommendations({
      ingredients: [{ canonicalName: "egg", displayName: "Яйца" }],
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    const args = createMock.mock.calls[0][0] as { max_completion_tokens: number };
    expect(args.max_completion_tokens).toBe(2500);
  });
});
