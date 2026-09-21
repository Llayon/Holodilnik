/**
 * Host platform abstraction — the ONLY module that touches Mini App bridges.
 * Everything else uses the normalized HostInfo (never window.Telegram etc.).
 */

export type HostName = "telegram" | "max" | "web";

export interface HostInfo {
  name: HostName;
  /** Raw signed initData (server verifies the signature; never trusted here). */
  initData: string | null;
  /** Acquisition metadata extracted from initData (unsigned parse, telemetry only). */
  startParam: string | null;
}

interface TelegramBridge {
  initData?: string;
}

interface MaxBridge {
  initData?: string;
}

function readGlobal(path: string[]): unknown {
  let node: unknown = window;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Unsigned metadata extraction from an initData query string (telemetry only). */
export function extractStartParam(initData: string | null): string | null {
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const v = params.get("start_param") ?? params.get("startapp");
    return v && v.length <= 512 ? v : null;
  } catch {
    return null;
  }
}

export function detectHost(): HostInfo {
  const tg = readGlobal(["Telegram", "WebApp"]) as TelegramBridge | undefined;
  if (tg && typeof tg.initData === "string" && tg.initData.length > 0) {
    return { name: "telegram", initData: tg.initData, startParam: extractStartParam(tg.initData) };
  }
  const max = readGlobal(["WebApp"]) as MaxBridge | undefined;
  if (max && typeof max.initData === "string" && max.initData.length > 0) {
    return { name: "max", initData: max.initData, startParam: extractStartParam(max.initData) };
  }
  return { name: "web", initData: null, startParam: null };
}

/**
 * Safe bridge facts for the `?tgdebug=1` overlay (lengths/presence ONLY —
 * never initData content, never user IDs).
 */
export function describeBridge(): {
  hasTelegram: boolean;
  hasWebApp: boolean;
  initDataLen: number;
  hasMax: boolean;
  maxInitDataLen: number;
} {
  const tg = readGlobal(["Telegram"]) as { WebApp?: unknown } | undefined;
  const webApp = readGlobal(["Telegram", "WebApp"]) as TelegramBridge | undefined;
  const max = readGlobal(["WebApp"]) as MaxBridge | undefined;
  return {
    hasTelegram: !!tg,
    hasWebApp: !!webApp,
    initDataLen: webApp && typeof webApp.initData === "string" ? webApp.initData.length : -1,
    hasMax: !!max,
    maxInitDataLen: max && typeof max.initData === "string" ? max.initData.length : -1,
  };
}
