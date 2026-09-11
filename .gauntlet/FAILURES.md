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

## Next Watch
- If live Gemini returns `NO_FOOD_DETECTED` too often, tune vision prompt confidence threshold or add `mediaResolution` param.
- If recipe generation fails slot validation (duplicate slots), add retry or repair step.
