/**
 * Ingredient normalization layer.
 * Maps arbitrary model strings (Russian/English, plural, synonyms) to canonical IDs
 * and provides localized display names.
 */

export interface NormalizedIngredient {
  canonicalName: string;
  displayName: string;
}

// Canonical -> displayName (Russian)
const CANONICAL_DISPLAY: Record<string, string> = {
  egg: "Яйца",
  tomato: "Помидоры",
  cheese: "Сыр",
  chicken: "Курица",
  zucchini: "Кабачок",
  sour_cream: "Сметана",
  milk: "Молоко",
  butter: "Сливочное масло",
  onion: "Лук",
  garlic: "Чеснок",
  potato: "Картофель",
  carrot: "Морковь",
  cucumber: "Огурцы",
  bell_pepper: "Болгарский перец",
  mushroom: "Грибы",
  sausage: "Колбаса",
  ham: "Ветчина",
  yogurt: "Йогурт",
  cream: "Сливки",
  beef: "Говядина",
  pork: "Свинина",
  fish: "Рыба",
  salmon: "Лосось",
  rice: "Рис",
  pasta: "Макароны",
  bread: "Хлеб",
  flour: "Мука",
  sugar: "Сахар",
  salt: "Соль",
  black_pepper: "Чёрный перец",
  vegetable_oil: "Растительное масло",
  olive_oil: "Оливковое масло",
  greens: "Зелень",
  dill: "Укроп",
  parsley: "Петрушка",
  lettuce: "Салат",
  cabbage: "Капуста",
  apple: "Яблоки",
  banana: "Бананы",
  lemon: "Лимон",
  mayonnaise: "Майонез",
  ketchup: "Кетчуп",
  mustard: "Горчица",
  honey: "Мёд",
  kefir: "Кефир",
  cottage_cheese: "Творог",
};

