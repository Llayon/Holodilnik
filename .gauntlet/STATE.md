# STATE.md — Holodilnik Checkpoint

## Current Checkpoint: ZAI CHECKPOINT READY — Tri-Vision Benchmark (Gemini + Groq + Z.AI GLM-4.6V-Flash) Code Complete

**Date:** 2026-09-13
**Branch / Commit:** master at f77ca76 -> new Z.AI integration (see git log)
**HEAD before pass:** f77ca76 fix: handle invalid GROQ_API_KEY placeholder (ByteString) and improve config validation

### What Works End-to-End (mock, no key required)

- Landing → Photo (camera + upload, preview+replace) → Analyzing → Ingredients → Recommendations (exactly 3) → Recipe Detail (same as before)
- Mock flow deterministic: eggs/tomatoes/cheese/chicken/zucchini/sour cream + uncertain yogurt/greens; recipes 3 slots
- Ingredient normalization: fixed for Yellow tomato / Cherry_tomato / Cutlet etc., plus ZAI unknown labels (humanized fallback, never snake_case)
- Pantry staples unchanged: salt, black_pepper, vegetable_oil only
- Recommendations validation unchanged: pantry-aware, never `Всё есть` when missing, 3 distinct slots
- Security: `GEMINI_API_KEY`, `GROQ_API_KEY`, `ZAI_API_KEY` server-only, no `VITE_` variant, `.env.example` contains all three empty, `.env.local` gitignored
- Tests: 78 unit (shared + mock + groq + zai + router + cache) + 12 e2e (chromium+mobile) — all green without live keys

### Architecture (Current)

```
Browser (React Vite) --/api--> Express (port 3001) -- ProviderRouter --┬─> Gemini 3.8 Flash (vision primary, recipe fallback)
                                                                     ├─> Groq qwen/qwen3.8-27b (vision fallback, recipe primary)
                                                                     └─> Z.AI glm-4.6v-flash (vision BENCHMARK, not primary)
                             shared/* (schemas, normalization, pantry, validation)
                             server/cache.ts (in-memory, SHA-256 keys, per-provider promptVersion)
```

- Providers: `VisionProvider` / `RecipeProvider` in `server/providers/types.ts` now supports `mock|gemini|groq|zai`
- Implementations:
  - `MockVisionProvider` / `MockRecipeProvider` — deterministic, no quota
  - `GeminiVisionProvider` — `gemini-3.8-flash` via `@google/genai`
  - `GroqVisionProvider` — `qwen/qwen3.8-27b` via `groq-sdk`, reasoning_effort none, strict JSON Schema
  - `ZaiVisionProvider` — `glm-4.6v-flash` via direct HTTPS `https://api.z.ai/api/paas/v4/chat/completions` (OpenAI-compatible), `Authorization: Bearer ZAI_API_KEY`, data URL image, `response_format: {type:"json_object"}` with fallback without, prompt `zai-vision-v1`, same semantic rules as Gemini/Groq, sanitizes fences, local Zod validation, dedup, normalization
- Routing (unchanged in this pass):
  - **Vision PRODUCTION:** Gemini → Groq (fallback on 429/503 retryable only, at most one retry). ZAI is **BENCHMARK only**, not primary.
  - **Recipes:** Groq → Gemini (unchanged)
  - `server/providers/router.ts` still encapsulates Gemini/Groq chains; ZAI not in production chain by design (decision after benchmark)
  - Dev explicit provider selection: `POST /api/fridge/analyze?provider=zai` (or body `provider`) when `NODE_ENV !== production` and key available, bypasses chain for benchmark; harness also directly instantiates providers
- Cache:
  - Vision key = SHA-256(image bytes) + provider/model + promptVersion (`v1` for gemini/groq, `zai-vision-v1` for zai)
  - Recipe key unchanged
  - Provider/model + promptVersion ensures `gemini` cached result never returned for `zai` request and vice versa; `zai` isolation tested
  - Dev reset: `DELETE /api/cache` etc.
- Health:
  - `GET /api/health` now includes `vision.available.{gemini,groq,zai}`, `vision.benchmarkProviders:["gemini","groq","zai"]`, `zai:{available, model, apiBase}`, `models:{gemini,groq,zai}`, `cache`
  - `GET /api/fridge/status` includes `zaiAvailable`
  - Responses include `meta: {provider,modelId,cached,primary,fallback,requestedProvider?}` without secrets
  - ZAI error mapping: 401 invalid key (ByteString), 400/1214 invalid param, 429 rate limit codes 1302/1303/1304/1305/1308/1113 etc mapped to controlled errors, never leak key

