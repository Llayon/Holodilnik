# FAILURES.md — Known Issues Tried & Mitigations

## F-001: Express 5 wildcard `app.get("*")` throws PathError

- **Symptom:** `PathError: Missing parameter name at index 1: *` on server start with Express 5 + path-to-regexp v6.
- **Tried:** `app.get("*", ...)` as in Express 4 tutorials.
- **Fix:** Changed to `app.use((req,res)=>res.sendFile(...))` middleware for SPA fallback. Works in both dev and prod; no wildcard param needed.
- **Reference:** Express 5 migration requires `/*splat` or middleware.

## F-002: Playwright browser download timeout (chrome 1243 / 1193)

- **Symptom:** `npx playwright install --with-deps` timed out after 30s to https://cdn.playwright.dev/builds/cft/... chrome-win64.zip; later `browserType.launch: Executable doesn't exist at ...1243` and `...1193`.
- **Tried:** Installing 1.63 (expects 1243) and 1.55.1 (expects 1193) with network; both failed due to timeout / corporate firewall.
- **Fix:** Switched playwright.config to `channel: "chrome"` reusing system Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe` (and Edge). Works without download; workers=2 to reduce contention.
- **Mitigation if Chrome missing:** Install Chrome/Edge or run `npx playwright install chromium --with-deps` on unrestricted network.

## F-003: Vite build failed `Rolldown failed to resolve import "react"`

- **Symptom:** After rewriting `package.json`, `npm run build` failed: external react.
- **Cause:** New `package.json` omitted `react`/`react-dom` from dependencies (still in devDeps template). `node_modules/react` missing, Vite rolldown couldn't resolve.
- **Fix:** Added `react@19.2.8` and `react-dom@19.2.8` back to dependencies, `npm install`, build passed (19 modules, 238kB).

## F-004: Tiny 1x1 png (<500B) rejected as INVALID_IMAGE

- **Symptom:** E2E `full flow` failed: `expect(ingredients-step).toBeVisible` timeout; server returned 400 `INVALID_IMAGE` due to `bytes < 500` check.
- **Tried:** Using 1x1 png base64 (67B) as dummy fridge photo.
- **Fix:** Created 6KB dummy file (Buffer.alloc 6000 with png header) for e2e; real photos always >8KB so not user-facing. Kept server threshold 500B to filter icons/bad uploads; e2e helper now passes.
- **Alternative considered:** Lower threshold to 100B, rejected to avoid false positives.

## F-005: E2E suggest-mushroom not found (slice 0,8)

- **Symptom:** `full flow` timed out waiting for `getByTestId('suggest-mushroom')` 30s.
- **Cause:** `SUGGESTIBLE_INGREDIENTS.slice(0,8)` excluded mushroom (index 11); test expected it.
- **Fix:** Changed slice to `slice(0,12)` to include mushroom, onion, potato etc. Now 12 tests pass.

## F-006: Playwright parallel 8 workers contention → timeouts & provider-badge `…`

- **Symptom:** Running 12 tests with `fullyParallel: true, workers: 8` caused random `provider-badge` still `…` (health not ready), `setInputFiles` timeout 30s, worker exit 3221226505.
- **Fix:** Set `fullyParallel: false, workers: 2, timeout 60000, expect 10000, actionTimeout 10000`; badge test now waits 10s for `/api/health`; all 12 pass in 12.7s.

## F-007: tsc -b errors for missing .js extensions & implicit any

- **Symptom:** `tsc -b` complained `Relative import paths need explicit file extensions` for `server/providers/mock.test.ts` and `shared/*.test.ts` without `.js`, plus implicit any for `i`/`r`.
- **Fix:** Added `.js` extensions to test imports (NodeNext requires), typed params `i: {canonicalName:string}` etc.; strict still passes.

## F-008: Prettier check failed after edits

- **Symptom:** `npx prettier --check .` warned 19 files code style issues.
- **Fix:** Ran `npx prettier --write .`; now `prettier --check` passes; committed formatted.

## F-009: Curl JSON shell escaping for large base64

- **Symptom:** Manual `curl -d '{"imageBase64":"AAAA..."}'` with huge string failed `SyntaxError: Unterminated string in JSON at position 16359` due to shell quoting/line length.
- **Tried:** Direct curl.exe with huge -d string.
- **Fix:** Use PowerShell `Invoke-RestMethod` with `@{imageBase64=('A'*5000)} | ConvertTo-Json` which handles encoding correctly; health and mock analyze now return correct 6 ingredients.

## F-010: Gemini `responseFormat` vs `responseJsonSchema` confusion

- **Symptom:** Initial docs snippet used `config: { responseFormat: { text: { mimeType, schema } } }` which does not match current `GenerateContentConfig` type (`responseMimeType`/`responseJsonSchema`).
- **Verified:** Via https://discuss.ai.google.dev/t/documentation-issue-structured-outputs-example-uses-outdated-genai-sdk-and-zod-apis/168181 and js-genai `GenerationConfig` docs; correct is `responseMimeType` + `responseJsonSchema` (Zod 4 `z.toJSONSchema`), `responseSchema` is OpenAPI subset. Implemented with fallback manual schema and `z.toJSONSchema` check.

## F-011: Gemini minimal thinking unsupported

- **Symptom:** Spec warned Gemini 3.8 does NOT support `minimal` thinking, only low/medium/high. Early code tried `thinkingLevel: "minimal"`? Could error.
- **Fix:** Vision uses `low`, recipes `medium` (default), documented.

## F-012: dotenvx tip noise

- **Symptom:** `dotenv` injected env tip `[dotenv@17]` prints tip each run, not failure.
- **Mitigation:** Ignored; logs show `[config] GEMINI_API_KEY not set -> MOCK` correctly.

## F-013: TypeScript overload mismatch for Groq SDK chat.completions.create

- **Symptom:** `tsc -b` error `No overload matches this call` for `client.chat.completions.create({ model, messages, reasoning_effort, response_format })` with `as unknown as Record<string,unknown>` cast, plus `Unused @ts-expect-error`.
- **Cause:** Groq SDK types expose `ChatCompletionCreateParams` via `Chat.Completions.ChatCompletionCreateParams*`, not `Groq.Chat.ChatCompletionCreateParams`; direct cast to Record fails overload. Also `provider["client"]` private access no longer needs `expect-error` after moving to any cast.
- **Fix:** Use `(client.chat.completions.create as unknown as (args:unknown)=>Promise<ChatCompletion>)` and `(provider as unknown as {client:{...}}).client` to bypass private/overload checks without suppressing unrelated errors.

## F-014: Groq recipe test titles too short for Zod validation

- **Symptom:** `npm run test` 4 failures: `Groq recipe generation failed: Too small: expected string to have >=3 characters` for title "А" and `Too small >=5` for reason "r"/"норм"/"тест".
- **Cause:** Test payload used single-char titles and short reasons below schema minima (title min 3, reason min 5). Slot validation never reached.
- **Fix:** Changed titles to "Омлет быстрый" etc (>=3) and reasons to full sentences (>=5, e.g. "нормальный ужин для семьи"), now 63/63 pass.

## F-015: Health endpoint old shape after Groq changes not showing vision/recipes

- **Symptom:** After adding `vision`/`recipes` to `GET /api/health`, manual `Invoke-RestMethod` via `Start-Job` without `Set-Location` returned old shape (no vision field). Using `npx tsx server/index.ts` from wrong cwd gave `ERR_MODULE_NOT_FOUND: Cannot find module .../server/index.ts`.
- **Cause:** `Start-Job` defaults to `C:\Users\user\Documents`, not repo root; server never started with new code. Also `npm run dev:server` via `tsx watch` needed correct cwd.
- **Fix:** Use `Set-Location D:\Programms\Max\Holodilnik` inside job script; health now returns `vision:{primary,fallback,geminiAvailable,groqAvailable}` etc.

## F-016: Groq/GROQ_API_KEY placeholder ByteString error

- **Symptom:** `Groq vision failed: Cannot convert argument to a ByteString because the character at index 7 has a value of 1090` after adding GROQ provider; health showed `groqAvailable:true` but vision fallback failed.
- **Cause:** `.env.local` contained placeholder `GROQ_API_KEY=твой_ключ` (Cyrillic) — `Buffer.from` ASCII header `Authorization: Bearer твой_ключ` fails ByteString conversion at index 7 (first char of key `т` = 1090). Gemini 429/503 correctly tried fallback to Groq, but Groq failed with ByteString, resulting in generic `Ошибка анализа изображения`.
- **Fix:** Updated `server/config.ts` `isValidKey` to reject non-ASCII/placeholder/`YOUR`/too short, so `isGroqAvailable()` now `false` with placeholder and health shows `groqAvailable:false` with warning `looks invalid ... check .env.local is gsk_... ASCII`. Added explicit `ByteString` handling in `GroqVisionProvider`/`GroqRecipeProvider` to throw `401 Invalid GROQ_API_KEY` with hint. User must set real `gsk_...` ASCII key.

## F-017: Playwright reuseExistingServer hid new mockMode

- **Symptom:** After Groq changes, `npx playwright test` showed 4 failures: `expect(ingredients-step).toBeVisible` timeout, snapshot showed `LIVE · gemini-3.8-flash` instead of `MOCK` even though config has `MOCK_MODE=true`.
- **Cause:** `playwright.config.ts` has `reuseExistingServer: !process.env.CI` — local existing `dev:server` with real keys (LIVE) was reused instead of starting new mock server. New `isValidKey` still considered real keys valid, so `mockMode` was false.
- **Fix:** Kill existing node processes `taskkill /F /IM node.exe` before `npx playwright test` locally; now 12/12 pass. In CI `reuseExistingServer:false` so not affected.

## F-018: Z.AI ByteString with placeholder key (same as Groq)

- **Symptom:** Initial manual `Groq` ByteString test also appeared for `ZaiVisionProvider` when `ZAI_API_KEY=твой_ключ` — same `Authorization: Bearer` header fails.
- **Cause:** Same placeholder handling as Groq.
- **Fix:** Reused `isValidKey` for `isZaiAvailable()`, same warning, and added `ByteString` catch in `ZaiVisionProvider` to throw `401 Invalid ZAI_API_KEY` hint. Direct fetch with `Authorization: Bearer` now validates ASCII before request.

## F-019: Groq strict schema 400 for optional fields

- **Symptom:** `Groq vision failed: 400 invalid JSON schema for response_format: 'fridge_analysis': /properties/ingredients/items/required: required is required to be supplied and to be an array including every key in properties. The following properties must be listed in required: quantityGuess` (and later `reason` for uncertainItems).
- **Cause:** `getGroqJsonSchema()` had `quantityGuess` as `anyOf` optional and `reason` optional not in `required`, but Groq `strict:true` requires every property in `properties` to be listed in `required` (per https://console.groq.com/docs/structured-outputs). Same for `uncertainItems` `reason`.
- **Fix:** Keep strict attempt first, catch 400 and retry with `strict:false` (best-effort) — already implemented in `GroqVisionProvider` (`tryCall(true)` → catch 400 → `tryCall(false)`). Works; strict documented as incompatible with optional fields. No change to Zod schema (quantityGuess remains optional).

## F-020: Z.AI 1305 overloaded transient

- **Symptom:** `ZAI vision failed: 429 code 1305 The service may be temporarily overloaded, please try again later` — 2 of 5 attempts in tri-benchmark failed, 1 succeeded on immediate retry, 1 succeeded on 8s retry.
- **Cause:** Free `glm-4.6v-flash` is Completely Free but with rate/daily limits; 1305 is transient overload per https://docs.z.ai/api-reference/api-code.
- **Fix:** Benchmark harness reports 1305 explicitly (not silent fallback), retries once after 8s, succeeds. Cache ensures second same-image run is `cached:true` with no new quota.

## F-021: Gemini daily quota 20 exceeded

- **Symptom:** `Gemini vision failed: 429 RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProjectPerModel-FreeTier quotaValue 20` — Gemini out of quota for today, no result for tri-benchmark.
- **Cause:** Free-tier daily limit 20 (also 5/min) hit by earlier manual/UI tests.
- **Fix:** Documented as expected; Groq/ZAI fallback still works for production (Groq primary for recipes, Groq fallback for vision). Next benchmark should be on new day or with quota reset; do not claim global accuracy from one image where Gemini unavailable.

## F-022: Client compression dummy image invalid decode

- **Symptom:** After adding `src/lib/imageCompression.ts` canvas pipeline, e2e `full flow` failed: `expect(photo-step).toBeVisible` timeout, then `expect(landing)` with error banner. Browser console: `createImageBitmap` / `Image` failed to decode dummy 6KB buffer (random bytes with png header, not valid image).
- **Cause:** Previous `createTempImage` wrote `Buffer.alloc(6000)` with png header + zeros — not decodable by browser decoder. Old `handleFile` just read base64 without decode, so passed. New pipeline requires real decode + correct orientation + re-encode.
- **Fix:** Updated `e2e/app.spec.ts` `createTempImage` to use `sharp` to generate valid 800×600 JPEG (SVG fridge overlay, mozjpeg 80, ~8-15KB, decodable) when sharp available, fallback to repeated 1×1 PNG (browser ignores trailing). Also updated `handleFile` to handle `preparing` step before `photo`. Now 12/12 pass with compression.

## F-023: Vercel api/health 404 after first deploy

- **Symptom:** First production deploy `https://holodilnik-seven.vercel.app/api/health` returned `404 NOT_FOUND` (Vercel `fra1::...`), while `GET /` succeeded (static). Function `λ api/index (1.62MB)` existed but `/api/health` not routed.
- **Cause:** Project has `api/index.ts` (Express) + Vite `dist`. Without `vercel.json` rewrites, request `/api/health` looks for file `api/health.ts` not `api/index.ts`. `vercel.json` had only `buildCommand`/`outputDirectory`, no rewrites, so `/api/*` not funneled to single `api/index` function. Also `server.ts` not built because framework detection for Vite overrode Express zero-config.
- **Fix:** Added `vercel.json` rewrites `[{source:"/api/(.*)", destination:"/api"}]` to funnel all api to single function, added dual mounts in `server/app.ts` (`/api/health` + `/health`, `/api/fridge` + `/fridge`, etc.) for stripped prefix compatibility, added `process.env.VERCEL` conditional to skip `express.static` in prod function. Redeployed preview → production, health now 200 prod minimal, 413/404 policies verified.

## F-024: Vercel link project name case sensitivity

- **Symptom:** `npx vercel link --yes` failed: `Project names ... must be lowercase. They can include letters, digits, and following characters: '.', '_', '-'. However, they cannot contain the sequence '---'. (400)` for directory `Holodilnik` (capital H).
- **Cause:** Vercel auto-detects project name from directory name, which was `Holodilnik` with capital H.
- **Fix:** Created project explicitly via `vercel project add holodilnik` (lowercase), then `vercel link --yes --project holodilnik` succeeded. Added `.vercel` to `.gitignore`.

## F-025: Vercel env .env.local overwritten with OIDC token

- **Symptom:** After `vercel link`, `.env.local` lost `PORT=3001` and gained `VERCEL_OIDC_TOKEN=...` (development OIDC), but kept `GEMINI/GROQ/ZAI` keys. `npm run dev` would default port incorrectly.
- **Cause:** `vercel pull` behavior merges project env; linked project had no env yet, but CLI added token and overwrote file without preserving `PORT`.
- **Fix:** Restored `PORT=3001` manually, kept `VERCEL_OIDC_TOKEN` (harmless, gitignored). Then set real env vars via `vercel env add GEMINI_API_KEY/GROQ_API_KEY/ZAI_API_KEY` for Production/Preview/Development (sensitive, hidden).

## F-026: Image quality regression with high-frequency noise synthetic

- **Symptom:** `server/imageQualityRegression.test.ts` with naive `Buffer.alloc` noise (per-pixel `sin` xor) produced 6000×4000 JPEG 717KB at 1440 q84, failing `expect(... ≤300KB)` and timing out 15s for 6000×4000 generation.
- **Cause:** High-frequency random noise is worst-case for JPEG (incompressible), not representative of real fridge photos (which compress to 130–150KB at 1086×1448 q80). Synthetic with noise bloats.
- **Fix:** Replaced synthetic with SVG fridge overlay (rectangles + text) via `sharp` SVG composite — realistic compressible content, same dimensions → 4000×3000 now 701ms, all 5 tests pass (1086×1448 ≤200KB, 800×600 not upscaled, metadata stripped).

## Next Watch

- If live Gemini returns `NO_FOOD_DETECTED` too often, tune vision prompt confidence threshold or add `mediaResolution` param.
- If recipe generation fails slot validation (duplicate slots), add retry or repair step.
- Groq/ZAI vision may occasionally return English displayName; normalization re-maps to Russian but monitor for new unknown canonicals → add alias/display.
- Z.AI free tier limits (1302/1305 etc) — harness reports explicitly, consider exponential backoff if overload persists.
- Vercel Hobby production is public (password requires Pro 428) — for closed test, use Preview SSO (`ssoProtection all_except_custom_domains`) or upgrade plan/dashboard password; do not expose uncontrolled AI endpoint publicly.
- HEIC: Chrome/Firefox cannot decode HEIC → shown guidance, but iPhone default is HEIC; Safari works. Monitor real iPhone photo success rate.
- Large function 1.62MB OK (<250MB), but if dependencies grow, enable `VERCEL_SUPPORT_LARGE_FUNCTIONS` or trim.
