import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fridgeRouter from "./routes/fridge.js";
import recommendationsRouter from "./routes/recommendations.js";
import { config, logConfig } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

// Health
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    provider: config.geminiApiKey ? (config.mockMode ? "mock" : "gemini") : "mock",
    modelId: config.modelId,
    mockMode: !config.geminiApiKey || config.mockMode,
  });
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
