import { useEffect, useRef, useState } from "react";
import "./index.css";
import {
  analyzeFridge,
  getRecommendations,
  checkHealth,
  humanizeApiError,
  isApiError,
} from "./lib/api";
import type { FridgeAnalysisResult, Recipe } from "../shared/types";
import { SLOT_LABELS } from "../shared/types";
import { normalizeIngredient } from "../shared/normalization";
import { SUGGESTIBLE_INGREDIENTS } from "../shared/normalization";

type Step = "landing" | "photo" | "analyzing" | "ingredients" | "recommendations" | "recipe";

export default function App() {
  const [step, setStep] = useState<Step>("landing");
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageMime, setImageMime] = useState<string>("image/jpeg");
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<FridgeAnalysisResult | null>(null);
  const [ingredients, setIngredients] = useState<
    Array<{ canonicalName: string; displayName: string }>
  >([]);
  const [uncertain, setUncertain] = useState<
    Array<{ canonicalName: string; displayName: string; reason?: string }>
  >([]);
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingRecs, setLoadingRecs] = useState(false);
  const [providerMode, setProviderMode] = useState<"mock" | "gemini" | "groq" | "unknown">(
    "unknown",
  );
  const [modelId, setModelId] = useState<string>("");
  const [healthVision, setHealthVision] = useState<string | null>(null);
  const [healthRecipes, setHealthRecipes] = useState<string | null>(null);
  const [lastVisionProvider, setLastVisionProvider] = useState<string | null>(null);
  const [lastRecipeProvider, setLastRecipeProvider] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    checkHealth()
      .then((h) => {
        const mode = h.mockMode ? "mock" : (h.provider as "gemini" | "groq" | "mock");
        setProviderMode(mode ?? "unknown");
        setModelId(h.modelId);
        if (h.vision)
          setHealthVision(
            `${h.vision.primary.toUpperCase()}${h.vision.fallback ? ` → ${h.vision.fallback.toUpperCase()}` : ""}`,
          );
        if (h.recipes)
          setHealthRecipes(
            `${h.recipes.primary.toUpperCase()}${h.recipes.fallback ? ` → ${h.recipes.fallback.toUpperCase()}` : ""}`,
          );
      })
      .catch(() => setProviderMode("unknown"));
  }, []);

  const handleFile = (file: File) => {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Пожалуйста, выберите изображение");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("Фото слишком большое (максимум 8 МБ). Попробуйте другое.");
      return;
    }

    setImageMime(file.type || "image/jpeg");
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is data URL
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      setImageBase64(base64);
      setImagePreviewUrl(result);
      setStep("photo");
    };
    reader.readAsDataURL(file);
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    // reset so same file can be picked again
    e.target.value = "";
  };

  const triggerAnalyze = async () => {
    if (!imageBase64) {
      setError("Сначала выберите фото");
      return;
    }
    setError(null);
    setStep("analyzing");
    try {
      const { data, meta } = await analyzeFridge({ imageBase64, mimeType: imageMime });
      setProviderMode(meta.provider as never);
      setModelId(meta.modelId);
      setLastVisionProvider(meta.provider);
      setAnalysis(data);
      setIngredients(
        data.ingredients.map((i) => ({
          canonicalName: i.canonicalName,
          displayName: i.displayName,
        })),
      );
      setUncertain(data.uncertainItems);
      setStep("ingredients");
    } catch (e) {
      const msg = humanizeApiError(e);
      setError(msg);
      // If invalid image or no food, stay on photo but show error, keep image
      if (isApiError(e) && (e.code === "NO_FOOD_DETECTED" || e.code === "INVALID_IMAGE")) {
        // keep preview, go to photo step
        setStep("photo");
      } else {
        // for other errors, stay on photo with retry
        setStep("photo");
      }
    }
  };

  const removeIngredient = (canonical: string) => {
    setIngredients((prev) => prev.filter((i) => i.canonicalName !== canonical));
  };

  const addUncertain = (item: { canonicalName: string; displayName: string }) => {
    setIngredients((prev) => {
      if (prev.some((p) => p.canonicalName === item.canonicalName)) return prev;
      return [...prev, item];
    });
    setUncertain((prev) => prev.filter((u) => u.canonicalName !== item.canonicalName));
  };

  const addCustomIngredient = () => {
    const val = addInputRef.current?.value.trim();
    if (!val) return;
    const norm = normalizeIngredient(val);
    if (ingredients.some((i) => i.canonicalName === norm.canonicalName)) {
      if (addInputRef.current) addInputRef.current.value = "";
      return;
    }
    setIngredients((prev) => [...prev, norm]);
    if (addInputRef.current) addInputRef.current.value = "";
  };

  const handleRecommend = async () => {
    if (ingredients.length === 0) {
      setError("Добавьте хотя бы один ингредиент");
      return;
    }
    setError(null);
    setLoadingRecs(true);
    try {
      const { data, meta } = await getRecommendations({ ingredients });
      setProviderMode(meta.provider as never);
      setModelId(meta.modelId);
      setLastRecipeProvider(meta.provider);
      setRecipes(data.recipes as unknown as Recipe[]);
      setStep("recommendations");
    } catch (e) {
      setError(humanizeApiError(e));
    } finally {
      setLoadingRecs(false);
    }
  };

  const openRecipe = (r: Recipe) => {
    setSelectedRecipe(r);
    setStep("recipe");
    window.scrollTo(0, 0);
  };

  const resetToLanding = () => {
    setStep("landing");
    setImageBase64(null);
    setImagePreviewUrl(null);
    setAnalysis(null);
    setIngredients([]);
    setUncertain([]);
    setRecipes(null);
    setSelectedRecipe(null);
    setError(null);
  };

  // Dev-only provider routing diagnostics (not user-facing infrastructure)
  const isDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="logo">Холодильник</div>
        <div
          className={`mock-badge ${providerMode === "mock" ? "mock" : providerMode === "gemini" || providerMode === "groq" ? "live" : ""}`}
          data-testid="provider-badge"
        >
          {providerMode === "mock"
            ? "MOCK"
            : providerMode === "gemini" || providerMode === "groq"
              ? `LIVE · ${modelId}`
              : "…"}
        </div>
      </header>
      {isDev && (healthVision || healthRecipes) && (
        <div
          style={{
            fontSize: 10,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--muted)",
            textAlign: "center",
            padding: "4px 8px",
            background: "var(--bg-subtle, #f8f8f8)",
            borderBottom: "1px solid var(--border, #eee)",
          }}
          data-testid="dev-provider-routing"
        >
          {healthVision && <span>VISION · {healthVision}</span>}
          {healthVision && healthRecipes && <span style={{ margin: "0 8px" }}>·</span>}
          {healthRecipes && <span>RECIPES · {healthRecipes}</span>}
          {(lastVisionProvider || lastRecipeProvider) && (
            <span style={{ marginLeft: 8, opacity: 0.7 }}>
              | last: {lastVisionProvider ? `VISION ${lastVisionProvider.toUpperCase()}` : ""}
              {lastVisionProvider && lastRecipeProvider ? " · " : ""}
              {lastRecipeProvider ? `RECIPES ${lastRecipeProvider.toUpperCase()}` : ""}
            </span>
          )}
        </div>
      )}

      <main className="app-main">
        {step === "landing" && (
          <section className="landing" data-testid="landing">
            <div className="landing-hero">
              <h1>Покажи холодильник — подберём, что&nbsp;приготовить.</h1>
              <p>Сфотографируй полки. Мы найдём продукты и предложим 3 блюда без лишней суеты.</p>
            </div>

            <div className="fridge-illust" aria-hidden="true">
              <div className="fridge-illust-inner">
                <div className="shelf">
                  <div className="shelf-dot tomato" />
                  <div className="shelf-dot cheese" />
                  <div className="shelf-line" />
                </div>
                <div className="shelf">
                  <div className="shelf-dot egg" />
                  <div className="shelf-dot greens" />
                  <div className="shelf-line short" />
                  <div className="shelf-dot milk" />
                </div>
                <div className="shelf">
                  <div className="shelf-dot tomato" />
                  <div className="shelf-line" />
                  <div className="shelf-dot cheese" />
                </div>
              </div>
            </div>

            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}

            <div className="cta-stack">
              <button
                className="btn btn-primary"
                onClick={() => cameraInputRef.current?.click()}
                data-testid="cta-camera"
              >
                📷 Сфотографировать холодильник
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => fileInputRef.current?.click()}
                data-testid="cta-upload"
              >
                Загрузить фото
              </button>
              <div className="helper">Работает на телефоне и на компьютере</div>
            </div>

            {/* hidden inputs */}
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="upload-input"
              onChange={onPickFile}
              data-testid="input-camera"
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="upload-input"
              onChange={onPickFile}
              data-testid="input-upload"
            />
          </section>
        )}

        {step === "photo" && (
          <section className="photo-section" data-testid="photo-step">
            <h2 style={{ margin: 0, fontSize: 18 }}>Твоё фото</h2>
            <div className="photo-preview">
              {imagePreviewUrl ? (
                <img src={imagePreviewUrl} alt="Выбранное фото холодильника" />
              ) : (
                <div className="placeholder">Нет фото</div>
              )}
            </div>

            {error && (
              <div className="error-banner" role="alert" data-testid="error-banner">
                <span>{error}</span>
                <button onClick={() => setError(null)}>Скрыть</button>
              </div>
            )}

            <div className="photo-actions">
              <button
                className="btn btn-secondary btn-small"
                onClick={() => fileInputRef.current?.click()}
                data-testid="replace-photo"
              >
                Заменить
              </button>
              <button className="btn btn-ghost btn-small" onClick={resetToLanding}>
                На главную
              </button>
            </div>

            <button className="btn btn-primary" onClick={triggerAnalyze} data-testid="analyze-btn">
              Смотрю, что у тебя есть…
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="upload-input"
              onChange={onPickFile}
              data-testid="input-replace"
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="upload-input"
              onChange={onPickFile}
            />
          </section>
        )}

        {step === "analyzing" && (
          <section className="analyzing" data-testid="analyzing">
            <div className="spinner" aria-hidden="true" />
            <h2>Смотрю, что у тебя есть…</h2>
            <p>Отправляю фото на сервер — ключ в безопасности</p>
            {imagePreviewUrl && (
              <div className="preview-thumb">
                <img src={imagePreviewUrl} alt="preview" />
              </div>
            )}
            {analysis === null && error && <div className="error-banner">{error}</div>}
          </section>
        )}

        {step === "ingredients" && (
          <section className="ingredients" data-testid="ingredients-step">
            <h2>Вот что я нашёл</h2>
            <p className="subtitle">Нажми ✕ чтобы убрать,добавь недостающее</p>

            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}

            <div className="chip-list" data-testid="ingredients-list">
              {ingredients.length === 0 && (
                <div style={{ color: "var(--muted)", fontSize: 14 }}>
                  Список пуст — добавь ингредиенты вручную
                </div>
              )}
              {ingredients.map((ing) => (
                <div
                  key={ing.canonicalName}
                  className="chip"
                  data-testid={`chip-${ing.canonicalName}`}
                >
                  <span>{ing.displayName}</span>
                  <button
                    aria-label={`Удалить ${ing.displayName}`}
                    onClick={() => removeIngredient(ing.canonicalName)}
                    data-testid={`remove-${ing.canonicalName}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {uncertain.length > 0 && (
              <div className="uncertain-section" data-testid="uncertain-section">
                <h3>Возможно ещё</h3>
                <div className="chip-list">
                  {uncertain.map((u) => (
                    <div key={u.canonicalName} className="chip uncertain">
                      <span>{u.displayName}</span>
                      <button
                        onClick={() => addUncertain(u)}
                        aria-label={`Добавить ${u.displayName}`}
                        data-testid={`add-uncertain-${u.canonicalName}`}
                      >
                        +
                      </button>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  Нажми +, чтобы добавить — это не точно
                </div>
              </div>
            )}

            <div className="add-row">
              <input
                ref={addInputRef}
                placeholder="Добавить ингредиент…"
                className="input-add"
                data-testid="add-input"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomIngredient();
                  }
                }}
              />
              <button
                className="btn btn-secondary btn-small"
                onClick={addCustomIngredient}
                data-testid="add-btn"
              >
                + Добавить
              </button>
            </div>

            <div className="suggest-list" data-testid="suggest-list">
              {SUGGESTIBLE_INGREDIENTS.slice(0, 12).map((s) => (
                <button
                  key={s.canonicalName}
                  className="suggest-chip"
                  onClick={() => {
                    if (!ingredients.some((i) => i.canonicalName === s.canonicalName)) {
                      setIngredients((prev) => [...prev, s]);
                    }
                  }}
                  data-testid={`suggest-${s.canonicalName}`}
                >
                  + {s.displayName}
                </button>
              ))}
            </div>

            <button
              className="btn btn-primary"
              onClick={handleRecommend}
              disabled={loadingRecs || ingredients.length === 0}
              data-testid="to-recs"
            >
              {loadingRecs ? "Подбираю…" : "Подобрать 3 блюда →"}
            </button>

            <button className="btn btn-ghost btn-small" onClick={() => setStep("photo")}>
              ← Вернуться к фото
            </button>
          </section>
        )}

        {step === "recommendations" && recipes && (
          <section className="recs" data-testid="recommendations">
            <h2>Что можно приготовить</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {recipes.map((r) => (
                <div
                  key={r.id}
                  className="recipe-card"
                  onClick={() => openRecipe(r)}
                  data-testid={`recipe-card-${r.slot}`}
                >
                  <div className="slot">{SLOT_LABELS[r.slot]}</div>
                  <h3>{r.title}</h3>
                  <div className="meta-row">
                    <span>⏱ {r.estimatedMinutes} мин</span>
                    <span>·</span>
                    <span>{r.difficulty === "easy" ? "Легко" : "Средне"}</span>
                    <span className={`badge ${r.hasAllIngredients ? "ok" : "missing"}`}>
                      {r.hasAllIngredients
                        ? "Всё есть"
                        : `Не хватает: ${r.missingIngredients.map((m) => m.displayName).join(", ")}`}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--muted)" }}>{r.reason}</div>
                </div>
              ))}
            </div>
            {error && <div className="error-banner">{error}</div>}
            <button
              className="btn btn-secondary"
              onClick={() => setStep("ingredients")}
              data-testid="back-to-ingredients"
            >
              ← Изменить продукты
            </button>
            <button className="btn btn-ghost btn-small" onClick={resetToLanding}>
              Начать заново
            </button>
          </section>
        )}

        {step === "recipe" && selectedRecipe && (
          <section className="recipe-detail" data-testid="recipe-detail">
            <button
              className="back"
              onClick={() => setStep("recommendations")}
              data-testid="back-to-recs"
            >
              ← Назад к блюдам
            </button>
            <div
              className="slot"
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--muted)",
              }}
            >
              {SLOT_LABELS[selectedRecipe.slot]}
            </div>
            <h2>{selectedRecipe.title}</h2>
            <div className="detail-meta">
              <span className="badge">⏱ {selectedRecipe.estimatedMinutes} мин</span>
              <span className="badge">
                {selectedRecipe.difficulty === "easy" ? "Легко" : "Средне"}
              </span>
              <span className={`badge ${selectedRecipe.hasAllIngredients ? "ok" : "missing"}`}>
                {selectedRecipe.hasAllIngredients ? "Всё есть" : "Чего-то не хватает"}
              </span>
            </div>
            <div style={{ fontSize: 14, color: "var(--muted)" }}>{selectedRecipe.reason}</div>

            <div className="ing-list">
              <h3>Ингредиенты</h3>
              {selectedRecipe.requiredIngredients.map((ing) => {
                const isMissing = selectedRecipe.missingIngredients.some(
                  (m) => m.canonicalName === ing.canonicalName,
                );
                return (
                  <div
                    key={ing.canonicalName}
                    className={`ing-item ${isMissing ? "missing" : ""}`}
                    data-testid={`req-${ing.canonicalName}`}
                  >
                    <span>{ing.displayName}</span>
                    <span style={{ color: "var(--muted)", fontSize: 13 }}>{ing.amount ?? ""}</span>
                  </div>
                );
              })}
              {selectedRecipe.missingIngredients.length > 0 && (
                <div style={{ fontSize: 12, color: "var(--warning)", marginTop: 4 }}>
                  Не хватает:{" "}
                  {selectedRecipe.missingIngredients.map((m) => m.displayName).join(", ")}
                </div>
              )}
              {selectedRecipe.optionalIngredients &&
                selectedRecipe.optionalIngredients.length > 0 && (
                  <>
                    <h3 style={{ marginTop: 8 }}>Опционально</h3>
                    {selectedRecipe.optionalIngredients.map((ing) => (
                      <div
                        key={`opt-${ing.canonicalName}`}
                        className="ing-item"
                        style={{ opacity: 0.8 }}
                      >
                        <span>{ing.displayName}</span>
                        <span style={{ color: "var(--muted)", fontSize: 13 }}>
                          {ing.amount ?? ""}
                        </span>
                      </div>
                    ))}
                  </>
                )}
            </div>

            <div className="steps">
              <h3>Шаги</h3>
              {selectedRecipe.steps.map((s, idx) => (
                <div key={idx} className="step" data-testid={`step-${idx}`}>
                  <div className="step-num">{idx + 1}</div>
                  <div>{s}</div>
                </div>
              ))}
            </div>

            <button
              className="btn btn-secondary"
              onClick={resetToLanding}
              data-testid="reset-from-recipe"
            >
              Готовить другое → На главную
            </button>
          </section>
        )}

        {step !== "landing" && step !== "analyzing" && (
          <div className="helper">MOCK / LIVE определяется сервером · ключ не в браузере</div>
        )}
      </main>
    </div>
  );
}
