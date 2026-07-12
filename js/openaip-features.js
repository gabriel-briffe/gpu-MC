import { MAP_TEXT_FONT } from "./map-fonts.js";
import { zoomStep } from "./openaip-style-expr.js";

const OPENAIP_SOURCE_ID = "openaip";

const FEATURE_LABEL_PAINT = {
  "text-color": "rgba(0, 0, 0, 1)",
  "text-halo-color": "rgba(255, 255, 255, 1)",
  "text-halo-width": 2,
  "text-halo-blur": 1,
};

/** Tile type `on_request` maps to sprite id `reporting_point_request-medium`. */
const REPORTING_POINT_ICON = [
  "step",
  ["zoom"],
  [
    "concat",
    "reporting_point_",
    [
      "case",
      ["==", ["get", "type"], "on_request"],
      "request",
      ["get", "type"],
    ],
    "-medium",
  ],
  11,
  [
    "concat",
    "reporting_point_",
    [
      "case",
      ["==", ["get", "type"], "on_request"],
      "request",
      ["get", "type"],
    ],
    "-medium",
  ],
];

const FEATURE_LAYERS = [
  {
    id: "obstacle",
    type: "symbol",
    sourceLayer: "obstacles",
    minzoom: 11,
    filter: ["all"],
    layout: {
      visibility: "visible",
      "icon-image": zoomStep("icon-image", [[11, "obstacle_{type}"]]),
      "icon-pitch-alignment": "map",
      "icon-allow-overlap": true,
      "text-field": zoomStep("text-field", [
        [10, "{name_label}"],
        [13, "{name_label_full}"],
      ]),
      "text-font": MAP_TEXT_FONT,
      "text-size": 11,
      "text-offset": zoomStep("text-offset", [[11, [0, 2.5]]]),
      "text-allow-overlap": false,
    },
    paint: FEATURE_LABEL_PAINT,
  },
  {
    id: "reporting_point",
    type: "symbol",
    sourceLayer: "reporting_points",
    minzoom: 10,
    filter: ["all"],
    layout: {
      visibility: "visible",
      "icon-image": REPORTING_POINT_ICON,
      "icon-pitch-alignment": "map",
      "icon-allow-overlap": true,
      "text-field": zoomStep("text-field", [[11, "{name}"]]),
      "text-font": MAP_TEXT_FONT,
      "text-size": 12,
      "text-offset": zoomStep("text-offset", [[11, [0, 2.5]]]),
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: FEATURE_LABEL_PAINT,
  },
];

export const FEATURE_LAYER_IDS = FEATURE_LAYERS.map((layer) => layer.id);

function addOpenAipLayer(map, layer) {
  map.addLayer({
    id: layer.id,
    type: layer.type,
    source: OPENAIP_SOURCE_ID,
    "source-layer": layer.sourceLayer,
    minzoom: layer.minzoom ?? 0,
    filter: layer.filter,
    layout: layer.layout ?? { visibility: "visible" },
    paint: layer.paint ?? {},
  });
}

export function addFeatureLayers(map) {
  for (const layer of FEATURE_LAYERS) {
    addOpenAipLayer(map, layer);
  }
}
