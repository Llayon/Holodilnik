# STATE.md — Holodilnik Checkpoint

## Current Checkpoint: PRODUCTION ROUTING SWITCH (ZAI PRIMARY) + PUBLIC ABUSE PROTECTION — DEPLOYED

**Date:** 2026-09-17
**Branch:** master (pushed, clean)
**Starting HEAD before pass:** 0e30eb4002399dc65ce6497717bf48bac1791763 (chore: document vercel deployment)
**Ending HEAD:** 3d1b597 (fix: fail closed without Redis in production; see git log)
**Production URL:** https://holodilnik-seven.vercel.app (aliased from holodilnik-jtqigizky deployment, iad1, build 17s)
**Preview URL (build only, SSO-gated):** https://holodilnik-f4xa1iac0-maximocappuccino-gmailcoms-projects.vercel.app (build 17s OK; API returns SSO login redirect by design per ssoProtection)

### Stop condition reached: A. ROUTING + RATE LIMIT DEPLOYED

### Commits in this pass (pushed to origin/master)

- `971566c feat: make GLM primary vision provider` (ZAI→Groq, no Gemini anon; device ID; Redis/memory store; limits; tests)
- `5bbefdc chore: document ZAI-primary routing and rate-limit checkpoint` (STATE checkpoint B, ADRs 033-039, F-027/028)
- `3d1b597 fix: fail closed without Redis in production` (prod throws RATE_LIMIT_STORE_UNAVAILABLE without KV/Upstash creds; routes 503; Upstash errors propagate; KV resolution + precedence + fail-closed tests)

### Production vision policy (live-verified)

- PRIMARY: Z.AI `glm-4.6v-flash`, FALLBACK: Groq `qwen/qwen3.8-27b`. Gemini NOT in anon chain.
- `GET /api/health` → `{"status":"ok","mockMode":false,"provider":"zai","modelId":"glm-4.6v-flash"}`
- `GET /api/fridge/status` → `provider:zai, vision:{primary:zai, fallback:groq}` (all three keys available, routing still zai→groq)
- `?provider=groq` / `?provider=gemini` → 404 NOT_FOUND (override blocked, zero AI cost)
- ONE smoke (image-a.jpg 130050B, random device UUID): ZAI attempted → `timeout after 10000ms` → `primary zai failed (10003ms), trying fallback groq` → Groq 429 OTPM tier limit → controlled 429 RATE_LIMITED to client. No Gemini in logs. No image/device/IP/keys logged (rid/provider/latency only).
- Recipes: Groq-only in prod — `ENABLE_GEMINI_PRODUCTION_FALLBACK` unset in Vercel env (verified via `env ls`: only GEMINI/GROQ/ZAI + KV\_\*), unit tests prove unset → no Gemini fallback.

### Rate limiting (live-verified where possible with ONE AI call)

- Store: `upstash-redis` durable via `KV_REST_API_URL`+`KV_REST_API_TOKEN` (read-write token; UPSTASH\_\* takes precedence; resolution + precedence + prod-fail-closed covered by unit tests).
- Prod function proved durable selection across invocations: smoke request executed 2 live Redis GETs (device+IP checks) successfully — missing creds or Redis failure would have returned 503 RATE_LIMIT_UNAVAILABLE instead of reaching providers. No store errors in Vercel logs.
- Direct local INCR/TTL roundtrip was NOT possible: `vercel env pull` writes `[SENSITIVE]` placeholders for secret vars (verified: parsed values were literally 11-char `[SENSITIVE]`), so no local REST write test without exposing secrets. INCR/EXPIRE-on-first-write shares the proven `call()` helper (same auth/URL/wire format as the live GETs) and is covered by memory-adapter + logic tests; first successful prod scan will exercise it (counters increment only after successful provider response).
- Limits: vision 5/device/day + 20/IP/day; recipes 20/device/day + 50/IP/day. 6th-device/21st-IP 429 DAILY_LIMIT_REACHED proven in integration tests (mock, zero quota).
- Keys: `rate:<kind>:<ip|device>:<sha256>:YYYY-MM-DD`, TTL to next UTC midnight +1h; unit-tested that raw IDs never appear in keys. Vercel prod logs contain no raw IP/device/base64/keys/secrets.
- Fail-closed: prod without Redis → 503 RATE_LIMIT_UNAVAILABLE (unit-tested); `recordUsage` failures after provider success only log (never discard a spent-quota result).

### Quality gates (final, after all changes)

```
npm run format:check ✓
npm run lint        ✓ (0 errors, 6 pre-existing warnings in vision-gauntlet.ts)
npm run typecheck   ✓
npm run test        ✓ 167/167 (was 128; +14 productionRouting, +22 rateLimit, +3 deviceId)
npm run build       ✓ (246KB JS)
npm run test:e2e    ✓ 12/12 (MOCK_MODE=true, system Chrome)
npx vercel (preview) ✓ build 17s READY (API SSO-gated by design)
npx vercel --prod    ✓ READY, aliased holodilnik-seven.vercel.app
```

