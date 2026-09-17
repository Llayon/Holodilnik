/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { clearAllCaches } from "./cache.js";
import {
  MemoryRateLimitStore,
  UpstashRedisRateLimitStore,
  __setRateLimitStoreForTests,
  __resetRateLimitStoreForTests,
  getRateLimitStore,
  getRedisCredentials,
  parseDeviceId,
  normalizeIp,
  getClientIp,
  hashIp,
  hashDevice,
  checkLimits,
  recordUsage,
  getDailyBucket,
  ttlUntilEndOfDaySeconds,
  DEVICE_HEADER,
} from "./rateLimit.js";
import { config } from "./config.js";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";
const OTHER_UUID = "123e4567-e89b-12d3-a456-426614174001";

function makeImageBytes(seed: number, size = 2000): string {
  const buf = Buffer.alloc(size, 0x01);
  // vary content per seed to avoid cache hits (cache is SHA-256 of bytes)
  for (let i = 0; i < 16; i++) buf[i] = (seed + i) & 0xff;
  // Avoid ftyp HEIC false-positive: first bytes must not decode to "ftyp"
  buf[0] = 0xff;
  buf[1] = 0xd8;
  return buf.toString("base64");
}

describe("rateLimit primitives", () => {
  it("valid device header accepted", () => {
    expect(parseDeviceId(VALID_UUID)).toBe(VALID_UUID);
  });
  it("malformed device ID ignored safely", () => {
    expect(parseDeviceId(undefined)).toBeUndefined();
    expect(parseDeviceId("")).toBeUndefined();
    expect(parseDeviceId("short")).toBeUndefined();
    expect(parseDeviceId("<script>alert(1)</script>")).toBeUndefined();
    expect(parseDeviceId("тест-кириллица-12345678")).toBeUndefined();
    expect(parseDeviceId("a".repeat(200))).toBeUndefined();
    expect(parseDeviceId(123 as unknown as string)).toBeUndefined();
  });
  it("hashes do not contain raw IP/device", () => {
    const ipH = hashIp("1.2.3.4");
    const devH = hashDevice(VALID_UUID);
    expect(ipH).toMatch(/^[a-f0-9]{64}$/);
    expect(devH).toMatch(/^[a-f0-9]{64}$/);
    expect(ipH).not.toContain("1.2.3.4");
    expect(devH).not.toContain(VALID_UUID);
  });
  it("normalizeIp strips port/brackets consistently", () => {
    expect(normalizeIp("1.2.3.4:5432")).toBe("1.2.3.4");
    expect(normalizeIp("  1.2.3.4 ")).toBe("1.2.3.4");
    expect(normalizeIp("[::1]")).toBe("::1");
  });
  it("getClientIp prefers x-real-ip (Vercel canonical)", () => {
    const req = {
      headers: { "x-real-ip": "5.6.7.8", "x-forwarded-for": "9.9.9.9" },
      socket: {},
    } as never;
    expect(getClientIp(req)).toBe("5.6.7.8");
  });
  it("daily bucket is YYYY-MM-DD and TTL slightly above 24h window", () => {
    expect(getDailyBucket(new Date("2026-09-17T10:00:00Z"))).toBe("2026-09-17");
    const ttl = ttlUntilEndOfDaySeconds(new Date("2026-09-17T10:00:00Z"));
    expect(ttl).toBeGreaterThan(3600);
    expect(ttl).toBeLessThanOrEqual(48 * 3600);
  });
  it("memory store counts and expires", async () => {
    const s = new MemoryRateLimitStore();
    expect(s.isDurable).toBe(false);
    expect(await s.get("k")).toBe(0);
    expect(await s.incr("k", 60)).toBe(1);
    expect(await s.incr("k", 60)).toBe(2);
    expect(await s.get("k")).toBe(2);
    await s.clear();
    expect(await s.get("k")).toBe(0);
  });
  it("production store is durable, memory is not", () => {
    const mem = new MemoryRateLimitStore();
    const redis = new UpstashRedisRateLimitStore("https://example.upstash.io", "token");
    expect(mem.isDurable).toBe(false);
    expect(redis.isDurable).toBe(true);
    expect(redis.name).toBe("upstash-redis");
  });
  it("tests/dev use memory adapter by default (no Redis env)", async () => {
    __resetRateLimitStoreForTests();
    const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    const prevKvUrl = process.env.KV_REST_API_URL;
    const prevKvTok = process.env.KV_REST_API_TOKEN;
    const prevNode = process.env.NODE_ENV;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.NODE_ENV = "development";
    try {
      const store = getRateLimitStore();
      expect(store.isDurable).toBe(false);
      expect(store.name).toBe("memory");
    } finally {
      if (prevUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = prevUrl;
      if (prevTok !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = prevTok;
      if (prevKvUrl !== undefined) process.env.KV_REST_API_URL = prevKvUrl;
      if (prevKvTok !== undefined) process.env.KV_REST_API_TOKEN = prevKvTok;
      if (prevNode !== undefined) process.env.NODE_ENV = prevNode;
      __resetRateLimitStoreForTests();
    }
  });
  it("resolves Vercel KV vars (KV_REST_API_URL/TOKEN) to durable Redis store", async () => {
    __resetRateLimitStoreForTests();
    const prevUpUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevUpTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    const prevKvUrl = process.env.KV_REST_API_URL;
    const prevKvTok = process.env.KV_REST_API_TOKEN;
    const prevNode = process.env.NODE_ENV;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.KV_REST_API_URL = "https://test-kv.upstash.io";
    process.env.KV_REST_API_TOKEN = "test-token-1234567890";
    process.env.NODE_ENV = "production";
    try {
      expect(getRedisCredentials()).toEqual({
        url: "https://test-kv.upstash.io",
        token: "test-token-1234567890",
      });
      const store = getRateLimitStore();
      expect(store.isDurable).toBe(true);
      expect(store.name).toBe("upstash-redis");
    } finally {
      if (prevUpUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = prevUpUrl;
      else delete process.env.UPSTASH_REDIS_REST_URL;
      if (prevUpTok !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = prevUpTok;
      else delete process.env.UPSTASH_REDIS_REST_TOKEN;
      if (prevKvUrl !== undefined) process.env.KV_REST_API_URL = prevKvUrl;
      else delete process.env.KV_REST_API_URL;
      if (prevKvTok !== undefined) process.env.KV_REST_API_TOKEN = prevKvTok;
      else delete process.env.KV_REST_API_TOKEN;
      if (prevNode !== undefined) process.env.NODE_ENV = prevNode;
      else delete process.env.NODE_ENV;
      __resetRateLimitStoreForTests();
    }
  });
  it("UPSTASH_* takes precedence over KV_*", () => {
    const prevUpUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevUpTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    const prevKvUrl = process.env.KV_REST_API_URL;
    const prevKvTok = process.env.KV_REST_API_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash-prio.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
    process.env.KV_REST_API_URL = "https://kv-other.upstash.io";
    process.env.KV_REST_API_TOKEN = "kv-token";
    try {
      expect(getRedisCredentials()).toEqual({
        url: "https://upstash-prio.upstash.io",
        token: "upstash-token",
      });
    } finally {
      if (prevUpUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = prevUpUrl;
      else delete process.env.UPSTASH_REDIS_REST_URL;
      if (prevUpTok !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = prevUpTok;
      else delete process.env.UPSTASH_REDIS_REST_TOKEN;
      if (prevKvUrl !== undefined) process.env.KV_REST_API_URL = prevKvUrl;
      else delete process.env.KV_REST_API_URL;
      if (prevKvTok !== undefined) process.env.KV_REST_API_TOKEN = prevKvTok;
      else delete process.env.KV_REST_API_TOKEN;
      __resetRateLimitStoreForTests();
    }
  });
  it("production without Redis fails closed (no memory fallback)", async () => {
    __resetRateLimitStoreForTests();
    const prevUpUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevUpTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    const prevKvUrl = process.env.KV_REST_API_URL;
    const prevKvTok = process.env.KV_REST_API_TOKEN;
    const prevNode = process.env.NODE_ENV;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.NODE_ENV = "production";
    try {
      expect(() => getRateLimitStore()).toThrow(/RATE_LIMIT_STORE_UNAVAILABLE/);
    } finally {
      if (prevUpUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = prevUpUrl;
      if (prevUpTok !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = prevUpTok;
      if (prevKvUrl !== undefined) process.env.KV_REST_API_URL = prevKvUrl;
      if (prevKvTok !== undefined) process.env.KV_REST_API_TOKEN = prevKvTok;
      if (prevNode !== undefined) process.env.NODE_ENV = prevNode;
      else delete process.env.NODE_ENV;
      __resetRateLimitStoreForTests();
    }
  });
});

describe("rateLimit check/record semantics", () => {
  beforeEach(() => {
    __setRateLimitStoreForTests(new MemoryRateLimitStore());
  });
  afterEach(() => {
    __resetRateLimitStoreForTests();
  });

  it("different devices independent, different IPs independent", async () => {
    await recordUsage("vision", { deviceId: VALID_UUID, ip: "1.1.1.1" });
    const sameDevice = await checkLimits("vision", { deviceId: VALID_UUID, ip: "9.9.9.9" });
    // device count is 1 < 5, so allowed (device tracked regardless of IP)
    expect(sameDevice.allowed).toBe(true);
    const otherDevice = await checkLimits("vision", { deviceId: OTHER_UUID, ip: "1.1.1.1" });
    // IP count is 1 < 20, so allowed
    expect(otherDevice.allowed).toBe(true);
    const fresh = await checkLimits("vision", { deviceId: OTHER_UUID, ip: "2.2.2.2" });
    expect(fresh.allowed).toBe(true);
  });

  it("new day resets allowance (different bucket)", async () => {
    const store = getRateLimitStore();
    const bucketA = "2026-09-17";
    const bucketB = "2026-09-18";
    for (let i = 0; i < config.visionDeviceDailyLimit; i++) {
      await recordUsage("vision", { deviceId: VALID_UUID, bucket: bucketA });
    }
    const blocked = await checkLimits("vision", { deviceId: VALID_UUID, bucket: bucketA });
    expect(blocked.allowed).toBe(false);
    const nextDay = await checkLimits("vision", { deviceId: VALID_UUID, bucket: bucketB });
    expect(nextDay.allowed).toBe(true);
    expect(await store.get(`rate:vision:device:${hashDevice(VALID_UUID)}:${bucketB}`)).toBe(0);
  });
});

describe("vision/device/IP limits via API (mock, no live calls)", () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origMockMode = process.env.MOCK_MODE;
  let analyzeSpy: { mockRestore: () => void } | null = null;
  beforeEach(async () => {
    clearAllCaches();
    __setRateLimitStoreForTests(new MemoryRateLimitStore());
    process.env.NODE_ENV = "development";
    process.env.MOCK_MODE = "true";
    // Instant mock provider: no 800ms delay, no live ZAI/Groq calls.
    // VisionProviderChain in mock mode uses MockVisionProvider per request;
    // spy the prototype so cache logic in the chain still runs.
    const { MockVisionProvider } = await import("./providers/mockVision.js");
    const { MOCK_FRIDGE_ANALYSIS } = await import("../shared/mockData.js");
    const spy = vi
      .spyOn(MockVisionProvider.prototype, "analyzeFridgeImage")
      .mockImplementation(async () => {
        return JSON.parse(JSON.stringify(MOCK_FRIDGE_ANALYSIS));
      });
    analyzeSpy = spy;
  });
  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv;
    if (origMockMode === undefined) delete process.env.MOCK_MODE;
    else process.env.MOCK_MODE = origMockMode;
    if (analyzeSpy) analyzeSpy.mockRestore();
    analyzeSpy = null;
    clearAllCaches();
    __resetRateLimitStoreForTests();
  });

  it("5th device scan allowed, 6th -> 429 DAILY_LIMIT_REACHED", async () => {
    const { app } = await import("./app.js");
    const deviceId = VALID_UUID;
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/fridge/analyze")
        .set("Content-Type", "application/json")
        .set(DEVICE_HEADER, deviceId)
        .set("x-real-ip", `10.20.30.${40 + i}`) // distinct IPs so only device limit binds
        .send({ imageBase64: makeImageBytes(100 + i), mimeType: "image/jpeg" });
      expect(res.status).toBe(200);
    }
    const blocked = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .set(DEVICE_HEADER, deviceId)
      .set("x-real-ip", "10.20.30.99")
      .send({ imageBase64: makeImageBytes(200), mimeType: "image/jpeg" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("DAILY_LIMIT_REACHED");
    expect(blocked.body.error).toMatch(/лимит/i);
  });

  it("20th IP scan allowed, 21st -> 429 (no device header)", async () => {
    const { app } = await import("./app.js");
    const ip = "198.51.100.7";
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post("/api/fridge/analyze")
        .set("Content-Type", "application/json")
        .set("x-real-ip", ip)
        .send({ imageBase64: makeImageBytes(300 + i), mimeType: "image/jpeg" });
      expect(res.status).toBe(200);
    }
    const blocked = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .set("x-real-ip", ip)
      .send({ imageBase64: makeImageBytes(999), mimeType: "image/jpeg" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("DAILY_LIMIT_REACHED");
  });

  it("invalid payload does not consume quota", async () => {
    const { app } = await import("./app.js");
    const deviceId = OTHER_UUID;
    const bad = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .set(DEVICE_HEADER, deviceId)
      .set("x-real-ip", "203.0.113.9")
      .send({ mimeType: "image/jpeg" }); // missing imageBase64
    expect(bad.status).toBe(400);
    const store = getRateLimitStore();
    const bucket = getDailyBucket();
    expect(await store.get(`rate:vision:device:${hashDevice(deviceId)}:${bucket}`)).toBe(0);
    // Valid request afterwards still allowed
    const ok = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .set(DEVICE_HEADER, deviceId)
      .set("x-real-ip", "203.0.113.9")
      .send({ imageBase64: makeImageBytes(500), mimeType: "image/jpeg" });
    expect(ok.status).toBe(200);
  });

  it("oversized image does not consume quota", async () => {
    const { app } = await import("./app.js");
    const deviceId = "oversize-device-12345678";
    const big = Buffer.alloc(400 * 1024, 0x02).toString("base64");
    const res = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .set(DEVICE_HEADER, deviceId)
      .set("x-real-ip", "203.0.113.10")
      .send({ imageBase64: big, mimeType: "image/jpeg" });
    expect(res.status).toBe(413);
    const store = getRateLimitStore();
    const bucket = getDailyBucket();
    expect(await store.get(`rate:vision:device:${hashDevice(deviceId)}:${bucket}`)).toBe(0);
  });

  it("cached identical result does not consume another allowance", async () => {
    const { app } = await import("./app.js");
    const deviceId = "cache-device-12345678";
    const ip = "203.0.113.11";
    const img = makeImageBytes(777, 5000);
    const first = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .set(DEVICE_HEADER, deviceId)
      .set("x-real-ip", ip)
      .send({ imageBase64: img, mimeType: "image/jpeg" });
    expect(first.status).toBe(200);
    expect(first.body.meta.cached).toBe(false);
    const second = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .set(DEVICE_HEADER, deviceId)
      .set("x-real-ip", ip)
      .send({ imageBase64: img, mimeType: "image/jpeg" });
    expect(second.status).toBe(200);
    expect(second.body.meta.cached).toBe(true);
    const store = getRateLimitStore();
    const bucket = getDailyBucket();
    // Only the first (uncached) call consumed allowance.
    expect(await store.get(`rate:vision:device:${hashDevice(deviceId)}:${bucket}`)).toBe(1);
    expect(await store.get(`rate:vision:ip:${hashIp(ip)}:${bucket}`)).toBe(1);
  });

  it("malformed device ID is ignored (IP limit still applies, no crash)", async () => {
    const { app } = await import("./app.js");
    const res = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .set(DEVICE_HEADER, "<script>alert(1)</script>")
      .set("x-real-ip", "203.0.113.12")
      .send({ imageBase64: makeImageBytes(888), mimeType: "image/jpeg" });
    expect(res.status).toBe(200);
  });

  it("device still limited when no trusted IP available", async () => {
    const { app } = await import("./app.js");
    const deviceId = "no-ip-device-12345678";
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/fridge/analyze")
        .set("Content-Type", "application/json")
        .set(DEVICE_HEADER, deviceId)
        .send({ imageBase64: makeImageBytes(900 + i), mimeType: "image/jpeg" });
      // Without x-real-ip, supertest sets 127.0.0.1; distinct device still binds at 5.
      expect(res.status).toBe(200);
    }
    const blocked = await request(app)
      .post("/api/fridge/analyze")
      .set("Content-Type", "application/json")
      .set(DEVICE_HEADER, deviceId)
      .send({ imageBase64: makeImageBytes(950), mimeType: "image/jpeg" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("DAILY_LIMIT_REACHED");
  });

  it("production without Redis fails closed (503, no unlimited serve)", async () => {
    // Simulate production with no Redis creds: expensive endpoint must 503,
    // not serve via memory. No live AI calls (fails before provider).
    __resetRateLimitStoreForTests();
    const prevUpUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevUpTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    const prevKvUrl = process.env.KV_REST_API_URL;
    const prevKvTok = process.env.KV_REST_API_TOKEN;
    const prevNode = process.env.NODE_ENV;
    const prevMock = process.env.MOCK_MODE;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.NODE_ENV = "production";
    process.env.MOCK_MODE = "true";
    clearAllCaches();
    try {
      const { app } = await import("./app.js");
      const res = await request(app)
        .post("/api/fridge/analyze")
        .set("Content-Type", "application/json")
        .set(DEVICE_HEADER, VALID_UUID)
        .set("x-real-ip", "203.0.113.99")
        .send({ imageBase64: makeImageBytes(4242), mimeType: "image/jpeg" });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("RATE_LIMIT_UNAVAILABLE");
    } finally {
      if (prevUpUrl !== undefined) process.env.UPSTASH_REDIS_REST_URL = prevUpUrl;
      if (prevUpTok !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = prevUpTok;
      if (prevKvUrl !== undefined) process.env.KV_REST_API_URL = prevKvUrl;
      if (prevKvTok !== undefined) process.env.KV_REST_API_TOKEN = prevKvTok;
      if (prevNode !== undefined) process.env.NODE_ENV = prevNode;
      else delete process.env.NODE_ENV;
      if (prevMock !== undefined) process.env.MOCK_MODE = prevMock;
      else delete process.env.MOCK_MODE;
      __resetRateLimitStoreForTests();
      __setRateLimitStoreForTests(new MemoryRateLimitStore());
      clearAllCaches();
    }
  });
});
