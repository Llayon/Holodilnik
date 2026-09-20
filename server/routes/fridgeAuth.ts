import type { Request, Response } from "express";
import { config } from "../config.js";
import { VisionProviderChain } from "../providers/router.js";
import { getVisionCache } from "../cache.js";
import { checkAuthVisionLimits, getClientIp, recordAuthVisionUsage } from "../rateLimit.js";
import { PlatformError } from "../platform/errors.js";
import type { IPlatformClient } from "../platform/client.js";
import type { SettledScan } from "../platform/settlement.js";
import { recallSettlement, runExclusive, storeSettlement } from "../platform/settlement.js";
import { requestPlatformClient, requestPlatformSession } from "./platform.js";
import type { FridgeAnalysisResult } from "../../shared/types.js";

export const SCAN_OPERATION = "fridge.scan";
export const INSUFFICIENT_MESSAGE = "Кредиты закончились — новые начисления скоро появятся.";
export const PLATFORM_DOWN_MESSAGE = "Сервис аккаунта временно недоступен";
export const AUTH_ABUSE_MESSAGE = "Слишком много запросов за сегодня. Попробуйте завтра.";
export const COMMIT_UNCERTAIN_MESSAGE =
  "Не удалось подтвердить списание — повторите запрос, повторная оплата не спишется.";

interface ScanCtx {
  base64Part: string;
  effectiveMime: string;
  clientRequestId: string | undefined;
  requestLogId: string;
  startedAt: number;
}

/**
 * Authenticated scan pipeline (Gauntlet 2, ADR-045):
 * validate (done by caller) → session → requestId → abuse check → reserve →
 * cache/AI → commit (usable result incl. confident NO_FOOD) / release
 * (technical failure). Never calls AI before a successful reserve.
 */
export async function handleAuthenticatedScan(
  req: Request,
  res: Response,
  ctx: ScanCtx,
): Promise<Response> {
  const token = requestPlatformSession(req);
  if (!token) {
    return res
      .status(401)
      .json({ error: "Сессия истекла — войдите заново", code: "SESSION_EXPIRED" });
  }
  const client = requestPlatformClient(req);

  // 1. Session → user (also fails closed when Platform is down).
  let userId: string;
  try {
    const me = await client.getMe(token);
    userId = me.userId;
  } catch (err) {
    return res.status(platformStatus(err)).json(platformBody(err));
  }

  // 2. Client billing key is mandatory in auth mode (never server-invented).
  if (!ctx.clientRequestId) {
    return res.status(400).json({ error: "Missing requestId", code: "MISSING_REQUEST_ID" });
  }
  const platformRequestId = `${SCAN_OPERATION}:${ctx.clientRequestId}`;

  // 3. Settlement replay: same requestId after a lost acknowledgement reuses
  // the finished scan (idempotent commit retry, no AI rerun, no new charge).
  const replay = recallSettlement(platformRequestId);
  if (replay) {
    try {
      const settled = await client.commit(token, replay.reservationId);
      const withBalance: SettledWithBalance = {
        ...replay,
        available: settled.reservation.availableBalance,
        reserved: settled.reservation.reservedBalance,
      };
      if (withBalance.empty) {
        return res.status(422).json({
          error: "No recognizable food found",
          code: "NO_FOOD_DETECTED",
          data: withBalance.result,
          meta: successMeta(withBalance),
        });
      }
      return res.json({ data: withBalance.result, meta: successMeta(withBalance) });
    } catch (err) {
      if (err instanceof PlatformError && err.code === "PLATFORM_UNAVAILABLE") {
        return res.status(503).json({
          error: COMMIT_UNCERTAIN_MESSAGE,
          code: "COMMIT_UNCERTAIN",
          requestId: ctx.clientRequestId,
        });
      }
      // Already settled differently (e.g. racing duplicate): the single
      // charge stands; return the stored result without invented balances.
      if (err instanceof PlatformError && (err.status === 404 || err.status === 409)) {
        const withoutBalance: SettledWithBalance = { ...replay };
        if (withoutBalance.empty) {
          return res.status(422).json({
            error: "No recognizable food found",
            code: "NO_FOOD_DETECTED",
            data: withoutBalance.result,
            meta: successMeta(withoutBalance),
          });
        }
        return res.json({ data: withoutBalance.result, meta: successMeta(withoutBalance) });
      }
      return res.status(platformStatus(err)).json(platformBody(err));
    }
  }

  // 4. Abuse protection (authenticated caps; fail-closed on store outage).
  const ip = getClientIp(req);
  try {
    const limits = await checkAuthVisionLimits({ userId, ip });
    if (!limits.allowed) {
      console.log(`[vision] rid=${ctx.requestLogId} auth_rate_limited reason=${limits.reason}`);
      return res.status(429).json({ error: AUTH_ABUSE_MESSAGE, code: "DAILY_LIMIT_REACHED" });
    }
  } catch (storeErr) {
    console.error(
      `[vision] rid=${ctx.requestLogId} rate_limit_store_unavailable msg=${String(storeErr).slice(0, 200)}`,
    );
    return res.status(503).json({
      error: "Сервис временно недоступен, попробуйте позже",
      code: "RATE_LIMIT_UNAVAILABLE",
    });
  }

  // 5. Reserve BEFORE any AI work. Same requestId → same reservation.
  let reservationId: string;
  try {
    const out = await client.reserve(token, {
      operation: SCAN_OPERATION,
      requestId: platformRequestId,
    });
    reservationId = out.reservation.reservationId;
  } catch (err) {
    if (err instanceof PlatformError && err.code === "INSUFFICIENT_CREDITS") {
      return res.status(402).json({ error: INSUFFICIENT_MESSAGE, code: "INSUFFICIENT_CREDITS" });
    }
    return res.status(platformStatus(err)).json(platformBody(err));
  }

  // 6. One execution per requestId even under retry storms (billing safety
  // holds via idempotent reserve regardless; this avoids AI waste too).
  try {
    const settled = await runExclusive(platformRequestId, () =>
      executeSettlingScan(client, token, reservationId, platformRequestId, ctx, userId, ip),
    );
    if (settled.empty) {
      return res.status(422).json({
        error: "No recognizable food found",
        code: "NO_FOOD_DETECTED",
        data: settled.result,
        meta: successMeta(settled),
      });
    }
    return res.json({ data: settled.result, meta: successMeta(settled) });
  } catch (err) {
    if (err instanceof ScanFailedError) {
      return res.status(err.status).json({ ...err.body, requestId: ctx.clientRequestId });
    }
    return res.status(502).json({ error: "Ошибка анализа изображения", code: "PROVIDER_ERROR" });
  }
}