// Aliases -> canonical (lowercased, trimmed)
const ALIASES: Record<string, string> = {
  // egg
  egg: "egg",
  eggs: "egg",
  яйца: "egg",
  яйцо: "egg",

  // tomato
  tomato: "tomato",
  tomatoes: "tomato",
  помидоры: "tomato",
  помидор: "tomato",
  томаты: "tomato",
  томат: "tomato",

  // cheese
  cheese: "cheese",
  сыр: "cheese",
  сыры: "cheese",

  // chicken
  chicken: "chicken",
  курица: "chicken",
  куриное_филе: "chicken",
  chicken_fillet: "chicken",
  куриное: "chicken",

  // zucchini
  zucchini: "zucchini",
  кабачок: "zucchini",
  кабачки: "zucchini",
  цуккини: "zucchini",

  // sour cream
  sour_cream: "sour_cream",
  "sour cream": "sour_cream",
  сметана: "sour_cream",

  // milk
  milk: "milk",
  молоко: "milk",

  // butter
  butter: "butter",
  масло_сливочное: "butter",
  "сливочное масло": "butter",

  // onion
  onion: "onion",
  onions: "onion",
  лук: "onion",
  луковица: "onion",

  // garlic
  garlic: "garlic",
  чеснок: "garlic",

  // potato
  potato: "potato",
  potatoes: "potato",
  картофель: "potato",
  картошка: "potato",

  // carrot
  carrot: "carrot",
  carrots: "carrot",
  морковь: "carrot",
  морковка: "carrot",

  // cucumber
  cucumber: "cucumber",
  cucumbers: "cucumber",
  огурец: "cucumber",
  огурцы: "cucumber",

  // bell pepper
  bell_pepper: "bell_pepper",
  "bell pepper": "bell_pepper",
  "sweet pepper": "bell_pepper",
  pepper: "bell_pepper",
  перец: "bell_pepper",
  болгарский_перец: "bell_pepper",
  сладкий_перец: "bell_pepper",
  peppers: "bell_pepper",

  // mushroom
  mushroom: "mushroom",
  mushrooms: "mushroom",
  грибы: "mushroom",
  гриб: "mushroom",
  шампиньоны: "mushroom",

  // sausage
  sausage: "sausage",
  sausages: "sausage",
  колбаса: "sausage",

  // ham
  ham: "ham",
  ветчина: "ham",

  // yogurt
  yogurt: "yogurt",
  yoghurt: "yogurt",
  йогурт: "yogurt",

  // etc
  beef: "beef",
  говядина: "beef",
  pork: "pork",
  свинина: "pork",
  fish: "fish",
  рыба: "fish",
  salmon: "salmon",
  лосось: "salmon",
  rice: "rice",
  рис: "rice",
  pasta: "pasta",
  макароны: "pasta",
  паста: "pasta",
  bread: "bread",
  хлеб: "bread",
  flour: "flour",
  мука: "flour",
  sugar: "sugar",
  сахар: "sugar",
  salt: "salt",
  соль: "salt",
  "black pepper": "black_pepper",
  перец_черный: "black_pepper",
  "чёрный перец": "black_pepper",
  "черный перец": "black_pepper",
  "vegetable oil": "vegetable_oil",
  "растительное масло": "vegetable_oil",
  масло: "vegetable_oil",
  "olive oil": "olive_oil",
  "оливковое масло": "olive_oil",
  greens: "greens",
  зелень: "greens",
  dill: "dill",
  укроп: "dill",
  parsley: "parsley",
  петрушка: "parsley",
  lettuce: "lettuce",
  салат: "lettuce",
  капуста: "cabbage",
  cabbage: "cabbage",
  яблоко: "apple",
  яблоки: "apple",
  apple: "apple",
  apples: "apple",
  banana: "banana",
  бананы: "banana",
  банан: "banana",
  лимон: "lemon",
  lemon: "lemon",
  майонез: "mayonnaise",
  mayonnaise: "mayonnaise",
  кетчуп: "ketchup",
  ketchup: "ketchup",
  горчица: "mustard",
  mustard: "mustard",
  мёд: "honey",
  мед: "honey",
  honey: "honey",
  кефир: "kefir",
  kefir: "kefir",
  творог: "cottage_cheese",
  cottage_cheese: "cottage_cheese",
  "cottage cheese": "cottage_cheese",
};

function normalizeKey(input: string): string {
  return input.toLowerCase().trim().replace(/\s+/g, "_").replace(/ё/g, "е");
}

export function normalizeIngredient(input: string): NormalizedIngredient {
  const key = normalizeKey(input);
  const canonical = ALIASES[key] ?? ALIASES[input.toLowerCase().trim()] ?? key;

  // canonical may still contain spaces - replace
  const canonicalClean = canonical.toLowerCase().replace(/\s+/g, "_");

  const displayName =
    CANONICAL_DISPLAY[canonicalClean] ??
    // fallback: capitalize original input
    input.trim().charAt(0).toUpperCase() + input.trim().slice(1).toLowerCase();

  return {
    canonicalName: canonicalClean,
    displayName,
  };
}

export function getDisplayName(canonical: string): string {
  return CANONICAL_DISPLAY[canonical] ?? canonical;
}

export function isKnownCanonical(canonical: string): boolean {
  return canonical in CANONICAL_DISPLAY;
}

// List for UI addition (popular fridge items)
export const SUGGESTIBLE_INGREDIENTS: NormalizedIngredient[] = [
  "egg",
  "tomato",
  "cheese",
  "chicken",
  "zucchini",
  "sour_cream",
  "milk",
  "onion",
  "potato",
  "cucumber",
  "bell_pepper",
  "mushroom",
  "sausage",
  "yogurt",
  "greens",
  "butter",
  "carrot",
  "cabbage",
  "apple",
  "kefir",
].map((c) => ({
  canonicalName: c,
  displayName: CANONICAL_DISPLAY[c],
}));