### Model IDs Locked

- Gemini: `gemini-3.8-flash` (verified GA 2026-09-02)
- Groq: `qwen/qwen3.8-27b` (verified via https://console.groq.com/docs/models)
- Z.AI: `glm-4.6v-flash` (verified via https://docs.z.ai/guides/vlm/glm-4.6v and https://docs.z.ai/api-reference/llm/chat-completion — Vision model, Image/Video/Text/File input, 128K context, Lightweight, Completely Free, endpoint `https://api.z.ai/api/paas/v4/chat/completions`, enum includes `glm-4.6v-flash`). Do not silently substitute.
- Z.AI endpoint and pricing verified 2026-09-13 via webfetch: base `https://api.z.ai/api/paas/v4`, model `glm-4.6v-flash`, free but with rate/daily limits (see error codes), context 128K, image limit 5M per image, 150 images max for 4.6V series

### Security

- `.env.example` now contains `GEMINI_API_KEY=`, `GROQ_API_KEY=`, `ZAI_API_KEY=` (no real secrets)
- `.env.local` expected: `GEMINI_API_KEY=...` + `GROQ_API_KEY=...` + `ZAI_API_KEY=...` + `PORT=3001` (gitignored)
- Keys never exposed in browser, API responses, logs, screenshots; only booleans `zaiAvailable` exposed
- Live harness and dev endpoint never log Authorization header

### How to Go Live (ZAI Checkpoint Instructions)

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

**WHERE TO GET THE KEY:** Official Z.AI Open Platform API Keys page: https://z.ai/manage-apikey/apikey-list (or https://chat.z.ai → API Keys). Create key, copy `...` value. Do NOT paste into chat.

**RATE LIMIT PAGE:** Z.AI API Key management → Rate Limits / https://docs.z.ai/api-reference/api-code (codes 1302 Rate limit, 1303 high frequency, 1304 daily limit, 1305 overloaded, 1308 usage limit, 1113 insufficient balance). Free model has daily/usage limits despite price free.

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

### Quality Gates (last run 2026-09-13 after ZAI code, before live key)

```
npm run typecheck   ✓
npm run lint        ✓
npx prettier --check . ✓
npm run test        ✓ 78/78 (shared + mock + groq + zai + router + cache)
npm run build       ✓
npx playwright test ✓ 12/12 (chromium+mobile, MOCK_MODE=true)
```

Live commands isolated, not run in CI, zero quota in `npm test`.

### Known Notes

- ZAI is benchmark only this pass; production routing remains Gemini→Groq, recipes Groq→Gemini. Do not make ZAI primary until same-image evidence reviewed.
- ZAI vision fallback not in production chain; benchmark harness reports limits explicitly (1302/1305/etc) rather than silently replacing.
- ZAI image limit 5M per image (vs 8MB app limit), pixels 6000x6000, max 150 images for 4.6V series — app limit 8MB is safe.
- Tiny 1x1 png still rejected; e2e uses 6KB dummy.
- Playwright reuses system Chrome, workers 2.
- Do not commit `.env.local`.

### Next Phase (after key installed)

- Run `npm run test:live:vision` on same fridge photo already used for Gemini/Groq; only ZAI should need new request if cache hit.
- Produce `tmp/live-vision-comparison.json` and manual table:

```
Provider          | Correct | False Positive | Misses | User Corrections
Gemini 3.8 Flash  |         |                |        |
Groq Qwen 3.8 27B |         |                |        |
GLM-4.6V-Flash    |         |                |        |
```

- Evaluate: cucumbers, yellow tomatoes, red/cherry tomatoes, cutlets, melted cheese on cutlets; package on right should be omitted unless evidence; count required manual additions/deletions per provider.
- Decide future routing (e.g., Gemini → ZAI → Groq) only after evidence.

### For Next Agent

- Do not rewrite git history, do not commit secrets
- Keep model IDs unchanged: `gemini-3.8-flash`, `qwen/qwen3.8-27b`, `glm-4.6v-flash`
- See DECISIONS.md ADRs 022+ for ZAI, cache, health
- See FAILURES.md for ZAI ByteString, Playwright reuse, etc.
- Wait for user to install ZAI_API_KEY before tri-benchmark
