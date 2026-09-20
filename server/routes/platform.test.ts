/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { app } from "../app.js";
import { MockPlatformClient } from "../platform/mock.js";
import { __resetPlatformMockForTests, __setPlatformClientForTests } from "./platform.js";

function cookieOf(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.join(";");
}

const ORIGINAL_FLAG = process.env.PLATFORM_INTEGRATION_ENABLED;

beforeAll(() => {
  process.env.PLATFORM_INTEGRATION_ENABLED = "true";
});

afterEach(() => {
  __resetPlatformMockForTests();
  process.env.PLATFORM_INTEGRATION_ENABLED = "true";
});

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.PLATFORM_INTEGRATION_ENABLED;
  else process.env.PLATFORM_INTEGRATION_ENABLED = ORIGINAL_FLAG;
  __resetPlatformMockForTests();
});

function injectMock(opts = {}) {
  const mock = new MockPlatformClient(opts);
  __setPlatformClientForTests(mock);
  return mock;
}

describe("platform auth bridge (integration enabled)", () => {
  it("GET /api/platform/status reports the flag", async () => {
    const res = await request(app).get("/api/platform/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ integrationEnabled: true });
  });

  it("exchange sets an HttpOnly cookie and never leaks the session token", async () => {
    injectMock();
    const res = await request(app)
      .post("/api/platform/exchange")
      .send({ platform: "telegram", initData: "tg-test-1", startParam: "campaign_7" });
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.balance.available).toBe(10);
    expect(res.body.appSlug).toBe("fridge");
    expect(res.body.sessionToken).toBeUndefined();
    expect(res.body.token).toBeUndefined();
    expect(res.body.initData).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/sessionToken/);
    const setCookie = cookieOf(res);
    expect(setCookie).toContain("holodilnik_session=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("exchange rejects bad payloads before touching Platform", async () => {
    const mock = injectMock();
    let called = false;
    const orig = mock.exchangePlatform.bind(mock);
    mock.exchangePlatform = async (input) => {
      called = true;
      return orig(input);
    };
    const res = await request(app)
      .post("/api/platform/exchange")
      .send({ platform: "email", initData: "" });
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("Platform outage → 503 PLATFORM_UNAVAILABLE (fail-closed, no anonymous AI)", async () => {
    injectMock({ exchangeFail: true });
    const res = await request(app)
      .post("/api/platform/exchange")
      .send({ platform: "telegram", initData: "tg-down" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PLATFORM_UNAVAILABLE");
  });

  it("me restores the session from the cookie; missing cookie → 401", async () => {
    injectMock();
    const agent = request.agent(app);
    await agent.post("/api/platform/exchange").send({ platform: "telegram", initData: "tg-me" });
    const me = await agent.get("/api/platform/me");
    expect(me.status).toBe(200);
    expect(me.body.authenticated).toBe(true);
    expect(me.body.balance.available).toBe(10);
    expect(me.body.sessionToken).toBeUndefined();

    const naked = await request(app).get("/api/platform/me");
    expect(naked.status).toBe(401);
  });

  it("tampered cookie → 401", async () => {
    injectMock();
    const res = await request(app)
      .get("/api/platform/me")
      .set("Cookie", "holodilnik_session=forged-token-value-1234567890");
    expect(res.status).toBe(401);
  });

  it("logout clears the cookie (204) even when Platform is down", async () => {
    const mock = injectMock();
    const agent = request.agent(app);
    await agent.post("/api/platform/exchange").send({ platform: "telegram", initData: "tg-lo" });
    mock.setExchangeFail(true);
    const out = await agent.delete("/api/platform/session");
    expect(out.status).toBe(204);
    expect(cookieOf(out)).toContain("Max-Age=0");
    const me = await agent.get("/api/platform/me");
    expect(me.status).toBe(401);
  });

  it("dev exchange works outside production; unknown persona → 400", async () => {
    injectMock();
    const res = await request(app).post("/api/platform/dev/exchange").send({ persona: "tester-1" });
    expect(res.status).toBe(200);
    expect(res.body.balance.available).toBe(10);
    const bad = await request(app).post("/api/platform/dev/exchange").send({});
    expect(bad.status).toBe(400);
  });
});

describe("platform auth bridge (integration disabled)", () => {
  it("exchange and me are not enumerable when the flag is off", async () => {
    process.env.PLATFORM_INTEGRATION_ENABLED = "false";
    expect((await request(app).get("/api/platform/status")).body).toEqual({
      integrationEnabled: false,
    });
    await request(app)
      .post("/api/platform/exchange")
      .send({ platform: "telegram", initData: "x" })
      .expect(404);
    await request(app).get("/api/platform/me").expect(404);
  });
});
