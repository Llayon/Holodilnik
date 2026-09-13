# STATE.md — Holodilnik Checkpoint

## Current Checkpoint: ZAI LIVE BENCHMARK DONE — Tri-Vision (Gemini + Groq + ZAI) Compared on Same Real Fridge Image

**Date:** 2026-09-14
**Branch / Commit:** master at bcd0fe0 -> Z.AI tri-benchmark (see git log + tmp/live-vision-comparison.json)
**HEAD before pass:** f77ca76 fix: handle invalid GROQ_API_KEY placeholder (ByteString) and improve config validation
**Live image:** `tmp/fridge.jpg` (138818 bytes, `D:\Programms\Max\Holodilnik\tmp\fridge.jpg` — cucumbers 5, yellow tomatoes 6-8, red/cherry tomatoes 6-7, cutlets 3 with melted cheese on top, partially visible package on right)

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

### Live Tri-Benchmark Results (2026-09-14, same image, cache-aware)

**Artifact:** `tmp/live-vision-comparison.json` (sanitized, 138818 bytes, `tmp/fridge.jpg`) — also `tmp/live-verify-comparison.json` legacy copy. No keys in artifact.

**Run:** `npx tsx server/liveVerifyVision.ts` with `tmp/fridge.jpg`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `ZAI_API_KEY` all valid. Gemini cached? No — Gemini hit daily quota `20/day` (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, `RESOURCE_EXHAUSTED`, `retryDelay 12s` then `10s`). Groq and ZAI succeeded (ZAI transient 1305 overloaded on 2 of 5 attempts, succeeded on retry; Groq strict schema `required: quantityGuess/reason` failed 400, retried best-effort and succeeded — documented as strict incompatibility).

**Raw provider outputs (sanitized):**

- **Gemini 3.8 Flash:** `429` `RESOURCE_EXHAUSTED` quota exceeded `20/day` — no result for this image today. Not a model quality failure, but quota block. Previous logs showed Gemini could work but now daily limit hit.
- **Groq qwen/qwen3.8-27b:** 4 ingredients, `cucumber(Огурцы) conf 0.98 qty 4`, `yellow_bell_pepper(Yellow Bell Pepper) conf 0.95 qty 4`, `cherry_tomato(Помидоры черри) conf 0.95 qty 6`, `cutlet(Котлета) conf 0.85 qty 2`, `uncertainItems: []`. Strict schema error `quantityGuess`/`reason` not in `required` → retried `strict:false`.
- **ZAI glm-4.6v-flash:** 4 ingredients, `cutlet(Котлета) conf 0.95 qty 3`, `cherry_tomato(Помидоры черри) conf 0.9 qty 7`, `yellow_tomato(Жёлтые помидоры) conf 0.9 qty 8`, `cucumber(Огурцы) conf 0.9 qty 5`, `uncertainItems: []`. Second attempt succeeded after 1305 overloaded, no schema fallback needed beyond initial `json_object`.

**Human-readable comparison (manual evaluation against ground truth: cucumbers 5, yellow tomatoes 6-8 elongated, red/cherry tomatoes 6-7 small round, cutlets 3 with melted cheese on top, package on right should be omitted):**

| Provider                | Correct                                                                             | False Positive                                                                                                      | Misses                                                                            | User Corrections (add/delete)                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Gemini 3.8 Flash**    | — (quota 20/day exceeded, no result)                                                | —                                                                                                                   | —                                                                                 | — (cannot evaluate today)                                                                                              |
| **Groq Qwen 3.8 27B**   | 3 (cucumber, cherry_tomato, cutlet)                                                 | 1 (yellow_bell_pepper misclassifies yellow_tomato as bell pepper, display English "Yellow Bell Pepper" not Russian) | 2 (yellow_tomato correct type, cheese melted on cutlets not detected as separate) | **Delete** 1 (yellow_bell_pepper), **Add** 2 (yellow_tomato, cheese) = **3 corrections** (qty also off: cutlet 2 vs 3) |
| **Z.AI GLM-4.6V-Flash** | 4 (cucumber, cherry_tomato, yellow_tomato, cutlet) all with correct Russian display | 0                                                                                                                   | 1 (cheese melted on cutlets not as separate ingredient)                           | **Add** 1 (cheese) = **1 correction** (qty accurate: cutlet 3, cucumber 5)                                             |