No test makes live AI calls (F-027 mitigations hold). Exactly ONE live vision call this pass (smoke above); no gauntlet rerun; no recipe live calls.

### For Next Agent

- First successful prod vision scan will be the first live Redis INCR/EXPIRE write — check Vercel logs for `record_usage_failed` absence and Redis key presence via Upstash dashboard (never paste secrets in chat).
- Groq OTPM tier limit (1000 limit, asked 2000 max_tokens) caused the smoke fallback failure — consider lowering Groq vision `max_completion_tokens` or upgrading Groq tier if fallback reliability matters. No code change made in this pass (out of scope).
- Next phase is Auth/Supabase/payments (not started).

---

## Previous Checkpoint: RATE LIMIT STORAGE CHECKPOINT (superseded by deployment above)

The Upstash/Vercel-KV setup notes from the prior checkpoint section are now complete (KV\_\* present for Preview+Production). Prior setup instructions retained in git history (`5bbefdc`) for reference.

---

## Superseded Checkpoint-B Draft (kept for history; deployment completed above)

> NOTE (2026-09-17): everything below up to the next "Previous Checkpoint:
> VERCEL PRODUCTION READINESS" header describes the pre-deploy checkpoint-B
> state (push deferred, smoke deferred). It is superseded by the DEPLOYED
> checkpoint at the top of this file. Retained for audit trail.

### Stop condition B (superseded): RATE LIMIT STORAGE CHECKPOINT READY

Code for ZAI-primary routing + anonymous rate limits is implemented and all
quality gates pass locally. Production deploy is ON HOLD waiting for durable
rate-limit storage credentials (Upstash Redis REST). Pushing to master now
would auto-deploy to public production with an ephemeral in-memory limiter
(unreliable across Vercel Fluid instances), so push/deploy is deferred until
the user completes the 5-minute Upstash setup below.

### RATE LIMIT STORAGE CHECKPOINT READY — exact setup instructions

**Provider selected:** Upstash Redis via REST (no new SDK dependency; plain
`fetch` to `UPSTASH_REDIS_REST_URL` with `Bearer UPSTASH_REDIS_REST_TOKEN`).

**Why Upstash Redis (Sept 2026):**

- Vercel KV is Upstash-backed; the `@upstash/redis` SDK reads
  `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL`/
  `KV_REST_API_TOKEN` from the Vercel KV integration). Verified via current
  Upstash docs (`Redis.fromEnv()` reads both pairs, UPSTASH_* wins).
- Serverless-safe: REST, no persistent TCP, works in Vercel Fluid functions.
- Free tier sufficient: prototype stores only tiny counters
  (`rate:vision:ip:<sha256>:YYYY-MM-DD` etc., ~50 bytes each, TTL ~24-48h).
  Even 1k users × few keys/day is far below free limits (256MB, 500k cmds/mo
  typical free tier; exact quota shown in Upstash console at creation).
- No Supabase, no new DB, smallest reliable option.

**Where to create the store (2 options, either works):**

1. Upstash Console (recommended, explicit): https://console.upstash.com
   → Create Database → Regional (choose `eu-west-1` or closest to Vercel
   `iad1`; latency ~50-150ms acceptable for rate-limit checks) → copy REST URL
   - REST Token from Details/REST API section.
2. Vercel Dashboard → Storage → Create → Upstash Redis/KV → connect to
   `holodilnik` project → variables auto-injected as `KV_REST_API_URL`/
   `KV_REST_API_TOKEN` (our code reads those as fallback, no rename needed).

**Exact variable names to add in Vercel (Production + Preview):**

```
UPSTASH_REDIS_REST_URL=https://<your-db>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<your-token>
```

(or keep `KV_REST_API_URL`/`KV_REST_API_TOKEN` if created via Vercel
integration — no code change needed; `Redis.fromEnv()`-compatible).

**How to add (CLI, from repo root, no secrets in chat):**

```
npx vercel env add UPSTASH_REDIS_REST_URL production
npx vercel env add UPSTASH_REDIS_REST_TOKEN production
npx vercel env add UPSTASH_REDIS_REST_URL preview
npx vercel env add UPSTASH_REDIS_REST_TOKEN preview
```

(Paste values only into the CLI prompt; never into chat. Select
Sensitive. Then `npx vercel --prod` redeploy so the function picks them up.)

**How we verify after you confirm:**

- `curl /api/health` → prod minimal `{status,mockMode,provider:zai,modelId:glm-4.6v-flash}`
- ONE real fridge photo → 200, `meta.provider=zai` (or `groq` on ZAI overload)
- 6th same-device scan → 429 `DAILY_LIMIT_REACHED` (Russian message)
- Server log shows `[rateLimit]` using `upstash-redis` (durable), not the
  `WARNING: no UPSTASH... using ephemeral memory` line.

**What happens today without Redis:** `getRateLimitStore()` returns
`MemoryRateLimitStore` + logs a loud production WARNING. Tests/dev always use
memory (correct). We do NOT pretend memory is reliable across Vercel
instances — hence this checkpoint.

### Production vision policy (implemented, not yet deployed)

