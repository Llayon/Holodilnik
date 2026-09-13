# DECISIONS.md — Architectural Decision Records

## ADR-001: Model lock gemini-3.8-flash

- **Decision:** Use `gemini-3.8-flash` as modelId everywhere, verified GA 2026-09-02.
- **Context:** Spec requires verify current docs, do not silently switch. Web search confirmed model card https://deepmind.google/models/model-cards/gemini-3-8-flash/ and https://ai.google.dev/gemini-api/docs/latest-model — ID `gemini-3.8-flash`, context 1M, output 65k, default thinking medium.
- **Consequence:** `server/config.ts` single source; both vision+recipe providers use it; health endpoint exposes it.

## ADR-002: SDK @google/genai (not @google/generative-ai)

- **Decision:** Use `npm install @google/genai` official JS SDK.
- **Context:** Docs https://googleapis.github.io/js-genai/ show legacy `@google/generative-ai` not maintained for 2.0+ features. Verified SDK uses `new GoogleGenAI({apiKey})` and `ai.models.generateContent`.
- **Alternative rejected:** `@google/generative-ai` — deprecated, lacks structured outputs.

## ADR-003: Server-side key architecture

- **Decision:** Express server on port 3001, Vite dev proxy `/api` → server, production serves `dist/index.html`. No `VITE_GEMINI_API_KEY`.
- **Context:** Non-negotiable security. Browser never calls Gemini directly. `GEMINI_API_KEY` only in `server/config.ts` via dotenv loading `.env.local` + `.env`.
- **Consequence:** `.env.example` committed with empty key, `.gitignore` covers `.env*local`.

## ADR-004: Structured outputs via responseJsonSchema + Zod 4

- **Decision:** Use `responseMimeType: "application/json"` + `responseJsonSchema: z.toJSONSchema(schema)` for Gemini calls; fallback manual JSON Schema if Zod version lacks native.
- **Context:** Verified current docs: `responseJsonSchema` subset supports $defs/$ref, not pattern/const. `zodToJsonSchema` community package deprecated in Zod 4. Forum issue https://discuss.ai.google.dev/t/documentation-issue-structured-outputs-example-uses-outdated-genai-sdk-and-zod-apis/168181 confirms correct shape is `responseMimeType`/`responseJsonSchema` not `responseFormat.text`.
- **Consequence:** Added `getFridgeJsonSchema()`/`getRecommendationsJsonSchema()` helpers; validation still via `zod.parse` after response to enforce dropped constraints.

## ADR-005: ThinkingLevel low for vision, medium for recipes

- **Decision:** Vision `thinkingLevel: "low"` (speed), Recipes `thinkingLevel: "medium"` (default).
- **Context:** Spec suggests low for vision prompt, medium for recipe. Verified Gemini 3.8 only supports low/medium/high, not minimal; minimal returns error. Docs note default medium.
- **Alternative rejected:** `minimal` (unsupported), `temperature`/`top_p` (removed in Gemini 3).

## ADR-006: Provider abstraction VisionProvider / RecipeProvider

- **Decision:** Interfaces in `server/providers/types.ts`, separate mock vs gemini impls.
- **Context:** Spec requires separating vision and recipe generation to allow later replacement. Mock deterministic with 600-800ms delay, no quota; live uses same schemas.
- **Consequence:** `isMockMode()` chooses provider based on `MOCK_MODE` env or missing key. Health reflects mode for UI badge.

## ADR-007: Normalization layer canonical ↔ displayName

- **Decision:** `shared/normalization.ts` maps aliases (plural, ru/en) to snake_case canonical, `CANONICAL_DISPLAY` provides Russian UI names.
- **Context:** Avoid treating arbitrary model strings as entities; allow later localization.
- **Consequence:** Vision provider re-normalizes Gemini output; frontend `+ Добавить` also normalizes; `SUGGESTIBLE_INGREDIENTS` curated for fast addition.

## ADR-008: Pantry staples minimal

- **Decision:** Only `salt`, `black_pepper`, `vegetable_oil` in `shared/pantry.ts`.
- **Context:** Spec forbids silently assuming cream/cheese/rice/pasta etc. `validateRecipeAvailability` checks pantry set to avoid false missing.
- **Consequence:** Recipes requiring unavailable staples marked missing, UI never shows `Всё есть` incorrectly.

## ADR-009: Exact 3 slots validation

