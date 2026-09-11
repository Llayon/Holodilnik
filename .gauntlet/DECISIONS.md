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
