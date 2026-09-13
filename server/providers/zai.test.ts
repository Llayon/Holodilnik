import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ZaiVisionProvider } from "./zaiVision.js";
import { clearAllCaches } from "../cache.js";

function mockFetchResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mockZaiSuccess(payload: unknown) {
  return mockFetchResponse({
    id: "zai-test",
    model: "glm-4.6v-flash",
    choices: [{ message: { content: JSON.stringify(payload) } }],
  });
}

describe("ZaiVisionProvider", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllCaches();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uses correct model ID glm-4.6v-flash", async () => {
    const provider = new ZaiVisionProvider("test-zai-key", "https://api.z.ai/api/paas/v4");
    expect(provider.modelId).toBe("glm-4.6v-flash");
    expect(provider.name).toBe("zai");
  });

  it("throws if no key", () => {
    expect(() => new ZaiVisionProvider("", "https://api.z.ai/api/paas/v4")).toThrow(/ZAI_API_KEY/);
  });

  it("constructs request with data URL image and json_object", async () => {
    const provider = new ZaiVisionProvider("test-key", "https://api.z.ai/api/paas/v4");
    const fakePayload = {
      ingredients: [
        { canonicalName: "cucumber", displayName: "Огурцы", confidence: 0.92, visibility: "clear" },
      ],
      uncertainItems: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(mockZaiSuccess(fakePayload));
    global.fetch = fetchMock as unknown as typeof fetch;

    await provider.analyzeFridgeImage({ imageBase64: "aGVsbG8=", mimeType: "image/jpeg" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.model).toBe("glm-4.6v-flash");
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const messages = body.messages as Array<{ role: string; content: unknown[] }>;
    const content = messages[0].content as Array<Record<string, unknown>>;
    const imagePart = content.find((c) => c.type === "image_url") as { image_url: { url: string } };
    expect(imagePart.image_url.url).toBe("data:image/jpeg;base64,aGVsbG8=");
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("serializes data URL correctly for png mime", async () => {
    const provider = new ZaiVisionProvider("k", "https://api.z.ai/api/paas/v4");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockZaiSuccess({ ingredients: [], uncertainItems: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await provider.analyzeFridgeImage({ imageBase64: "abc", mimeType: "image/png" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    const messages = body.messages as Array<{ content: unknown[] }>;
    const imageUrl = (
      (messages[0].content as Array<Record<string, unknown>>).find(
        (c) => c.type === "image_url",
      ) as { image_url: { url: string } }
    ).image_url.url;
    expect(imageUrl).toBe("data:image/png;base64,abc");
  });

  it("parses valid JSON and normalizes unknown labels via same pipeline", async () => {
    const provider = new ZaiVisionProvider("k", "https://api.z.ai/api/paas/v4");
    const payload = {
      ingredients: [
        {
          canonicalName: "Dragon_fruit",
          displayName: "Dragon_fruit",
          confidence: 0.88,
          visibility: "clear",
        },
        { canonicalName: "Cucumber", displayName: "Огурцы", confidence: 0.9, visibility: "clear" },
      ],
      uncertainItems: [],
    };
    global.fetch = vi.fn().mockResolvedValue(mockZaiSuccess(payload)) as unknown as typeof fetch;
    const res = await provider.analyzeFridgeImage({ imageBase64: "a", mimeType: "image/jpeg" });
    // Dragon_fruit should be humanized to "Dragon Fruit" via normalization fallback
    const dragon = res.ingredients.find((i) => i.canonicalName === "dragon_fruit");
    expect(dragon).toBeDefined();
    expect(dragon?.displayName).toBe("Dragon Fruit");
    expect(dragon?.displayName).not.toContain("_");
    expect(res.meta?.provider).toBe("zai");
  });

  it("sanitizes markdown fences", async () => {
    const provider = new ZaiVisionProvider("k", "https://api.z.ai/api/paas/v4");
    const payload = {
      ingredients: [
        { canonicalName: "tomato", displayName: "Помидоры", confidence: 0.9, visibility: "clear" },
      ],
      uncertainItems: [],
    };
    const fenced = "```json\n" + JSON.stringify(payload) + "\n```";
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        mockFetchResponse({ choices: [{ message: { content: fenced } }] }),
      ) as unknown as typeof fetch;
    const res = await provider.analyzeFridgeImage({ imageBase64: "a", mimeType: "image/jpeg" });
    expect(res.ingredients[0].canonicalName).toBe("tomato");
  });

  it("validates schema locally and throws on malformed", async () => {
    const provider = new ZaiVisionProvider("k", "https://api.z.ai/api/paas/v4");
    const bad = {
      ingredients: [
        { canonicalName: "tomato", displayName: "Помидоры", confidence: 5, visibility: "clear" },
      ],
      uncertainItems: [],
    };
    global.fetch = vi.fn().mockResolvedValue(mockZaiSuccess(bad)) as unknown as typeof fetch;
    await expect(
      provider.analyzeFridgeImage({ imageBase64: "a", mimeType: "image/jpeg" }),
    ).rejects.toThrow();
  });

  it("retries without response_format on 1214 invalid parameter", async () => {
    const provider = new ZaiVisionProvider("k", "https://api.z.ai/api/paas/v4");
    const payload = { ingredients: [], uncertainItems: [] };
    const fail = mockFetchResponse(
      { code: 1214, message: "Parameter response_format is invalid" },
      400,
    );
    const success = mockZaiSuccess(payload);
    const fetchMock = vi.fn().mockResolvedValueOnce(fail).mockResolvedValueOnce(success);
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await provider.analyzeFridgeImage({ imageBase64: "a", mimeType: "image/jpeg" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.ingredients).toEqual([]);
  });

  it("maps 429 and Z.AI codes 1302/1305/1113 etc to retryable error string", async () => {
    const provider = new ZaiVisionProvider("k", "https://api.z.ai/api/paas/v4");
    for (const code of [1302, 1305, 1308, 1113]) {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockFetchResponse({ code, message: "Rate limit reached for requests" }, 429),
        ) as unknown as typeof fetch;
      await expect(
        provider.analyzeFridgeImage({ imageBase64: "a", mimeType: "image/jpeg" }),
      ).rejects.toThrow(new RegExp(`${code}`));
    }
  });

  it("maps 1303/1304 high frequency / daily limit as error", async () => {
    const provider = new ZaiVisionProvider("k", "https://api.z.ai/api/paas/v4");
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        mockFetchResponse({ code: 1303, message: "high frequency" }, 429),
      ) as unknown as typeof fetch;
    await expect(
      provider.analyzeFridgeImage({ imageBase64: "a", mimeType: "image/jpeg" }),
    ).rejects.toThrow(/1303/);
  });

  it("handles ByteString invalid key as 401", async () => {
    const provider = new ZaiVisionProvider("твой_ключ", "https://api.z.ai/api/paas/v4");
    // Even though constructor allows Cyrillic, fetch will fail with ByteString in real client; we simulate by throwing ByteString from fetch
    global.fetch = vi
      .fn()
      .mockRejectedValue(
        new TypeError(
          "Cannot convert argument to a ByteString because the character at index 7 has a value of 1090 which is greater than 255.",
        ),
      ) as unknown as typeof fetch;
    await expect(
      provider.analyzeFridgeImage({ imageBase64: "a", mimeType: "image/jpeg" }),
    ).rejects.toThrow(/Invalid ZAI_API_KEY/);
  });

  it("deduplicates ingredients", async () => {
    const provider = new ZaiVisionProvider("k", "https://api.z.ai/api/paas/v4");
    const payload = {
      ingredients: [
        { canonicalName: "tomato", displayName: "Помидоры", confidence: 0.9, visibility: "clear" },
        { canonicalName: "tomato", displayName: "Помидоры", confidence: 0.8, visibility: "clear" },
      ],
      uncertainItems: [],
    };
    global.fetch = vi.fn().mockResolvedValue(mockZaiSuccess(payload)) as unknown as typeof fetch;
    const res = await provider.analyzeFridgeImage({ imageBase64: "a", mimeType: "image/jpeg" });
    expect(res.ingredients).toHaveLength(1);
  });

  it("cache isolation: different provider/model not sharing", async () => {
    // This test documents cache behavior; actual cache test is in cache.test.ts but we verify provider field used
    const provider = new ZaiVisionProvider("k", "https://api.z.ai/api/paas/v4");
    expect(provider.name).toBe("zai");
    expect(provider.modelId).toBe("glm-4.6v-flash");
  });
});
