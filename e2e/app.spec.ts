import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Valid small JPEG for e2e — must be decodable by browser canvas (after client compression)
// and >500 bytes to pass server's tiny-image guard. Using sharp if available.

async function createTempImage(filename = "fridge-test.png"): Promise<string> {
  const filePath = path.join(process.cwd(), filename);
  try {
    const { default: sharp } = await import("sharp");
    // Create a realistic 800×600 fridge-like JPEG (~8-15KB, valid, decodable)
    const svg = `<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f5f5f0"/><rect x="40" y="40" width="720" height="160" rx="12" fill="#ff3b30"/><rect x="60" y="240" width="340" height="140" rx="8" fill="#34c759"/><rect x="430" y="240" width="310" height="140" rx="8" fill="#ffcc02"/><text x="120" y="130" font-size="24" fill="white" font-family="sans-serif">Test fridge</text></svg>`;
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 80, mozjpeg: true })
      .toFile(filePath);
    return filePath;
  } catch {
    // Fallback: tiny 1x1 png padded to >500 bytes but still decodable?
    // Create 6KB buffer with valid 1x1 PNG header + readable tail (browser may still decode header)
    const TINY_PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    const base = Buffer.from(TINY_PNG_BASE64, "base64");
    // Instead of random bytes, repeat base to keep PNG chunks valid-ish? Use sharp fallback if needed.
    // Write at least 600 bytes OF valid PNG — use base as is and rely on server mock (will still need decode)
    // For fallback, just write base (67 bytes) - e2e will handle compression failure by fallback? Better ensure >500 via valid large PNG.
    // As last resort, write base repeated 10 times — browser will decode first PNG and ignore trailing? Most decoders ignore trailing.
    const buf = Buffer.concat(Array.from({ length: 10 }, () => base));
    fs.writeFileSync(filePath, buf);
    return filePath;
  }
}