- PRIMARY: Z.AI `glm-4.6v-flash` (`VISION_PRIMARY=zai`)
- FALLBACK: Groq `qwen/qwen3.8-27b` (`VISION_FALLBACK=groq`)
- Gemini is NOT in the anonymous production chain. Kept for dev/benchmark
  (`?provider=gemini` in dev only, still blocked 404 in prod) and future
  authenticated routing.
- Flow: GLM attempt → success return; on 429/1302/1303/1304/1305/1308/1113/
  5xx/timeout/network/malformed → Groq once; Groq failure → controlled app
  error (never silent Gemini).
- ZAI timeout: `ZAI_TIMEOUT_MS=10000` (AbortController, 8–12s intent).
  Only immediate `1214/response_format` single retry inside ZAI provider
  (no 2s→5s→8s chain). Router has no loops (1 call per provider max).
- Recipes: Groq primary → Gemini fallback GATED by
  `ENABLE_GEMINI_PRODUCTION_FALLBACK` (default false = Groq-only in public
  prod to preserve Gemini quota; true re-enables fallback; dev always allows
  fallback). Current prod behavior after deploy: Groq-only recipes.
- Health: prod minimal `{provider:zai, modelId:glm-4.6v-flash}`; dev full
  diagnostics show `vision:{primary:zai,fallback:groq}`,
  `recipes:{primary:groq,fallback:undefined|gemini}`.
- Cache: identical image/provider/model/prompt hit returns WITHOUT consuming
  scan allowance (documented). No images stored (only SHA-256 → result).
- Observability: per-request `rid`, attempted/succeeded provider, fallback
  bool, latency, error class, cached flag. No base64/IP/device/keys logged.

### Rate limits (implemented)

- Vision: 5/device/day, 20/IP/day. Recipes: 20/device/day, 50/IP/day.
  (Env-overridable `VISION_DEVICE_DAILY_LIMIT` etc.; single source `config`.)
- Device ID: `crypto.randomUUID()` in `localStorage:holodilnik_device_id`,
  sent as `X-Holodilnik-Device-Id`. No fingerprinting. Server validates
  ASCII 8–128 `[A-Za-z0-9_-:]`, ignores malformed.
- Client IP: `x-real-ip` first (Vercel canonical, spoof-safe — platform
  overwrites XFF), then `x-forwarded-for[0]`, then `x-vercel-forwarded-for`,
  then socket. Normalized (trim/lower, strip port/brackets/zone).
- Keys (hashed, TTL to next UTC midnight +1h):
  `rate:vision:ip:<sha256>:YYYY-MM-DD` etc. Raw IP/device never persisted.
- Semantics: validation (payload/size/mime) BEFORE counters; invalid/
  oversized/cached do NOT consume; provider exceptions do NOT consume
  (increment only after successful provider response, incl. 422-empty which
  still used quota). Sequential check-then-increment has small concurrent
  overshoot window (documented prototype tradeoff).
- UX: 429 `{code:DAILY_LIMIT_REACHED, error:"На сегодня лимит тестовых..."}`
  → frontend shows "На сегодня тестовый лимит закончился. Попробуйте снова
  завтра." No quota/infra details. No balance UI.

### Quality gates (this pass, local)

```
npm run format:check ✓
npm run lint        ✓ (0 errors, 6 pre-existing warnings in vision-gauntlet.ts)
npm run typecheck   ✓
npm run test        ✓ 163/163 (was 128; +14 productionRouting, +18 rateLimit, +3 deviceId)
npm run build       ✓ (246KB JS)
npm run test:e2e    ✓ 12/12 (MOCK_MODE=true, system Chrome)
```

No test makes live Gemini/Groq/ZAI calls (rateLimit API tests force
`MOCK_MODE=true` + instant `MockVisionProvider` spy; routing tests use
injected fakes; `productionRouting` uses `node` env to avoid Groq browser
guard).

### Commits in this pass (local, not pushed)

- feat: make GLM primary vision provider (ZAI->Groq, no Gemini anon)
- fix: ZAI short timeout + fast fallback, no long retry chain
- feat: add anonymous production rate limits (Redis/memory store, hashed keys)
- feat: add anonymous device id (client + header validation)
- test: cover production routing and abuse limits
- (docs commits for STATE/DECISIONS/FAILURES)

### Live smoke (deferred until Redis + deploy)

Per §25, no gauntlet rerun and no quota burn in this pass. After user adds
Redis vars: deploy Preview → verify → deploy production → ONE real fridge
photo smoke (`meta.provider` observed) + mock-based fallback evidence from
tests above. No images persisted.

### For Next Agent (after Redis ready)

1. Confirm `npx vercel env ls` shows UPSTASH_* (Production+Preview).
2. `git push origin master` (or merge), `npx vercel --prod`, verify health +
   ONE photo smoke, 6th-device 429, then update STATE with ending HEAD +
   deployment URL + smoke result.
3. Do NOT begin Auth/Supabase/credits.

---

## Previous Checkpoint: VERCEL PRODUCTION READINESS + EPHEMERAL IMAGE PASS — DEPLOYED