- **Decision:** `validateRecommendationsSlots` enforces length 3 and distinct `fastest`/`normal`/`from_what_exists`; server sorts by slot order.
- **Context:** Product solves indecision via 3 semantic slots; must not show 20 recipes.
- **Consequence:** Gemini recipe provider re-validates after generation; mock always returns correct 3.

## ADR-010: Frontend vertical slice state machine

- **Decision:** Single `App.tsx` with `Step` type, no router, no auth, no store library.
- **Context:** Smallest polished useful product; steps handled via useState, photo preview kept across errors.
- **Consequence:** Simple, testable via data-testid; Playwright covers full flow without needing router logic.

## ADR-011: Express 5 SPA fallback

- **Decision:** Use `app.use((req,res)=>res.sendFile(dist/index.html))` not `app.get("*")`.
- **Context:** Express 5 path-to-regexp v6 throws `Missing parameter name at index 1: *` for `*`. Fix via middleware.
- **Consequence:** Production serving works; dev uses Vite proxy instead.

## ADR-012: Playwright using system Chrome channel

- **Decision:** `channel: "chrome"` for both projects, workers 2, fullyParallel false.
- **Context:** `npx playwright install` timed out for 1243/1193 browsers; system Chrome/Edge available at `C:\Program Files\...`. Avoids flaky download, works on Windows.
- **Consequence:** `npx playwright test` passes 12/12 with mock; if Chrome missing, fallback to `msedge` or install browsers.

## ADR-013: Image size validation

- **Decision:** Client checks >8MB, server checks base64 decoded bytes >500B and <8MB, returns 413/400.codes.
- **Context:** Prevent invalid tiny icons (<500B) being sent; e2e needed 6KB dummy to pass; real photos always larger.
- **Consequence:** Error banner humanized, image kept for retry.

## ADR-014: Build config strict TS + bundler

- **Decision:** `tsconfig.app.json` includes `shared` with `moduleResolution: bundler`, `tsconfig.node.json` with `NodeNext` and `.js` extensions; `vite.config.ts` proxies `/api`.
- **Context:** Shared types used both server (NodeNext) and client (bundler); need dual strict handling.
- **Consequence:** `tsc -b` passes with no unused locals, etc.

## ADR-015: Mock vs Live visibility

- **Decision:** UI badge shows `MOCK` yellow vs `LIVE · gemini-3.8-flash` green, health endpoint exposes provider, server logs config.
- **Context:** Spec requires obvious way to determine whether app uses MOCK or LIVE; must not ship mock as default without visibility.
- **Consequence:** Playwright asserts badge contains MOCK|LIVE; manual curl verifies `/api/health`.

## ADR-016: Groq as second provider qwen/qwen3.8-27b

- **Decision:** Add Groq Qwen 3.8 27B (`qwen/qwen3.8-27b`) as second AI provider. Vision primary Gemini → Groq fallback; Recipes primary Groq → Gemini fallback. Model ID verified 2026-09-13 via https://console.groq.com/docs/models and https://console.groq.com/docs/model/qwen/qwen3.8-27b (preview, 131K context, 3 images/req, 20MB limit, supports vision + structured outputs strict:true + reasoning_effort none/low/medium/high).
- **Context:** Gemini free-tier quota restrictive; recipe generation does not need Gemini vision strength. Preserve Gemini quota for fridge scans. Groq SDK `groq-sdk` 1.6.0 official, OpenAI compatible `chat.completions.create` with `response_format: { type: "json_schema", json_schema: { strict, schema } }` and `reasoning_effort: "none"` + `reasoning_format: "hidden"` for non-thinking instruct behavior.
- **Consequence:** `server/config.ts` exports `GROQ_MODEL_ID`, `GROQ_API_KEY`, `isGroqAvailable()`; `.env.example` adds `GROQ_API_KEY=`; `shared/types.ts` ProviderName includes `groq`; both `GroqVisionProvider` and `GroqRecipeProvider` reuse same normalized validation as Gemini; never expose reasoning.

## ADR-017: Provider router chain (no scattered fallback)

- **Decision:** Introduce `server/providers/router.ts` with `VisionProviderChain` (Gemini→Groq) and `RecipeProviderChain` (Groq→Gemini), at most one fallback per operation, no loops.
- **Context:** Spec forbids scattering fallback through Express routes; requires explicit routing layer and quota-aware logic (only retryable 429/503/RATE_LIMITED/RESOURCE_EXHAUSTED/unavailable, not 400/INVALID_PAYLOAD/schema bugs).
- **Consequence:** Routes instantiate chain per request, check cache per provider, propagate `meta.provider` of ultimately serving provider, log fallback; injection-friendly for tests (mocked transports). Prevents burning Gemini quota on recipe path.

