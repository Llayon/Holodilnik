import { randomUUID } from "node:crypto";
import { PlatformError, platformUnavailable } from "./errors.js";
import type { IPlatformClient } from "./client.js";
import type {
  HostPlatformName,
  PlatformExchangeInput,
  PlatformExchangeResult,
  PlatformMe,
  PlatformMutation,
} from "./types.js";

/**
 * Deterministic in-memory UserPlatform fake (tests/E2E only, never production).
 * Models one shared wallet per mock user with reserve→commit|release and the
 * same idempotency shape as the real API (same requestId → same reservation).
 *
 * Failure knobs (set per-test; all default to success):
 * - exchangeFail: exchangePlatform throws PLATFORM_UNAVAILABLE
 * - commitTimeouts: number of leading commit() calls that throw 504/timeout
 * - releaseTimeouts: number of leading release() calls that throw
 * - reserveInsufficientAt: balances at or below this trigger INSUFFICIENT
 *   (default: real rule — available < cost)
 */
export interface MockPlatformOptions {
  initialBalance?: number;
  exchangeFail?: boolean;
  commitTimeouts?: number;
  releaseTimeouts?: number;
  persona?: string;
}

interface MockReservation {
  reservationId: string;
  requestId: string;
  operation: string;
  amount: number;
  status: "reserved" | "committed" | "released";
}

const COSTS: Record<string, number> = {
  "fridge.scan": 1,
  "fridge.recipe": 0,
};

export class MockPlatformClient implements IPlatformClient {
  private balances = new Map<string, { available: number; reserved: number }>();
  private sessions = new Map<string, string>(); // sessionToken -> userId
  private reservations = new Map<string, MockReservation>(); // by id
  private byRequest = new Map<string, MockReservation>(); // userId:requestId -> reservation
  private commitTimeouts: number;
  private releaseTimeouts: number;
  private exchangeFail: boolean;
  private initialBalance: number;

  constructor(opts: MockPlatformOptions = {}) {
    this.initialBalance = opts.initialBalance ?? 10;
    this.exchangeFail = opts.exchangeFail ?? false;
    this.commitTimeouts = opts.commitTimeouts ?? 0;
    this.releaseTimeouts = opts.releaseTimeouts ?? 0;
  }

  /** Test hook: balances for assertions. */
  balanceOf(userId: string): { available: number; reserved: number } {
    return this.balances.get(userId) ?? { available: 0, reserved: 0 };
  }

  /** Test hook: force modes mid-test. */
  setExchangeFail(v: boolean): void {
    this.exchangeFail = v;
  }

  private userIdFor(platform: HostPlatformName, key: string): string {
    // Stable mock identity: same persona → same user (mirrors real namespace rule).
    return `mock:${platform}:${key}`;
  }

  /** Dev/E2E persona exchange (never production). */
  async exchangeDev(persona: string): Promise<PlatformExchangeResult> {
    return this.exchangePlatform({ platform: "telegram", initData: `dev:${persona}` });
  }

  /** Test/E2E hook: tune future behavior (initial balances, outage flags). */
  configure(opts: Partial<MockPlatformOptions> & { reset?: boolean }): void {
    if (opts.reset) {
      this.balances.clear();
      this.sessions.clear();
      this.reservations.clear();
      this.byRequest.clear();
    }
    if (opts.initialBalance !== undefined) {
      // Applies to wallets created from now on (existing users keep theirs).
      this.initialBalance = opts.initialBalance;
    }
    if (opts.exchangeFail !== undefined) this.exchangeFail = opts.exchangeFail;
    if (opts.commitTimeouts !== undefined) this.commitTimeouts = opts.commitTimeouts;
    if (opts.releaseTimeouts !== undefined) this.releaseTimeouts = opts.releaseTimeouts;
  }

  private ensureWallet(userId: string): { available: number; reserved: number } {
    let w = this.balances.get(userId);
    if (!w) {
      w = { available: this.initialBalance, reserved: 0 };
      this.balances.set(userId, w);
    }
    return w;
  }

  async exchangePlatform(input: PlatformExchangeInput): Promise<PlatformExchangeResult> {
    if (this.exchangeFail) throw platformUnavailable();
    if (!input.initData) {
      throw new PlatformError(400, "INVALID_PLATFORM_DATA", "Invalid platform data");
    }
    const isNew = !this.balances.has(this.userIdFor(input.platform, input.initData));
    const userId = this.userIdFor(input.platform, input.initData);
    const wallet = this.ensureWallet(userId);
    const sessionToken = `mock-session-${randomUUID()}`;
    this.sessions.set(sessionToken, userId);
    return {
      userId,
      userStatus: "active",
      isNewUser: isNew,
      availableBalance: wallet.available,
      appSlug: "fridge",
      sessionToken,
      sessionExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    };
  }

