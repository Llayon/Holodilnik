# AGENTS.md — Holodilnik

## Project: Holodilnik (Mobile-first AI Cooking App)

### Stack
- Node 24+
- React 19, Vite 8, TypeScript strict
- Vitest 3, Playwright 1.55, ESLint 9, Prettier 3
- Server: Express 5, Zod 4, @google/genai 1.x
- Model: `gemini-3.8-flash` (GA 2026-09-02) — verified via https://ai.google.dev/gemini-api/docs/latest-model

### Architecture
```
Browser (React)  →  Our Server API (Express)  →  Gemini API
                    GEMINI_API_KEY server-only
```

- Never expose key to client. No `VITE_GEMINI_API_KEY`.
- Client calls `/api/fridge/analyze` (POST {imageBase64, mimeType}) and `/api/recommendations` (POST {ingredients})
- Server validates with Zod, checks size (8MB), returns controlled errors.

### Providers
- Interfaces: `VisionProvider`, `RecipeProvider` in `server/providers/types.ts`
- Implementations:
  - `MockVisionProvider` / `MockRecipeProvider` — deterministic, 600-800ms delay, no quota
  - `GeminiVisionProvider` / `GeminiRecipeProvider` — uses `@google/genai` with structured outputs

### Gemini Integration Details (verified current SDK)
- SDK: `import { GoogleGenAI } from "@google/genai"` (official JS SDK, not deprecated `@google/generative-ai`)
- Init: `new GoogleGenAI({ apiKey: GEMINI_API_KEY })`
- Model ID: `gemini-3.8-flash` — confirmed via DeepMind Model Card and Google AI docs (see DECISIONS.md)
- Vision call:
  ```ts
  ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }]}],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: z.toJSONSchema(fridgeAnalysisSchema),
      thinkingConfig: { thinkingLevel: "low" }
    }
  })
  ```
- Recipe call similar with `thinkingLevel: "medium"`
- Note: Gemini 3.8 does NOT support `minimal` thinking, only `low`/`medium`/`high` (default medium). Removed deprecated `temperature`/`top_p`.
- Structured outputs use `responseMimeType` + `responseJsonSchema` (Zod 4 native `z.toJSONSchema`). Fallback manual JSON Schema if not available.

### Shared Domain
- `shared/types.ts` — domain types
- `shared/schemas.ts` — Zod schemas, JSON Schema generation
- `shared/normalization.ts` — canonical ↔ displayName, aliases (plural, ru/en), `SUGGESTIBLE_INGREDIENTS`
- `shared/pantry.ts` — `salt`, `black_pepper`, `vegetable_oil` only
- `shared/validation.ts` — `validateRecipeAvailability` (pantry-aware), `validateRecommendationsSlots` (exactly 3 distinct slots)
- `shared/mockData.ts` — deterministic mock fridge + recipes

### Frontend Flow (vertical slice)
LANDING → PHOTO → ANALYZING → INGREDIENTS → RECOMMENDATIONS (exactly 3) → RECIPE DETAIL
- Landing: `Покажи холодильник — подберём, что приготовить.` CTA `Сфотографировать холодильник` + `Загрузить фото`
- Photo: preview + replace, camera capture via `capture="environment"`
- Analyzing: `Смотрю, что у тебя есть…` spinner, keeps preview
- Ingredients: `Вот что я нашёл` chips removable, uncertain as `Возможно ещё: йогурт` tap to add, `+ Добавить` input, suggest chips
- Recommendations: 3 cards with slots `САМОЕ БЫСТРОЕ` / `НОРМАЛЬНЫЙ УЖИН` / `ИЗ ТОГО, ЧТО ЕСТЬ`, shows `Всё есть` or missing, computed deterministically
- Recipe: steps 2-7 short, never shows `Всё есть` if missing, pantry handled

### Server Endpoints
- `POST /api/fridge/analyze` — validates base64, mime, size, provider (mock or gemini), returns 400/413/422/429/502 with codes
- `POST /api/recommendations` — validates ingredients, returns exactly 3
- `GET /api/health` / `GET /api/fridge/status` — provider info for UI badge
- SPA fallback serves `dist/index.html` in prod

### Error Handling
- invalid image, too large, no food, rate limit, invalid structured response, network — all map to UI banners, retry keeps image
- Never leak provider credentials or raw internal errors

### Security
- `.env.example` contains `GEMINI_API_KEY=` (committed)
- `.env`, `.env.local`, `.env.*.local` ignored via `.gitignore`
- Secret expected at `<repo>/.env.local` — never committed, never pasted in chat

### Tests
- Unit: `shared/*.test.ts`, `server/providers/mock.test.ts` — no quota
- E2E: `e2e/app.spec.ts` — 12 tests (chromium+mobile) covering landing, upload, analyze, removal, addition, 3 recipes, detail, failure, 360/390/430/desktop
- Playwright uses `channel: "chrome"` to reuse system Chrome (no download needed), workers=2, fullyParallel=false
- Mock mode forced via `MOCK_MODE=true` in playwright webServer

### Scripts
- `npm run dev` — concurrently server + client
- `npm run dev:server` — `tsx watch server/index.ts`
- `npm run dev:client` — `vite --port 5173`
- `npm run build` — `tsc -b && vite build`
- `npm run lint` / `format` / `typecheck` / `test` / `test:e2e`

### Env/Model Notes
- Model `gemini-3.8-flash` verified GA 2026-09-02, context 1M, output 65k, thinkingLevel low/medium/high
- Do not silently switch model — all provider code uses `config.modelId = "gemini-3.8-flash"`

### For Next Agent
- See `.gauntlet/STATE.md` for current checkpoint
- See `.gauntlet/DECISIONS.md` for ADRs
- See `.gauntlet/FAILURES.md` for known issues tried