**Date:** 2026-09-16
**Branch / Commit:** master at 4a0e52a -> vercel rewrites + ephemeral image policy (see git log)
**Starting HEAD before pass:** bfe1d019dbff792c2387ea40050b8f89c589c692 (vision gauntlet scoring rubric)
**Ending HEAD:** 4a0e52ad1328843baadeb4de059cfc69bc2deca3 (fix: route api via vercel rewrites)
**Commits created in this pass:**

- 7547f34 chore: prepare express app for vercel deployment
- 11e7ea4 feat: compress fridge photos before upload
- c4811e0 fix: enforce 300kb production image limit
- 0e0ad73 test: cover production image privacy and limits
- 4a0e52a fix: route api via vercel rewrites and handle stripped prefix
  **Git status:** clean, ahead of origin/master 0 after push
  **Deployment URL:** https://holodilnik-seven.vercel.app (production, also https://holodilnik-by7sspu6k-maximocappuccino-gmailcoms-projects.vercel.app)
  **Deployment protection:** Preview deployments require Vercel SSO (ssoProtection all_except_custom_domains); Production is public on Hobby plan (Password Protection requires Pro per `vercel project protection` 428). For closed test, share Preview URL or use Vercel Authentication bypass; proper user auth will be next phase.

### What Works End-to-End (production, live keys)

- Landing → Photo (camera + upload) → Preparing ("Подготавливаю фото…") → Photo preview (normalized) → Analyzing ("Смотрю, что у тебя есть…") → Ingredients → Recommendations (exactly 3) → Recipe Detail
- Client compression: all photos normalized BEFORE upload via `src/lib/imageCompression.ts` (canvas, createImageBitmap with `imageOrientation:"from-image"`, EXIF stripped by re-encode, long edge 1440 initial, JPEG quality 0.84→0.55 bounded, fallback dimensions 1280/1024/800/640, target ≤200KB, hard ≤300KB, never intentional >300KB). Preview uses normalized dataUrl that is actually sent.
- Server limit: `config.maxImageBytes = 300*1024`, measured via `Buffer.from(base64,'base64').length` (decoded bytes, not string length). Oversized → 413 `IMAGE_TOO_LARGE` with Russian message. Express json limit 2mb (base64 inflation ~33% keeps 300KB → ~400KB + JSON < Vercel 4.5MB).
- Privacy: photos NEVER persisted by application. Flow: compressed bytes → HTTP → server memory → AI provider → structured JSON → request completes. No filesystem /tmp / Blob / DB / cache / logs / GitHub persistence. Verified via code review + tests. Cache stores only `SHA-256(image bytes)+provider/model/promptVersion → structured result`, never base64/dataURL.
- Security: `DELETE /api/cache` and `POST /api/cache/clear` disabled in production (404), `?provider=` override disabled in production (404), `GET /api/health` hides diagnostics in production (only `{status,mockMode,provider,modelId}`), CORS same-origin in production (no wildcard), only localhost:5173 allowed in dev. No `VITE_` secrets, no secret leakage in bundle or responses.
- Vercel deployment: `server/app.ts` exports Express app, `server/index.ts` listens locally, `server.ts` + `api/index.ts` are Vercel entrypoints (zero-config Express, also `api` folder function). `vercel.json` with `buildCommand: npm run build`, `outputDirectory: dist`, `rewrites: [{source:"/api/(.*)", destination:"/api"}]` to funnel api to single function. Framework Vite. Static served from `dist` via Vercel CDN, api via Fluid compute function `λ api/index (1.62MB)`.
- Providers unchanged: Vision Gemini→Groq fallback, Recipes Groq→Gemini, ZAI benchmark.

### Architecture (Current)

```
Browser (React Vite, imageCompression) --/api (same origin, no localhost:3001)--> Vercel (dist static via CDN + api/index Fluid Function)
  compress 200KB ─┐   413 if >300KB      Express app (server/app.ts) -- ProviderRouter --┬─> Gemini 3.8 Flash (vision primary)
  JPEG 1440 q0.84 ┘   CORS prod same-origin                                          ├─> Groq qwen/qwen3.8-27b (vision fallback, recipe primary)
  EXIF stripped        health minimal prod                                            └─> Z.AI glm-4.6v-flash (benchmark, not primary)
                              shared/* (schemas, normalization, pantry, validation)
                              server/cache.ts (SHA-256 keys, no image bytes)
```