  private requireSession(sessionToken: string): string {
    const userId = this.sessions.get(sessionToken);
    if (!userId) throw new PlatformError(401, "SESSION_EXPIRED", "Session expired");
    return userId;
  }

  async getMe(sessionToken: string): Promise<PlatformMe> {
    const userId = this.requireSession(sessionToken);
    const w = this.ensureWallet(userId);
    return {
      userId,
      userStatus: "active",
      availableBalance: w.available,
      reservedBalance: w.reserved,
    };
  }

  async reserve(
    sessionToken: string,
    input: { operation: string; requestId: string },
  ): Promise<PlatformMutation> {
    const userId = this.requireSession(sessionToken);
    if (input.operation !== "fridge.scan" && input.operation !== "fridge.recipe") {
      // Mirror Platform scoping: another app's known operation is 403,
      // an unknown key is 404 (real Platform decides via its registry).
      if (/^(wardrobe|interior)\.[a-z0-9_]+$/.test(input.operation)) {
        throw new PlatformError(
          403,
          "SESSION_FORBIDDEN",
          "Operation does not belong to this application",
        );
      }
      throw new PlatformError(404, "NOT_FOUND", "Unknown operation");
    }
    const key = `${userId}:${input.requestId}`;
    const seen = this.byRequest.get(key);
    const wallet = this.ensureWallet(userId);
    if (seen) return { reservation: this.view(seen, wallet), reused: true };
    const cost = COSTS[input.operation];
    if (wallet.available < cost) {
      throw new PlatformError(402, "INSUFFICIENT_CREDITS", "Insufficient credits");
    }
    wallet.available -= cost;
    wallet.reserved += cost;
    const r: MockReservation = {
      reservationId: randomUUID(),
      requestId: input.requestId,
      operation: input.operation,
      amount: cost,
      status: "reserved",
    };
    this.reservations.set(r.reservationId, r);
    this.byRequest.set(key, r);
    return { reservation: this.view(r, wallet), reused: false };
  }

  async commit(sessionToken: string, reservationId: string): Promise<PlatformMutation> {
    if (this.commitTimeouts > 0) {
      this.commitTimeouts -= 1;
      throw platformUnavailable("Commit acknowledgement lost");
    }
    const userId = this.requireSession(sessionToken);
    const r = this.reservations.get(reservationId);
    const wallet = this.ensureWallet(userId);
    if (!r) throw new PlatformError(404, "NOT_FOUND", "Reservation not found");
    if (r.status === "committed") return { reservation: this.view(r, wallet), reused: true };
    if (r.status !== "reserved") {
      throw new PlatformError(409, "RESERVATION_CONFLICT", "Cannot commit released reservation");
    }
    r.status = "committed";
    wallet.reserved -= r.amount;
    return { reservation: this.view(r, wallet), reused: false };
  }

  async release(sessionToken: string, reservationId: string): Promise<PlatformMutation> {
    if (this.releaseTimeouts > 0) {
      this.releaseTimeouts -= 1;
      throw platformUnavailable("Release acknowledgement lost");
    }
    const userId = this.requireSession(sessionToken);
    const r = this.reservations.get(reservationId);
    const wallet = this.ensureWallet(userId);
    if (!r) throw new PlatformError(404, "NOT_FOUND", "Reservation not found");
    if (r.status === "released") return { reservation: this.view(r, wallet), reused: true };
    if (r.status !== "reserved") {
      throw new PlatformError(409, "RESERVATION_CONFLICT", "Cannot release committed reservation");
    }
    r.status = "released";
    wallet.available += r.amount;
    wallet.reserved -= r.amount;
    return { reservation: this.view(r, wallet), reused: false };
  }

  async revokeSession(sessionToken: string): Promise<void> {
    this.sessions.delete(sessionToken);
  }

  private view(
    r: MockReservation,
    wallet: { available: number; reserved: number },
  ): PlatformMutation["reservation"] {
    return {
      reservationId: r.reservationId,
      requestId: r.requestId,
      operation: r.operation,
      amount: r.amount,
      status: r.status,
      availableBalance: wallet.available,
      reservedBalance: wallet.reserved,
    };
  }
}