test.describe("Holodilnik vertical slice (MOCK)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("landing shows single CTA", async ({ page }) => {
    await expect(page.getByTestId("landing")).toBeVisible();
    await expect(page.getByTestId("cta-camera")).toBeVisible();
    await expect(page.getByTestId("cta-upload")).toBeVisible();
    await expect(page.getByText("Покажи холодильник")).toBeVisible();
    await expect(page.getByTestId("provider-badge")).toContainText(/MOCK|LIVE/, { timeout: 10000 });
  });

  test("full flow: upload -> analyze -> ingredients -> 3 recipes -> detail", async ({ page }) => {
    const imgPath = await createTempImage("test-fridge.png");

    // upload via secondary input
    const fileInput = page.getByTestId("input-upload");
    await fileInput.setInputFiles(imgPath);

    // compression is client-side (brief "Подготавливаю фото…" then photo)
    // wait for photo step (allow preparing intermediate)
    await expect(page.getByTestId("photo-step")).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId("analyze-btn")).toBeVisible();

    // trigger analyze
    await page.getByTestId("analyze-btn").click();

    // analyzing
    await expect(page.getByTestId("analyzing")).toBeVisible();
    await expect(page.getByText("Смотрю, что у тебя есть")).toBeVisible();

    // ingredient confirmation
    await expect(page.getByTestId("ingredients-step")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Вот что я нашёл")).toBeVisible();

    // ingredients list should have eggs etc from mock
    await expect(page.getByTestId("ingredients-list")).toBeVisible();
    await expect(page.getByTestId("chip-egg")).toBeVisible();
    await expect(page.getByTestId("chip-tomato")).toBeVisible();

    // uncertain items
    await expect(page.getByTestId("uncertain-section")).toBeVisible();
    // add uncertain
    await page.getByTestId("add-uncertain-yogurt").click();
    await expect(page.getByTestId("chip-yogurt")).toBeVisible();
    await expect(
      page.getByTestId("uncertain-section").getByTestId("add-uncertain-yogurt"),
    ).toHaveCount(0);

    // remove ingredient
    await page.getByTestId("remove-cheese").click();
    await expect(page.getByTestId("chip-cheese")).toHaveCount(0);

    // add custom
    await page.getByTestId("add-input").fill("лук");
    await page.getByTestId("add-btn").click();
    await expect(page.getByTestId("chip-onion")).toBeVisible();

    // add via suggest
    await page.getByTestId("suggest-mushroom").click();
    await expect(page.getByTestId("chip-mushroom")).toBeVisible();

    // go to recommendations
    await page.getByTestId("to-recs").click();

    await expect(page.getByTestId("recommendations")).toBeVisible({ timeout: 10000 });
    // exactly 3 cards
    await expect(page.getByTestId("recipe-card-fastest")).toBeVisible();
    await expect(page.getByTestId("recipe-card-normal")).toBeVisible();
    await expect(page.getByTestId("recipe-card-from_what_exists")).toBeVisible();

    // check slot labels
    await expect(page.getByText("САМОЕ БЫСТРОЕ")).toBeVisible();
    await expect(page.getByText("НОРМАЛЬНЫЙ УЖИН")).toBeVisible();
    await expect(page.getByText("ИЗ ТОГО, ЧТО ЕСТЬ")).toBeVisible();

    // open recipe detail
    await page.getByTestId("recipe-card-fastest").click();
    await expect(page.getByTestId("recipe-detail")).toBeVisible();
    await expect(page.getByTestId("step-0")).toBeVisible();
    // back
    await page.getByTestId("back-to-recs").click();
    await expect(page.getByTestId("recommendations")).toBeVisible();
  });

  test("ingredient addition via suggest and custom input works", async ({ page }) => {
    const imgPath = await createTempImage("test-fridge2.png");
    await page.getByTestId("input-upload").setInputFiles(imgPath);
    await expect(page.getByTestId("photo-step")).toBeVisible({ timeout: 8000 });
    await page.getByTestId("analyze-btn").click();
    await expect(page.getByTestId("ingredients-step")).toBeVisible({ timeout: 10000 });

    const initialCount = await page.getByTestId("ingredients-list").locator(".chip").count();

    // add via input
    await page.getByTestId("add-input").fill("картофель");
    await page.getByTestId("add-btn").click();
    await expect(page.getByTestId("chip-potato")).toBeVisible();

    const afterCount = await page.getByTestId("ingredients-list").locator(".chip").count();
    expect(afterCount).toBe(initialCount + 1);

    // removing restores?
    await page.getByTestId("remove-potato").click();
    await expect(page.getByTestId("chip-potato")).toHaveCount(0);
  });

  test("error handling: API failure shows banner and keeps image", async ({ page }) => {
    // Intercept analyze to return 429
    await page.route("**/api/fridge/analyze", async (route) => {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "Превышен лимит", code: "RATE_LIMITED" }),
      });
    });

    const imgPath = await createTempImage("test-fridge3.png");
    await page.getByTestId("input-upload").setInputFiles(imgPath);
    await expect(page.getByTestId("photo-step")).toBeVisible({ timeout: 8000 });
    await page.getByTestId("analyze-btn").click();

    // should return to photo step with error
    await expect(page.getByTestId("photo-step")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("error-banner")).toBeVisible();
    await expect(page.getByText("Превышен лимит")).toBeVisible();
    // image still visible
    await expect(page.locator(".photo-preview img")).toBeVisible();
  });

  test("mobile layout 390px width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("landing")).toBeVisible();
    // CTA should be visible and not overflow
    const cta = page.getByTestId("cta-camera");
    await expect(cta).toBeVisible();
    const box = await cta.boundingBox();
    expect(box?.width).toBeGreaterThan(300);
    expect(box?.width).toBeLessThan(390);

    // check header mock badge
    await expect(page.getByTestId("provider-badge")).toBeVisible();
  });

  test("mobile layout 360px and 430px", async ({ page }) => {
    for (const w of [360, 430]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.reload();
      await expect(page.getByTestId("landing")).toBeVisible();
      await expect(page.getByTestId("cta-camera")).toBeVisible();
    }
  });
});
