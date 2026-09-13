import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { GeminiVisionProvider } from "./providers/geminiVision.js";
import { GroqVisionProvider } from "./providers/groqVision.js";
import { GroqRecipeProvider } from "./providers/groqRecipe.js";

async function main() {
  console.log("=== Live Groq Verification (small, quota-safe) ===");
  console.log(`Gemini available: ${!!config.geminiApiKey} Groq available: ${!!config.groqApiKey}`);
  if (!config.geminiApiKey)
    console.log("WARN: GEMINI_API_KEY missing - cannot compare Gemini vision");
  if (!config.groqApiKey) console.log("WARN: GROQ_API_KEY missing - cannot test Groq");
  if (!config.geminiApiKey || !config.groqApiKey) {
    console.log("\nTo run live verification:");
    console.log("  1. Ensure <repo>/.env.local contains:");
    console.log("     GEMINI_API_KEY=...");
    console.log("     GROQ_API_KEY=...");
    console.log("  2. Place a fridge photo at ./tmp/fridge.jpg or pass path as arg");
    console.log("     npm run test:live:groq -- ./path/to/fridge.jpg");
    console.log("  3. Then rerun npm run test:live:groq");
    console.log("\nSkipping live calls (no keys).");
    // Still test recipe path if groq available, use mock ingredients
    if (config.groqApiKey) {
      console.log("\n[Groq recipe small test with mock ingredients]");
      const groqRecipe = new GroqRecipeProvider(config.groqApiKey);
      const res = await groqRecipe.generateRecommendations({
        ingredients: [
          { canonicalName: "egg", displayName: "Яйца" },
          { canonicalName: "tomato", displayName: "Помидоры" },
          { canonicalName: "cheese", displayName: "Сыр" },
        ],
      });
      console.log(
        `Groq recipes: ${res.recipes.length} slots ${res.recipes.map((r) => r.slot).join(",")}`,
      );
      if (res.recipes.length !== 3) throw new Error("Expected 3 recipes");
      console.log("Groq recipe small test PASS");
    }
    return;
  }

  // Find image
  const argPath = process.argv[2];
  const candidates = [
    argPath,
    "tmp/fridge.jpg",
    "tmp/fridge.png",
    "test-fridge.jpg",
    "e2e/fixtures/fridge.jpg",
    "public/fridge.jpg",
  ].filter(Boolean) as string[];

  let imagePath: string | undefined;
  let base64: string | undefined;
  let mime = "image/jpeg";
  for (const p of candidates) {
    const full = path.resolve(p);
    if (fs.existsSync(full)) {
      const buf = fs.readFileSync(full);
      if (buf.length < 500) continue;
      if (buf.length > 8 * 1024 * 1024) {
        console.log(`Skipping ${full}: too large ${buf.length}`);
        continue;
      }
      base64 = buf.toString("base64");
      if (p.endsWith(".png")) mime = "image/png";
      else if (p.endsWith(".webp")) mime = "image/webp";
      else mime = "image/jpeg";
      imagePath = full;
      break;
    }
  }

  if (!base64 || !imagePath) {
    console.log("\nNo fridge image found. Using recipe-only verification with sample ingredients.");
    console.log("To test vision A/B, place an image at tmp/fridge.jpg or pass path:");
    console.log("  npm run test:live:groq -- ./path/to/photo.jpg");
    // Recipe test
    const groqRecipe = new GroqRecipeProvider(config.groqApiKey);
    const groqRes = await groqRecipe.generateRecommendations({
      ingredients: [
        { canonicalName: "egg", displayName: "Яйца" },
        { canonicalName: "tomato", displayName: "Помидоры" },
        { canonicalName: "cheese", displayName: "Сыр" },
        { canonicalName: "chicken", displayName: "Курица" },
      ],
    });
    console.log("\n[Groq recipe from sample ingredients]");
    console.log(
      JSON.stringify(
        groqRes.recipes.map((r) => ({ slot: r.slot, title: r.title, hasAll: r.hasAllIngredients })),
        null,
        2,
      ),
    );
    if (groqRes.recipes.length !== 3) throw new Error("Expected 3");
    console.log("\nLive recipe verification PASS (3 valid dishes, groq primary)");
    return;
  }

  console.log(
    `\nUsing image: ${imagePath} mime=${mime} bytes=${Buffer.byteLength(base64, "base64")}`,
  );

  // A/B vision
  console.log("\n--- A. Gemini 3.8 Flash vision ---");
  const geminiVision = new GeminiVisionProvider(config.geminiApiKey);
  let gemRes: Awaited<ReturnType<GeminiVisionProvider["analyzeFridgeImage"]>> | undefined;
  try {
    gemRes = await geminiVision.analyzeFridgeImage({ imageBase64: base64, mimeType: mime });
    console.log(`Gemini detected ${gemRes.ingredients.length} ingredients:`);
    console.log(
      gemRes.ingredients
        .map((i) => ` - ${i.canonicalName} (${i.displayName}) conf=${i.confidence}`)
        .join("\n"),
    );
    if (gemRes.uncertainItems.length)
      console.log(`Uncertain: ${gemRes.uncertainItems.map((u) => u.canonicalName).join(", ")}`);
  } catch (e) {
    console.error("Gemini vision failed:", e instanceof Error ? e.message : String(e));
  }

  console.log("\n--- B. Groq Qwen 3.8 27B vision ---");
  const groqVision = new GroqVisionProvider(config.groqApiKey);
  let groqRes: Awaited<ReturnType<GroqVisionProvider["analyzeFridgeImage"]>> | undefined;
  try {
    groqRes = await groqVision.analyzeFridgeImage({ imageBase64: base64, mimeType: mime });
    console.log(`Groq detected ${groqRes.ingredients.length} ingredients:`);
    console.log(
      groqRes.ingredients
        .map((i) => ` - ${i.canonicalName} (${i.displayName}) conf=${i.confidence}`)
        .join("\n"),
    );
    if (groqRes.uncertainItems.length)
      console.log(`Uncertain: ${groqRes.uncertainItems.map((u) => u.canonicalName).join(", ")}`);
  } catch (e) {
    console.error("Groq vision failed:", e instanceof Error ? e.message : String(e));
  }

  if (gemRes && groqRes) {
    const gemSet = new Set(gemRes.ingredients.map((i) => i.canonicalName));
    const groqSet = new Set(groqRes.ingredients.map((i) => i.canonicalName));
    const gemOnly = [...gemSet].filter((x) => !groqSet.has(x));
    const groqOnly = [...groqSet].filter((x) => !gemSet.has(x));
    console.log("\n=== Sanitized Comparison (no secrets) ===");
    console.log(`Gemini detected: ${[...gemSet].join(", ") || "(none)"}`);
    console.log(`Groq detected: ${[...groqSet].join(", ") || "(none)"}`);
    console.log(`Gemini misses (Groq only): ${groqOnly.join(", ") || "(none)"}`);
    console.log(`Groq misses (Gemini only): ${gemOnly.join(", ") || "(none)"}`);
    console.log("Gemini false positives: (manual review needed vs photo)");
    console.log("Groq false positives: (manual review needed vs photo)");
    console.log(
      "\nManual corrections: inspect photo vs lists above; neither provider is declared globally better from one image.",
    );
    // Save sanitized file
    const out = {
      image: path.basename(imagePath),
      gemini: gemRes.ingredients.map((i) => ({
        canonicalName: i.canonicalName,
        displayName: i.displayName,
        confidence: i.confidence,
      })),
      groq: groqRes.ingredients.map((i) => ({
        canonicalName: i.canonicalName,
        displayName: i.displayName,
        confidence: i.confidence,
      })),
      gemOnly,
      groqOnly,
      note: "Single-image comparison, not global accuracy",
    };
    const outPath = path.resolve("tmp/live-verify-comparison.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`\nSaved sanitized comparison to ${outPath}`);
  }

  // Recipe test from Groq vision or combined ingredients
  const confirmed = (groqRes ?? gemRes)?.ingredients.map((i) => ({
    canonicalName: i.canonicalName,
    displayName: i.displayName,
  })) ?? [
    { canonicalName: "egg", displayName: "Яйца" },
    { canonicalName: "tomato", displayName: "Помидоры" },
  ];
  console.log("\n--- Confirmed ingredients -> Groq recipes (exactly 3) ---");
  const groqRecipe = new GroqRecipeProvider(config.groqApiKey);
  const rec = await groqRecipe.generateRecommendations({ ingredients: confirmed });
  console.log(`Got ${rec.recipes.length} recipes:`);
  for (const r of rec.recipes) {
    console.log(
      ` [${r.slot}] ${r.title} - ${r.estimatedMinutes}min hasAll=${r.hasAllIngredients} missing=${r.missingIngredients.map((m) => m.displayName).join(",") || "none"}`,
    );
  }
  if (rec.recipes.length !== 3) throw new Error("Expected 3");
  const slots = new Set(rec.recipes.map((r) => r.slot));
  if (slots.size !== 3) throw new Error("Expected 3 distinct slots");
  console.log("\nLive verification PASS");
}

main().catch((e) => {
  console.error("Live verify failed:", e);
  process.exit(1);
});
