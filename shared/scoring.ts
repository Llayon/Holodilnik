/**
 * Deterministic edit-cost scoring for vision gauntlet
 * Lower is better. False positives double penalty.
 */
export interface GroundTruthItem {
  canonicalId: string;
  quantity: { min: number; max: number };
  required: boolean;
}

export interface GroundTruthImage {
  id: string;
  items: GroundTruthItem[];
}

export interface ProviderIngredient {
  canonicalId: string;
  displayName: string;
  quantityGuess: number | null;
  confidence?: number;
}

export interface ScoreDetail {
  provider: string;
  imageId: string;
  correct: number;
  missing: string[];
  wrongClass: Array<{ expected: string; got: string }>;
  falsePositives: Array<{ canonicalId: string; displayName: string }>;
  quantityErrors: Array<{ canonicalId: string; expected: string; got: number | null }>;
  localizationErrors: Array<{ canonicalId: string; displayName: string }>;
  totalEditCost: number;
}

function isCyrillic(str: string): boolean {
  return /[а-яё]/i.test(str);
}

/**
 * Score one image/provider against ground truth
 * - Correct: 0
 * - Wrong fine-grained class: +1
 * - Missing required: +1
 * - Quantity outside range: +1
 * - Localization (non-Cyrillic for known Russian, or underscore): +1
 * - False positive (returned not in GT): +2
 * No double penalty for wrongClass quantity.
 */
export function scoreOne(
  groundTruth: GroundTruthImage,
  providerIngredients: ProviderIngredient[],
): ScoreDetail {
  const detail: ScoreDetail = {
    provider: "",
    imageId: groundTruth.id,
    correct: 0,
    missing: [],
    wrongClass: [],
    falsePositives: [],
    quantityErrors: [],
    localizationErrors: [],
    totalEditCost: 0,
  };
  const returnedIds = new Set(providerIngredients.map((r) => r.canonicalId));
  const gtRequired = groundTruth.items.filter((i) => i.required);
  const allGtIds = new Set(groundTruth.items.map((i) => i.canonicalId));

  for (const gt of gtRequired) {
    const found = providerIngredients.find((r) => r.canonicalId === gt.canonicalId);
    if (found) {
      detail.correct++;
      const qty = found.quantityGuess;
      if (qty !== null && (qty < gt.quantity.min || qty > gt.quantity.max)) {
        detail.quantityErrors.push({ canonicalId: gt.canonicalId, expected: `${gt.quantity.min}-${gt.quantity.max}`, got: qty });
        detail.totalEditCost += 1;
      }
      if (!isCyrillic(found.displayName) || found.displayName.includes("_")) {
        detail.localizationErrors.push({ canonicalId: gt.canonicalId, displayName: found.displayName });
        detail.totalEditCost += 1;
      }
    } else {
      // Check for wrong fine-grained class (e.g., yellow_tomato vs yellow_bell_pepper)
      let wrongFound: string | undefined;
      if (gt.canonicalId === "yellow_tomato" && returnedIds.has("yellow_bell_pepper")) wrongFound = "yellow_bell_pepper";
      if (wrongFound) {
        detail.wrongClass.push({ expected: gt.canonicalId, got: wrongFound });
        detail.totalEditCost += 1;
      } else {
        detail.missing.push(gt.canonicalId);
        detail.totalEditCost += 1;
      }
    }
  }

  // False positives
  for (const ret of providerIngredients) {
    if (!allGtIds.has(ret.canonicalId)) {
      const alreadyWrong = detail.wrongClass.some((w) => w.got === ret.canonicalId);
      if (alreadyWrong) continue;
      const gtItem = groundTruth.items.find((i) => i.canonicalId === ret.canonicalId);
      if (gtItem && !gtItem.required) continue;
      detail.falsePositives.push({ canonicalId: ret.canonicalId, displayName: ret.displayName });
      detail.totalEditCost += 2;
    }
  }

  return detail;
}
