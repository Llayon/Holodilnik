export const DEVICE_STORAGE_KEY = "holodilnik_device_id";
export const DEVICE_HEADER = "X-Holodilnik-Device-Id";

/** Get or create a random anonymous installation ID (no fingerprinting). */
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (existing && isPlausibleDeviceId(existing)) return existing;
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      localStorage.setItem(DEVICE_STORAGE_KEY, fresh);
    } catch {
      // storage unavailable (private mode) — still return ephemeral ID
    }
    return fresh;
  } catch {
    return `ephemeral-${Date.now()}`;
  }
}

function isPlausibleDeviceId(v: string): boolean {
  if (!v || v.length < 8 || v.length > 128) return false;
  return /^[A-Za-z0-9_\-:]+$/.test(v);
}
