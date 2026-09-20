import { PlatformError, platformUnavailable, toPlatformError } from "./errors.js";
import type {
  HostPlatformName,
  PlatformBalance,
  PlatformExchangeInput,
  PlatformExchangeResult,
  PlatformMe,
  PlatformMutation,
} from "./types.js";

/**
 * Server-only UserPlatform adapter (strategy D, ADR-042).
 *
 * All methods run backend-to-backend: the service credential travels in
 * `Authorization`, the user's app session in `X-Platform-Session`. Nothing
 * here is importable from browser code (server/ only, no VITE_ env).
 */
export interface IPlatformClient {
  exchangePlatform(input: PlatformExchangeInput): Promise<PlatformExchangeResult>;
  /** Dev/E2E persona exchange (UserPlatform dev endpoint; never called in prod). */
  exchangeDev(persona: string): Promise<PlatformExchangeResult>;
  getMe(sessionToken: string): Promise<PlatformMe>;
  reserve(
    sessionToken: string,
    input: { operation: string; requestId: string },
  ): Promise<PlatformMutation>;
  commit(sessionToken: string, reservationId: string): Promise<PlatformMutation>;
  release(sessionToken: string, reservationId: string): Promise<PlatformMutation>;
  revokeSession(sessionToken: string): Promise<void>;
}

export interface PlatformClientOptions {
  baseUrl: string;
  getServiceToken: () => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface RawReservation {
  reservationId: string;
  requestId: string;
  operation: string;
  amount: number;
  status: "reserved" | "committed" | "released";
  balance: PlatformBalance;
}

function toMutation(json: { reservation: RawReservation; reused: boolean }): PlatformMutation {
  return {
    reservation: {
      reservationId: json.reservation.reservationId,
      requestId: json.reservation.requestId,
      operation: json.reservation.operation,
      amount: json.reservation.amount,
      status: json.reservation.status,
      availableBalance: json.reservation.balance.available,
      reservedBalance: json.reservation.balance.reserved,
    },
    reused: json.reused,
  };
}

export class PlatformClient implements IPlatformClient {
  private readonly opts: PlatformClientOptions;
  constructor(opts: PlatformClientOptions) {
    this.opts = opts;
  }

  private serviceToken(): string {
    const token = this.opts.getServiceToken();
    if (!token) {
      // Fail closed: missing credential is indistinguishable from outage to
      // callers (503, never anonymous AI for TG/MAX).
      throw platformUnavailable();
    }
    return token;
  }

  private async request<T>(path: string, init: RequestInit, sessionToken?: string): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    headers["Authorization"] = `Bearer ${this.serviceToken()}`;
    if (sessionToken) headers["X-Platform-Session"] = sessionToken;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const timeoutMs = this.opts.timeoutMs ?? 15000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${this.opts.baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        signal: ctrl.signal,
      });
    } catch (err) {
      throw platformUnavailable(
        err instanceof Error && err.name === "AbortError"
          ? "Сервис аккаунта временно недоступен"
          : "Сервис аккаунта временно недоступен",
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500) throw platformUnavailable();
    const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok) throw toPlatformError(res.status, json, "Platform request failed");
    return json as T;
  }

  async exchangePlatform(input: PlatformExchangeInput): Promise<PlatformExchangeResult> {
    if (input.platform !== "telegram" && input.platform !== "max") {
      throw new PlatformError(400, "INVALID_PLATFORM_DATA", "Unknown platform");
    }
    const json = await this.request<{
      user: { id: string; status: string };
      isNewUser: boolean;
      balance: number;
      app: { slug: string };
      session: { token: string; expiresAt: string };
    }>("/v1/service/auth/platform-exchange", {
      method: "POST",
      body: JSON.stringify({
        platform: input.platform as HostPlatformName,
        initData: input.initData,
        ...(input.startParam ? { startParam: input.startParam } : {}),
      }),
    });
    return {
      userId: json.user.id,
      userStatus: json.user.status,
      isNewUser: json.isNewUser,
      availableBalance: json.balance,
      appSlug: json.app.slug,
      sessionToken: json.session.token,
      sessionExpiresAt: json.session.expiresAt,
    };
  }

  async exchangeDev(persona: string): Promise<PlatformExchangeResult> {
    const json = await this.request<{
      user: { id: string; status: string };
      isNewUser: boolean;
      balance: number;
      app: { slug: string };
      session: { token: string; expiresAt: string };
    }>("/v1/service/auth/dev/exchange", {
      method: "POST",
      body: JSON.stringify({ persona }),
    });
    return {
      userId: json.user.id,
      userStatus: json.user.status,
      isNewUser: json.isNewUser,
      availableBalance: json.balance,
      appSlug: json.app.slug,
      sessionToken: json.session.token,
      sessionExpiresAt: json.session.expiresAt,
    };
  }

  async getMe(sessionToken: string): Promise<PlatformMe> {
    const json = await this.request<{
      user: { id: string; status: string };
      balance: PlatformBalance;
    }>("/v1/me", { method: "GET" }, sessionToken);
    return {
      userId: json.user.id,
      userStatus: json.user.status,
      availableBalance: json.balance.available,
      reservedBalance: json.balance.reserved,
    };
  }

  async reserve(
    sessionToken: string,
    input: { operation: string; requestId: string },
  ): Promise<PlatformMutation> {
    const json = await this.request<{ reservation: RawReservation; reused: boolean }>(
      "/v1/credits/reserve",
      { method: "POST", body: JSON.stringify(input) },
      sessionToken,
    );
    return toMutation(json);
  }

  async commit(sessionToken: string, reservationId: string): Promise<PlatformMutation> {
    const json = await this.request<{ reservation: RawReservation; reused: boolean }>(
      "/v1/credits/commit",
      { method: "POST", body: JSON.stringify({ reservationId }) },
      sessionToken,
    );
    return toMutation(json);
  }

  async release(sessionToken: string, reservationId: string): Promise<PlatformMutation> {
    const json = await this.request<{ reservation: RawReservation; reused: boolean }>(
      "/v1/credits/release",
      { method: "POST", body: JSON.stringify({ reservationId }) },
      sessionToken,
    );
    return toMutation(json);
  }

  async revokeSession(sessionToken: string): Promise<void> {
    try {
      // UserPlatform logout reads the session from the cookie only, so send
      // it as a Cookie header (X-Platform-Session is not honored there).
      await this.request<void>(
        "/v1/auth/session",
        {
          method: "DELETE",
          headers: { Cookie: `up_session=${encodeURIComponent(sessionToken)}` },
        },
        sessionToken,
      );
    } catch (err) {
      // Logout clears our cookie regardless; revocation is best-effort.
      // 404/401 here means the session is already gone — not an error.
      if (err instanceof PlatformError && (err.status === 401 || err.status === 404)) return;
      throw err;
    }
  }
}

export function createPlatformClient(opts: PlatformClientOptions): PlatformClient {
  return new PlatformClient(opts);
}
