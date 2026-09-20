# CRITIC.md — Holodilnik adversarial review log

## Gauntlet 2 Phase 0 critic pass — integration architecture (2026-09-20)

Critic reviewed the UserPlatform Service Bridge contract against the current
Holodilnik request flow (server/routes/fridge.ts, rateLimit.ts, cache.ts,
providers/router.ts, src/lib/api.ts, src/App.tsx) before any integration code.

### Attacks verified against the CURRENT (pre-integration) flow

- **H-01 [BLOCKER, to fix] Server-generated log requestId billed:** route mints
  an 8-char `requestId` per HTTP request; a client retry is a new billing unit
  by construction. Fix: client-generated `requestId` (ADR-044), one UUID per
  deliberate action, reused across technical retries.
- **H-02 [BLOCKER, to fix] Cache-before-counter becomes free authenticated
  scans:** `getVisionCache` hit returns before `checkLimits` today. Under
  credits this would make repeat images free. Fix: reserve-before-cache for
  authenticated mode (ADR-045); anonymous keeps current semantics.
- **H-03 [BLOCKER, to fix] Single anonymous device limit caps credit users:**
  5/device/day would block an authenticated 10-credit user at scan #6. Fix:
  dual policy with separate authenticated abuse caps (ADR-046).
- **H-04 [P1, to fix] No commit/release settlement:** no Platform calls exist
  yet; AI-success + lost-acknowledgement has no recovery shape. Fix: settlement
  cache + idempotent commit retry on same `requestId` (ADR-044/045).
- **H-05 [P1, accepted design] Recipes stay credit-free:** `fridge.recipe = 0`
  costs nothing; adding reserve/commit overhead would make recipes fragile for
  zero accounting value. No Platform calls on the recipe route in MVP.

### Verified safe to keep

- Validation (payload/size/mime/HEIC) already runs before any counter — stays
  before reserve (0 credits on 400/413).
- Provider chain throws on technical failure and returns normally on
  empty-but-valid results, so empty→commit / throw→release maps cleanly onto
  the existing code shape (NO_FOOD stays a paid completed scan).
- Redis fail-closed, hashed keys, no raw logging: reused unchanged for the
  authenticated keys (user-UUID hash + IP layer).
- `?provider=` override blocked in prod (404); dev benchmark path untouched.

No integration code yet. Architecture approved (ADR-042..047); BUILDER may
proceed to Phase 1.

## Gauntlet 2 Phase 1 critic pass — platform adapter (2026-09-20, CLOSED)

- **C-101 [P1] Missing credential must 503, not 500:** first version threw
  `PlatformError(500, SERVICE_UNAUTHORIZED)` when no service token was
  configured — routes could have mapped it to a generic 500 while still
  serving anonymous AI. FIXED: `serviceToken()` throws `PLATFORM_UNAVAILABLE`
  (503) so every no-credential path fails closed by construction.
- **Checked:** no token/initData/session in any message (codes only);
  `revokeSession` sends the session as a `Cookie` because UserPlatform logout
  reads the cookie only (verified against `apps/api/src/routes/auth.ts`);
  mock enforces same idempotency shape (same requestId → same reservation),
  cross-app 403, namespace split, timeout knobs; `getPlatformClient()` never
  returns a silently-unauthenticated real client (prod without token fails at
  call time, non-prod falls back to mock).
- No open BLOCKER/P1. Phase 1 may commit (commits deferred to phase batches
  per §55; working tree holds Phase 1 changes).

## Gauntlet 2 Phase 2 critic pass — host auth bridge (2026-09-20, CLOSED)

- **C-201 [P1] Test/env isolation:** first test version used `vi.resetModules`
  - dynamic `app` import, which forked the platform-route module graph — the
    injected mock landed on a different module instance than the route, so the
    outage test passed vacuously (healthy singleton answered). FIXED: flag is a
    live env read (`isPlatformIntegrationEnabled()`), single module graph,
    per-test mock injection; the outage test now genuinely exercises the
    failure path. Lesson: never assert mock behavior through a re-imported app.
- **Checked:** exchange JSON contains no token/initData (string-matched);
  cookie is HttpOnly (+Secure in prod, Lax — code-reviewed); 400 before any
  Platform call (spy-pinned); tampered cookie 401; logout 204 + cleared cookie
  even when Platform is down; dev endpoints 404 in production (shared
  `requireDev` pattern); flag-off exchange/me 404; frontend host access
  quarantined in `host.ts` (only file touching `window.Telegram`/`WebApp`,
  unit-tested incl. Telegram-wins and empty-initData cases); TG/MAX failure
  shows retryable `auth-error` (no silent anonymous downgrade); web stays
  anonymous by design.
- No open BLOCKER/P1.

## Gauntlet 2 Phase 3/4/5 critic pass — credit-aware scans, recovery, rate limits (2026-09-20, CLOSED)

- **C-301 [P1] Anonymous quota tripped the J-test the wrong way:** the first
  J version sent no device header, so the 5-device cap never engaged and the
  "blocked" probe returned 200. FIXED: device header pinned; the 6th anon
  scan 429s while the credit holder's scan succeeds (separate namespaces).
- **Attacked and repelled (all tested in `fridgeAuth.test.ts`):** same
  requestId x3 = one charge; same image + new requestId = new charge;
  missing requestId in auth mode = 400 (server never invents billing keys);
  zero balance = 402 with zero AI calls (spy-pinned); AI throw = release =
  balance whole; commit timeout = 503 COMMIT_UNCERTAIN then same-key retry
  reuses the single AI result for one charge (spy counts 1 analyze);
  balance-1 x10 parallel unique = exactly one reserve; smuggled
  operation/userId/cost inert; oversized image = 413 costing 0; forged cookie
  = 401 with no AI and no anonymous downgrade; anonymous legacy unchanged
  (no balance meta, no requestId required).
- **Residuals (documented, not hidden):** release failing 3x leaves a
  `reserved` row for the Platform stale sweeper (error logged, AI error still
  returned); process restart drops settlement replays (idempotent reserve
  bounds the damage to one repeated AI call, never a double charge);
  cookie-absent callers are treated as anonymous-web even under an enabled
  flag — inherent while the transitional anonymous product exists (§16), no
  server-side identity downgrade occurs because the server never sees the
  host identity on analyze.
- No open BLOCKER/P1.

## Gauntlet 2 Phase 6 critic pass — UI + mobile E2E (2026-09-20, CLOSED)

- **C-601 [P1] Sticky mock flag broke the outage-recovery E2E:** the mock
  singleton keeps `exchangeFail` until reconfigured, so "retry with a clean
  route" still failed and `landing` never appeared. FIXED: the route sends an
  explicit scenario header on EVERY exchange (fail once, clear on retry).
- **Watch (not a blocker):** the very first full parallel run showed one
  mobile legacy failure (analyzing-text race) that never reproduced — app.spec
  mobile alone 6/6, mobile project both files 10/11 (only C-601), full matrix
  22/22 green twice. Attributed to dev-server saturation under 2 workers with
  800ms mock scans; production is unaffected (no shared singletons there
  beyond Redis, which is the designed store).
- **Checked:** balance chip renders only when authenticated (absent for
  anonymous); authoritative balance from scan meta with /me refresh fallback
  (never local decrement); zero-credit Russian state; auth-error retry
  recovers; 360/390/430 overflow-free with chip visible; plurals unit-tested
  (1/21 кредит, 2–4 кредита, 0/5–25 кредитов).
- No open BLOCKER/P1.