class ScanFailedError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super("scan failed");
    this.status = status;
    this.body = body;
  }
}

interface SettledWithBalance extends SettledScan {
  available?: number;
  reserved?: number;
}

function chainNames(): { primary: string; fallback: string | undefined } {
  const chain = new VisionProviderChain();
  return { primary: chain.getPrimaryName(), fallback: chain.getFallbackName() };
}

function successMeta(settled: SettledWithBalance): Record<string, unknown> {
  const names = chainNames();
  return {
    provider: settled.provider,
    modelId: settled.modelId,
    cached: settled.cached,
    primary: names.primary,
    fallback: names.fallback,
    balance:
      settled.available !== undefined
        ? { available: settled.available, reserved: settled.reserved ?? 0 }
        : undefined,
    charged: true,
  };
}

async function executeSettlingScan(
  client: IPlatformClient,
  token: string,
  reservationId: string,
  platformRequestId: string,
  ctx: ScanCtx,
  userId: string,
  ip: string | undefined,
): Promise<SettledWithBalance> {
  const chain = new VisionProviderChain();
  const primaryModelId =
    chain.getPrimaryName() === "zai"
      ? config.zaiModelId
      : chain.getPrimaryName() === "groq"
        ? config.groqModelId
        : config.modelId;

  // Cache lookup AFTER reserve: a hit skips AI but the scan is still paid.
  const cachedPrimary = getVisionCache({
    imageBase64: ctx.base64Part,
    provider: chain.getPrimaryName(),
    modelId: primaryModelId,
  });
  let result: FridgeAnalysisResult;
  let provider = chain.getPrimaryName();
  let modelId: string = primaryModelId;
  let cached = false;
  if (cachedPrimary) {
    result = cachedPrimary;
    cached = true;
  } else {
    try {
      const out = await chain.analyze({
        imageBase64: ctx.base64Part,
        mimeType: ctx.effectiveMime,
      });
      result = out.result;
      provider = out.provider;
      modelId = out.modelId;
      cached = out.cached;
    } catch (aiErr) {
      // Technical failure → release (bounded retries on lost acknowledgement).
      await releaseBestEffort(client, token, reservationId, ctx.requestLogId);
      throw new ScanFailedError(...mapVisionFailure(aiErr));
    }
  }

  const empty = result.ingredients.length === 0 && result.uncertainItems.length === 0;
  // Usable result (including confident NO_FOOD) → commit. Only a lost
  // acknowledgement escapes as COMMIT_UNCERTAIN with settlement stored.
  try {
    const committed = await client.commit(token, reservationId);
    try {
      await recordAuthVisionUsage({ userId, ip });
    } catch (storeErr) {
      console.error(
        `[vision] rid=${ctx.requestLogId} record_usage_failed msg=${String(storeErr).slice(0, 200)}`,
      );
    }
    console.log(
      `[vision] rid=${ctx.requestLogId} auth committed provider=${provider} cached=${cached} empty=${empty} latency=${Date.now() - ctx.startedAt}ms`,
    );
    const settled: SettledWithBalance = {
      result,
      provider,
      modelId,
      cached,
      reservationId,
      empty,
      available: committed.reservation.availableBalance,
      reserved: committed.reservation.reservedBalance,
    };
    storeSettlement(platformRequestId, settled);
    return settled;
  } catch (err) {
    if (err instanceof PlatformError && err.code === "PLATFORM_UNAVAILABLE") {
      // AI succeeded but settlement is uncertain: store and ask for a retry
      // with the SAME requestId (replay path settles without AI rerun).
      storeSettlement(platformRequestId, {
        result,
        provider,
        modelId,
        cached,
        reservationId,
        empty,
      });
      throw new ScanFailedError(503, {
        error: COMMIT_UNCERTAIN_MESSAGE,
        code: "COMMIT_UNCERTAIN",
      });
    }
    if (err instanceof PlatformError && (err.status === 404 || err.status === 409)) {
      // Already settled (e.g. racing duplicate): single charge happened;
      // balances refresh client-side via /me (no invented numbers here).
      const settled: SettledWithBalance = {
        result,
        provider,
        modelId,
        cached,
        reservationId,
        empty,
      };
      storeSettlement(platformRequestId, settled);
      return settled;
    }
    throw new ScanFailedError(platformStatus(err), platformBody(err));
  }
}

