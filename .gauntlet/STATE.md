# STATE.md — Holodilnik Checkpoint

## Current Checkpoint: BUILD CHECKPOINT READY — Mock + Live Adapter Complete

**Date:** 2026-09-12
**Branch / Commit:** initial build (no git yet, to be `git init` + commit)

### What Works End-to-End (mock, no key required)
- Landing → Photo (camera + upload, preview+replace) → Analyzing → Ingredients → Recommendations (exactly 3) → Recipe Detail
- Mock flow deterministic: eggs/tomatoes/cheese/chicken/zucchini/sour cream + uncertain yogurt/greens; recipes: Омлет 10мин, Курица с кабачком 25мин, Запеканка 35мин
- Ingredient normalization: tomatoes→tomato, eggs→egg, sweet pepper→bell_pepper etc. with separate displayName
- Pantry staples: salt, black_pepper, vegetable_oil only — not assumed cream/cheese/rice etc.
- Recommendations validation: pantry-aware, missingIngredients computed, never shows `Всё есть` when missing, exactly 3 slots validated distinct
- Error UI: invalid image (<500B), too large (>8MB), no food (422), rate limit (429), provider parse failure (502), network — retry keeps image, banners humanized
- Mobile-first: 390px primary, verified 360/430/desktop, no dense dashboard
- Security: `GEMINI_API_KEY` server-only, no `VITE_` variant, browser calls `/api/*` only, `.env.example` committed, `.env*.local` gitignored
- Tests: 20 unit (shared + mock) + 12 e2e (chromium+mobile) — all green without quota
- Build: `tsc -b && vite build` passes, 238kB JS gz 74kB

### Architecture
```
Browser (React Vite) --/api--> Express (port 3001) --@google/genai--> Gemini 3.8 Flash
                             shared/* (schemas, normalization, pantry, validation)
```
- Providers: `server/providers/types.ts` → `mock*` vs `gemini*` (vision low, recipe medium thinking)
- Structured outputs: `responseMimeType: application/json` + `responseJsonSchema: z.toJSONSchema(...)` with manual fallback
- Server validates payloads via Zod, checks base64 size, maps provider errors to controlled codes

### Gemini Adapter Status
- **Verified live adapter exists:** `server/providers/geminiVision.ts` + `geminiRecipe.ts` using `gemini-3.8-flash`, `thinkingLevel` low/medium, no temperature/topP, no minimal
- **Model ID locked:** `server/config.ts` `modelId = "gemini-3.8-flash"`; do not silently switch
- Docs verified: https://ai.google.dev/gemini-api/docs/latest-model , DeepMind model card 2026-09-02, js-genai docs `responseJsonSchema`/`responseMimeType`

### How to Go Live (precise instructions required by spec)

**FILE TO CREATE:** `<repository root>/.env.local` (e.g. `D:\Programms\Max\Holodilnik\.env.local`)

**CONTENTS:**
```
GEMINI_API_KEY=PUT_YOUR_REAL_KEY_HERE
```

**Where to obtain key:**
- https://aistudio.google.com/apikey → Create API key (Google AI Studio, same key works for `generativelanguage.googleapis.com`)
- Or Google Cloud Console → APIs & Services → Credentials → Create API key for Vertex? For this app use AI Studio key.

**COMMAND TO RUN** (after creating file, from repo root):
```
npm run dev
```
Or separate:
```
npm run dev:server
npm run dev:client
```
Then open http://localhost:5173

**LIVE VERIFICATION** (prove not mock):
1. `curl http://localhost:3001/api/health` → should show `{"provider":"gemini","mockMode":false,...}` instead of mock
2. UI header badge: should show `LIVE · gemini-3.8-flash` (green) not `MOCK` (yellow)
3. Upload a real fridge photo → Analyze → recipes should vary with photo content (not always same 6 mock ingredients) and `meta.provider` in network response (`/api/fridge/analyze`) is `gemini`
4. Server log on start: `[config] GEMINI_API_KEY set -> running in LIVE GEMINI mode` (if not, check .env.local path)

If no key exists, app continues in mock — no blocking.

### Quality Gates (last run)
```
npm run typecheck   ✓
npm run lint        ✓
npx prettier --check .  ✓
npm run test        ✓ 20/20
npm run build       ✓
npx playwright test --reporter=list  ✓ 12/12 (chromium+mobile, workers=2, channel:chrome, mock)
```

### Next Gauntlet Phase (after key installed)
- Real fridge image testing (vision prompt refinement)
- Recipe quality eval (slot differentiation, timing accuracy)
- UI refinement (desktop polish, accessibility)
- Final autonomous critic loop

### Known Notes
- Tiny 1x1 png (<500B) rejected as INVALID_IMAGE by design; e2e uses 6KB dummy to pass; real photos always >8KB so fine
- Playwright uses system Chrome via `channel:"chrome"` to avoid download flakiness; if Chrome missing, install or switch to `msedge`
- Do not commit `.env.local` — already gitignored

### For Next Agent
- Do not rewrite git history, do not commit secrets
- Keep `server/config.ts` modelId unchanged
- See DECISIONS.md for ADRs, FAILURES.md for tried paths
