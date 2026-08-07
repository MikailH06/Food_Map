/**
 * Price normalisation.
 *
 * schema.org's `priceRange` is a free-text field, so restaurants fill it in
 * however they like. Real values seen in the wild include:
 *
 *   "$$"            "$$$$"           "$10 - $25"       "£5 - £25"
 *   "20-40"         "Under $15"      "Moderate"        "$$ - $$$"
 *   "€€"            "About $30"      "Inexpensive"     "$15+"
 *
 * All of it has to become an integer 1-4 so it can sit alongside Google's
 * price level and the community's, and be rendered as $ through $$$$.
 */

import { ratings } from '../../config.js';

/** Currency symbols that mean "one step up the price scale" when repeated. */
const CURRENCY_SYMBOLS = ['$', '£', '€', '¥', '₩', '₹'];

/** Word forms, mostly from Google and TripAdvisor-style vocabularies. */
const WORD_LEVELS = new Map([
  ['free', 1],
  ['cheap', 1],
  ['inexpensive', 1],
  ['budget', 1],
  ['affordable', 1],
  ['moderate', 2],
  ['mid-range', 2],
  ['midrange', 2],
  ['average', 2],
  ['expensive', 3],
  ['pricey', 3],
  ['upscale', 3],
  ['fine dining', 4],
  ['very expensive', 4],
  ['luxury', 4],
  // Google Places API (New) enum values.
  ['price_level_free', 1],
  ['price_level_inexpensive', 1],
  ['price_level_moderate', 2],
  ['price_level_expensive', 3],
  ['price_level_very_expensive', 4],
]);

/**
 * Map a typical main-course price in USD onto a 1-4 tier.
 * Thresholds live in config.js so they can be retuned without touching code.
 */
export function amountToPriceLevel(amount) {
  if (!Number.isFinite(amount) || amount < 0) return null;

  const thresholds = ratings.priceLevelThresholdsUsd;
  for (let i = 0; i < thresholds.length; i += 1) {
    if (amount <= thresholds[i]) return i + 1;
  }
  return thresholds.length;
}

/**
 * Turn any priceRange representation into an integer 1-4, or null.
 *
 * @param {string|number|null|undefined} raw
 * @returns {number|null}
 */
export function normalizePriceLevel(raw) {
  if (raw === null || raw === undefined) return null;

  // Already a level.
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    const rounded = Math.round(raw);
    return rounded >= ratings.minPriceLevel && rounded <= ratings.maxPriceLevel ? rounded : null;
  }

  if (typeof raw !== 'string') return null;

  const value = raw.trim().toLowerCase();
  if (!value) return null;

  // "moderate", "PRICE_LEVEL_EXPENSIVE", ...
  const word = WORD_LEVELS.get(value);
  if (word) return word;

  // Longest match first, so "very expensive" wins over "expensive".
  for (const [phrase, level] of [...WORD_LEVELS].sort((a, b) => b[0].length - a[0].length)) {
    if (value.includes(phrase)) return level;
  }

  // Repeated currency symbols: "$$" -> 2. Handle a range like "$$ - $$$" by
  // taking the longest run rather than the total count.
  for (const symbol of CURRENCY_SYMBOLS) {
    if (value.includes(symbol)) {
      const runs = value.match(new RegExp(`\\${symbol}+`, 'g')) ?? [];
      const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);

      // A symbol immediately followed by a digit is a real amount ("$15"),
      // not a tier marker — fall through to the numeric branch below.
      const isAmount = new RegExp(`\\${symbol}\\s*\\d`).test(value);
      if (!isAmount && longest > 0) {
        return Math.min(longest, ratings.maxPriceLevel);
      }
      break;
    }
  }

  // Numeric amounts: "$10 - $25", "20-40", "Under $15", "$15+".
  const numbers = (value.match(/\d+(?:\.\d+)?/g) ?? [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

  if (numbers.length === 0) return null;

  // For a range, the midpoint represents a typical spend better than either end.
  const representative =
    numbers.length >= 2
      ? (Math.min(...numbers) + Math.max(...numbers)) / 2
      : numbers[0];

  return amountToPriceLevel(representative);
}

/** Render a level as a $ string for display. */
export function priceLevelToSymbols(level) {
  if (!Number.isInteger(level) || level < ratings.minPriceLevel || level > ratings.maxPriceLevel) {
    return null;
  }
  return '$'.repeat(level);
}