async function releaseBestEffort(
  client: IPlatformClient,
  token: string,
  reservationId: string,
  logId: string,
  attempts = 3,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await client.release(token, reservationId);
      return;
    } catch (err) {
      // Already released/committed concurrently → nothing to do.
      if (err instanceof PlatformError && (err.status === 404 || err.status === 409)) return;
      if (i === attempts - 1) {
        // Residual: reservation may stay `reserved`; the Platform stale
        // sweeper recovers it. Never loop forever, never hide the AI error.
        console.error(`[vision] rid=${logId} release_failed_after_retries`);
      }
    }
  }
}

function mapVisionFailure(err: unknown): [number, Record<string, unknown>] {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof PlatformError) {
    return [platformStatus(err), platformBody(err)];
  }
  const lower = message.toLowerCase();
  if (
    lower.includes("quota") ||
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.includes("503") ||
    lower.includes("unavailable") ||
    lower.includes("high demand")
  ) {
    return [
      429,
      {
        error: "Превышен лимит запросов — подождите 20-30 секунд и попробуйте снова",
        code: "RATE_LIMITED",
      },
    ];
  }
  if (message.includes("Invalid JSON") || message.includes("parse")) {
    return [
      502,
      {
        error: "Не удалось распознать изображение, попробуйте ещё раз",
        code: "INVALID_PROVIDER_RESPONSE",
      },
    ];
  }
  return [502, { error: "Ошибка анализа изображения", code: "PROVIDER_ERROR" }];
}

function platformStatus(err: unknown): number {
  if (err instanceof PlatformError) return err.status;
  return 500;
}

function platformBody(err: unknown): { error: string; code: string } {
  if (err instanceof PlatformError) {
    if (err.code === "SESSION_EXPIRED")
      return { error: "Сессия истекла — войдите заново", code: "SESSION_EXPIRED" };
    if (err.code === "SESSION_FORBIDDEN")
      return { error: "Операция недоступна", code: "FORBIDDEN" };
    if (err.code === "PLATFORM_UNAVAILABLE")
      return { error: PLATFORM_DOWN_MESSAGE, code: "PLATFORM_UNAVAILABLE" };
    return { error: "Ошибка сервиса аккаунта", code: "PLATFORM_ERROR" };
  }
  return { error: "Internal server error", code: "INTERNAL_ERROR" };
}
