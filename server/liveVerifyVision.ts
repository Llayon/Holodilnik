import fs from "node:fs";
import path from "node:path";
import { config, isGeminiAvailable, isGroqAvailable, isZaiAvailable } from "./config.js";
import { GeminiVisionProvider } from "./providers/geminiVision.js";
import { GroqVisionProvider } from "./providers/groqVision.js";
import { ZaiVisionProvider } from "./providers/zaiVision.js";
import { getVisionCache, setVisionCache } from "./cache.js";
import type { FridgeAnalysisResult } from "../shared/types.js";

type ProviderName = "gemini" | "groq" | "zai";

interface VisionRun {
  provider: ProviderName;
  modelId: string;
  cached: boolean;
  result?: FridgeAnalysisResult;
  error?: string;
  skipped?: boolean;
}

async function runProvider(
  name: ProviderName,
  imageBase64: string,
  mimeType: string,
): Promise<VisionRun> {
  const modelMap: Record<ProviderName, string> = {
    gemini: config.modelId,
    groq: config.groqModelId,
    zai: config.zaiModelId,
  };
  const modelId = modelMap[name];

  // Check cache first
  const cached = getVisionCache({ imageBase64, provider: name, modelId });
  if (cached) {
    console.log(`[liveVision] ${name} cache HIT`);
    return { provider: name, modelId, cached: true, result: cached };
  }

  // Check availability
  const avail =
    (name === "gemini" && isGeminiAvailable()) ||
    (name === "groq" && isGroqAvailable()) ||
    (name === "zai" && isZaiAvailable());
  if (!avail) {
    console.log(`[liveVision] ${name} not available (missing key or mock mode)`);
    return { provider: name, modelId, cached: false, skipped: true, error: "not available" };
  }

  try {
    let provider;
    if (name === "gemini") provider = new GeminiVisionProvider();
    else if (name === "groq") provider = new GroqVisionProvider();
    else provider = new ZaiVisionProvider();
    const res = await provider.analyzeFridgeImage({ imageBase64, mimeType });
    setVisionCache({ imageBase64, provider: name, modelId }, res);
    return { provider: name, modelId, cached: false, result: res };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[liveVision] ${name} failed:`, msg.slice(0, 800));
    return { provider: name, modelId, cached: false, error: msg };
  }
}

function findImage(): { base64: string; mimeType: string; path: string } | undefined {
  const argPath = process.argv.find(
    (a) => a.endsWith(".jpg") || a.endsWith(".png") || a.endsWith(".jpeg") || a.endsWith(".webp"),
  );
  const candidates = [
    argPath,
    "tmp/fridge.jpg",
    "tmp/fridge.png",
    "test-fridge.jpg",
    "public/fridge.jpg",
    "e2e/fixtures/fridge.jpg",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    const full = path.resolve(p);
    if (fs.existsSync(full)) {
      const buf = fs.readFileSync(full);
      if (buf.length < 500 || buf.length > 8 * 1024 * 1024) continue;
      const b64 = buf.toString("base64");
      const mime = p.endsWith(".png")
        ? "image/png"
        : p.endsWith(".webp")
          ? "image/webp"
          : "image/jpeg";
      return { base64: b64, mimeType: mime, path: full };
    }
  }
  return undefined;
}

async function main() {
  console.log("=== Live Tri-Provider Vision Benchmark (cache-aware) ===");
  console.log(`Gemini: ${isGeminiAvailable()} Groq: ${isGroqAvailable()} ZAI: ${isZaiAvailable()}`);
  console.log(
    `Models: gemini=${config.modelId} groq=${config.groqModelId} zai=${config.zaiModelId}`,
  );

  // Allow explicit provider filter via --provider=zai or provider=zai
  const providerArg = process.argv
    .find((a) => a.includes("provider="))
    ?.split("=")[1]
    ?.toLowerCase() as ProviderName | undefined;
  const requested: ProviderName[] =
    providerArg && ["gemini", "groq", "zai"].includes(providerArg)
      ? [providerArg]
      : ["gemini", "groq", "zai"];

  const img = findImage();
  if (!img) {
    console.log("No fridge image found. Place image at tmp/fridge.jpg or pass path:");
    console.log("  npm run test:live:vision -- ./path/to/photo.jpg");
    console.log("  npm run test:live:zai -- ./path/to/photo.jpg");
    console.log("Available providers:", requested.join(", "));
    // Still try recipe-like benchmark? No, vision-only pass
    return;
  }

  console.log(
    `Using image: ${img.path} mime=${img.mimeType} bytes=${Buffer.byteLength(img.base64, "base64")}`,
  );

  const runs: VisionRun[] = [];
  for (const p of requested) {
    const r = await runProvider(p, img.base64, img.mimeType);
    runs.push(r);
    if (r.result) {
      console.log(
        `\n--- ${p.toUpperCase()} (${r.modelId}) ${r.cached ? "[CACHED]" : "[LIVE]"} ---`,
      );
      console.log(`Detected ${r.result.ingredients.length} ingredients:`);
      console.log(
        r.result.ingredients
          .map(
            (i) =>
              ` - ${i.canonicalName} (${i.displayName}) conf=${i.confidence} vis=${i.visibility}`,
          )
          .join("\n") || " (none)",
      );
      if (r.result.uncertainItems.length)
        console.log(
          `Uncertain: ${r.result.uncertainItems.map((u) => `${u.canonicalName}(${u.displayName})`).join(", ")}`,
        );
    } else if (r.error) {
      console.log(`\n--- ${p.toUpperCase()} ERROR ---`);
      console.log(r.error.slice(0, 800));
    } else if (r.skipped) {
      console.log(`\n--- ${p.toUpperCase()} SKIPPED (no key) ---`);
    }
  }

  // Build sanitized comparison artifact
  const byProvider: Record<string, unknown> = {};
  for (const r of runs) {
    if (r.result) {
      byProvider[r.provider] = {
        modelId: r.modelId,
        cached: r.cached,
        ingredients: r.result.ingredients.map((i) => ({
          canonicalName: i.canonicalName,
          displayName: i.displayName,
          confidence: i.confidence,
          visibility: i.visibility,
          quantityGuess: i.quantityGuess,
        })),
        uncertainItems: r.result.uncertainItems.map((u) => ({
          canonicalName: u.canonicalName,
          displayName: u.displayName,
          reason: u.reason,
        })),
      };
    } else {
      byProvider[r.provider] = {
        modelId: r.modelId,
        cached: r.cached,
        error: r.error,
        skipped: r.skipped,
      };
    }
  }

  // Ground truth note (for manual evaluation, not hardcoded into prompts)
  const groundTruthNote = {
    visible: [
      "cucumber",
      "yellow_tomato",
      "tomato / cherry_tomato",
      "cutlet (cooked meat patties)",
      "cheese (melted on cutlets)",
    ],
    partiallyVisiblePackageOnRight:
      "should be omitted unless sufficient visual evidence (uncertainItems if doubtful)",
  };

  // Simple comparison table data
  const allCanonicals = new Set<string>();
  for (const r of runs)
    if (r.result) for (const ing of r.result.ingredients) allCanonicals.add(ing.canonicalName);

  // For manual comparison, we don't auto-judge correctness; we provide lists for human table
  const tableData = runs.map((r) => ({
    provider: r.provider,
    model: r.modelId,
    cached: r.cached,
    correct: r.result ? r.result.ingredients.length : 0, // placeholder, manual eval needed
    falsePositive: 0,
    misses: 0,
    detections: r.result
      ? r.result.ingredients.map((i) => `${i.canonicalName}(${i.displayName})`).join(", ")
      : (r.error ?? "skipped"),
  }));

  const artifact = {
    image: path.basename(img.path),
    models: { gemini: config.modelId, groq: config.groqModelId, zai: config.zaiModelId },
    promptVersions: { gemini: "v1", groq: "v1", zai: "zai-vision-v1" },
    groundTruthNote,
    providers: byProvider,
    tableData,
    note: "Single-image comparison, not global accuracy. Use manual evaluation: cucumbers, yellow tomatoes, red/cherry tomatoes, cutlets, melted cheese on cutlets; package on right should be omitted unless evidence.",
  };

  const outPath = path.resolve("tmp/live-vision-comparison.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`\nSaved sanitized comparison to ${outPath}`);

  // Human-readable table
  console.log("\n=== Provider | Detections | Uncertain | Cached ===");
  for (const r of runs) {
    const det = r.result
      ? r.result.ingredients.map((i) => i.displayName).join(", ") || "(none)"
      : (r.error?.slice(0, 60) ?? "skipped");
    const unc = r.result
      ? r.result.uncertainItems.map((u) => u.displayName).join(", ") || "-"
      : "-";
    console.log(
      `${r.provider.padEnd(7)} | ${det} | ${unc} | ${r.cached ? "cached" : r.skipped ? "skipped" : "live"}`,
    );
  }

  console.log(
    "\nManual evaluation needed: compare against ground truth (cucumbers, yellow_tomato, tomato, cutlet, cheese). Count user corrections (additions/deletions) per provider.",
  );
  console.log("Do not alter production routing (still Gemini→Groq) until evidence reviewed.");

  // Also write legacy single-provider file for backward compat
  const legacyPath = path.resolve("tmp/live-verify-comparison.json");
  if (fs.existsSync(outPath) && !fs.existsSync(legacyPath)) {
    fs.copyFileSync(outPath, legacyPath);
  }
}

main().catch((e) => {
  console.error("liveVision failed:", e);
  process.exit(1);
});
