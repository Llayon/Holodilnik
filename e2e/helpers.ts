import fs from "node:fs";
import path from "node:path";

/**
 * Valid small JPEG for e2e — must be decodable by browser canvas (after
 * client compression) and >500 bytes to pass the server's tiny-image guard.
 */
export async function createTempImage(filename = "fridge-test.png"): Promise<string> {
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
    const TINY_PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    const base = Buffer.from(TINY_PNG_BASE64, "base64");
    const buf = Buffer.concat(Array.from({ length: 10 }, () => base));
    fs.writeFileSync(filePath, buf);
    return filePath;
  }
}

/** Fake Telegram Mini App bridge payload (signature never checked client-side). */
export function fakeTelegramInitData(userId = 4242): string {
  const user = encodeURIComponent(JSON.stringify({ id: userId, first_name: "E2E" }));
  return `user=${user}&auth_date=${Math.floor(Date.now() / 1000)}&hash=fake`;
}