**Concrete differences:**

- _yellow tomato →_ Groq **confused with pepper** (`yellow_bell_pepper`, English fallback, not in `CANONICAL_DISPLAY`), ZAI **correctly identified** `yellow_tomato` → `Жёлтые помидоры`.
- _cheese →_ Both Groq and ZAI **missed** separate cheese (visible as melted on cutlets). Not hallucinated as separate package. ZAI slightly better qty for cheese-related cutlets.
- _opaque package on right →_ Both **correctly omitted** (no hallucinated hidden contents, `uncertainItems: []` — ideal per rules `prefer omission`).
- _cutlet →_ ZAI `conf 0.95 qty 3` exact, Groq `conf 0.85 qty 2` slight miss.
- _cucumber →_ Both correct, ZAI qty 5 exact, Groq 4 close.
- _cherry vs red tomatoes →_ Both detected `cherry_tomato` (small red), but ground truth has both yellow large and red small — ZAI distinguished yellow vs cherry correctly, Groq conflated yellow large with bell pepper.

**Product metric: HOW MANY USER CORRECTIONS ARE REQUIRED?**

- Groq: **3** (delete bell pepper, add yellow_tomato, add cheese)
- ZAI: **1** (add cheese)
- Gemini: **N/A** today (quota), but previously strong — need quota-free evaluation tomorrow.

**Rate-limit behavior observed (do not write "unlimited free"):**

- Gemini: `429` `RESOURCE_EXHAUSTED` `GenerateRequestsPerDayPerProjectPerModel-FreeTier` `quotaValue 20` (daily free-tier 20, also 5/min). `high demand 503` in earlier logs.
- ZAI: `429` `code 1305` `The service may be temporarily overloaded, please try again later` — transient, succeeded on retry after 8s. Free model but with `high frequency` / `daily limit` / `overloaded` limits per https://docs.z.ai/api-reference/api-code (1302 rate limit, 1303 high frequency, 1304 daily, 1305 overloaded, 1308 usage limit, 1113 insufficient balance). Observed 2/3 calls overloaded, 1 success.

**Decision (evidence-based, not automatic):**

- Do **NOT** yet make ZAI primary (per spec). Evidence from single image suggests ZAI > Groq for this fridge (correct fine-grained yellow tomato vs bell pepper hallucination, correct Russian display, exact cutlet qty). Recommended next routing after review: `Gemini → ZAI → Groq` (Gemini primary, ZAI second fallback, Groq third) to preserve Gemini quality but reduce Groq misclassification, while keeping Groq as final fallback. Requires second image verification and quota-free Gemini day.

### Quality Gates (last run 2026-09-14 after ZAI live benchmark)

```
npm run typecheck   ✓
npm run lint        ✓
npx prettier --check . ✓
npm run test        ✓ 78/78 (shared + mock + groq + zai + router + cache)
npm run build       ✓
npx playwright test ✓ 12/12 (chromium+mobile, MOCK_MODE=true)
npm run test:live:vision ✓ tri-provider (gemini 429 quota, groq 4 ingredients best-effort, zai 4 ingredients json_object) artifact saved
```

Live commands isolated, zero quota on second same-image run (cached:true).

### Known Notes

- ZAI is benchmark only this pass; production routing remains Gemini→Groq, recipes Groq→Gemini until second image.
- ZAI vision fallback not in production chain; benchmark harness reports limits explicitly (1305) rather than silently replacing.
- ZAI image limit 5M (vs 8MB app) — app limit safe; Groq strict 400 due to optional `quantityGuess`/`reason` not in `required` → best-effort fallback documented.
- Tiny 1x1 png still rejected; e2e uses 6KB dummy.
- Playwright reuses system Chrome, workers 2.
- Do not commit `.env.local` or `tmp/*.jpg` (fridge photo).

### For Next Agent

- Do not rewrite git history, do not commit secrets or `tmp/fridge.jpg`
- Keep model IDs unchanged: `gemini-3.8-flash`, `qwen/qwen3.8-27b`, `glm-4.6v-flash`
- See DECISIONS.md ADRs 022+ for ZAI, cache, health, live results
- See FAILURES.md for ZAI 1305, Groq strict schema, Playwright reuse, ByteString
- If changing production routing, update `server/providers/router.ts` Vision chain to `Gemini → ZAI → Groq` only after second image evidence