## ADR-018: Cache for quota-safe development

- **Decision:** Implement `server/cache.ts` in-memory Maps with SHA-256 keys: vision = hash(image bytes)+provider/model+promptVersion, recipe = hash(sorted canonicals+pantry)+provider/model+promptVersion. Max 100 entries each, LRU, no secrets, deep clone, `clearAllCaches()` + `DELETE/POST /api/cache` dev reset. Provider/model+version part of key prevents stale.
- **Context:** Limited free-tier quota; repeatedly testing same photo should not consume provider quota. Spec forbids Redis/DB for this phase.
- **Consequence:** Router checks cache before provider call and sets after success; second identical request returns `cached:true`; tests clear cache and verify isolation.

## ADR-019: Normalization display fix (canonical vs displayName)

- **Decision:** Fix `shared/normalization.ts` to never expose raw canonical snake_case. Added canonicals `cherry_tomato → Помидоры черри`, `yellow_tomato → Жёлтые помидоры`, `cutlet → Котлета` + aliases, and humanize fallback (`some_ingredient` → `Some Ingredient`). `getDisplayName` and `normalizeIngredient` now use `humanizeCanonical`.
- **Context:** Live screenshot exposed `Yellow tomato`, `Cherry_tomato`, `Cutlet` as raw IDs. Bug was fallback `input.charAt(0).toUpperCase ...` left underscore, and `getDisplayName` returned raw canonical if not in map.
- **Consequence:** UI chips always show Russian displayName or humanized fallback, never `snake_case`. Dedup via canonical Set remains. Future variant model (tomato variants sharing base canonical with variant field) documented but smallest correct fix kept distinct canonicals to avoid large ontology rewrite.

## ADR-020: Health diagnostics and dev provider indicator

- **Decision:** Extend `GET /api/health` to include `vision:{primary,fallback,geminiAvailable,groqAvailable}`, `recipes:{primary,fallback,groqAvailable,geminiAvailable}`, `models:{gemini,groq}`, `cache`. Responses include `meta:{provider,modelId,cached,primary,fallback}`. Frontend shows dev-only routing bar `VISION · GEMINI → GROQ · RECIPES · GROQ → GEMINI | last: VISION X RECIPES Y` when `import.meta.env.DEV`.
- **Context:** Spec requires safe metadata (provider/model) without secrets, and easy dev inspection without cluttering production UI.
- **Consequence:** Manual `curl /api/health` shows availability, UI badge supports groq (`LIVE · qwen/qwen3.8-27b`), dev bar helps verify fallback without exposing keys.

## ADR-021: Live verification isolated command

- **Decision:** Add `npm run test:live:groq` → `tsx server/liveVerifyGroq.ts`, isolated from `npm test` / CI / Playwright. Script checks keys, optionally loads `tmp/fridge.jpg`, runs Gemini vs Groq A/B on same image, saves sanitized comparison to `tmp/live-verify-comparison.json`, tests Groq recipes exactly 3.
- **Context:** Spec requires small live verification after GROQ_API_KEY installed, not benchmark, no global accuracy claim from one image, no quota burn in automated loops.
- **Consequence:** Normal tests remain deterministic mocked; live command must be run manually with key and photo.

## ADR-022: Z.AI GLM-4.6V-Flash as third vision benchmark provider

