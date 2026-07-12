import { pointInGeoJson } from "./airspace.js";
import { openAipConfigured, openAipTileUrls } from "./openaip-client.js";
import { AIRPORT_LAYER_IDS, addAirportLayers } from "./openaip-vector-airports.js";
import { FEATURE_LAYER_IDS, addFeatureLayers } from "./openaip-features.js";
import { MAP_TEXT_FONT } from "./map-fonts.js";

const OPENAIP_SOURCE_ID = "openaip";

export const OPENAIP_AIRPORT_MIN_ZOOM = 5;
export const OPENAIP_AIRPORT_LABEL_MIN_ZOOM = 7;

/** Cached / map airport dots (px) — size ramp delayed one zoom vs label appearance. */
export const OPENAIP_AIRPORT_CIRCLE_RADIUS = [
  "interpolate",
  ["linear"],
  ["zoom"],
  5,
  3,
  7,
  5,
  8,
  6.5,
  10,
  7.5,
  13,
  8.5,
  15,
  10,
];

export function openAipAirportKey(properties, lng, lat) {
  const { source_id: sourceId, icao_code: icaoCode, name } = properties ?? {};
  return sourceId ?? icaoCode ?? `${name}@${lng.toFixed(5)},${lat.toFixed(5)}`;
}

export function airspaceFeatureKey(feature) {
  const props = feature.properties ?? {};
  return (
    props.source_id ??
    props.id ??
    props.icaoCode ??
    props.icao_code ??
    `${props.name ?? "?"}@${props.type ?? "?"}`
  );
}

/** All OpenAIP airspace vector features whose polygon contains lng/lat. */
export function queryOpenAipAirspacesAt(map, lng, lat) {
  if (!map.getSource(OPENAIP_SOURCE_ID)) {
    return [];
  }

  try {
    const features = map.querySourceFeatures(OPENAIP_SOURCE_ID, {
      sourceLayer: "airspaces",
    });

    const seen = new Set();
    const matches = [];

    for (const feature of features) {
      if (!pointInGeoJson(lng, lat, feature.geometry)) {
        continue;
      }
      const key = airspaceFeatureKey(feature);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      matches.push(feature);
    }

    return matches;
  } catch (error) {
    console.warn("OpenAIP vector query skipped", error);
    return [];
  }
}

const AIRSPACE_LABEL_PAINT = {
  "text-halo-width": 20,
  "text-halo-color": "rgb(211,226,255)",
  "text-color": "rgb(21,23,94)",
  "text-halo-blur": 0,
};

const AIRSPACE_LABEL_LAYOUT = {
  visibility: "visible",
  "symbol-placement": "line",
  "text-font": MAP_TEXT_FONT,
  "text-optional": true,
  "text-allow-overlap": false,
  "text-ignore-placement": false,
  "symbol-avoid-edges": true,
  "text-anchor": "center",
  "text-justify": "center",
};

const AIRSPACE_LIMIT_LABEL = (datumKey, valueKey, unitKey) => [
  "case",
  [
    "all",
    ["==", ["get", datumKey], "GND"],
    ["==", ["get", valueKey], 0],
  ],
  "GND",
  [
    "case",
    ["==", ["get", datumKey], "STD"],
    ["concat", "FL", ["to-string", ["get", valueKey]]],
    [
      "concat",
      ["to-string", ["get", valueKey]],
      " ",
      ["get", unitKey],
      " ",
      ["get", datumKey],
    ],
  ],
];

