/**
 * Vercel entrypoint — zero-config Express deployment.
 *
 * Vercel auto-detects `server.{js,ts}` at repository root (see
 * https://vercel.com/docs/frameworks/backend/express). The file must
 * export the Express app as default (or listen on PORT).
 *
 * Local dev still uses `server/index.ts` (tsx watch). This file is the
 * production Vercel entrypoint and must remain tiny — all app construction
 * lives in `server/app.ts` to avoid duplication.
 */
import app from "./server/app.js";

export default app;
