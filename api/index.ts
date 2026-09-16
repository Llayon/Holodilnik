/**
 * Vercel API entrypoint — alternative to root server.ts.
 *
 * Vercel Functions under `api/` are automatically routed to `/api/*`.
 * This file re-exports the Express app so both `/api/*` and root
 * `server.ts` handling work on Vercel (whichever detection wins).
 *
 * All app construction lives in `server/app.ts` — no duplication.
 */
import app from "../server/app.js";

export default app;