/** OpenAIP default-style airspace borders, offset fills, and labels. */
const AIRSPACE_LAYERS = [
  {
    id: "airspace_tfr_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["tfr"], true, false]],
    paint: {
      "line-color": "rgba(154,14,14,0.5)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.2, 10, 1],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.1],
    },
  },
  {
    id: "airspace_tsa_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["tsa"], true, false]],
    paint: {
      "line-color": "rgba(154, 14, 14, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 10, 2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.3],
    },
  },
  {
    id: "airspace_tra_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["tra"], true, false]],
    paint: {
      "line-color": "rgba(154, 14, 14, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 10, 2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.3],
      "line-dasharray": [
        "step",
        ["zoom"],
        ["literal", [3, 1]],
        3,
        ["literal", [5, 2]],
        12,
        ["literal", [12, 4]],
      ],
    },
  },
  {
    id: "airspace_tra_tsa_tfa_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["tra", "tsa", "tfa"], true, false]],
    paint: {
      "fill-color": "rgba(154, 14, 14, 1)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.2],
      "fill-outline-color": "rgba(154, 14, 14, 0)",
    },
  },
  {
    id: "airspace_rdp_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["restricted", "danger", "prohibited"], true, false],
    ],
    paint: {
      "line-color": "rgba(154, 14, 14, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 10, 2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_rdp_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["restricted", "danger", "prohibited"], true, false],
    ],
    paint: {
      "fill-color": "rgba(154, 14, 14, 1)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.25],
      "fill-outline-color": "rgba(154, 14, 14, 0)",
    },
  },
  {
    id: "airspace_cd_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["other"], true, false],
      ["match", ["get", "icao_class"], ["c", "d"], true, false],
    ],
    paint: {
      "line-color": "rgba(51, 158, 47, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 10, 2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_cd_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset_2x",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["other"], true, false],
      ["match", ["get", "icao_class"], ["c", "d"], true, false],
    ],
    paint: {
      "fill-color": "rgba(51, 158, 47, 1)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.2],
      "fill-outline-color": "rgba(51, 158, 47, 0)",
    },
  },
  {
    id: "airspace_ab_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["other"], true, false],
      ["match", ["get", "icao_class"], ["a", "b"], true, false],
    ],
    paint: {
      "line-color": "rgba(51, 158, 47, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 10, 2],
      "line-dasharray": ["literal", [5, 5]],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.5],
    },
  },
  {
    id: "airspace_ab_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset_2x",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["other"], true, false],
      ["match", ["get", "icao_class"], ["a", "b"], true, false],
    ],
    paint: {
      "fill-color": "rgba(51, 158, 47, 0.5)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.2],
      "fill-outline-color": "rgba(118, 145, 195, 0)",
    },
  },
  {
    id: "airspace_e_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["other"], true, false],
      ["match", ["get", "icao_class"], ["e"], true, false],
    ],
    paint: {
      "line-color": "rgba(21, 77, 154, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 10, 2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_f_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["other"], true, false],
      ["match", ["get", "icao_class"], ["f"], true, false],
    ],
    paint: {
      "line-color": "rgba(21, 77, 154, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.2, 10, 4],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_f_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset_2x",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["other"], true, false],
      ["match", ["get", "icao_class"], ["f"], true, false],
    ],
    paint: {
      "fill-color": "rgba(118, 145, 195, 1)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.5],
      "fill-outline-color": "rgba(118, 145, 195, 0)",
    },
  },
  {
    id: "airspace_g_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["other"], true, false],
      ["match", ["get", "icao_class"], ["g"], true, false],
    ],
    paint: {
      "line-color": "rgba(21, 77, 154, 0.5)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 10, 2],
      "line-dasharray": ["literal", [5, 5]],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_g_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset_2x",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["other"], true, false],
      ["match", ["get", "icao_class"], ["g"], true, false],
    ],
    paint: {
      "fill-color": "rgba(118, 145, 195, 0.2)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.5],
      "fill-outline-color": "rgba(118, 145, 195, 0)",
    },
  },
  {
    id: "airspace_ctr_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["ctr"], true, false]],
    paint: {
      "fill-color": "rgba(218, 111, 134, 1)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.2],
      "fill-outline-color": "rgba(218, 111, 134, 0)",
    },
  },
  {
    id: "airspace_ctr_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["ctr"], true, false]],
    paint: {
      "line-color": "rgba(21, 77, 154, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 3],
      "line-dasharray": [
        "step",
        ["zoom"],
        ["literal", [3, 1]],
        3,
        ["literal", [5, 2]],
        12,
        ["literal", [12, 4]],
      ],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_tmz_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["tmz"], true, false]],
    paint: {
      "line-color": "rgba(21, 77, 154, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 8, 2, 10, 4, 14, 10],
      "line-dasharray": [
        "step",
        ["zoom"],
        ["literal", [5, 5]],
        10,
        ["literal", [10, 10]],
      ],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_tmz_border_dot",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["tmz"], true, false]],
    paint: {
      "line-color": "rgba(21, 77, 154, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 8, 2, 10, 4, 14, 10],
      "line-dasharray": [
        "step",
        ["zoom"],
        ["literal", [1.25, 2.5]],
        10,
        ["literal", [2, 5]],
      ],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_rmz_tiz_tia_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["rmz", "tiz", "tia"], true, false]],
    paint: {
      "line-color": "rgba(21, 77, 154, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 14, 2],
      "line-dasharray": ["literal", [1, 1]],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.5],
    },
  },
  {
    id: "airspace_rmz_tiz_tia_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["rmz", "tiz", "tia"], true, false]],
    paint: {
      "fill-color": "rgba(101, 134, 175, 1)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.1],
      "fill-outline-color": "rgba(101, 134, 175, 0)",
    },
  },
  {
    id: "airspace_trp_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["trp"], true, false]],
    paint: {
      "line-color": "rgba(21, 77, 154, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 8, 2, 10, 4, 14, 10],
      "line-dasharray": [
        "step",
        ["zoom"],
        ["literal", [1, 1]],
        10,
        ["literal", [2, 2]],
      ],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_tma_cta_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["tma", "cta"], true, false]],
    paint: {
      "line-color": "rgba(21, 77, 154, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 10, 2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_tma_cta_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["tma", "cta"], true, false]],
    paint: {
      "fill-color": "rgba(218, 111, 134, 1)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.2],
      "fill-outline-color": "rgba(218, 111, 134, 0)",
    },
  },
  {
    id: "airspace_fir_fis_acc_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["fir", "acc_sector", "fis_sector"], true, false],
    ],
    paint: {
      "line-color": "rgba(110, 201, 32, 0.4)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 10, 4, 11, 6],
      "line-opacity": 0.8,
      "line-dasharray": [
        "step",
        ["zoom"],
        ["literal", [5, 2.5]],
        12,
        ["literal", [10, 5]],
      ],
    },
  },
  {
    id: "airspace_uir_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["uir"], true, false]],
    paint: {
      "line-color": "rgba(91, 156, 38, 0.4)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 10, 4, 11, 6],
      "line-opacity": 0.8,
      "line-dasharray": [
        "step",
        ["zoom"],
        ["literal", [5, 2.5]],
        12,
        ["literal", [10, 5]],
      ],
    },
  },
  {
    id: "airspace_ways_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["awy"], true, false]],
    paint: {
      "line-color": "rgba(87, 87, 87, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 10, 0.5],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.2],
    },
  },
  {
    id: "airspace_ways_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["awy"], true, false]],
    paint: {
      "fill-color": "rgba(206, 206, 206, 1)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.1],
      "fill-outline-color": "rgba(206, 206, 206, 0)",
    },
  },
  {
    id: "airspace_moa_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["mtr", "mta", "mrt"], true, false]],
    paint: {
      "line-color": "rgba(255,146,0, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.3, 10, 2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.6],
      "line-dasharray": ["literal", [2, 2]],
    },
  },
  {
    id: "airspace_moa_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["mtr", "mta", "mrt"], true, false]],
    paint: {
      "fill-color": "rgb(255,146,0)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.05],
      "fill-outline-color": "rgba(255, 146, 0, 0)",
    },
  },
  {
    id: "airspace_traffic_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["matz", "atz", "htz"], true, false]],
    paint: {
      "line-color": "rgba(21, 77, 154, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 10, 0.5],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.3],
    },
  },
  {
    id: "airspace_traffic_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["matz", "atz", "htz"], true, false]],
    paint: {
      "fill-color": "rgba(21, 77, 154, 1)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.2],
      "fill-outline-color": "rgba(21, 77, 154, 0)",
    },
  },
  {
    id: "airspace_alwapro_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["alert", "warning", "protected"], true, false]],
    paint: {
      "line-color": "rgb(147,53,201)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 10, 2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.4],
      "line-dasharray": [
        "step",
        ["zoom"],
        ["literal", [3, 1]],
        3,
        ["literal", [5, 2]],
        12,
        ["literal", [12, 4]],
      ],
    },
  },
  {
    id: "airspace_alwapro_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["alert", "warning", "protected"], true, false]],
    paint: {
      "fill-color": "rgb(147,53,201)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.1],
      "fill-outline-color": "rgba(147, 53, 201, 0)",
    },
  },
  {
    id: "airspace_adiz_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["adiz"], true, false]],
    paint: {
      "line-color": "rgba(86, 0, 150, 1)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 2, 10, 4],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_adiz_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset_2x",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["adiz"], true, false]],
    paint: {
      "fill-color": "rgba(122, 0, 150, 1)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.2],
      "fill-outline-color": "rgba(142, 0, 181, 0)",
    },
  },
  {
    id: "airspace_gliding_sector_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["gliding_sector", "vfr_sector", "lta", "uta"], true, false],
    ],
    paint: {
      "line-color": "rgba(255, 215, 0, 1)",
      "line-width": 1,
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_gliding_sector_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset",
    minzoom: 3,
    filter: [
      "all",
      ["match", ["get", "type"], ["gliding_sector", "vfr_sector"], true, false],
    ],
    paint: {
      "fill-color": "rgba(255, 215, 0, 0.8)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.1],
      "fill-outline-color": "rgba(255, 215, 0, 0)",
    },
  },
  {
    id: "airspace_aerial_sporting_recreational_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["aerial_sporting_recreational"], true, false]],
    paint: {
      "line-color": "rgb(0,139,175)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 10, 2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_aerial_sporting_recreational_offset",
    type: "fill",
    sourceLayer: "airspaces_border_offset",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["aerial_sporting_recreational"], true, false]],
    paint: {
      "fill-color": "rgb(0,139,175)",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 0.2],
      "fill-outline-color": "rgba(0, 139, 175, 0)",
    },
  },
  {
    id: "airspace_overflight_restriction_border",
    type: "line",
    sourceLayer: "airspaces",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["overflight_restriction"], true, false]],
    paint: {
      "line-color": "rgb(119,21,154)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.05, 10, 3],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0, 7, 1],
    },
  },
  {
    id: "airspace_label_minimal",
    type: "symbol",
    sourceLayer: "airspaces",
    minzoom: 7,
    maxzoom: 8,
    filter: ["all"],
    layout: {
      ...AIRSPACE_LABEL_LAYOUT,
      "text-field": [
        "format",
        [
          "case",
          ["!=", ["get", "icao_class"], "unclassified"],
          ["upcase", ["get", "icao_class"]],
          ["upcase", ["get", "type"]],
        ],
      ],
      "symbol-spacing": 150,
      "text-size": ["step", ["zoom"], 6, 8, 9],
      "text-offset": [0, 0.8],
    },
    paint: AIRSPACE_LABEL_PAINT,
  },
  {
    id: "airspace_label_medium",
    type: "symbol",
    sourceLayer: "airspaces",
    minzoom: 8,
    maxzoom: 10,
    filter: ["all"],
    layout: {
      ...AIRSPACE_LABEL_LAYOUT,
      "text-field": ["get", "name_label"],
      "symbol-spacing": 550,
      "text-size": ["step", ["zoom"], 9, 10, 12],
      "text-offset": [0, 1],
    },
    paint: AIRSPACE_LABEL_PAINT,
  },
  {
    id: "airspace_label_full",
    type: "symbol",
    sourceLayer: "airspaces",
    minzoom: 10,
    filter: ["all"],
    layout: {
      ...AIRSPACE_LABEL_LAYOUT,
      "text-field": [
        "format",
        [
          "case",
          ["!=", ["get", "icao_class"], "unclassified"],
          ["upcase", ["get", "icao_class"]],
          "",
        ],
        "\n",
        ["get", "name"],
        "\n",
        AIRSPACE_LIMIT_LABEL(
          "upper_limit_reference_datum",
          "upper_limit_value",
          "upper_limit_unit"
        ),
        "\n",
        AIRSPACE_LIMIT_LABEL(
          "lower_limit_reference_datum",
          "lower_limit_value",
          "lower_limit_unit"
        ),
      ],
      "symbol-spacing": 600,
      "text-size": ["step", ["zoom"], 10, 11, 12],
      "text-offset": [0, 3.5],
    },
    paint: AIRSPACE_LABEL_PAINT,
  },
];