- **Decision:** Add Z.AI `glm-4.6v-flash` as third vision provider (`ZaiVisionProvider`) via direct HTTPS `https://api.z.ai/api/paas/v4/chat/completions` with `Authorization: Bearer ZAI_API_KEY`, `model: glm-4.6v-flash`, data URL image, prompt `zai-vision-v1` (same semantic rules as Gemini/Groq), `response_format: {type:"json_object"}` with fallback without, local Zod validation, dedup, normalization. Verified via https://docs.z.ai/guides/vlm/glm-4.6v (Lightweight, Completely Free, 128K context, Image/Video/Text/File) and https://docs.z.ai/api-reference/llm/chat-completion (enum includes `glm-4.6v-flash`, endpoint `/paas/v4/chat/completions`, vision content `image_url`). Free pricing but with rate/daily limits (codes 1302/1303/1304/1305/1308/1113, 429). Do not silently substitute other GLM.
- **Context:** Benchmark Z.AI vision vs Gemini/Groq on same real fridge image; production routing stays Gemini→Groq, recipes Groq→Gemini until evidence. Z.AI is OpenAI-compatible, simplest is direct fetch without large SDK.
- **Consequence:** `server/config.ts` adds `ZAI_MODEL_ID`, `ZAI_API_BASE`, `ZAI_VISION_PROMPT_VERSION`, `isZaiAvailable()` with ASCII/placeholder check; `.env.example` adds `ZAI_API_KEY=`; `shared/types.ts` ProviderName includes `zai`; `server/cache.ts` uses `zai-vision-v1` for ZAI prompt version (provider/model/promptVersion isolation); health shows `zaiAvailable` and `benchmarkProviders`; dev explicit provider selection via `?provider=zai` in `POST /api/fridge/analyze` when not production.

## ADR-023: Tri-provider live benchmark harness

- **Decision:** Add `server/liveVerifyVision.ts` (cache-aware, reuses `getVisionCache` for Gemini/Groq, only ZAI needs new request if image already cached) and npm scripts `test:live:vision` (all three) and `test:live:zai` (only ZAI). Artifact `tmp/live-vision-comparison.json` with `{image, models, providers:{gemini,groq,zai}, groundTruthNote, tableData}` and human table. Legacy `test:live:groq` kept. No quota burn on second run of same image (cached:true).
- **Context:** Spec requires same-image A/B/C benchmark, not re-calling Gemini/Groq if cached, only ZAI new, sanitized JSON without keys, manual evaluation of cucumbers/yellow tomatoes/cherry tomatoes/cutlets/cheese and package on right should be omitted.
- **Consequence:** `npm run test:live:vision [-- ./photo.jpg]` / `npm run test:live:zai` isolated from CI; second run hits cache; manual table `Provider | Correct | False Positive | Misses | User Corrections` filled by human.

## ADR-024: ZAI error mapping and health diagnostics

- **Decision:** Map Z.AI business codes 1302 rate limit, 1303 high frequency, 1304 daily limit, 1305 overloaded, 1308 usage limit, 1113 insufficient balance (plus HTTP 429/503) to `RATE_LIMITED` semantics; 1214 invalid param triggers retry without `response_format`; ByteString (non-ASCII key) mapped to 401 invalid key with hint to check `ZAI_API_KEY` is ASCII. Health `GET /api/health` exposes `zai:{available, model, apiBase}` and `vision.available.zai` without secrets.
- **Context:** Z.AI docs list codes via https://docs.z.ai/api-reference/api-code ; free model still has daily/usage limits; transient limits should be visible, not silent fallback loops.
- **Consequence:** Benchmark harness reports ZAI limits explicitly rather than silently replacing with another provider; fridge route maps ZAI 429/overloaded to 429, invalid key to 401.

## ADR-025: Live tri-benchmark result and routing decision deferral

- **Decision:** Keep production vision routing `Gemini → Groq` unchanged in this pass despite single-image evidence that ZAI (`glm-4.6v-flash`) outperformed Groq (`qwen/qwen3.8-27b`) on the same fridge (ZAI 4/4 correct fine-grained, 1 correction for cheese; Groq 3/4 correct, 1 false positive `yellow_bell_pepper` misclassifying yellow tomato, English display fallback, 3 corrections). Gemini was not comparable due to daily 20 quota `RESOURCE_EXHAUSTED`.
- **Context:** Single-image benchmark on `tmp/fridge.jpg` (138818 bytes, cucumbers, yellow tomatoes, red/cherry tomatoes, cutlets with melted cheese, package on right) via `npm run test:live:vision` (cache-aware). Groq strict schema 400 (`quantityGuess`/`reason` not in `required`) fell back to best-effort; ZAI 1305 overloaded transient but succeeded on retry. Ground truth not hardcoded into prompts, only for manual evaluation. Next routing `Gemini → ZAI → Groq` suggested but requires second image + quota-free Gemini day.
- **Consequence:** No automatic routing change; `VisionProviderChain` remains Gemini→Groq; ZAI remains `benchmarkProviders` and `?provider=zai` dev endpoint. Live artifact `tmp/live-vision-comparison.json` saved without keys for evidence. Do not claim global accuracy from one image.
