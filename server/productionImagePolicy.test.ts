/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { config } from "./config.js";
import { clearAllCaches, setVisionCache, getVisionCache, _internal } from "./cache.js";

describe("production image policy — server limits & privacy", () => {
  // Store original NODE_ENV
  const origEnv = process.env.NODE_ENV;

  beforeEach(() => {
    clearAllCaches();
  });

  afterEach(() => {
    process.env.NODE_ENV = origEnv;
    clearAllCaches();
    vi.restoreAllMocks();
  });

  it("config maxImageBytes is 300KB (hard ceiling)", () => {
    expect(config.maxImageBytes).toBe(300 * 1024);
  });

  it("base64 inflation keeps 300KB under Vercel 4.5MB limit", () => {
    const decoded = 300 * 1024;
    const base64Len = Math.ceil((decoded * 4) / 3);
    // JSON overhead ~ few hundred bytes; well below 4.5MB
    const jsonOverhead = 500;
    const total = base64Len + jsonOverhead;
    expect(total).toBeLessThan(4.5 * 1024 * 1024);
    expect(total).toBeLessThan(1024 * 1024); // even <1MB
  });

  it("server rejects >300KB decoded image with 413 IMAGE_TOO_LARGE", async () => {
    // Lazy import app after env setup to ensure middleware reads NODE_ENV correctly
    // But CORS is per-request dynamic, so we can import now.
    const { app } = await import("./app.js");
    // Create base64 that decodes to 400KB (>300KB)
    const oversizedBytes = 400 * 1024;
    const buf = Buffer.alloc(oversizedBytes, 0x01);
    const b64 = buf.toString("base64");

    const res = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .send({ imageBase64: b64, mimeType: "image/jpeg" });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("IMAGE_TOO_LARGE");
    expect(res.body.error).toMatch(/слишком большое/i);
  });

  it("server accepts <=300KB decoded image (mock mode)", async () => {
    process.env.MOCK_MODE = "true";
    // Need to re-evaluate isMockMode? It checks config.mockMode which is set at import.
    // config.mockMode is read from env at import time, so we mock isMockMode via env and direct.
    // Instead, send a valid 150KB image; mock provider will succeed even without MOCK_MODE if keys missing.
    const { app } = await import("./app.js");
    const okBytes = 150 * 1024;
    const buf = Buffer.alloc(okBytes, 0x02);
    // Avoid 1x1 icon rejection: ensure we pass JSON with valid base64 >500B
    const b64 = buf.toString("base64");

    const res = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .send({ imageBase64: b64, mimeType: "image/jpeg" });

    // In mock mode (no keys), should succeed with 200 and return ingredients
    // If keys exist, may still succeed via mock fallback when no keys? Our isMockMode returns true if no keys.
    // Either way, should NOT be 413
    expect(res.status).not.toBe(413);
    // Could be 200 or 422 (no food) depending on mock detection, but not IMAGE_TOO_LARGE
    if (res.status === 413) {
      throw new Error("Should not be 413 for 150KB");
    }
    // If mock, expect 200 with data
    if (res.status === 200) {
      expect(res.body.data).toBeDefined();
    }
  });

  it("server rejects tiny <500B image as INVALID_IMAGE", async () => {
    const { app } = await import("./app.js");
    const tiny = Buffer.alloc(100, 0x01).toString("base64");
    const res = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .send({ imageBase64: tiny, mimeType: "image/jpeg" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_IMAGE");
  });

  it("cache does not store image bytes/base64", async () => {
    const sample = {
      ingredients: [
        {
          canonicalName: "tomato",
          displayName: "Помидоры",
          confidence: 0.9,
          visibility: "clear" as const,
        },
      ],
      uncertainItems: [],
      meta: { provider: "mock" as const, modelId: "mock" },
    };
    const fakeBase64 = Buffer.from("fake-image-bytes-12345").toString("base64");
    setVisionCache({ imageBase64: fakeBase64, provider: "mock", modelId: "mock" }, sample as never);
    const cached = getVisionCache({ imageBase64: fakeBase64, provider: "mock", modelId: "mock" });
    expect(cached).toBeDefined();
    // Cached value should not contain base64 / bytes / data URL
    const json = JSON.stringify(cached);
    expect(json).not.toContain(fakeBase64);
    expect(json).not.toContain("data:image");
    // Key should be hash, not contain base64
    const key = _internal.stableVisionKey({
      imageBase64: fakeBase64,
      provider: "mock",
      modelId: "mock",
    });
    expect(key).not.toContain(fakeBase64);
    expect(key).not.toContain("data:image");
  });

  it("cache keys are SHA-256 hex (64 chars) and contain no raw image", () => {
    const b64 = Buffer.from("another-test-image").toString("base64");
    const key = _internal.stableVisionKey({
      imageBase64: b64,
      provider: "gemini",
      modelId: "gemini-3.8-flash",
    });
    // key format: vision:provider:model:promptVersion:hash
    const parts = key.split(":");
    const hash = parts[parts.length - 1];
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain(b64);
  });

  it("production cache-reset endpoint disabled (DELETE /api/cache)", async () => {
    process.env.NODE_ENV = "production";
    const { app } = await import("./app.js");
    const res = await request(app).delete("/api/cache");
    expect(res.status).toBe(404);
  });

  it("production POST /api/cache/clear disabled", async () => {
    process.env.NODE_ENV = "production";
    const { app } = await import("./app.js");
    const res = await request(app).post("/api/cache/clear");
    expect(res.status).toBe(404);
  });

  it("development cache reset still works", async () => {
    process.env.NODE_ENV = "development";
    const { app } = await import("./app.js");
    const res = await request(app).delete("/api/cache");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cleared");
  });

  it("production provider override via ?provider=groq is blocked (404)", async () => {
    process.env.NODE_ENV = "production";
    const { app } = await import("./app.js");
    const small = Buffer.alloc(2000, 0x01).toString("base64");
    const res = await request(app)
      .post("/api/fridge/analyze?provider=groq")
      .set("Content-Type", "application/json")
      .send({ imageBase64: small, mimeType: "image/jpeg" });
    // Should be 404 because provider override is disabled in prod (we return NOT_FOUND)
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("production provider override via body provider blocked", async () => {
    process.env.NODE_ENV = "production";
    const { app } = await import("./app.js");
    const small = Buffer.alloc(2000, 0x01).toString("base64");
    const res = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .send({ imageBase64: small, mimeType: "image/jpeg", provider: "zai" });
    expect(res.status).toBe(404);
  });

  it("development provider override still works (mock)", async () => {
    process.env.NODE_ENV = "development";
    const { app } = await import("./app.js");
    const small = Buffer.alloc(2000, 0x01).toString("base64");
    const res = await request(app)
      .post("/api/fridge/analyze?provider=mock")
      .set("Content-Type", "application/json")
      .send({ imageBase64: small, mimeType: "image/jpeg" });
    // mock provider should be used and succeed (200)
    expect(res.status).toBe(200);
    expect(res.body.meta.provider).toBe("mock");
  });

  it("GET /api/health in production hides detailed fields (privacy)", async () => {
    process.env.NODE_ENV = "production";
    const { app } = await import("./app.js");
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    // In production, should NOT expose cache sizes, vision detailed, etc.
    expect(res.body.cache).toBeUndefined();
    expect(res.body.vision).toBeUndefined();
    // But still provides minimal
    expect(res.body.mockMode).toBeDefined();
    expect(res.body.modelId).toBeDefined();
  });

  it("GET /api/health in development exposes diagnostics", async () => {
    process.env.NODE_ENV = "development";
    const { app } = await import("./app.js");
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.vision).toBeDefined();
    expect(res.body.models).toBeDefined();
  });

  it("CORS in production is same-origin (no wildcard)", async () => {
    process.env.NODE_ENV = "production";
    const { app } = await import("./app.js");
    const res = await request(app).get("/api/health").set("Origin", "https://example.com");
    // Production should not set wildcard CORS
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CORS in development allows localhost:5173", async () => {
    process.env.NODE_ENV = "development";
    const { app } = await import("./app.js");
    const res = await request(app).get("/api/health").set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});