export const OPENAIP_VECTOR_LAYER_IDS = [
  ...AIRSPACE_LAYERS.map((layer) => layer.id),
  ...AIRPORT_LAYER_IDS,
  ...FEATURE_LAYER_IDS,
];

/** Topmost OpenAIP vector layer — used for legacy layer-order anchor. */
export const OPENAIP_AIRSPACE_LAYER = OPENAIP_VECTOR_LAYER_IDS.at(-1);
export const OPENAIP_AIRSPACE_LAYERS = OPENAIP_VECTOR_LAYER_IDS;

function addAirspaceLayer(map, layer) {
  const definition = {
    id: layer.id,
    type: layer.type,
    source: OPENAIP_SOURCE_ID,
    "source-layer": layer.sourceLayer,
    minzoom: layer.minzoom ?? 0,
    filter: layer.filter,
    layout: layer.layout ?? { visibility: "visible" },
    paint: layer.paint,
  };
  if (layer.maxzoom != null) {
    definition.maxzoom = layer.maxzoom;
  }
  map.addLayer(definition);
}

export function initOpenAipAirspaceTiles(map, config) {
  if (!openAipConfigured(config)) {
    return false;
  }

  if (map.getSource(OPENAIP_SOURCE_ID)) {
    return true;
  }

  const tiles = openAipTileUrls(config);
  if (!tiles.length) {
    return false;
  }

  map.addSource(OPENAIP_SOURCE_ID, {
    type: "vector",
    tiles,
    minzoom: 3,
    maxzoom: 14,
    attribution:
      '<a href="https://www.openaip.net" target="_blank" rel="noopener">OpenAIP</a>',
  });

  for (const layer of AIRSPACE_LAYERS) {
    addAirspaceLayer(map, layer);
  }

  addAirportLayers(map);
  addFeatureLayers(map);

  return true;
}

