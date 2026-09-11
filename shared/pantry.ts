/**
 * Pantry staples - available without being photographed.
 * These are assumed to be always present and not required to be detected.
 * Keep minimal: salt, black pepper, neutral oil.
 */
export const PANTRY_STAPLES = [
  {
    canonicalName: "salt",
    displayName: "Соль",
  },
  {
    canonicalName: "black_pepper",
    displayName: "Чёрный перец",
  },
  {
    canonicalName: "vegetable_oil",
    displayName: "Растительное масло",
  },
] as const;

export type PantryStapleCanonical = (typeof PANTRY_STAPLES)[number]["canonicalName"];

export const PANTRY_SET = new Set<string>(PANTRY_STAPLES.map((s) => s.canonicalName));

export function isPantryStaple(canonical: string): boolean {
  return PANTRY_SET.has(canonical);
}
