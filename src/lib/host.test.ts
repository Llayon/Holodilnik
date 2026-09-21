import { describe, it, expect, afterEach } from "vitest";
import { describeBridge, detectHost, extractStartParam, readHashInitData } from "./host";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)["Telegram"];
  delete (window as unknown as Record<string, unknown>)["WebApp"];
  window.location.hash = "";
});

describe("detectHost (single bridge boundary)", () => {
  it("plain browser → web with no initData", () => {
    expect(detectHost()).toEqual({ name: "web", initData: null, startParam: null });
  });

  it("Telegram WebApp initData → telegram", () => {
    (window as unknown as Record<string, unknown>)["Telegram"] = {
      WebApp: { initData: "user=%7B%7D&auth_date=123&hash=abc&start_param=fridge_scan" },
    };
    const host = detectHost();
    expect(host.name).toBe("telegram");
    expect(host.startParam).toBe("fridge_scan");
  });

  it("MAX WebApp initData → max", () => {
    (window as unknown as Record<string, unknown>)["WebApp"] = {
      initData: "user=%7B%7D&auth_date=123&hash=abc",
    };
    expect(detectHost().name).toBe("max");
  });

  it("Telegram wins when both bridges exist", () => {
    (window as unknown as Record<string, unknown>)["Telegram"] = { WebApp: { initData: "a=1" } };
    (window as unknown as Record<string, unknown>)["WebApp"] = { initData: "b=2" };
    const host = detectHost();
    expect(host.name).toBe("telegram");
    expect(host.initData).toBe("a=1");
  });

  it("empty initData is ignored", () => {
    (window as unknown as Record<string, unknown>)["Telegram"] = { WebApp: { initData: "" } };
    expect(detectHost().name).toBe("web");
  });
});

describe("describeBridge (presence/length only, never content)", () => {
  it("reports absence in plain browsers", () => {
    expect(describeBridge()).toEqual({
      hasTelegram: false,
      hasWebApp: false,
      initDataLen: -1,
      hasMax: false,
      maxInitDataLen: -1,
      hashLen: -1,
    });
  });

  it("reports presence and length inside Telegram", () => {
    (window as unknown as Record<string, unknown>)["Telegram"] = {
      WebApp: { initData: "a=1&b=22" },
    };
    expect(describeBridge()).toEqual({
      hasTelegram: true,
      hasWebApp: true,
      initDataLen: 8,
      hasMax: false,
      maxInitDataLen: -1,
      hashLen: -1,
    });
  });
});

describe("WebK hash fallback (no bridge script yet)", () => {
  it("uses tgWebAppData from location.hash as telegram initData", () => {
    window.location.hash = "#tgWebAppData=user%3D1%26hash%3Dabc&tgWebAppVersion=8.0";
    const host = detectHost();
    expect(host.name).toBe("telegram");
    expect(host.initData).toBe("user=1&hash=abc");
  });

  it("bridge wins over hash when both exist", () => {
    (window as unknown as Record<string, unknown>)["Telegram"] = {
      WebApp: { initData: "a=1" },
    };
    window.location.hash = "#tgWebAppData=b%3D2";
    expect(detectHost().initData).toBe("a=1");
  });

  it("ignores empty hash data", () => {
    window.location.hash = "#tgWebAppVersion=8.0";
    expect(readHashInitData()).toBeNull();
    expect(detectHost().name).toBe("web");
  });
});

describe("extractStartParam (unsigned metadata only)", () => {
  it("parses start_param and caps length", () => {
    expect(extractStartParam("a=1&start_param=hello")).toBe("hello");
    expect(extractStartParam(null)).toBeNull();
    expect(extractStartParam("a=1")).toBeNull();
    expect(extractStartParam(`a=1&start_param=${"x".repeat(600)}`)).toBeNull();
  });
});