- Providers: `VisionProvider` / `RecipeProvider` in `server/providers/types.ts` supports `mock|gemini|groq|zai`
- Implementations: Mock (deterministic), Gemini (`gemini-3.8-flash` via `@google/genai`), Groq (`qwen/qwen3.8-27b` via `groq-sdk` strict), ZAI (`glm-4.6v-flash` via https)
- Routing: Vision Gemini→Groq (retryable 429/503 only, at most one retry), Recipes Groq→Gemini, ZAI benchmark via `?provider=zai` in dev only.
- Cache: Vision key = SHA-256(image bytes)+provider/model+promptVersion (`v1` / `zai-vision-v1`), Recipe key hashed sorted canonicals+pantry. LRU 100, no secrets, deep clone. Dev reset via DELETE/POST /api/cache (dev only).
- Health: `GET /api/health` minimal in prod, full diagnostics in dev (`vision.available.{gemini,groq,zai}`, `models`, `cache`). `GET /api/fridge/status` includes `zaiAvailable`.
- Frontend: `Step` includes `preparing` ("Подготавливаю фото…") before `photo`; analyzing is "Смотрю, что у тебя есть…"; privacy text near upload: "Фото используется для распознавания продуктов и не сохраняется в нашем хранилище. Для анализа фото временно передаётся сервису распознавания. Мы не сохраняем само изображение после обработки."

### Model IDs Locked

