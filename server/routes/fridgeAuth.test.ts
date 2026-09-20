/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app } from "../app.js";
import { clearAllCaches } from "../cache.js";
import {
  MemoryRateLimitStore,
  __resetRateLimitStoreForTests,
  __setRateLimitStoreForTests,
  checkAuthVisionLimits,
  recordAuthVisionUsage,
} from "../rateLimit.js";
import { VisionProviderChain } from "../providers/router.js";
import { MockPlatformClient } from "../platform/mock.js";
import { __clearSettlementForTests } from "../platform/settlement.js";
import { __resetPlatformMockForTests, __setPlatformClientForTests } from "./platform.js";

const ORIGINAL_FLAG = process.env.PLATFORM_INTEGRATION_ENABLED;
const ORIGINAL_MOCK = process.env.MOCK_MODE;

function makeImage(seed: number, size = 2000): string {
  const buf = Buffer.alloc(size, seed % 256);
  return buf.toString("base64");
}

let mock: MockPlatformClient;

beforeEach(() => {
  process.env.PLATFORM_INTEGRATION_ENABLED = "true";
  process.env.MOCK_MODE = "true";
  __setRateLimitStoreForTests(new MemoryRateLimitStore());
  clearAllCaches();
  __clearSettlementForTests();
  mock = new MockPlatformClient();
  __setPlatformClientForTests(mock);
});

afterEach(() => {
  __resetPlatformMockForTests();
  __resetRateLimitStoreForTests();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.PLATFORM_INTEGRATION_ENABLED;
  else process.env.PLATFORM_INTEGRATION_ENABLED = ORIGINAL_FLAG;
  if (ORIGINAL_MOCK === undefined) delete process.env.MOCK_MODE;
  else process.env.MOCK_MODE = ORIGINAL_MOCK;
});

/** Authenticated agent (dev persona exchange → first-party cookie). */
async function authedAgent(persona: string) {
  const agent = request.agent(app);
  const ex = await agent.post("/api/platform/dev/exchange").send({ persona });
  expect(ex.status).toBe(200);
  return agent;
}