let removeOpenAipVectorTilesFrame = null;

export function removeOpenAipVectorTiles(map) {
  if (!map?.getSource(OPENAIP_SOURCE_ID)) {
    return;
  }

  for (const layerId of OPENAIP_VECTOR_LAYER_IDS) {
    if (map.getLayer(layerId)) {
      try {
        map.setLayoutProperty(layerId, "visibility", "none");
      } catch {
        // Style may be mid-update while toggling OpenAIP overlay.
      }
    }
  }

  if (removeOpenAipVectorTilesFrame !== null) {
    cancelAnimationFrame(removeOpenAipVectorTilesFrame);
  }

  removeOpenAipVectorTilesFrame = requestAnimationFrame(() => {
    removeOpenAipVectorTilesFrame = null;
    if (!map?.getSource(OPENAIP_SOURCE_ID)) {
      return;
    }
    for (const layerId of OPENAIP_VECTOR_LAYER_IDS) {
      if (map.getLayer(layerId)) {
        try {
          map.removeLayer(layerId);
        } catch {
          // Ignore teardown races with in-flight vector tiles.
        }
      }
    }
    try {
      map.removeSource(OPENAIP_SOURCE_ID);
    } catch {
      // Ignore teardown races with in-flight vector tiles.
    }
  });
}

export function setOpenAipAirspaceVisible(map, visible) {
  const visibility = visible ? "visible" : "none";
  for (const layerId of OPENAIP_VECTOR_LAYER_IDS) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visibility);
    }
  }
}
