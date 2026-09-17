import crypto from "node:crypto";
import type { Request } from "express";
import { config } from "./config.js";

/**
 * Anonymous prototype rate limiting.
 *
 * Two layers:
 *  A. per-IP (VISION_IP_DAILY_LIMIT / RECIPE_IP_DAILY_LIMIT)
 *  B. per-device anonymous ID via X-Holodilnik-Device-Id
 *     (VISION_DEVICE_DAILY_LIMIT / RECIPE_DEVICE_DAILY_LIMIT)
 *
 * Privacy: raw IPs / device IDs are never persisted. Keys store only
 * SHA-256 hashes + UTC daily bucket, with TTL slightly above 24h.
 * No images, no base64, no secrets in the store.
 *
 * Semantics:
 *  - Validation (payload, size, mime) happens BEFORE any counter check.
 *  - Cached identical results do NOT consume allowance (no provider call).
 *  - Counters increment only after a successful provider response
 *    (including empty-but-valid 422 NO_FOOD_DETECTED which still used quota).
 *    Provider exceptions do NOT consume device allowance.
 *  - Sequential check-then-increment has a small concurrent-overshoot
 *    window; acceptable for a prototype. Documented, not hidden.
 */

export const DEVICE_HEADER = "x-holodilnik-device-id";
export const DEVICE_STORAGE_KEY = "holodilnik_device_id";

export interface RateLimitStore {
  /** Human-readable adapter name for diagnostics (never secrets). */
  readonly name: string;
  /** True when backed by durable external storage (Redis). */
  readonly isDurable: boolean;
  /** Current count for key (0 when missing/expired). */
  get(key: string): Promise<number>;
  /** Atomically increment and return new count; sets TTL on first creation. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Reset all counters (tests/dev only). */
  clear(): Promise<void>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  readonly name = "memory";
  readonly isDurable = false;
  private counts = new Map<string, { count: number; expiresAt: number }>();

