import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fridgeRouter from "./routes/fridge.js";
import platformRouter from "./routes/platform.js";
import recommendationsRouter from "./routes/recommendations.js";
import {
  config,
  isMockMode,
  isGeminiAvailable,
  isGroqAvailable,
  isZaiAvailable,
} from "./config.js";
import { getCacheStats, clearAllCaches } from "./cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Holodilnik Express application.
 *
 * Privacy guarantee: refrigerator photos are NEVER persisted by our
 * application. Flow: compressed bytes → HTTP request → server memory
 * → chosen AI provider → structured ingredient JSON → request completes.
 * No filesystem / Blob / DB / cache / log persistence of image bytes.
 *
 * Cache: stores only SHA-256(image bytes) → structured result, never
 * base64 / raw bytes / data URL / file path.
 */

export const app = express();

// CORS: same-origin in production; allow localhost:5173 only in dev.
// Check per-request so tests can toggle NODE_ENV.
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== "production") {
    return cors({
      origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
      credentials: false,
    })(req, res, next);
  }
  return next();
});

// Body parsers: compressed images are <=300KB decoded (~400KB base64 + JSON)
// — well below Vercel Functions 4.5 MB payload limit. Keep limit tight.
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Health — safe status, no secrets / key prefixes / infra detail leak.
// In production, hide detailed vision/recipes breakdown to anonymous visitors.
// Handler shared for both /api/health and /health (Vercel api/index strips /api prefix via rewrite).
function handleHealth(_req: express.Request, res: express.Response) {
  const mockMode = isMockMode();
  const geminiAvail = isGeminiAvailable();
  const groqAvail = isGroqAvailable();
  const zaiAvail = isZaiAvailable();
  const isProd = process.env.NODE_ENV === "production";

  // Minimal safe payload in production; full diagnostics in dev.
  // Production vision policy: primary=zai (glm-4.6v-flash), fallback=groq.
  const prodProvider = mockMode ? "mock" : zaiAvail ? "zai" : groqAvail ? "groq" : "mock";
  const prodModel =
    prodProvider === "zai"
      ? config.zaiModelId
      : prodProvider === "groq"
        ? config.groqModelId
        : config.modelId;
  const base = {
    status: "ok" as const,
    mockMode,
    provider: prodProvider,
    modelId: prodModel,
  };

  if (isProd) {
    // In production, expose only minimal safe info — no cache sizes, no fallback lists
    return res.json(base);
  }

  return res.json({
    ...base,
    vision: {
      primary: "zai",
      fallback: "groq",
      geminiAvailable: geminiAvail,
      groqAvailable: groqAvail,
      primaryAvailable: zaiAvail,
      available: {
        gemini: geminiAvail,
        groq: groqAvail,
        zai: zaiAvail,
      },
      benchmarkProviders: ["gemini", "groq", "zai"],
    },
    recipes: {
      primary: "groq",
      fallback: config.enableGeminiProductionFallback ? "gemini" : undefined,
      groqAvailable: groqAvail,
      geminiAvailable: geminiAvail,
      primaryAvailable: groqAvail,
      geminiFallbackEnabled: config.enableGeminiProductionFallback,
    },
    zai: {
      available: zaiAvail,
      model: config.zaiModelId,
      apiBase: config.zaiApiBase,
    },
    models: {
      gemini: config.modelId,
      groq: config.groqModelId,
      zai: config.zaiModelId,
    },
    benchmarkProviders: ["gemini", "groq", "zai"],
    cache: getCacheStats(),
  });
}
app.get("/api/health", handleHealth);
app.get("/health", handleHealth);

// Dev-only cache reset. Must not be available in production.
const requireDev = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
  }
  next();
};

function handleCacheClear(_req: express.Request, res: express.Response) {
  clearAllCaches();
  res.json({ status: "cleared", cache: getCacheStats() });
}
app.delete("/api/cache", requireDev, handleCacheClear);
app.delete("/cache", requireDev, handleCacheClear);
app.post("/api/cache/clear", requireDev, handleCacheClear);
app.post("/cache/clear", requireDev, handleCacheClear);

// Routes — mount at both /api/* and /* for Vercel api/index stripped prefix compatibility.
app.use("/api/fridge", fridgeRouter);
app.use("/fridge", fridgeRouter);
app.use("/api/platform", platformRouter);
app.use("/platform", platformRouter);
app.use("/api/recommendations", recommendationsRouter);
app.use("/recommendations", recommendationsRouter);

// Serve frontend in production (local `npm run build` + `node dist`).
// On Vercel, express.static is ignored — static is served from `dist` via
// Vercel's static output (outputDirectory). Keep for local production preview.
if (!process.env.VERCEL) {
  const distPath = path.resolve(__dirname, "../dist");
  app.use(express.static(distPath));

  // SPA fallback — must be after API routes.
  app.use((_req, res) => {
    const indexPath = path.join(distPath, "index.html");
    res.sendFile(indexPath, (err) => {
      if (err) {
        res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      }
    });
  });
} else {
  // On Vercel, handle SPA fallback for non-API, non-static routes.
  // Static files (dist) are served by Vercel CDN; this catch-all ensures
  // unknown non-API routes still return JSON 404, not HTML, while
  // Vercel's rewrites handle SPA index.html.
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
  });
}

// Error handler — never leak provider credentials or raw internal errors
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[unhandled]", err);
    res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
  },
);

export default app;
