import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config, isPlatformIntegrationEnabled, isProduction } from "../config.js";
import { getPlatformClient, type IPlatformClient } from "../platform/index.js";
import { MockPlatformClient } from "../platform/mock.js";
import { PlatformError } from "../platform/errors.js";
import { buildClearedCookie, buildSessionCookie, readSessionCookie } from "../platform/cookies.js";

const router = Router();

// ---------- test hooks (supertest + E2E process control) ----------

let clientOverride: IPlatformClient | null = null;
let mockSingleton: MockPlatformClient | null = null;

export function __setPlatformClientForTests(client: IPlatformClient | null): void {
  clientOverride = client;
}

function activeMock(): MockPlatformClient {
  if (!mockSingleton) mockSingleton = new MockPlatformClient();
  return mockSingleton;
}

export function __resetPlatformMockForTests(): void {
  mockSingleton = null;
  clientOverride = null;
}

/** Shared server-side client resolution (auth bridge + credit-aware scans). */
export function requestPlatformClient(req: Request): IPlatformClient {
  return resolveClient(req);
}

/** Raw opaque Platform session from our first-party cookie (never from body). */
export function requestPlatformSession(req: Request): string | undefined {
  return readSessionCookie(req.headers, cookieName());
}

function resolveClient(req: Request): IPlatformClient {
  if (clientOverride) return clientOverride;
  const token = config.userPlatformServiceToken;
  if (token) return getPlatformClient();
  // Non-production without a token: shared deterministic mock (dev/E2E).
  // Production without a token: real client that fails closed at call time.
  if (!isProduction()) {
    const mock = activeMock();
    // E2E scenario control — honored ONLY on the mock path (never production,
    // never with a real service credential configured).
    const header = req.headers["x-platform-mock"];
    if (typeof header === "string" && header) {
      try {
        const parsed = JSON.parse(header) as {
          initialBalance?: number;
          exchangeFail?: boolean;
          commitTimeouts?: number;
          releaseTimeouts?: number;
          reset?: boolean;
        };
        mock.configure(parsed);
      } catch {
        // Malformed scenario header is ignored (tests use valid JSON).
      }
    }
    return mock;
  }
  return getPlatformClient();
}

function cookieName(): string {
  return config.platformSessionCookieName;
}

function sessionMaxAge(): number {
  return 30 * 24 * 3600;
}

// ---------- schemas ----------

const exchangeSchema = z.object({
  platform: z.enum(["telegram", "max"]),
  initData: z.string().min(1).max(8192),
  startParam: z.string().max(512).optional(),
});

// ---------- public status (safe, unauthenticated) ----------

router.get("/status", (_req, res) => {
  res.json({ integrationEnabled: isPlatformIntegrationEnabled() });
});

// ---------- exchange (browser → Holodilnik backend, never UserPlatform directly) ----------

router.post("/exchange", async (req, res) => {
  if (!isPlatformIntegrationEnabled()) {
    return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
  }
  const parsed = exchangeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request payload", code: "INVALID_PAYLOAD" });
  }
  const client = resolveClient(req);
  try {
    const out = await client.exchangePlatform({
      platform: parsed.data.platform,
      initData: parsed.data.initData,
      startParam: parsed.data.startParam,
    });
    res.setHeader(
      "Set-Cookie",
      buildSessionCookie(cookieName(), out.sessionToken, {
        isProduction: isProduction(),
        maxAgeSeconds: sessionMaxAge(),
      }),
    );
    // Safe subset ONLY: never the Platform session token, service credential,
    // or raw initData.
    return res.json({
      authenticated: true,
      user: { id: out.userId, status: out.userStatus },
      isNewUser: out.isNewUser,
      balance: { available: out.availableBalance, reserved: 0 },
      appSlug: out.appSlug,
    });
  } catch (err) {
    return res.status(mapStatus(err)).json(mapBody(err));
  }
});

