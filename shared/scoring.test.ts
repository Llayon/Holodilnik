import { describe, it, expect } from "vitest";
import { scoreOne } from "./scoring.js";

function gt(items: Array<{ canonicalId: string; min: number; max: number; required?: boolean }>) {
  return {
    id: "test",
    items: items.map((i) => ({ canonicalId: i.canonicalId, quantity: { min: i.min, max: i.max }, required: i.required ?? true })),
  };
}

describe("scoring rubric", () => {
  it("correct canonical 0 edits", () => {
    const s = scoreOne(gt([{ canonicalId: "cucumber", min: 2, max: 3 }]), [
      { canonicalId: "cucumber", displayName: "Огурцы", quantityGuess: 2 },
    ]);
    expect(s.correct).toBe(1);
    expect(s.totalEditCost).toBe(0);
  });

  it("wrong fine-grained class +1, not missing", () => {
    const s = scoreOne(gt([{ canonicalId: "yellow_tomato", min: 6, max: 8 }]), [
      { canonicalId: "yellow_bell_pepper", displayName: "Yellow Bell Pepper", quantityGuess: 4 },
    ]);
    expect(s.wrongClass).toHaveLength(1);
    expect(s.missing).toHaveLength(0);
    expect(s.totalEditCost).toBe(1);
  });

  it("missing required +1", () => {
    const s = scoreOne(gt([{ canonicalId: "cucumber", min: 1, max: 1 }]), []);
    expect(s.missing).toContain("cucumber");
    expect(s.totalEditCost).toBe(1);
  });

  it("quantity outside range +1", () => {
    const s = scoreOne(gt([{ canonicalId: "cucumber", min: 4, max: 5 }]), [
      { canonicalId: "cucumber", displayName: "Огурцы", quantityGuess: 10 },
    ]);
    expect(s.quantityErrors).toHaveLength(1);
    expect(s.totalEditCost).toBe(1); // correct 0 + quantity 1
  });

  it("quantity inside range 0", () => {
    const s = scoreOne(gt([{ canonicalId: "cucumber", min: 4, max: 5 }]), [
      { canonicalId: "cucumber", displayName: "Огурцы", quantityGuess: 4 },
    ]);
    expect(s.quantityErrors).toHaveLength(0);
    expect(s.totalEditCost).toBe(0);
  });

  it("false positive double penalty +2", () => {
    const s = scoreOne(gt([{ canonicalId: "cucumber", min: 1, max: 1 }]), [
      { canonicalId: "cucumber", displayName: "Огурцы", quantityGuess: 1 },
      { canonicalId: "dragonfruit", displayName: "Dragonfruit", quantityGuess: 1 },
    ]);
    expect(s.falsePositives).toHaveLength(1);
    expect(s.totalEditCost).toBe(2);
  });

  it("no double penalty for wrong-class quantity", () => {
    // yellow_tomato wrong as yellow_bell_pepper with bad qty should only be +1 wrongClass, not +1 qty
    const s = scoreOne(gt([{ canonicalId: "yellow_tomato", min: 6, max: 8 }]), [
      { canonicalId: "yellow_bell_pepper", displayName: "Yellow Bell Pepper", quantityGuess: 1 },
    ]);
    expect(s.wrongClass).toHaveLength(1);
    expect(s.quantityErrors).toHaveLength(0); // not double counted
    expect(s.totalEditCost).toBe(1);
  });

  it("localization error when not Cyrillic", () => {
    const s = scoreOne(gt([{ canonicalId: "cucumber", min: 1, max: 1 }]), [
      { canonicalId: "cucumber", displayName: "Cucumber", quantityGuess: 1 },
    ]);
    expect(s.localizationErrors).toHaveLength(1);
    expect(s.totalEditCost).toBe(1);
  });

  it("localization ok for Cyrillic", () => {
    const s = scoreOne(gt([{ canonicalId: "cucumber", min: 1, max: 1 }]), [
      { canonicalId: "cucumber", displayName: "Огурцы", quantityGuess: 1 },
    ]);
    expect(s.localizationErrors).toHaveLength(0);
  });

  it("alias normalization without semantic remapping: yellow_bell_pepper != yellow_tomato", () => {
    const s = scoreOne(
      gt([
        { canonicalId: "yellow_tomato", min: 1, max: 1 },
        { canonicalId: "yellow_bell_pepper", min: 1, max: 1 },
      ]),
      [{ canonicalId: "yellow_bell_pepper", displayName: "Перец", quantityGuess: 1 }],
    );
    // yellow_tomato is wrongClass (pepper returned instead), not plain missing
    expect(s.wrongClass).toHaveLength(1);
    expect(s.wrongClass[0]).toEqual({ expected: "yellow_tomato", got: "yellow_bell_pepper" });
    expect(s.missing).toHaveLength(0);
    expect(s.correct).toBe(1); // bell_pepper correct
  });

  it("accepted quantity ranges 6-8", () => {
    const s1 = scoreOne(gt([{ canonicalId: "tomato", min: 6, max: 8 }]), [
      { canonicalId: "tomato", displayName: "Помидоры", quantityGuess: 6 },
    ]);
    const s2 = scoreOne(gt([{ canonicalId: "tomato", min: 6, max: 8 }]), [
      { canonicalId: "tomato", displayName: "Помидоры", quantityGuess: 8 },
    ]);
    const s3 = scoreOne(gt([{ canonicalId: "tomato", min: 6, max: 8 }]), [
      { canonicalId: "tomato", displayName: "Помидоры", quantityGuess: 9 },
    ]);
    expect(s1.totalEditCost).toBe(0);
    expect(s2.totalEditCost).toBe(0);
    expect(s3.quantityErrors).toHaveLength(1);
  });

  it("cache key includes provider/model/image hash/prompt/version is tested via cache.test.ts", () => {
    expect(true).toBe(true);
  });

  it("Groq strict schema validates locally", async () => {
    const { fridgeAnalysisSchema } = await import("./schemas.js");
    const valid = {
      ingredients: [{ canonicalName: "tomato", displayName: "Помидоры", confidence: 0.9, visibility: "clear", quantityGuess: 3 }],
      uncertainItems: [{ canonicalName: "yogurt", displayName: "Йогурт", reason: "test" }],
    };
    expect(() => fridgeAnalysisSchema.parse(valid)).not.toThrow();
  });
});