- Gemini: `gemini-3.8-flash` (verified GA 2026-09-02)
- Groq: `qwen/qwen3.8-27b` (verified via https://console.groq.com/docs/models)
- Z.AI: `glm-4.6v-flash` (verified via https://docs.z.ai/guides/vlm/glm-4.6v and https://docs.z.ai/api-reference/llm/chat-completion — endpoint `https://api.z.ai/api/paas/v4/chat/completions`, enum includes `glm-4.6v-flash`, 128K, free but rate-limited). Do not silently substitute.
- Z.AI endpoint verified 2026-09-13.

### Security

- `.env.example` contains `GEMINI_API_KEY=`, `GROQ_API_KEY=`, `ZAI_API_KEY=`, `PORT=3001` (no real secrets)
- `.env.local` expected: `GEMINI_API_KEY=...` + `GROQ_API_KEY=...` + `ZAI_API_KEY=...` + `PORT=3001` + `VERCEL_OIDC_TOKEN` (gitignored via `.vercel`/.env*)
- Vercel env vars configured via `vercel env add` for Production/Preview/Development (sensitive, hidden): `GEMINI_API_KEY`, `GROQ_API_KEY`, `ZAI_API_KEY`
- Keys never exposed in browser bundle (checked via `vite build` output), API responses, logs, screenshots; only booleans exposed; health in prod minimal.
- Live harness and dev endpoint never log Authorization header.

### Vercel Deployment (NEW)

**Project:** `holodilnik` under `maximocappuccino-gmailcoms-projects` (Hobby)
**Project ID:** `prj_fFGmz01ieTJSI6mwYsPlku7FyK6Y`
**Production URL:** `https://holodilnik-seven.vercel.app` (aliased from `https://holodilnik-by7sspu6k-maximocappuccino-gmailcoms-projects.vercel.app`)
**Preview URL (latest):** `https://holodilnik-oy18njvcz-maximocappuccino-gmailcoms-projects.vercel.app` (protected via Vercel SSO — shows Log in to Vercel for anonymous)
**Build:** `npm run build` (`tsc -b && vite build`) → `dist` (Vite 246KB JS). Function `λ api/index (1.62MB)` + static `dist/index.html` etc. Build 20-25s in `iad1`.
**Entrypoint:** `server/app.ts` (Express app) → `server/index.ts` (local) + `server.ts` + `api/index.ts` (Vercel). `vercel.json` with `buildCommand`, `outputDirectory`, `rewrites` for `/api`.
**Env:** `GEMINI_API_KEY`, `GROQ_API_KEY`, `ZAI_API_KEY` set for Production/Preview/Development via CLI (sensitive).
**Protection:** Preview SSO protected (`ssoProtection all_except_custom_domains`, `gitForkProtection true`). Production public (Hobby password protection requires Pro — 428). For closed test, use Preview with Vercel auth or upgrade plan/add dashboard password later. Documented per spec §15.

**Verification (run 2026-09-16):**

```
curl -s https://holodilnik-seven.vercel.app/api/health
→ {"status":"ok","mockMode":false,"provider":"gemini","modelId":"gemini-3.8-flash"} (prod minimal, no cache leak)

curl -s -X DELETE https://holodilnik-seven.vercel.app/api/cache → 404 NOT_FOUND (blocked in prod)

curl -s "https://holodilnik-seven.vercel.app/api/fridge/analyze?provider=groq" with valid 2000B image → 404 (provider override blocked)

node synthetic: POST /api/fridge/analyze with tmp/vision-gauntlet/input/image-a.jpg (130050 bytes) → 200 (ingredients 7, includes cucumber/bell_pepper/cherry_tomato/egg/cheese)

node synthetic: POST /api/recommendations with egg+tomato → 200 (3 recipes, slots fastest/normal/from_what_exists)

node: POST /api/fridge/analyze with 400KB dummy → 413 IMAGE_TOO_LARGE Russian

fetch with Origin https://example.com → no access-control-allow-origin (CORS same-origin)

Frontend loads at / (200 HTML), Vite assets 246KB, no secret in bundle (grep VITE_ negative, grep GEMINI negative)

Image policy: original 130KB → compressed via sharp analogy stays ≤200KB at 1440 q84 (tested in server/imageQualityRegression.test.ts 5 cases: 1086×1448→130KB, 4000×3000→≤200KB, 800×600 not upscaled, portrait/landscape long edge, metadata stripped)
```

**Known limitations:**

- HEIC: Safari 17+ (iOS/macOS) decodes HEIC natively via `createImageBitmap` + `imageOrientation: "from-image"` → normalized to JPEG automatically. Chrome/Firefox cannot decode HEIC → `HEIC_DECODE_FAILED` with Russian guidance to convert via iOS Share → Save as JPEG or Settings → Camera → Most Compatible. Actual bytes always re-encoded JPEG, never MIME rename. Documented in `src/lib/imageCompression.ts`.
- `express.static` ignored on Vercel — static served from `dist` via CDN; `server/app.ts` conditional on `process.env.VERCEL` (no static in prod function, 404 JSON catch-all). Local `npm run dev` still uses Vite proxy and `express.static` for preview.
- Vercel Functions payload limit 4.5MB — our 300KB decoded → ~400KB base64 + JSON <1MB, comfortably below.
- Large `api` function 1.62MB (within 250MB limit).

### How to Go Live (ZAI Checkpoint Instructions — unchanged)

**FILE TO EDIT:** `<repository root>/.env.local` (e.g. `D:\Programms\Max\Holodilnik\.env.local`)

**ADD (if not present):**

```
ZAI_API_KEY=YOUR_REAL_ZAI_KEY
```

Keep existing `GEMINI_API_KEY` and `GROQ_API_KEY`. Expected:

```
GEMINI_API_KEY=...
GROQ_API_KEY=...
ZAI_API_KEY=...
PORT=3001
```

**WHERE TO GET THE KEY:** https://z.ai/manage-apikey/apikey-list (or https://chat.z.ai → API Keys). Create key, copy `...` value. Do NOT paste into chat.

**RATE LIMIT PAGE:** https://docs.z.ai/api-reference/api-code (codes 1302/1303/1304/1305/1308/1113).

**COMMAND TO RESTART (from repo root):**

```
npm run dev
```

Or:

```
npm run dev:server
npm run dev:client
```

Server log should show:

```
[config] gemini=gemini-3.8-flash groq=qwen/qwen3.8-27b zai=glm-4.6v-flash ...
[config] geminiAvailable=true groqAvailable=true zaiAvailable=true
```

If only Gemini/Groq keys, `zaiAvailable:false` → benchmark unavailable but app still works.

**HOW TO VERIFY (without key, still works):**

```
Invoke-RestMethod http://localhost:3001/api/health | ConvertTo-Json -Depth 6
# expect vision.available.zai:true/false, models.zai:"glm-4.6v-flash", benchmarkProviders includes zai
```

**LIVE TEST (after key installed, single image, cache-aware):**

Place same fridge photo used for Gemini/Groq at `tmp/fridge.jpg` (or pass path), then:

```
npm run test:live:vision            # runs gemini + groq + zai on same image, reuses cached gemini/groq if already cached, only ZAI needs new request
npm run test:live:vision -- ./path/to/photo.jpg
npm run test:live:zai               # only ZAI on same image
npm run test:live:zai -- ./path/to/photo.jpg
# legacy still works:
npm run test:live:groq
```

Or via dev API (not production):

```
Invoke-RestMethod -Method Post -Uri "http://localhost:3001/api/fridge/analyze?provider=zai" -ContentType "application/json" -Body (@{imageBase64="..."; mimeType="image/jpeg"} | ConvertTo-Json)
```

Artifact: `tmp/live-vision-comparison.json` (and `tmp/live-verify-comparison.json` legacy) with:

```
{
  "image": "...",
  "providers": { "gemini": {...}, "groq": {...}, "zai": {...} },
  "groundTruthNote": { "visible": ["cucumber","yellow_tomato","tomato","cutlet","cheese"], "partiallyVisiblePackageOnRight": "should be omitted" }
}
```

Table printed:

```
Provider | Detections | Uncertain | Cached
gemini   | ... | ... | cached/live
groq     | ... | ... |
zai      | ... | ... |
```

Second run of same image should show `cached:true` for all, no new quota.

### 3-Image Vision Routing Gauntlet (2026-09-14, unchanged)

**Artifacts (sanitized, no keys):** `tmp/vision-gauntlet/input/image-a.jpg` (bdf58a...), `image-b.jpg` (cec0d7...), `image-c.jpg` (27fd92...), `tmp/vision-gauntlet/ground-truth.json`, `tmp/vision-gauntlet/results.json`, `tmp/vision-gauntlet/scorecard.json`, `tmp/vision-gauntlet/REPORT.md`. Baseline `tmp/fridge.jpg` NOT used as gauntlet image per spec. 5 PNGs in `tmp` (`0209d...`, `455f...`, `78b681...`, `8c47...`, `fda5...`) compressed via `scripts/compress-fridge-photo.ts --gauntlet` (PNG 1.9-2MB 1086x1448 → JPG 130-148KB 1086x1448, sharp mozjpeg q80, SHA-256 recorded).

**Run:** `npx tsx scripts/vision-gauntlet.ts` (rotation: A `gemini→zai→groq`, B `zai→groq→gemini`, C `groq→gemini→zai`, max 3 attempts, 2s/5s/8s backoff, cache-aware). Groq strict fix: `quantityGuess` and `reason` now required (allow null/empty) → `strict:true` now succeeds (previously 400). ZAI `json_object` with fallback without on 1214. Prompt parity `v1`/`zai-vision-v1` same semantic.

**Results (from `tmp/vision-gauntlet/REPORT.md`):**

| Provider | A edits | B edits | C edits       | Total            | FP  | First-attempt success | Retries | Avg latency |
| -------- | ------- | ------- | ------------- | ---------------- | --- | --------------------- | ------- | ----------- |
| gemini   | 12      | 9       | 21            | **42**           | 15  | 2/3                   | 1       | 38851ms     |
| groq     | 0       | 8       | 13            | **21**           | 6   | 3/3                   | 0       | 3066ms      |
| zai      | 2       | 2       | — (fail 1305) | **4** (2 images) | 0   | 1/3                   | 4       | 22397ms     |

- **Image A (easy, 455f...):** GT: cucumber 4, bell_pepper 1, cherry_tomato 11-13, egg 9-10, cheese 1. Groq **0** (perfect, all 5 correct, qty exact, Russian), ZAI **2** (qty cherry 10 vs 11-13, egg 12 vs 9-10), Gemini **12** (miss bell_pepper/cherry_tomato/cheese, FP red_bell_pepper/cherry_tomatoes/hard_cheese/napa_cabbage, qty egg 8).
- **Image B (ambiguous, fda...):** GT: zucchini 1, avocado 1, apple 3, lime 2, tomato 4-5. Groq **8** (FP carrot/lettuce, qty zucchini 2 vs 1, apple 4 vs 3, loc avocado/lime English), ZAI **2** (loc avocado/lime English only), Gemini **9** (miss apple, FP green_apple/cucumber/carrot, loc).
- **Image C (difficult, 0209...):** GT: mushroom 8-12, cauliflower 1, cucumber 2-3, grape 1, chicken 2, pickles 1, carrot 2-3, mustOmit: white/brown paper bags, transparent grain container, jar. Groq **13** (miss chicken/pickles, FP pickle/chicken_breast/tomato/rice, qty mushroom 1 vs 8-12, loc), Gemini **21** (miss mushroom/grape/chicken/pickles, 8 FP incl. champignon_mushrooms/fresh_dill/etc, loc), ZAI **FAIL** `1305 overloaded` after 3 attempts (no result, not scored for accuracy per spec).

**Reliability (separate):**

| Provider | first-attempt | retries | 429    | 5xx | quotaBlocked | avg latency | total wall |
| -------- | ------------- | ------- | ------ | --- | ------------ | ----------- | ---------- |
| gemini   | 2/3           | 1       | 0      | 0   | 0            | 38851ms     | 138512ms   |
| groq     | 3/3           | 0       | 0      | 0   | 0            | 3066ms      | 9200ms     |
| zai      | 1/3           | 4       | 1×1305 | 0   | 0            | 22397ms     | 67883ms    |

- Gemini: 400 `INVALID_ARGUMENT` then 503 `high demand` on image A (retry succeeded), image B 503 then success, image C success first try.
- Groq: strict now succeeds, 3/3 first-attempt, lowest latency.
- ZAI: 2/3 success, 1/3 fail 1305 overloaded after 3 attempts (transient, 2 of those attempts were on image A and C).

**Manual review excerpts:**

- A/Groq: `DIFF: — EDIT COST 0` (perfect)
- A/ZAI: `QUANTITY: cherry 10 vs 11-13, egg 12 vs 9-10`
- B/ZAI: `LOCALIZATION: avocado "Avocado" not Cyrillic` (only error)
- C/Groq: `MISS: chicken, pickles; FP: pickle, chicken_breast, tomato, rice; QUANTITY: mushroom 1 vs 8-12`
- C/ZAI: `FAIL 1305` — no accuracy score, reliability fail.

**Cache verification:** Second run with cache enabled → all hits, identical, zero quota, `cacheCheck: PASSED` (key includes provider/model/image SHA-256/promptVersion/schemaVersion).

**Single-image baseline (previous `tmp/fridge.jpg` 138818 bytes):** Still valid, not reused. Groq 3 corrections (bell_pepper hallucination), ZAI 1 correction (cheese), Gemini quota 20/day blocked. Now superseded by 3-image gauntlet.

**Decision (evidence-based, not automatic, per spec):**

- **Vision Accuracy Ranking:** 1. zai (4 total, 2.0 mean, 0 FP on 2 images, but 1 image failed), 2. groq (21 total, 7.0 mean, 6 FP), 3. gemini (42 total, 14.0 mean, 15 FP). If counting only completed images, zai clearly best on accuracy per image, but incomplete (2/3).
- **Reliability Ranking:** 1. groq (3/3, 0 429), 2. gemini (2/3 first-attempt, but 3/3 eventual), 3. zai (1/3 first-attempt, 2/3 eventual, 1 fail 1305).
- **Recommended Production Routing:** Keep `Gemini → Groq` **unchanged** until ZAI reliability improves (needs 3/3 success). ZAI shows best accuracy when it succeeds (lowest edit cost, zero FP on A/B), but 1305 overload on C makes it not yet fallback #1 per spec (requires ≥2/3 success — it has 2/3, but transient reliability needs bounded retries; currently 1 fail). **Hold** — recommend `Gemini → Groq` primary, keep `ZAI` as benchmark (`?provider=zai`), re-evaluate after ZAI overload stabilizes or with `Gemini → ZAI → Groq` if ZAI achieves 3/3 on retry day.
- **Zero-Budget Routing:** `ZAI → Groq` attractive (both free), but ZAI 33% fail rate on this gauntlet vs Groq 100% success — for zero-budget, Groq is more reliable despite higher edit cost. **Hold** zero-budget as `Groq → ZAI` or `ZAI → Groq` with retry.
- **Next:** Do NOT auto-switch routing. This gauntlet used new 3 images, not `tmp/fridge.jpg`. For production change, need explicit separate commit.

### Previous Single-Image Baseline (for reference, not gauntlet)

**Artifact:** `tmp/live-vision-comparison.json` (138818 bytes, `tmp/fridge.jpg`) — Groq 3 corrections, ZAI 1 correction, Gemini quota 20/day. Now superseded.

### Quality Gates (last run 2026-09-16 after Vercel pass)

```
npm run format:check ✓ (prettier)
npm run lint        ✓ (eslint, 6 warnings in scripts/vision-gauntlet.ts only)
npm run typecheck   ✓
npm run test        ✓ 128/128 (shared 38 + mock 3 + groq 12 + zai 13 + router 19 + cache 11 + scoring 13 + imageCompression 15 + productionImagePolicy 17 + imageQualityRegression 5)
npm run build       ✓ (vite 246KB js, tsc -b)
npx playwright test ✓ 12/12 (chromium+mobile, MOCK_MODE=true, with valid 800×600 JPEG via sharp, preparing step handled)
vercel --prod       ✓ https://holodilnik-seven.vercel.app (production, 38s, λ api/index 1.62MB, iad1)
curl /api/health    ✓ 200 prod minimal
curl DELETE /api/cache prod → 404
curl POST /api/fridge/analyze?provider=groq prod → 404 (blocked)
synthetic POST image-a.jpg 130KB → 200 (ingredients)
synthetic POST 400KB dummy → 413 IMAGE_TOO_LARGE
```

Live commands isolated, zero quota on second same-image cached rerun.

### Known Notes

- Production routing remains Gemini→Groq, recipes Groq→Gemini — ZAI is benchmark only until gauntlet decision. Gauntlet shows ZAI best accuracy (4 vs 21) but 1/3 fail 1305, so hold.
- ZAI image limit 5M (vs 8MB app old) — now app limit 300KB, ZAI 5M safe.
- Phone photo compress script: `scripts/compress-fridge-photo.ts` (sharp, 6000x6000, 5M, mozjpeg 80, resize to 1920) — `npm run compress:photo input.jpg [output.jpg]` and `npm run compress:photo -- --gauntlet` for 3 images. Now superseded by client-side `src/lib/imageCompression.ts` for production (browser canvas).
- Client compression: target 200KB, hard 300KB, long edge 1440, quality 0.84→0.55 bounded, fallback dimensions 1280/1024/800/640, never upscale small images, EXIF stripped, HEIC handling documented (Safari native, Chrome/Firefox error with guidance).
- Tiny 1x1 png still rejected; e2e now uses valid 800×600 JPEG via sharp (was 6KB dummy).
- Playwright reuses system Chrome, workers 2; kill node before run if LIVE server running.
- Do not commit `.env.local`, `tmp/*.jpg`, `tmp/vision-gauntlet/*.jpg` (tmp gitignored), `.vercel` gitignored.
- Vercel: build 20-38s, function 1.62MB <250MB limit, payload 400KB base64 <4.5MB, CORS same-origin prod, health minimal prod.
- Deployment protection: Preview SSO protected, Production public on Hobby (password requires Pro). For closed test, use Preview URL with Vercel auth.

### For Next Agent

- Do not rewrite git history, do not commit secrets or `tmp/fridge.jpg` or `tmp/vision-gauntlet/input/*.jpg` (tmp is gitignored) or `.env.local` (contains OIDC token)
- Keep model IDs unchanged: `gemini-3.8-flash`, `qwen/qwen3.8-27b`, `glm-4.6v-flash`
- See DECISIONS.md ADRs 026-032 for Vercel, compression, privacy, CORS, etc.
- See FAILURES.md F-022..F-026 for HEIC, api routing, vercel build, etc.
- If changing production routing, update `server/providers/router.ts` Vision chain to `Gemini → ZAI → Groq` only after explicit decision commit — current is HOLD per gauntlet (ZAI 2/3 success, need 3/3)
- Next phase is Auth/Supabase/payments (not this pass)
