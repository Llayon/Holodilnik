# STATE.md — Holodilnik Checkpoint

## Current Checkpoint: VISION ROUTING GAUNTLET — 3 IMAGES, DECISION READY (ZAI 4 vs Groq 21 vs Gemini 42)

**Date:** 2026-09-14
**Branch / Commit:** master at 1a1bb11 -> vision gauntlet harness + Groq strict fix (see git log + tmp/vision-gauntlet/REPORT.md)
**HEAD before pass:** f77ca76 fix: handle invalid GROQ_API_KEY placeholder (ByteString) and improve config validation
**Gauntlet images:** `tmp/vision-gauntlet/input/image-a.jpg` (130050 bytes, bdf58a..., 1086x1448), `image-b.jpg` (131100 bytes, cec0d7..., 1086x1448), `image-c.jpg` (148219 bytes, 27fd92..., 1086x1448) — 5 PNGs in `tmp` compressed via `scripts/compress-fridge-photo.ts --gauntlet` (>6000x6000 → 1920, JPG 80, SHA-256 recorded)
**Baseline image (not gauntlet):** `tmp/fridge.jpg` (138818 bytes, 712f4e..., 960x1280 — cucumbers 5, yellow tomatoes 6-8, red/cherry 6-7, cutlets 3, package on right) — previous single-image benchmark, now superseded by 3-image gauntlet

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

### 3-Image Vision Routing Gauntlet (NEW, 2026-09-14)

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

### Quality Gates (last run 2026-09-14 after 3-image gauntlet)

```
npm run typecheck   ✓
npm run lint        ✓
npx prettier --check . ✓ (after --write)
npm run test        ✓ 78/78 (shared + mock + groq + zai + router + cache + scoring)
npm run build       ✓ (vite 240KB)
npx playwright test ✓ 12/12 (chromium+mobile, MOCK_MODE=true, reuseExistingServer handled)
npm run test:live:vision-gauntlet ✓ 3 images × 3 providers, rotation, strict fixed, cache verified, artifacts saved
```

Live commands isolated, zero quota on second same-image cached rerun.

### Known Notes

- Production routing remains Gemini→Groq, recipes Groq→Gemini — ZAI is benchmark only until gauntlet decision. Gauntlet shows ZAI best accuracy (4 vs 21) but 1/3 fail 1305, so hold.
- ZAI image limit 5M (vs 8MB app) — app limit safe; Groq strict now fixed (quantityGuess/reason required) → strict:true succeeds.
- Phone photo compress script: `scripts/compress-fridge-photo.ts` (sharp, 6000x6000, 5M, mozjpeg 80, resize to 1920) — `npm run compress:photo input.jpg [output.jpg]` and `npm run compress:photo -- --gauntlet` for 3 images.
- Tiny 1x1 png still rejected; e2e uses 6KB dummy.
- Playwright reuses system Chrome, workers 2; kill node before run if LIVE server running.
- Do not commit `.env.local`, `tmp/*.jpg`, `tmp/vision-gauntlet/*.jpg` (but `ground-truth.json` is human-reviewed, keep in repo? Currently in tmp, not committed per spec — if needed, move to `tmp/vision-gauntlet/input` is gitignored via `tmp`).
- 5 PNGs in `tmp` (1.9-2MB 1086x1448) → 3 JPGs in `tmp/vision-gauntlet/input` (130-148KB) for gauntlet; hero.png / fridge.jpg NOT used.

### For Next Agent

- Do not rewrite git history, do not commit secrets or `tmp/fridge.jpg` or `tmp/vision-gauntlet/input/*.jpg` (tmp is gitignored)
- Keep model IDs unchanged: `gemini-3.8-flash`, `qwen/qwen3.8-27b`, `glm-4.6v-flash`
- See DECISIONS.md ADRs 022-025 for ZAI, cache, health, live results, gauntlet decision
- See FAILURES.md F-019..F-021 for Groq strict, ZAI 1305, Gemini daily quota
- If changing production routing, update `server/providers/router.ts` Vision chain to `Gemini → ZAI → Groq` only after explicit decision commit — current is HOLD per gauntlet (ZAI 2/3 success, need 3/3)
