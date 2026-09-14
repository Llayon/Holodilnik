#!/usr/bin/env tsx
/**
 * Compress user fridge photos from phone (often 10MB+) to JPG <5M and within 6000x6000 for Z.AI (5M limit) and 8M app limit.
 * Usage:
 *   npx tsx scripts/compress-fridge-photo.ts input.jpg [output.jpg]
 *   npx tsx scripts/compress-fridge-photo.ts --dir tmp --out tmp/compressed
 *   npx tsx scripts/compress-fridge-photo.ts --gauntlet  # compresses tmp/*.png to tmp/vision-gauntlet/input/*.jpg
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

const MAX_BYTES = 5 * 1024 * 1024; // 5M for Z.AI
const APP_MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIM = 6000;
const TARGET_DIM = 1920; // for phone photos, reduce to 1920 on longest side for faster inference
const JPEG_QUALITY = 80;

async function compressOne(
  inputPath: string,
  outputPath: string,
): Promise<{ outPath: string; bytes: number; dims: string; sha256: string }> {
  const img = sharp(inputPath);
  const meta = await img.metadata();
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;
  const needResize = origW > MAX_DIM || origH > MAX_DIM || origW > TARGET_DIM || origH > TARGET_DIM;
  let pipeline = img;
  if (needResize) {
    // Resize to fit within TARGET_DIM, keep aspect
    pipeline = pipeline.resize({
      width: TARGET_DIM,
      height: TARGET_DIM,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  // Convert to JPEG with quality 80, mozjpeg
  const buffer = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
  // If still >5M, reduce quality further
  let outBuf = buffer;
  let q = JPEG_QUALITY;
  while (outBuf.length > MAX_BYTES && q > 50) {
    q -= 10;
    outBuf = await sharp(buffer).jpeg({ quality: q, mozjpeg: true }).toBuffer();
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outBuf);
  const outMeta = await sharp(outBuf).metadata();
  const hash = crypto.createHash("sha256").update(outBuf).digest("hex");
  return {
    outPath: outputPath,
    bytes: outBuf.length,
    dims: `${outMeta.width}x${outMeta.height}`,
    sha256: hash,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--gauntlet")) {
    // Compress the 5 PNGs in tmp to vision-gauntlet/input as JPGs for gauntlet A/B/C
    const srcDir = path.resolve("tmp");
    const outDir = path.resolve("tmp/vision-gauntlet/input");
    fs.mkdirSync(outDir, { recursive: true });
    const files = fs
      .readdirSync(srcDir)
      .filter((f) => f.endsWith(".png") && f.match(/^[0-9a-f-]{36}\.png$/));
    if (files.length < 3) {
      console.error(
        `Found only ${files.length} png in tmp, need at least 3 for gauntlet. Place images in tmp/vision-gauntlet/input manually.`,
      );
      process.exit(1);
    }
    // Select 3 meaningfully different for A/B/C per spec
    // A: easy (cucumbers, pepper, eggs, cheese) -> 455f69f9...
    // B: ambiguous (lime vs green apple) -> fda5d328...
    // C: difficult (mushrooms, many items) -> 0209d3ee...
    const selection: Record<string, string> = {
      "455f69f9-b783-4e16-ada6-44390a99cb1b.png": "image-a.jpg", // A ordinary/easy
      "fda5d328-d13a-4568-867b-316ffcc3255b.png": "image-b.jpg", // B ambiguous
      "0209d3ee-2f89-4826-a6b4-20dd3677e6e1.png": "image-c.jpg", // C difficult
    };
    for (const [srcName, outName] of Object.entries(selection)) {
      const srcPath = path.join(srcDir, srcName);
      if (!fs.existsSync(srcPath)) {
        console.warn(`Missing ${srcName}, skipping`);
        continue;
      }
      const outPath = path.join(outDir, outName);
      const res = await compressOne(srcPath, outPath);
      console.log(
        `${srcName} -> ${outName} | ${res.dims} | ${res.bytes} bytes | SHA256 ${res.sha256}`,
      );
    }
    console.log(`Done. Gauntlet inputs in ${outDir}`);
    // Also copy fridge.jpg baseline for reference but not as gauntlet image
    const fridgeSrc = path.resolve("tmp/fridge.jpg");
    if (fs.existsSync(fridgeSrc)) {
      const fridgeHash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(fridgeSrc))
        .digest("hex");
      console.log(
        `Baseline tmp/fridge.jpg | SHA256 ${fridgeHash} | NOT used as gauntlet image (per spec)`,
      );
    }
    // Record all 3
    const inputs = fs.readdirSync(outDir).filter((f) => f.endsWith(".jpg"));
    for (const f of inputs) {
      const p = path.join(outDir, f);
      const buf = fs.readFileSync(p);
      const meta = await sharp(buf).metadata();
      const hash = crypto.createHash("sha256").update(buf).digest("hex");
      console.log(`INPUT ${f} | ${meta.width}x${meta.height} | ${buf.length} bytes | ${hash}`);
    }
    return;
  }

  if (args.includes("--dir")) {
    const dirIdx = args.indexOf("--dir");
    const outIdx = args.indexOf("--out");
    const dir = args[dirIdx + 1];
    const outDir = outIdx !== -1 ? args[outIdx + 1] : dir + "/compressed";
    const files = fs.readdirSync(dir).filter((f) => /\.(jpg|jpeg|png|webp|heic|heif)$/i.test(f));
    for (const f of files) {
      const src = path.join(dir, f);
      const out = path.join(outDir, path.parse(f).name + ".jpg");
      const res = await compressOne(src, out);
      console.log(`${f} -> ${out} | ${res.dims} | ${res.bytes}`);
    }
    return;
  }

  const input = args[0];
  const output =
    args[1] ?? path.join(path.dirname(input), path.parse(input).name + ".compressed.jpg");
  if (!input) {
    console.log("Usage: npx tsx scripts/compress-fridge-photo.ts input.jpg [output.jpg]");
    console.log("       npx tsx scripts/compress-fridge-photo.ts --gauntlet");
    console.log("       npx tsx scripts/compress-fridge-photo.ts --dir tmp --out tmp/compressed");
    process.exit(1);
  }
  const res = await compressOne(input, output);
  console.log(
    `Compressed ${input} -> ${res.outPath} | ${res.dims} | ${res.bytes} bytes | SHA256 ${res.sha256}`,
  );
  if (res.bytes > APP_MAX_BYTES) console.warn(`Still >8M, consider lower quality`);
  if (res.bytes > MAX_BYTES) console.warn(`Still >5M, Z.AI may reject, lower quality further`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