// ---------- me (session restoration / balance refresh) ----------

router.get("/me", async (req, res) => {
  if (!isPlatformIntegrationEnabled()) {
    return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
  }
  const token = readSessionCookie(req.headers, cookieName());
  if (!token) {
    return res
      .status(401)
      .json({ authenticated: false, error: "Not authenticated", code: "UNAUTHORIZED" });
  }
  try {
    const me = await resolveClient(req).getMe(token);
    return res.json({
      authenticated: true,
      user: { id: me.userId, status: me.userStatus },
      balance: { available: me.availableBalance, reserved: me.reservedBalance },
    });
  } catch (err) {
    return res.status(mapStatus(err)).json({ authenticated: false, ...mapBody(err) });
  }
});

// ---------- logout ----------

router.delete("/session", async (req, res) => {
  const token = readSessionCookie(req.headers, cookieName());
  // Revoke server-side when possible; always clear our cookie.
  if (token && isPlatformIntegrationEnabled()) {
    try {
      await resolveClient(req).revokeSession(token);
    } catch {
      // Best-effort: the cookie is cleared regardless.
    }
  }
  res.setHeader("Set-Cookie", buildClearedCookie(cookieName(), isProduction()));
  return res.status(204).end();
});

// ---------- dev-only persona exchange + mock reset (never production) ----------

const requireDev = (_req: Request, res: Response, next: NextFunction): void => {
  if (isProduction()) {
    res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    return;
  }
  next();
};

router.post("/dev/exchange", requireDev, async (req, res) => {
  if (!isPlatformIntegrationEnabled()) {
    return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
  }
  const persona = String(req.body?.persona ?? "");
  if (!persona) {
    return res.status(400).json({ error: "Unknown persona", code: "INVALID_PAYLOAD" });
  }
  try {
    const out = await resolveClient(req).exchangeDev(persona);
    res.setHeader(
      "Set-Cookie",
      buildSessionCookie(cookieName(), out.sessionToken, {
        isProduction: false,
        maxAgeSeconds: sessionMaxAge(),
      }),
    );
    return res.json({
      authenticated: true,
      user: { id: out.userId, status: out.userStatus },
      isNewUser: out.isNewUser,
      balance: { available: out.availableBalance, reserved: 0 },
      appSlug: out.appSlug,
    });
  } catch (err) {
    return res.status(mapStatus(err)).json(mapBody(err));
  }
});

router.post("/dev/reset", requireDev, (_req, res) => {
  __resetPlatformMockForTests();
  return res.json({ status: "reset" });
});

// ---------- error mapping ----------

function mapStatus(err: unknown): number {
  if (err instanceof PlatformError) {
    // Missing service credential surfaces as PLATFORM_UNAVAILABLE (503) by
    // the adapter — never leak which side misconfigured.
    return err.status;
  }
  return 500;
}

function mapBody(err: unknown): { error: string; code: string } {
  if (err instanceof PlatformError) {
    switch (err.code) {
      case "INVALID_PLATFORM_DATA":
        return { error: "Некорректные данные платформы", code: "INVALID_PLATFORM_DATA" };
      case "PLATFORM_DATA_EXPIRED":
        return {
          error: "Данные платформы устарели — откройте приложение заново",
          code: "PLATFORM_DATA_EXPIRED",
        };
      case "SESSION_EXPIRED":
        return { error: "Сессия истекла — войдите заново", code: "SESSION_EXPIRED" };
      case "SESSION_FORBIDDEN":
        return { error: "Операция недоступна", code: "FORBIDDEN" };
      case "PLATFORM_UNAVAILABLE":
        return { error: "Сервис аккаунта временно недоступен", code: "PLATFORM_UNAVAILABLE" };
      default:
        return { error: "Ошибка сервиса аккаунта", code: "PLATFORM_ERROR" };
    }
  }
  return { error: "Internal server error", code: "INTERNAL_ERROR" };
}

export default router;