  async get(key: string): Promise<number> {
    const entry = this.counts.get(key);
    if (!entry) return 0;
    if (Date.now() > entry.expiresAt) {
      this.counts.delete(key);
      return 0;
    }
    return entry.count;
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    const entry = this.counts.get(key);
    if (!entry || now > entry.expiresAt) {
      const fresh = { count: 1, expiresAt: now + ttlSeconds * 1000 };
      this.counts.set(key, fresh);
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  async clear(): Promise<void> {
    this.counts.clear();
  }
}

/**
 * Production Redis store via Upstash REST (or Vercel KV-compatible vars).
 * Uses only INCR / GET / EXPIRE over HTTPS, no image data.
 * Env (either pair works, UPSTASH_* takes precedence):
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *   KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV integration)
 */
export class UpstashRedisRateLimitStore implements RateLimitStore {
  readonly name = "upstash-redis";
  readonly isDurable = true;
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
  }

  private async call<T>(path: string, method = "POST"): Promise<T> {
    const res = await fetch(`${this.url}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Redis REST ${res.status}`);
    const json = (await res.json()) as { result?: T };
    return json.result as T;
  }

  async get(key: string): Promise<number> {
    // Fail-closed in production: propagate Redis errors so routes return 503
    // instead of serving unlimited requests. Dev/tests use memory store.
    const raw = await this.call<string | number | null>(`get/${encodeURIComponent(key)}`);
    if (raw === null || raw === undefined) return 0;
    const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : 0;
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.call<number>(`incr/${encodeURIComponent(key)}`);
    // Set TTL only on first creation to keep a fixed UTC-day window
    // (not a sliding window).
    if (count === 1) {
      try {
        await this.call<number>(`expire/${encodeURIComponent(key)}/${ttlSeconds}`);
      } catch (err) {
        console.error("[rateLimit] redis EXPIRE failed:", String(err).slice(0, 200));
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    // No global flush in production; tests use memory store.
    throw new Error("clear() not supported on production Redis store");
  }
}

export function getRedisCredentials(): { url: string; token: string } | null {
  // UPSTASH_* takes precedence; Vercel Upstash integration injects KV_*.
  // Must use read-write TOKEN (not READ_ONLY) for INCR/EXPIRE.
  const resolvedUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const resolvedToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (resolvedUrl && resolvedToken) return { url: resolvedUrl, token: resolvedToken };
  return null;
}

// Singleton store: durable Redis when credentials exist.
// In production there is NO memory fallback — fail closed (throw) so expensive
// AI endpoints return 503 instead of serving unlimited requests across
// ephemeral serverless instances. Dev/tests use memory.
let singleton: RateLimitStore | null = null;

export function getRateLimitStore(): RateLimitStore {
  if (singleton) return singleton;
  const creds = getRedisCredentials();
  if (creds) {
    singleton = new UpstashRedisRateLimitStore(creds.url, creds.token);
    return singleton;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "RATE_LIMIT_STORE_UNAVAILABLE: no UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_URL/TOKEN) in production",
    );
  }
  singleton = new MemoryRateLimitStore();
  return singleton;
}

/** For tests: inject a fresh memory store. */
export function __setRateLimitStoreForTests(store: RateLimitStore): void {
  singleton = store;
}

export function __resetRateLimitStoreForTests(): void {
  singleton = null;
}

// ---------- identifiers ----------

export function getDailyBucket(date = new Date()): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

/** Seconds until next UTC midnight + 1h buffer (fixed-day TTL). */
export function ttlUntilEndOfDaySeconds(now = new Date()): number {
  const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const diffSec = Math.max(1, Math.floor((midnightUtc - now.getTime()) / 1000));
  return diffSec + 3600;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Client IP on Vercel: trust only Vercel-provided headers.
 * Vercel overwrites X-Forwarded-For and does not forward external IPs,
 * so spoofing is prevented by the platform. Canonical source is
 * `x-real-ip` (== first entry of `x-forwarded-for` as set by Vercel proxy).
 * See https://vercel.com/docs/headers/request-headers
 */
export function getClientIp(req: Request): string | undefined {
  const realIp = (req.headers["x-real-ip"] as string | undefined)?.split(",")[0]?.trim();
  if (realIp) return normalizeIp(realIp);
  const forwarded = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  if (forwarded) return normalizeIp(forwarded);
  const vercelForwarded = (req.headers["x-vercel-forwarded-for"] as string | undefined)
    ?.split(",")[0]
    ?.trim();
  if (vercelForwarded) return normalizeIp(vercelForwarded);
  const socketIp =
    (req as unknown as { ip?: string }).ip ??
    (req.socket as unknown as { remoteAddress?: string } | undefined)?.remoteAddress;
  if (socketIp) return normalizeIp(socketIp);
  return undefined;
}

export function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  // Strip brackets from IPv6 literals and port suffix for plain IPv4:port.
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  // Remove :port only when it looks like IPv4:port (single colon).
  const colonCount = (ip.match(/:/g) ?? []).length;
  if (colonCount === 1 && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.split(":")[0];
  // Strip IPv6 zone id (%eth0).
  if (ip.includes("%")) ip = ip.split("%")[0];
  return ip;
}

/**
 * Validate anonymous device ID header.
 * Accepts UUID-like ASCII (crypto.randomUUID output), reasonable length.
 * Returns normalized ID or undefined when missing/malformed (ignored).
 */
export function parseDeviceId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  if (v.length < 8 || v.length > 128) return undefined;
  // Plain ASCII only, no fingerprinting.
  if (/[^\x20-\x7E]/.test(v)) return undefined;
  if (!/^[A-Za-z0-9_\-:]+$/.test(v)) return undefined;
  return v;
}

export function hashIp(ip: string): string {
  return sha256Hex(`ip:${normalizeIp(ip)}`);
}

export function hashDevice(deviceId: string): string {
  return sha256Hex(`device:${deviceId}`);
}

export function visionIpKey(ipHash: string, bucket: string): string {
  return `rate:vision:ip:${ipHash}:${bucket}`;
}
export function visionDeviceKey(deviceHash: string, bucket: string): string {
  return `rate:vision:device:${deviceHash}:${bucket}`;
}
export function recipeIpKey(ipHash: string, bucket: string): string {
  return `rate:recipe:ip:${ipHash}:${bucket}`;
}
export function recipeDeviceKey(deviceHash: string, bucket: string): string {
  return `rate:recipe:device:${deviceHash}:${bucket}`;
}

// ---------- limit checks ----------

export type LimitKind = "vision" | "recipe";

export interface LimitCheck {
  allowed: boolean;
  reason?: "device" | "ip";
  deviceCount?: number;
  ipCount?: number;
}

export const DAILY_LIMIT_MESSAGE =
  "На сегодня лимит тестовых запросов исчерпан. Попробуйте завтра.";

export async function checkLimits(
  kind: LimitKind,
  opts: { ip?: string; deviceId?: string; bucket?: string },
): Promise<LimitCheck> {
  const store = getRateLimitStore();
  const bucket = opts.bucket ?? getDailyBucket();
  const deviceLimit =
    kind === "vision" ? config.visionDeviceDailyLimit : config.recipeDeviceDailyLimit;
  const ipLimit = kind === "vision" ? config.visionIpDailyLimit : config.recipeIpDailyLimit;

  let deviceCount: number | undefined;
  let ipCount: number | undefined;

  if (opts.deviceId) {
    const key =
      kind === "vision"
        ? visionDeviceKey(hashDevice(opts.deviceId), bucket)
        : recipeDeviceKey(hashDevice(opts.deviceId), bucket);
    deviceCount = await store.get(key);
    if (deviceCount >= deviceLimit)
      return { allowed: false, reason: "device", deviceCount, ipCount };
  }
  if (opts.ip) {
    const key =
      kind === "vision"
        ? visionIpKey(hashIp(opts.ip), bucket)
        : recipeIpKey(hashIp(opts.ip), bucket);
    ipCount = await store.get(key);
    if (ipCount >= ipLimit) return { allowed: false, reason: "ip", deviceCount, ipCount };
  }
  return { allowed: true, deviceCount, ipCount };
}

export async function recordUsage(
  kind: LimitKind,
  opts: { ip?: string; deviceId?: string; bucket?: string; ttlSeconds?: number },
): Promise<void> {
  const store = getRateLimitStore();
  const bucket = opts.bucket ?? getDailyBucket();
  const ttl = opts.ttlSeconds ?? ttlUntilEndOfDaySeconds();
  const jobs: Array<Promise<number>> = [];
  if (opts.deviceId) {
    const key =
      kind === "vision"
        ? visionDeviceKey(hashDevice(opts.deviceId), bucket)
        : recipeDeviceKey(hashDevice(opts.deviceId), bucket);
    jobs.push(store.incr(key, ttl));
  }
  if (opts.ip) {
    const key =
      kind === "vision"
        ? visionIpKey(hashIp(opts.ip), bucket)
        : recipeIpKey(hashIp(opts.ip), bucket);
    jobs.push(store.incr(key, ttl));
  }
  await Promise.all(jobs);
}

export function limitExceededResponse() {
  return {
    status: 429 as const,
    body: { error: DAILY_LIMIT_MESSAGE, code: "DAILY_LIMIT_REACHED" as const },
  };
}
