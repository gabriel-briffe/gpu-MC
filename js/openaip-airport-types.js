/**
 * OpenAIP airport type enums — curated from mountainCircles-map:
 * Grok/mountaincircles/composeApp/src/commonMain/kotlin/org/mountaincircles/app/modules/airports/import/logic/AirportsStorage.kt
 */

/** REST API / core `type` field (integer code → display name). */
export const OPENAIP_AIRPORT_TYPES_BY_CODE = {
  0: "Airport (civil/military)",
  1: "Glider Site",
  2: "Airfield Civil",
  3: "International Airport",
  4: "Heliport Military",
  5: "Military Aerodrome",
  6: "Ultra Light Flying Site",
  7: "Heliport Civil",
  8: "Aerodrome Closed",
  9: "Airport resp. Airfield IFR",
  10: "Airfield Water",
  11: "Landing Strip",
  12: "Agricultural Landing Strip",
  13: "Altiport",
};

/** REST API `trafficType` entries (integer code → label). */
export const OPENAIP_AIRPORT_TRAFFIC_TYPES_BY_CODE = {
  0: "VFR",
  1: "IFR",
};

/**
 * Vector tile `type` slugs for excluded REST codes (OpenAIP MVT airports layer).
 * Only codes in OPENAIP_EXCLUDED_AIRPORT_TYPE_CODES need slugs for MapLibre filters.
 */
export const OPENAIP_AIRPORT_TYPE_SLUG_BY_CODE = {
  4: "heli_mil",
  7: "heli_civil",
  8: "ad_closed",
  10: "af_water",
};

/** Types excluded from fetch, map display, and compute seeds. */
export const OPENAIP_EXCLUDED_AIRPORT_TYPE_CODES = [4, 6, 7, 8, 10, 11, 12, 13];

/** REST API `type` query values (all known codes minus {@link OPENAIP_EXCLUDED_AIRPORT_TYPE_CODES}). */
export const OPENAIP_INCLUDED_AIRPORT_TYPE_CODES = Object.keys(OPENAIP_AIRPORT_TYPES_BY_CODE)
  .map(Number)
  .filter((code) => !OPENAIP_EXCLUDED_AIRPORT_TYPE_CODES.includes(code));

export const OPENAIP_EXCLUDED_AIRPORT_TYPE_TILE_SLUGS = OPENAIP_EXCLUDED_AIRPORT_TYPE_CODES.map(
  (code) => OPENAIP_AIRPORT_TYPE_SLUG_BY_CODE[code]
).filter(Boolean);

export const OPENAIP_AIRPORT_FILTER = [
  "!",
  ["in", ["get", "type"], ["literal", OPENAIP_EXCLUDED_AIRPORT_TYPE_CODES]],
];

export const OPENAIP_CACHE_AIRPORT_FILTER = OPENAIP_AIRPORT_FILTER;

const OPENAIP_AIRPORT_TYPE_CODE_BY_NAME = Object.fromEntries(
  Object.entries(OPENAIP_AIRPORT_TYPES_BY_CODE).map(([code, name]) => [name, Number(code)])
);

const OPENAIP_AIRPORT_TYPE_CODE_BY_SLUG = Object.fromEntries(
  Object.entries(OPENAIP_AIRPORT_TYPE_SLUG_BY_CODE).map(([code, slug]) => [slug, Number(code)])
);

export function openAipAirportTypeName(raw) {
  const code = openAipAirportTypeCode(raw);
  return code == null ? null : OPENAIP_AIRPORT_TYPES_BY_CODE[code] ?? null;
}

export function openAipAirportTypeCode(raw) {
  if (raw == null) {
    return null;
  }

  if (typeof raw === "number" && Number.isInteger(raw)) {
    return raw in OPENAIP_AIRPORT_TYPES_BY_CODE ? raw : null;
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const asInt = Number(trimmed);
    if (Number.isInteger(asInt) && asInt in OPENAIP_AIRPORT_TYPES_BY_CODE) {
      return asInt;
    }
    if (trimmed in OPENAIP_AIRPORT_TYPE_CODE_BY_SLUG) {
      return OPENAIP_AIRPORT_TYPE_CODE_BY_SLUG[trimmed];
    }
    if (trimmed in OPENAIP_AIRPORT_TYPE_CODE_BY_NAME) {
      return OPENAIP_AIRPORT_TYPE_CODE_BY_NAME[trimmed];
    }
  }

  return null;
}

export function isIncludedOpenAipAirportType(raw) {
  const code = openAipAirportTypeCode(raw);
  if (code == null) {
    return true;
  }
  return !OPENAIP_EXCLUDED_AIRPORT_TYPE_CODES.includes(code);
}