describe("credit-aware scans (authenticated)", () => {
  it("C: new scan charges exactly 1 with authoritative balance", async () => {
    const agent = await authedAgent("bill-1");
    const res = await agent.post("/api/fridge/analyze").send({
      imageBase64: makeImage(11),
      mimeType: "image/jpeg",
      requestId: randomUUID(),
    });
    expect(res.status).toBe(200);
    expect(res.body.meta.charged).toBe(true);
    expect(res.body.meta.balance).toEqual({ available: 9, reserved: 0 });
  });

  it("D: same requestId ×3 → one charge", async () => {
    const agent = await authedAgent("bill-2");
    const id = randomUUID();
    for (let i = 0; i < 3; i++) {
      const res = await agent.post("/api/fridge/analyze").send({
        imageBase64: makeImage(12),
        mimeType: "image/jpeg",
        requestId: id,
      });
      expect(res.status).toBe(200);
      expect(res.body.meta.balance.available).toBe(9);
    }
  });

  it("E: same image + new requestId → new charge; retry does not", async () => {
    const agent = await authedAgent("bill-3");
    const img = makeImage(13);
    const first = await agent
      .post("/api/fridge/analyze")
      .send({ imageBase64: img, mimeType: "image/jpeg", requestId: randomUUID() });
    expect(first.body.meta.balance.available).toBe(9);
    const retryId = randomUUID();
    const second = await agent
      .post("/api/fridge/analyze")
      .send({ imageBase64: img, mimeType: "image/jpeg", requestId: retryId });
    // Cached image skips AI but still costs one credit (new action).
    expect(second.body.meta.balance.available).toBe(8);
    const retry = await agent
      .post("/api/fridge/analyze")
      .send({ imageBase64: img, mimeType: "image/jpeg", requestId: retryId });
    expect(retry.body.meta.balance.available).toBe(8);
  });

  it("missing requestId in auth mode → 400 (never server-invented)", async () => {
    const agent = await authedAgent("bill-4");
    const res = await agent
      .post("/api/fridge/analyze")
      .send({ imageBase64: makeImage(14), mimeType: "image/jpeg" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUEST_ID");
  });

  it("F: zero balance → 402 with zero AI calls", async () => {
    __setPlatformClientForTests(new MockPlatformClient({ initialBalance: 0 }));
    const agent = await authedAgent("bill-5");
    const spy = vi.spyOn(VisionProviderChain.prototype, "analyze");
    const res = await agent.post("/api/fridge/analyze").send({
      imageBase64: makeImage(15),
      mimeType: "image/jpeg",
      requestId: randomUUID(),
    });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
    expect(spy).not.toHaveBeenCalled();
  });

  it("G: AI failure releases → balance unchanged", async () => {
    const agent = await authedAgent("bill-6");
    vi.spyOn(VisionProviderChain.prototype, "analyze").mockRejectedValueOnce(
      new Error("Groq 503 overloaded"),
    );
    const res = await agent.post("/api/fridge/analyze").send({
      imageBase64: makeImage(16),
      mimeType: "image/jpeg",
      requestId: randomUUID(),
    });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    const me = await agent.get("/api/platform/me");
    expect(me.body.balance).toEqual({ available: 10, reserved: 0 });
  });

  it("H: commit timeout → 503 COMMIT_UNCERTAIN; same-key retry reuses AI result, one charge", async () => {
    const flaky = new MockPlatformClient({ commitTimeouts: 1 });
    __setPlatformClientForTests(flaky);
    const agent = await authedAgent("bill-7");
    const spy = vi.spyOn(VisionProviderChain.prototype, "analyze");
    const id = randomUUID();
    const body = { imageBase64: makeImage(17), mimeType: "image/jpeg", requestId: id };
    const first = await agent.post("/api/fridge/analyze").send(body);
    expect(first.status).toBe(503);
    expect(first.body.code).toBe("COMMIT_UNCERTAIN");
    const retry = await agent.post("/api/fridge/analyze").send(body);
    expect(retry.status).toBe(200);
    expect(retry.body.meta.balance.available).toBe(9);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("I: balance 1 + 10 parallel unique scans → exactly one reserve", async () => {
    __setPlatformClientForTests(new MockPlatformClient({ initialBalance: 1 }));
    const agent = await authedAgent("bill-8");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        agent.post("/api/fridge/analyze").send({
          imageBase64: makeImage(100 + i, 2000 + i),
          mimeType: "image/jpeg",
          requestId: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 402)).toHaveLength(9);
  });

  it("K: smuggled operation/userId/cost are inert (route hardcodes fridge.scan)", async () => {
    const agent = await authedAgent("bill-9");
    const res = await agent.post("/api/fridge/analyze").send({
      imageBase64: makeImage(19),
      mimeType: "image/jpeg",
      requestId: randomUUID(),
      operation: "wardrobe.outfit",
      userId: "attacker-uuid",
      cost: 0,
    });
    expect(res.status).toBe(200);
    expect(res.body.meta.balance.available).toBe(9);
  });

  it("validation runs before reserve: oversized image costs 0", async () => {
    const agent = await authedAgent("bill-10");
    const big = Buffer.alloc(400 * 1024, 0x02).toString("base64");
    const res = await agent
      .post("/api/fridge/analyze")
      .send({ imageBase64: big, mimeType: "image/jpeg", requestId: randomUUID() });
    expect(res.status).toBe(413);
    const me = await agent.get("/api/platform/me");
    expect(me.body.balance.available).toBe(10);
  });

  it("forged cookie never downgrades to anonymous AI (401, no AI)", async () => {
    const spy = vi.spyOn(VisionProviderChain.prototype, "analyze");
    const res = await request(app)
      .post("/api/fridge/analyze")
      .set("Cookie", "holodilnik_session=forged-token-value-1234567890")
      .send({ imageBase64: makeImage(20), mimeType: "image/jpeg", requestId: randomUUID() });
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("anonymous callers keep the legacy flow (no balance meta, no requestId needed)", async () => {
    const res = await request(app)
      .post("/api/fridge/analyze")
      .send({ imageBase64: makeImage(21), mimeType: "image/jpeg" });
    expect(res.status).toBe(200);
    expect(res.body.meta.charged).toBeUndefined();
    expect(res.body.meta.balance).toBeUndefined();
  });
});

describe("authenticated abuse caps (separate namespace)", () => {
  it("J: exhausted anonymous quota does not block credit holders", async () => {
    // Burn the anonymous device quota (5/day) with distinct images.
    const device = "j-quota-device-1";
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post("/api/fridge/analyze")
        .set("X-Holodilnik-Device-Id", device)
        .send({ imageBase64: makeImage(200 + i, 2000 + i), mimeType: "image/jpeg" });
      expect(r.status).toBe(200);
    }
    const blocked = await request(app)
      .post("/api/fridge/analyze")
      .set("X-Holodilnik-Device-Id", device)
      .send({ imageBase64: makeImage(299, 2999), mimeType: "image/jpeg" });
    expect(blocked.status).toBe(429);

    const agent = await authedAgent("bill-11");
    const ok = await agent.post("/api/fridge/analyze").send({
      imageBase64: makeImage(300, 3000),
      mimeType: "image/jpeg",
      requestId: randomUUID(),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.meta.balance.available).toBe(9);
  });

  it("auth user cap trips at 30/day via the abuse key (no AI burned)", async () => {
    const agent = await authedAgent("bill-12");
    const me = await agent.get("/api/platform/me");
    // NOTE: userId is mock-shaped here; the hashing rule is what matters.
    void me;
    // Directly saturate the abuse counter (avoids 30 AI calls in test).
    for (let i = 0; i < 30; i++) {
      await recordAuthVisionUsage({ userId: "cap-test-user", ip: "10.9.9.9" });
    }
    const check = await checkAuthVisionLimits({ userId: "cap-test-user", ip: "10.9.9.9" });
    expect(check.allowed).toBe(false);
  });
});
