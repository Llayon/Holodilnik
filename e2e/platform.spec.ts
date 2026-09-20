import { test, expect } from "@playwright/test";
import { createTempImage, fakeTelegramInitData } from "./helpers.js";

/**
 * UserPlatform integration E2E (mock Platform + mock vision, zero quota).
 * The dev server runs with PLATFORM_INTEGRATION_ENABLED=true (see
 * playwright.config.ts webServer env); no service token is configured so the
 * shared mock Platform client answers. Each test isolates via
 * POST /api/platform/dev/reset + a unique fake Telegram user.
 */

async function telegramPage(page: import("@playwright/test").Page, userId: number) {
  await page.addInitScript((initData: string) => {
    (window as unknown as Record<string, unknown>)["Telegram"] = { WebApp: { initData } };
  }, fakeTelegramInitData(userId));
}

async function platformReset(request: import("@playwright/test").APIRequestContext) {
  const res = await request.post("/api/platform/dev/reset");
  expect(res.ok()).toBeTruthy();
}

test.describe("platform integration (mock)", () => {
  test.beforeEach(async ({ request }) => {
    await platformReset(request);
  });

  test("anonymous web: no balance chip, legacy flow works", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("landing")).toBeVisible();
    await expect(page.getByTestId("balance-chip")).toHaveCount(0);

    const imgPath = await createTempImage("test-platform-anon.png");
    await page.getByTestId("input-upload").setInputFiles(imgPath);
    await expect(page.getByTestId("photo-step")).toBeVisible({ timeout: 8000 });
    await page.getByTestId("analyze-btn").click();
    await expect(page.getByTestId("ingredients-step")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("balance-chip")).toHaveCount(0);
  });

  test("telegram mock: 10 → scan → 9 with client requestId", async ({ page }) => {
    await telegramPage(page, 9001);
    let seenRequestId = "";
    await page.route("**/api/fridge/analyze", async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as { requestId?: string };
      seenRequestId = String(body.requestId ?? "");
      await route.continue();
    });
    await page.goto("/");
    await expect(page.getByTestId("balance-chip")).toContainText("10 AI-кредитов", {
      timeout: 10000,
    });

    const imgPath = await createTempImage("test-platform-tg.png");
    await page.getByTestId("input-upload").setInputFiles(imgPath);
    await expect(page.getByTestId("photo-step")).toBeVisible({ timeout: 8000 });
    await page.getByTestId("analyze-btn").click();
    await expect(page.getByTestId("ingredients-step")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("balance-chip")).toContainText("9 AI-кредитов");
    expect(seenRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("zero credits: scan denied with Russian state, no crash", async ({ page }) => {
    await telegramPage(page, 9002);
    await page.route("**/api/platform/exchange", async (route) => {
      const headers = {
        ...route.request().headers(),
        "x-platform-mock": '{"reset":true,"initialBalance":0}',
      };
      await route.continue({ headers });
    });
    await page.goto("/");
    await expect(page.getByTestId("balance-chip")).toContainText("0 AI-кредитов", {
      timeout: 10000,
    });

    const imgPath = await createTempImage("test-platform-zero.png");
    await page.getByTestId("input-upload").setInputFiles(imgPath);
    await expect(page.getByTestId("photo-step")).toBeVisible({ timeout: 8000 });
    await page.getByTestId("analyze-btn").click();
    await expect(page.getByTestId("photo-step")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("error-banner")).toContainText("Кредиты закончились");
  });

  test("platform outage: retryable auth error, recovery on retry", async ({ page }) => {
    await telegramPage(page, 9003);
    let failExchange = true;
    await page.route("**/api/platform/exchange", async (route) => {
      // The mock flag is sticky on the shared mock: explicitly set it every
      // time (fail on first boot, clear on retry).
      const scenario = failExchange
        ? '{"reset":true,"exchangeFail":true}'
        : '{"exchangeFail":false}';
      const headers = { ...route.request().headers(), "x-platform-mock": scenario };
      await route.continue({ headers });
    });
    await page.goto("/");
    await expect(page.getByTestId("auth-error")).toBeVisible({ timeout: 10000 });
    failExchange = false;
    await page.getByTestId("auth-retry").click();
    await expect(page.getByTestId("landing")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("balance-chip")).toContainText("AI-кредит", { timeout: 10000 });
  });

  test("authenticated viewports 360/390/430: no overflow, chip visible", async ({ page }) => {
    await telegramPage(page, 9004);
    await page.goto("/");
    await expect(page.getByTestId("balance-chip")).toBeVisible({ timeout: 10000 });
    for (const w of [360, 390, 430]) {
      await page.setViewportSize({ width: w, height: 800 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      await expect(page.getByTestId("balance-chip")).toBeVisible();
    }
  });
});
