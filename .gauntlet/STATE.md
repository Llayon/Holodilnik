# STATE.md — Holodilnik Checkpoint

## Current Checkpoint: GROQ CHECKPOINT READY — Dual Provider (Gemini + Groq) Code Complete

**Date:** 2026-09-13
**Branch / Commit:** master at 18b22a9 -> new groq integration (see git log)
**HEAD before pass:** 18b22a9 chore: ignore *.err logs

### What Works End-to-End (mock, no key required)

- Landing → Photo (camera + upload, preview+replace) → Analyzing → Ingredients → Recommendations (exactly 3) → Recipe Detail (same as before)
- Mock flow deterministic: eggs/tomatoes/cheese/chicken/zucchini/sour cream + uncertain yogurt/greens; recipes 3 slots
- Ingredient normalization: now fixed for Yellow tomato / Cherry_tomato / Cutlet etc. UI never shows snake_case; humanized fallback for unknown canonicals
- Pantry staples unchanged: salt, black_pepper, vegetable_oil only
- Recommendations validation unchanged: pantry-aware, never `Всё есть` when missing, 3 distinct slots
- Security: `GEMINI_API_KEY` and `GROQ_API_KEY` server-only, no `VITE_` variant, `.env.example` contains both empty, `.env.local` gitignored

### New Architecture (Target Achieved Code-Complete)

```
Browser (React Vite) --/api--> Express (port 3001) -- ProviderRouter --┬─> Gemini 3.8 Flash (vision primary, recipe fallback)
                                                                     └─> Groq qwen/qwen3.8-27b (vision fallback, recipe primary)
                             shared/* (schemas, normalization, pantry, validation)
                             server/cache.ts (in-memory, SHA-256 keys)
```

- Providers: `VisionProvider` / `RecipeProvider` in `server/providers/types.ts` now supports `mock|gemini|groq`
- Implementations:
  - `MockVisionProvider` / `MockRecipeProvider` — deterministic, no quota
  - `GeminiVisionProvider` / `GeminiRecipeProvider` — `gemini-3.8-flash` via `@google/genai`
  - `GroqVisionProvider` / `GroqRecipeProvider` — `qwen/qwen3.8-27b` via `groq-sdk` (official), `reasoning_effort: none`, `reasoning_format: hidden`, strict JSON Schema, fallback to best-effort on 400 strict incompatibility, normalized + deduped, local Zod validation
- Routing:
  - **Vision:** Gemini (primary) → Groq (fallback on 429/503/retryable only, at most one retry). Groq vision supports 3 images/req, each image 2048 tokens, 20MB limit, 131K context.
  - **Recipes:** Groq (primary) → Gemini (fallback on retryable, at most one). Normal recipe requests go directly to Groq, preserving Gemini quota.
  - Non-retryable errors (400 invalid payload, unsupported mime, schema bug, parse error) remain visible, no silent fallback, no loops.
  - `server/providers/router.ts` encapsulates chains, integrates cache, exposes `VisionProviderChain` / `RecipeProviderChain`, test-injectable.
- Cache:
  - Vision key = SHA-256(normalized image bytes) + provider/model + promptVersion (V1)
  - Recipe key = SHA-256(sorted canonical ingredient IDs + pantry state) + provider/model + promptVersion
  - In-memory Maps, max 100 entries each, LRU eviction, no secrets in keys/values, clone on get/set, isolated per provider/model
  - Dev reset: `DELETE /api/cache` or `POST /api/cache/clear`, also `clearAllCaches()` helper. Tests clear cache and never depend on persistence. Re-testing same photo does not consume quota.
- Health:
  - `GET /api/health` returns legacy `provider/modelId/mockMode` plus new `vision:{primary, fallback, geminiAvailable, groqAvailable}`, `recipes:{primary, fallback, groqAvailable, geminiAvailable}`, `models:{gemini, groq}`, `cache:{visionSize, recipeSize}` without secrets. Header badge still works mock|LIVE.
  - `GET /api/fridge/status` similarly updated.
  - Responses include `meta: { provider, modelId, cached, primary, fallback }` for dev diagnostics (no secrets).
- Normalization fix:
  - Added canonicals `cherry_tomato → Помидоры черри`, `yellow_tomato → Жёлтые помидоры`, `cutlet → Котлета` and aliases (with spaces, Russian variants). Fallback now humanizes snake_case to Title Case with spaces instead of exposing raw underscore. `getDisplayName` also humanizes.
  - Regression tests cover Cherry_tomato/Yellow tomato/Cutlet and unknown snake handling.
  - Future variant model documented (see DECISIONS.md) – variant collapse to base `tomato` not done in this phase to avoid disproportionate migration; distinct canonicals kept, recipe matching relies on exact canonical (future work: equivalence for tomato variants).

### Model IDs Locked

