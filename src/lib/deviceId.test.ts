import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDeviceId, DEVICE_STORAGE_KEY } from "./deviceId";

describe("deviceId", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("creates a random ID and persists in localStorage", () => {
    const id = getDeviceId();
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(localStorage.getItem(DEVICE_STORAGE_KEY)).toBe(id);
    const again = getDeviceId();
    expect(again).toBe(id);
  });

  it("creates UUID-like IDs when available", () => {
    const id = getDeviceId();
    expect(id).toMatch(/^[A-Za-z0-9_\-:]+$/);
  });

  it("recovers from corrupt stored value", () => {
    localStorage.setItem(DEVICE_STORAGE_KEY, "x");
    const id = getDeviceId();
    expect(id).not.toBe("x");
    expect(id.length).toBeGreaterThanOrEqual(8);
  });
});
