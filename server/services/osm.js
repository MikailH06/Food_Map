/**
 * OpenStreetMap translation.
 *
 * Pure functions only — no network, no database — so the mapping from OSM's
 * free-form tags to our schema can be tested exhaustively without touching
 * Overpass.
 *
 * OSM data is contributed by hand, so almost every tag is optional and many are
 * spelled more than one way (`phone` vs `contact:phone`). The rule here is to
 * accept what we can recognise and discard the rest rather than guess.
 */

import { catalog, geography } from '../config.js';

/**
 * Build an Overpass QL query for every restaurant in the target area.
 *
 * Two addressing modes:
 *   - by area name  (default) — follows the real county boundary, so it will
 *     not pick up places in neighbouring Orange or Ventura county
 *   - by bounding box — a blunt rectangle, but immune to the named area being
 *     ambiguous or missing, which makes it a useful fallback
 *
 * `out center tags` matters: restaurants mapped as buildings are ways or
 * relations rather than nodes, and without `center` those come back with no
 * coordinates at all. Roughly a third of LA's restaurants are mapped that way.
 */
export function buildOverpassQuery({
  amenities = catalog.osmAmenities,
  areaName = geography.osmAreaName,
  bounds = null,
  timeout = catalog.overpassTimeoutSeconds,
} = {}) {
  const filter = `["amenity"~"^(${amenities.join('|')})$"]`;

  if (bounds) {
    const [[south, west], [north, east]] = bounds;
    const bbox = `(${south},${west},${north},${east})`;
    return [
      `[out:json][timeout:${timeout}];`,
      '(',
      `  node${filter}${bbox};`,
      `  way${filter}${bbox};`,
      `  relation${filter}${bbox};`,
      ');',
      'out center tags;',
    ].join('\n');
  }

  return [
    `[out:json][timeout:${timeout}];`,
    `area["name"="${areaName}"]["admin_level"="6"]["boundary"="administrative"]->.searchArea;`,
    '(',
    `  node${filter}(area.searchArea);`,
    `  way${filter}(area.searchArea);`,
    `  relation${filter}(area.searchArea);`,
    ');',
    'out center tags;',
  ].join('\n');
}

/**
 * Split OSM's cuisine tag into separate values.
 *
 * OSM packs multiple cuisines into one semicolon-delimited string and uses
 * underscores for spaces, e.g. "mexican;ice_cream". Underscores become spaces
 * so full-text search tokenises "ice cream" as two searchable words.
 */
export function parseCuisines(raw) {
  if (!raw || typeof raw !== 'string') return [];

  const seen = new Set();
  for (const part of raw.split(';')) {
    const value = part.trim().toLowerCase().replace(/_/g, ' ');
    if (value) seen.add(value);
  }
  return [...seen];
}

/**
 * Normalise a website value into an absolute URL, or null if it is unusable.
 *
 * Contributors often omit the scheme ("www.example.com") or type something that
 * is not a URL at all. The enrichment crawler will try to fetch whatever comes
 * out of here, so anything it cannot fetch should become null now.
 */
export function normalizeWebsite(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let value = raw.trim();
  if (!value || value.includes(' ')) return null;

  if (!/^https?:\/\//i.test(value)) {
    // Reject values that are clearly not hostnames before assuming a scheme.
    if (!/^[\w-]+(\.[\w-]+)+/.test(value)) return null;
    value = `https://${value}`;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Assemble a street address from OSM's separate house-number and street tags. */
export function formatAddress(tags) {
  const houseNumber = tags['addr:housenumber']?.trim();
  const street = tags['addr:street']?.trim();

  let line = null;
  if (houseNumber && street) line = `${houseNumber} ${street}`;
  else if (street) line = street;

  return {
    address_line1: line,
    city: tags['addr:city']?.trim() ?? null,
    state: tags['addr:state']?.trim() ?? 'CA',
    postal_code: tags['addr:postcode']?.trim() ?? null,
  };
}

/**
 * Convert one Overpass element into a row for the restaurants table.
 *
 * @returns {object|null} null when the element is unusable — no name (we cannot
 *   show a nameless pin) or no coordinates (we cannot place it).
 */
export function osmElementToRestaurant(element) {
  if (!element || typeof element !== 'object') return null;

  const tags = element.tags ?? {};
  const name = tags.name?.trim();
  if (!name) return null;

  // Nodes carry lat/lon directly; ways and relations carry a computed centre.
  const lat = element.lat ?? element.center?.lat ?? null;
  const lng = element.lon ?? element.center?.lon ?? null;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const address = formatAddress(tags);

  return {
    source: 'osm',
    source_id: `${element.type}/${element.id}`,
    name,
    ...address,
    lat,
    lng,
    // amenity is a useful search term in its own right: "cafe" should match
    // places tagged as cafes even when the cuisine tag is missing.
    cuisines: [...new Set([...parseCuisines(tags.cuisine), tags.amenity].filter(Boolean))].map((c) =>
      c.replace(/_/g, ' ')
    ),
    phone: tags.phone?.trim() ?? tags['contact:phone']?.trim() ?? null,
    website: normalizeWebsite(tags.website ?? tags['contact:website']),
    opening_hours: tags.opening_hours?.trim() ?? null,
  };
}

/** True if a point falls inside [[southLat, westLng], [northLat, eastLng]]. */
export function withinBounds(lat, lng, bounds = geography.bounds) {
  const [[south, west], [north, east]] = bounds;
  return lat >= south && lat <= north && lng >= west && lng <= east;
}

/**
 * Turn a full Overpass response into rows ready for insertion.
 *
 * Also reports why elements were dropped — a seed run that silently discards
 * half its input is a bug worth noticing.
 */
export function elementsToRestaurants(elements, { bounds = geography.bounds } = {}) {
  const rows = [];
  const seen = new Set();
  const skipped = { unnamed: 0, noCoords: 0, outOfBounds: 0, duplicate: 0 };

  for (const element of elements ?? []) {
    const row = osmElementToRestaurant(element);

    if (!row) {
      // Distinguish the two failure modes for the summary.
      if (!element?.tags?.name?.trim()) skipped.unnamed += 1;
      else skipped.noCoords += 1;
      continue;
    }

    if (!withinBounds(row.lat, row.lng, bounds)) {
      skipped.outOfBounds += 1;
      continue;
    }

    // Overpass should not repeat an element, but a duplicate inside a single
    // INSERT would abort the whole batch, so guard against it here.
    if (seen.has(row.source_id)) {
      skipped.duplicate += 1;
      continue;
    }

    seen.add(row.source_id);
    rows.push(row);
  }

  return { rows, skipped };
}
