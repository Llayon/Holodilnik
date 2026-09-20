import { DEVICE_HEADER, getDeviceId } from "./deviceId";
import type { HostName } from "./host";

export type AuthState = "booting" | "authenticated" | "anonymous" | "auth-error";

export interface PlatformBalance {
  available: number;
  reserved: number;
}

export interface PlatformAccount {
  authenticated: boolean;
  user: { id: string; status: string };
  isNewUser: boolean;
  balance: PlatformBalance;
  appSlug: string;
}

export interface PlatformApiError {
  message: string;
  code: string;
  status: number;
}

function deviceHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", [DEVICE_HEADER]: getDeviceId() };
}

async function parseError(res: Response, fallback: string): Promise<never> {
  const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  throw {
    message: json.error ?? fallback,
    code: json.code ?? "UNKNOWN",
    status: res.status,
  } as PlatformApiError;
}

export async function getPlatformStatus(): Promise<{ integrationEnabled: boolean }> {
  const res = await fetch("/api/platform/status");
  if (!res.ok) return { integrationEnabled: false };
  return (await res.json()) as { integrationEnabled: boolean };
}

export async function exchangeWithHolodilnik(input: {
  platform: Exclude<HostName, "web">;
  initData: string;
  startParam?: string | null;
}): Promise<PlatformAccount> {
  const res = await fetch("/api/platform/exchange", {
    method: "POST",
    headers: deviceHeaders(),
    body: JSON.stringify({
      platform: input.platform,
      initData: input.initData,
      ...(input.startParam ? { startParam: input.startParam } : {}),
    }),
  });
  if (!res.ok) await parseError(res, "Ошибка входа");
  return (await res.json()) as PlatformAccount;
}

export async function fetchPlatformMe(): Promise<PlatformAccount> {
  const res = await fetch("/api/platform/me");
  if (!res.ok) await parseError(res, "Сессия истекла");
  const json = (await res.json()) as {
    authenticated: boolean;
    user: { id: string; status: string };
    balance: PlatformBalance;
  };
  return {
    authenticated: true,
    user: json.user,
    isNewUser: false,
    balance: json.balance,
    appSlug: "fridge",
  };
}

export async function logoutPlatform(): Promise<void> {
  await fetch("/api/platform/session", { method: "DELETE" }).catch(() => undefined);
}

/** Russian plural for AI credits: 1 AI-кредит, 2 AI-кредита, 5 AI-кредитов. */
export function formatCredits(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} AI-кредит`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} AI-кредита`;
  return `${n} AI-кредитов`;
}

export function humanizePlatformError(e: unknown): string {
  const code = (e as Partial<PlatformApiError> | null)?.code;
  switch (code) {
    case "INSUFFICIENT_CREDITS":
      return "Кредиты закончились — новые начисления скоро появятся.";
    case "PLATFORM_UNAVAILABLE":
      return "Сервис аккаунта временно недоступен. Попробуйте позже.";
    case "SESSION_EXPIRED":
      return "Сессия истекла — войдите заново.";
    case "PLATFORM_DATA_EXPIRED":
      return "Данные платформы устарели — откройте приложение заново.";
    case "INVALID_PLATFORM_DATA":
      return "Не удалось подтвердить вход. Попробуйте позже.";
    default:
      return (e as { message?: string })?.message ?? "Что-то пошло не так. Попробуйте ещё раз.";
  }
}
