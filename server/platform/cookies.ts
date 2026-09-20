/**
 * First-party session cookie helpers (no cookie-parser dependency).
 * Cookie: `holodilnik_session=<opaque Platform token>` (configurable name).
 */

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

export function readSessionCookie(
  headers: { cookie?: string },
  cookieName: string,
): string | undefined {
  const raw = readCookie(headers.cookie, cookieName);
  return raw ? decodeURIComponent(raw) : undefined;
}

export function buildSessionCookie(
  cookieName: string,
  token: string,
  opts: { isProduction: boolean; maxAgeSeconds: number },
): string {
  const parts = [
    `${cookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${Math.max(1, Math.floor(opts.maxAgeSeconds))}`,
    "HttpOnly",
  ];
  if (opts.isProduction) parts.push("Secure");
  // Same-origin backend: Lax is correct (NOT None — see UserPlatform ADR-013).
  parts.push("SameSite=Lax");
  return parts.join("; ");
}

export function buildClearedCookie(cookieName: string, isProduction: boolean): string {
  const parts = [`${cookieName}=`, "Path=/", "Max-Age=0", "HttpOnly"];
  if (isProduction) parts.push("Secure");
  parts.push("SameSite=Lax");
  return parts.join("; ");
}
