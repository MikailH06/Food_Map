/**
 * Geocoding registry.
 *
 * Turns an address the user typed into coordinates. Callers use this module and
 * never import a specific provider, so switching providers is a config change.
 *
 * Default order ('auto'):
 *   1. Google   — only if a key is set; best at vague or partial input
 *   2. Census   — free, no key, authoritative for US street addresses
 *   3. Nominatim— free, no key, resolves place names Census cannot
 *
 * Set GEOCODING_PROVIDER to 'census', 'nominatim' or 'google' to force one.
 */

import { providers as providerConfig } from '../../config.js';
import * as census from './census.js';
import * as nominatim from './nominatim.js';
import * as google from './google.js';

/**
 * @typedef {object} GeocodeResult
 * @property {number} lat
 * @property {number} lng
 * @property {string} formattedAddress
 * @property {string} provider
 * @property {'exact'|'approximate'} confidence
 */

const ALL = { census, nominatim, google };

/** Providers to try, in order, given the current configuration. */
export function activeProviders() {
  const choice = providerConfig.geocoding;

  if (choice !== 'auto') {
    const provider = ALL[choice];
    if (!provider) {
      throw new Error(
        `Unknown GEOCODING_PROVIDER "${choice}". Valid values: ${Object.keys(ALL).join(', ')}, auto`
      );
    }
    return [provider];
  }

  return [google, census, nominatim].filter((p) => p.isAvailable());
}

/**
 * Resolve an address to coordinates.
 *
 * Tries each provider in turn. A provider that throws is logged and skipped
 * rather than failing the whole request — a transient outage at one service
 * should not stop the user setting their map centre.
 *
 * @param {string} address
 * @returns {Promise<GeocodeResult|null>} null if nothing matched
 */
export async function geocode(address) {
  const trimmed = address?.trim();
  if (!trimmed) return null;

  const errors = [];

  for (const provider of activeProviders()) {
    try {
      const result = await provider.geocode(trimmed);
      if (result) return result;
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
    }
  }

  // Only worth logging when EVERY provider errored — a clean "no match" from
  // all of them is a normal outcome for a typo'd address.
  if (errors.length > 0 && errors.length === activeProviders().length) {
    console.warn(`[geocode] all providers failed for "${trimmed}": ${errors.join('; ')}`);
  }

  return null;
}

export { census, nominatim, google };
