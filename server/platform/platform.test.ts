/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { PlatformClient } from "./client.js";
import { MockPlatformClient } from "./mock.js";
import { PlatformError } from "./errors.js";
import { buildClearedCookie, buildSessionCookie, readSessionCookie } from "./cookies.js";

describe("MockPlatformClient (contract parity)", () => {
  it("stable identity: same initData → same user, second exchange not new", async () => {
    const mock = new MockPlatformClient();
    const a = await mock.exchangePlatform({ platform: "telegram", initData: "persona-1" });
    const b = await mock.exchangePlatform({ platform: "telegram", initData: "persona-1" });
    expect(a.userId).toBe(b.userId);
    expect(a.isNewUser).toBe(true);
    expect(b.isNewUser).toBe(false);
    expect(a.availableBalance).toBe(10);
  });

  it("telegram vs max namespaces are independent", async () => {
    const mock = new MockPlatformClient();
    const tg = await mock.exchangePlatform({ platform: "telegram", initData: "777" });
    const mx = await mock.exchangePlatform({ platform: "max", initData: "777" });
    expect(tg.userId).not.toBe(mx.userId);
  });

  it("reserve → commit moves exactly one credit; retry is idempotent", async () => {
    const mock = new MockPlatformClient();
    const ex = await mock.exchangePlatform({ platform: "telegram", initData: "u1" });
    const r1 = await mock.reserve(ex.sessionToken, {
      operation: "fridge.scan",
      requestId: "fridge.scan:aaa",
    });
    expect(r1.reservation.availableBalance).toBe(9);
    expect(r1.reused).toBe(false);
    const r2 = await mock.reserve(ex.sessionToken, {
      operation: "fridge.scan",
      requestId: "fridge.scan:aaa",
    });
    expect(r2.reused).toBe(true);
    expect(r2.reservation.availableBalance).toBe(9);
    const c1 = await mock.commit(ex.sessionToken, r1.reservation.reservationId);
    expect(c1.reservation.status).toBe("committed");
    const c2 = await mock.commit(ex.sessionToken, r1.reservation.reservationId);
    expect(c2.reused).toBe(true);
    expect(mock.balanceOf(ex.userId)).toEqual({ available: 9, reserved: 0 });
  });

  it("insufficient credits → 402, no balance movement", async () => {
    const mock = new MockPlatformClient({ initialBalance: 0 });
    const ex = await mock.exchangePlatform({ platform: "telegram", initData: "poor" });
    await expect(
      mock.reserve(ex.sessionToken, { operation: "fridge.scan", requestId: "fridge.scan:poor" }),
    ).rejects.toMatchObject({ status: 402, code: "INSUFFICIENT_CREDITS" });
    expect(mock.balanceOf(ex.userId)).toEqual({ available: 0, reserved: 0 });
  });

  it("foreign operation (wardrobe.outfit) → 403; unknown op → 404", async () => {
    const mock = new MockPlatformClient();
    const ex = await mock.exchangePlatform({ platform: "telegram", initData: "x" });
    await expect(
      mock.reserve(ex.sessionToken, { operation: "wardrobe.outfit", requestId: "fridge.scan:1" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      mock.reserve(ex.sessionToken, { operation: "nope.nope", requestId: "fridge.scan:2" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("release refunds; double release is a no-op", async () => {
    const mock = new MockPlatformClient();
    const ex = await mock.exchangePlatform({ platform: "telegram", initData: "rel" });
    const r = await mock.reserve(ex.sessionToken, {
      operation: "fridge.scan",
      requestId: "fridge.scan:rel",
    });
    await mock.release(ex.sessionToken, r.reservation.reservationId);
    expect(mock.balanceOf(ex.userId)).toEqual({ available: 10, reserved: 0 });
    const again = await mock.release(ex.sessionToken, r.reservation.reservationId);
    expect(again.reused).toBe(true);
  });

  it("commit timeout knob then success charges exactly once", async () => {
    const mock = new MockPlatformClient({ commitTimeouts: 1 });
    const ex = await mock.exchangePlatform({ platform: "telegram", initData: "ct" });
    const r = await mock.reserve(ex.sessionToken, {
      operation: "fridge.scan",
      requestId: "fridge.scan:ct",
    });
    await expect(mock.commit(ex.sessionToken, r.reservation.reservationId)).rejects.toMatchObject({
      code: "PLATFORM_UNAVAILABLE",
    });
    const ok = await mock.commit(ex.sessionToken, r.reservation.reservationId);
    expect(ok.reservation.status).toBe("committed");
    expect(mock.balanceOf(ex.userId)).toEqual({ available: 9, reserved: 0 });
  });

  it("unknown session → 401; revoked session → 401", async () => {
    const mock = new MockPlatformClient();
    await expect(mock.getMe("nope")).rejects.toMatchObject({ status: 401 });
    const ex = await mock.exchangePlatform({ platform: "telegram", initData: "rv" });
    await mock.revokeSession(ex.sessionToken);
    await expect(mock.getMe(ex.sessionToken)).rejects.toMatchObject({ status: 401 });
  });
});

describe("PlatformClient (typed errors via stubbed fetch)", () => {
  const stubFetch = (status: number, body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

  it("missing service token throws before network", async () => {
    const client = new PlatformClient({ baseUrl: "https://x", getServiceToken: () => undefined });
    await expect(
      client.reserve("sess", { operation: "fridge.scan", requestId: "fridge.scan:1" }),
    ).rejects.toBeInstanceOf(PlatformError);
  });

  it("402 maps to INSUFFICIENT_CREDITS; 5xx maps to PLATFORM_UNAVAILABLE", async () => {
    const poor = new PlatformClient({
      baseUrl: "https://x",
      getServiceToken: () => "tok",
      fetchImpl: stubFetch(402, { error: "No credits", code: "INSUFFICIENT_CREDITS" }),
    });
    await expect(
      poor.reserve("sess", { operation: "fridge.scan", requestId: "fridge.scan:1" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });

    const down = new PlatformClient({
      baseUrl: "https://x",
      getServiceToken: () => "tok",
      fetchImpl: stubFetch(502, { error: "bad gateway" }),
    });
    await expect(
      down.reserve("sess", { operation: "fridge.scan", requestId: "fridge.scan:1" }),
    ).rejects.toMatchObject({ code: "PLATFORM_UNAVAILABLE" });
  });
});

describe("session cookies", () => {
  it("build → parse round-trips; cleared cookie expires immediately", () => {
    const set = buildSessionCookie("holodilnik_session", "tok-123", {
      isProduction: true,
      maxAgeSeconds: 3600,
    });
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Lax");
    expect(readSessionCookie({ cookie: set.split(";")[0] }, "holodilnik_session")).toBe("tok-123");
    expect(buildClearedCookie("holodilnik_session", true)).toContain("Max-Age=0");
  });
});
