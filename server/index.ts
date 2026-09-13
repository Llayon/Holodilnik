import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fridgeRouter from "./routes/fridge.js";
import recommendationsRouter from "./routes/recommendations.js";
import {
  config,
  logConfig,
  isMockMode,
  isGeminiAvailable,
  isGroqAvailable,
  isZaiAvailable,
} from "./config.js";
import { getCacheStats, clearAllCaches } from "./cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

// Health
app.get("/api/health", (_req, res) => {
  const mockMode = isMockMode();
  const geminiAvail = isGeminiAvailable();
  const groqAvail = isGroqAvailable();
  const zaiAvail = isZaiAvailable();
  res.json({
    status: "ok",
    // legacy fields for backward compat
    provider: mockMode ? "mock" : geminiAvail ? "gemini" : groqAvail ? "groq" : "mock",
    modelId: config.modelId,
    mockMode,
    // new detailed diagnostics (no secrets)
    vision: {
      primary: "gemini",
      fallback: "groq",
      geminiAvailable: geminiAvail,
      groqAvailable: groqAvail,
      primaryAvailable: geminiAvail,
      available: {
        gemini: geminiAvail,
        groq: groqAvail,
        zai: zaiAvail,
      },
      benchmarkProviders: ["gemini", "groq", "zai"],
    },
    recipes: {
      primary: "groq",
      fallback: "gemini",
      groqAvailable: groqAvail,
      geminiAvailable: geminiAvail,
      primaryAvailable: groqAvail,
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
});

// Dev cache reset (obvious mechanism, no secrets)
app.delete("/api/cache", (_req, res) => {
  clearAllCaches();
  res.json({ status: "cleared", cache: getCacheStats() });
});
app.post("/api/cache/clear", (_req, res) => {
  clearAllCaches();
  res.json({ status: "cleared", cache: getCacheStats() });
});

// Routes
app.use("/api/fridge", fridgeRouter);
app.use("/api/recommendations", recommendationsRouter);

// Serve frontend in production
const distPath = path.resolve(__dirname, "../dist");
app.use(express.static(distPath));

// SPA fallback - must be after API routes, use middleware
app.use((_req, res) => {
  const indexPath = path.join(distPath, "index.html");
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    }
  });
});

// Error handler
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[unhandled]", err);
    res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
  },
);

const port = config.port;
app.listen(port, () => {
  logConfig();
  console.log(`[server] listening on http://localhost:${port}`);
});

export default app;
