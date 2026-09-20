import { PlatformClient, type IPlatformClient } from "./client.js";
import { MockPlatformClient } from "./mock.js";
import { config, isProduction } from "../config.js";

/**
 * Platform client factory (server-only).
 *
 * - Production without a service token → throws at call time (fail-closed;
 *   routes surface 503, never anonymous AI for TG/MAX).
 * - Non-production without a service token → deterministic mock (dev/tests).
 * - Tests inject their own client (mock or fetch-stubbed real client).
 */
export function getPlatformClient(): IPlatformClient {
  const token = config.userPlatformServiceToken;
  if (token) {
    return new PlatformClient({
      baseUrl: config.userPlatformUrl,
      getServiceToken: () => config.userPlatformServiceToken || undefined,
    });
  }
  if (isProduction()) {
    // Fail closed: never silently run TG/MAX traffic without service auth.
    return new PlatformClient({
      baseUrl: config.userPlatformUrl,
      getServiceToken: () => undefined,
    });
  }
  return new MockPlatformClient();
}

export type { IPlatformClient };
export { PlatformClient, MockPlatformClient };
export * from "./types.js";
export * from "./errors.js";