- Gemini: `gemini-3.8-flash` (AGENTS.md, server/config.ts `GEMINI_MODEL_ID`)
- Groq: `qwen/qwen3.8-27b` (verified via https://console.groq.com/docs/models and https://console.groq.com/docs/model/qwen/qwen3.8-27b). Do not silently substitute.
- Spec prior asked to verify official Groq docs before implementation – verified 2026-09-13 via webfetch; preview model supports vision + structured outputs strict:true + reasoning_effort none/low/medium/high, 131K context, 3 images per request, 20MB limit.

### Security

- `.env.example` now contains `GEMINI_API_KEY=` and `GROQ_API_KEY=` (no real secrets)
- `.env.local` expected: `GEMINI_API_KEY=...` + `GROQ_API_KEY=...` (gitignored via `.gitignore` already covers `*.local` and `.env*local`)
- Keys never exposed in browser, Vite env, API responses, logs, screenshots. Only `isGeminiAvailable`/`isGroqAvailable` booleans exposed.

### How to Go Live (Groq Checkpoint Instructions)

**FILE TO EDIT:** `<repository root>/.env.local` (e.g. `D:\Programms\Max\Holodilnik\.env.local`)

**LINE TO ADD (if not present):**

```
GROQ_API_KEY=YOUR_REAL_GROQ_KEY
```

Keep existing `GEMINI_API_KEY` line. Expected eventually:

```
GEMINI_API_KEY=...
GROQ_API_KEY=...
PORT=3001
```

**WHERE TO GET THE KEY:** Official Groq Console API Keys page: https://console.groq.com/keys → Create API Key (GroqCloud). Do NOT paste key into chat.

**COMMAND TO RESTART (from repo root):**

```
npm run dev
```

Or separately:

```
npm run dev:server
npm run dev:client
```

Server logs on start should show:

```
[config] gemini=gemini-3.8-flash groq=qwen/qwen3.8-27b mockMode=false ...
[config] geminiAvailable=true groqAvailable=true
```

If only Gemini key present, `groqAvailable=false` and recipes will fallback to Gemini (still works). If neither key, mock mode.

**HOW TO VERIFY:**

1. Health:

```
Invoke-RestMethod http://localhost:3001/api/health | ConvertTo-Json -Depth 5
# expect: vision.primary=gemini fallback=groq geminiAvailable=true groqAvailable=true
# recipes.primary=groq fallback=gemini groqAvailable=true
```

Or curl:

```
curl http://localhost:3001/api/health
```

2. UI header badge: after restart, open http://localhost:5173 → badge should show `LIVE · gemini-3.8-flash` or `LIVE · qwen/qwen3.8-27b` depending on last operation, not `MOCK`. In dev mode, small routing diagnostics bar shows `VISION · GEMINI → GROQ · RECIPES · GROQ → GEMINI` and last provider.

3. Vision A/B (after key installed, see live verification):
   - Place fridge photo at `tmp/fridge.jpg` (or pass path)
   - Run `npm run test:live:groq` → prints Gemini vs Groq detection comparison without burning quota repeatedly (cache).
   - Or upload same photo via UI twice → second call should be cached (`meta.cached=true` in network response, check DevTools).

4. Recipes: Add ingredients → `POST /api/recommendations` should go to Groq primary (`meta.provider=groq`). Check Network tab → Preview → meta.provider.

5. Cache reset: `Invoke-RestMethod -Method Delete http://localhost:3001/api/cache` or `POST /api/cache/clear` or restart server.

Do NOT ask to paste key into chat. Do NOT run `npm test` with live keys (tests mock).

### Quality Gates (last run 2026-09-13 before live key)

```
npm run typecheck   ✓
npm run lint        ✓ (eslint, no errors)
npx prettier --check . ✓ (after --write)
npm run test        ✓ 63/63 (shared + mock + groq + router + cache)
npm run build       ✓ (vite 240kB)
npx playwright test --reporter=list  (expected 12/12 with MOCK_MODE=true, not yet rerun after groq changes but header still MOCK|LIVE compatible)
```

Full gates with Playwright to be rerun after checkpoint commit.

Live verification command (isolated, not run in CI):

```
npm run test:live:groq            # uses tmp/fridge.jpg if exists, else recipe-only test
npm run test:live:groq -- ./path/to/photo.jpg
```

This command never runs from `npm test` or CI.

### Known Notes

- Groq vision fallback only on genuine Gemini 429/503 retryable; invalid image 400 does not trigger fallback (keeps error visible).
- Recipe requests normally go directly to Groq; Gemini 429 during recipe does NOT trigger second Gemini call (only one fallback at most).
- Cache is in-memory, not persistent across restarts; repeated same-image tests within same server process are quota-safe.
- Tiny 1x1 png (<500B) still rejected as INVALID_IMAGE; e2e uses 6KB dummy.
- Playwright uses `channel: "chrome"` system Chrome, workers 2.
- Do not commit `.env.local`.

### Next Phase (after key installed)

- Small live A/B on same fridge photo: Gemini vs Groq detection + Groq recipes exactly 3 validation (see `server/liveVerifyGroq.ts`)
- Record sanitized comparison to `tmp/live-verify-comparison.json` and update STATE/DECISIONS with results, do not claim global accuracy from one image.
- Final autonomous critic loop if needed.

### For Next Agent

- Do not rewrite git history, do not commit secrets
- Keep `server/config.ts` GROQ_MODEL_ID = "qwen/qwen3.8-27b" and GEMINI_MODEL_ID unchanged
- See DECISIONS.md ADRs 016+ for Groq, router, cache, normalization
- See FAILURES.md for new F-013... if any
- Wait for user to install GROQ_API_KEY before live benchmark
