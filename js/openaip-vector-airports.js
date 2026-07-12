import { MAP_TEXT_FONT } from "./map-fonts.js";
import { zoomInterpolate, zoomStep } from "./openaip-style-expr.js";

const OPENAIP_SOURCE_ID = "openaip";

const AIRPORT_LABEL_HALO = {
  "text-halo-color": "rgba(255, 255, 255, 1)",
  "text-halo-width": 1,
  "text-halo-blur": 0,
};

const AIRPORT_CODE_LABEL_HALO = {
  "text-halo-color": "rgba(255, 255, 255, 1)",
  "text-halo-width": 2,
  "text-halo-blur": 1,
};

const AIRPORT_LAYERS = [
  {
    id: "airport_runway",
    type: "symbol",
    sourceLayer: "airports",
    minzoom: 10,
    filter: [
      "all",
      ["match", ["get", "runway_surface"], ["paved", "unpaved"], true, false],
      [
        "match",
        ["get", "type"],
        ["ad_closed", "af_water", "heli_civil", "heli_mil", "intl_apt"],
        false,
        true,
      ],
      ["!", ["has", "icao_code"]],
    ],
    layout: {
      visibility: "visible",
      "icon-image": zoomStep("icon-image", [
        [9, "runway_{runway_surface}-small"],
        [12, "runway_{runway_surface}-medium"],
      ]),
      "icon-allow-overlap": true,
      "icon-rotate": ["get", "runway_rotation"],
      "icon-rotation-alignment": "map",
      "icon-pitch-alignment": "map",
      "icon-padding": 0,
    },
    paint: { "icon-opacity": 1 },
  },
  {
    id: "airport_parachute",
    type: "symbol",
    sourceLayer: "airports",
    minzoom: 8,
    filter: ["all", ["==", ["get", "skydive_activity"], true]],
    layout: {
      visibility: "visible",
      "icon-image": zoomStep("icon-image", [
        [8, "parachute-small"],
        [10, "parachute-large"],
      ]),
      "icon-size": 1,
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-optional": false,
      "icon-offset": zoomStep("icon-offset", [
        [8, [-20, 15]],
        [10, [-30, 20]],
        [17, [-40, 25]],
      ]),
      "icon-pitch-alignment": "map",
    },
  },
  {
    id: "airport_gliding",
    type: "symbol",
    sourceLayer: "airports",
    minzoom: 8,
    filter: [
      "all",
      ["match", ["get", "type"], ["gliding"], true, false],
      ["==", ["get", "winch_only"], false],
    ],
    layout: {
      visibility: "visible",
      "icon-image": zoomStep("icon-image", [
        [10, "{type}-small"],
        [12, "{type}-medium"],
      ]),
      "icon-pitch-alignment": "map",
      "icon-size": 1,
      "icon-allow-overlap": true,
      "symbol-avoid-edges": false,
      "symbol-placement": "point",
      "text-field": zoomStep("text-field", [
        [8, "{name_label}"],
        [10, "{name_label_full}"],
      ]),
      "text-font": MAP_TEXT_FONT,
      "text-size": zoomInterpolate([
        [8, 9],
        [12, 12],
      ]),
      "text-offset": zoomInterpolate([
        [9, [0, -3.5]],
        [10, [0, -4]],
      ]),
      "text-allow-overlap": false,
      "text-ignore-placement": true,
      "text-optional": true,
    },
    paint: {
      ...AIRPORT_LABEL_HALO,
      "icon-opacity": zoomInterpolate([
        [8, 0],
        [10, 1],
      ]),
      "text-opacity": zoomInterpolate([
        [8, 0],
        [10, 1],
      ]),
    },
  },
  {
    id: "airport_gliding_winch",
    type: "symbol",
    sourceLayer: "airports",
    minzoom: 8,
    filter: [
      "all",
      ["match", ["get", "type"], ["gliding"], true, false],
      ["==", ["get", "winch_only"], true],
    ],
    layout: {
      visibility: "visible",
      "icon-image": zoomStep("icon-image", [
        [10, "gliding_winch-small"],
        [12, "gliding_winch-medium"],
      ]),
      "icon-pitch-alignment": "map",
      "icon-size": 1,
      "icon-allow-overlap": true,
      "symbol-avoid-edges": false,
      "symbol-placement": "point",
      "text-field": zoomStep("text-field", [
        [8, "{name_label}"],
        [10, "{name_label_full}"],
      ]),
      "text-font": MAP_TEXT_FONT,
      "text-size": zoomInterpolate([
        [8, 9],
        [12, 12],
      ]),
      "text-offset": zoomInterpolate([
        [9, [0, -2.5]],
        [10, [0, -4]],
      ]),
      "text-allow-overlap": false,
      "text-ignore-placement": true,
      "text-optional": true,
    },
    paint: {
      ...AIRPORT_LABEL_HALO,
      "icon-opacity": zoomInterpolate([
        [8, 0],
        [10, 1],
      ]),
      "text-opacity": zoomInterpolate([
        [8, 0],
        [10, 1],
      ]),
    },
  },
  {
    id: "airport_other",
    type: "symbol",
    sourceLayer: "airports",
    minzoom: 8,
    filter: [
      "all",
      ["match", ["get", "type"], ["intl_apt", "gliding"], false, true],
      ["!", ["has", "icao_code"]],
    ],
    layout: {
      visibility: "visible",
      "icon-image": zoomStep("icon-image", [
        [10, "{type}-small"],
        [17, "{type}-medium"],
      ]),
      "icon-pitch-alignment": "map",
      "icon-size": 1,
      "icon-allow-overlap": true,
      "symbol-avoid-edges": false,
      "symbol-placement": "point",
      "text-field": zoomStep("text-field", [
        [8, "{name_label}"],
        [10, "{name_label_full}"],
      ]),
      "text-font": MAP_TEXT_FONT,
      "text-size": zoomInterpolate([
        [8, 9],
        [12, 12],
      ]),
      "text-offset": zoomInterpolate([
        [9, [0, -3.5]],
        [10, [0, -4]],
      ]),
      "text-allow-overlap": false,
      "text-ignore-placement": false,
      "text-optional": true,
    },
    paint: {
      ...AIRPORT_LABEL_HALO,
      "icon-opacity": zoomInterpolate([
        [8, 0],
        [10, 1],
      ]),
      "text-opacity": zoomInterpolate([
        [8, 0],
        [10, 1],
      ]),
    },
  },
  {
    id: "airport_with_code_runway",
    type: "symbol",
    sourceLayer: "airports",
    minzoom: 9,
    filter: [
      "all",
      ["match", ["get", "runway_surface"], ["paved", "unpaved"], true, false],
      [
        "match",
        ["get", "type"],
        ["ad_closed", "af_water", "heli_civil", "heli_mil", "intl_apt"],
        false,
        true,
      ],
      ["has", "icao_code"],
    ],
    layout: {
      visibility: "visible",
      "icon-image": zoomStep("icon-image", [
        [9, "runway_{runway_surface}-medium"],
        [17, "runway_{runway_surface}-large"],
      ]),
      "icon-allow-overlap": true,
      "icon-rotate": ["get", "runway_rotation"],
      "icon-rotation-alignment": "map",
      "icon-pitch-alignment": "map",
      "icon-padding": 0,
      "icon-size": zoomInterpolate([
        [9, 0.8],
        [10, 0.9],
        [15, 1],
      ]),
      "icon-optional": false,
    },
    paint: { "icon-opacity": 1 },
  },
  {
    id: "airport_with_code",
    type: "symbol",
    sourceLayer: "airports",
    minzoom: 7,
    filter: [
      "all",
      ["match", ["get", "type"], ["intl_apt"], false, true],
      ["has", "icao_code"],
    ],
    layout: {
      visibility: "visible",
      "icon-image": zoomStep("icon-image", [
        [7, "apt-dot"],
        [8, "{type}-small"],
        [9, "{type}-medium"],
        [17, "{type}-large"],
      ]),
      "icon-size": zoomInterpolate([
        [7, 0.3],
        [10, 1],
      ]),
      "icon-pitch-alignment": "map",
      "icon-allow-overlap": true,
      "text-field": zoomStep("text-field", [
        [7, "{icao_code}"],
        [9, "{name_label_full}"],
      ]),
      "text-font": MAP_TEXT_FONT,
      "text-justify": "left",
      "text-anchor": "center",
      "text-offset": zoomInterpolate([
        [7, [0, -1.5]],
        [8, [0, -2]],
        [9, [0, -4]],
        [10, [0, -4]],
      ]),
      "text-size": zoomInterpolate([
        [7, 9],
        [8, 10],
        [10, 12],
      ]),
      "text-allow-overlap": true,
      "text-padding": 2,
    },
    paint: {
      ...AIRPORT_CODE_LABEL_HALO,
      "icon-opacity": 1,
      "text-opacity": zoomInterpolate([
        [7, 0],
        [8, 1],
      ]),
    },
  },
  {
    id: "airport_runway_intl",
    type: "symbol",
    sourceLayer: "airports",
    minzoom: 8,
    filter: [
      "all",
      ["match", ["get", "runway_surface"], ["paved", "unpaved"], true, false],
      ["match", ["get", "type"], ["intl_apt"], true, false],
    ],
    layout: {
      visibility: "visible",
      "icon-image": zoomStep("icon-image", [
        [7, "runway_{runway_surface}-small"],
        [8, "runway_{runway_surface}-medium"],
        [17, "runway_{runway_surface}-large"],
      ]),
      "icon-allow-overlap": true,
      "icon-rotate": ["get", "runway_rotation"],
      "icon-pitch-alignment": "map",
      "icon-padding": 0,
      "icon-size": 1,
    },
    paint: { "icon-opacity": 1 },
  },
  {
    id: "airport_intl",
    type: "symbol",
    sourceLayer: "airports",
    minzoom: 3,
    filter: ["all", ["match", ["get", "type"], ["intl_apt"], true, false]],
    layout: {
      visibility: "visible",
      "icon-image": zoomStep("icon-image", [
        [5, "apt-dot"],
        [6, "apt-tiny"],
        [8, "apt-medium"],
      ]),
      "icon-size": zoomInterpolate([
        [3, 0.1],
        [5, 0.4],
        [8, 1],
      ]),
      "icon-pitch-alignment": "map",
      "icon-allow-overlap": true,
      "icon-optional": false,
      "text-field": zoomStep("text-field", [
        [6, "{icao_code}"],
        [8, "{name_label_full}"],
      ]),
      "text-font": MAP_TEXT_FONT,
      "text-justify": "left",
      "text-anchor": "center",
      "text-offset": zoomInterpolate([
        [7, [0, -2]],
        [8, [0, -4]],
        [10, [0, -5]],
      ]),
      "text-size": zoomInterpolate([
        [3, 0],
        [4, 5],
        [6, 12],
      ]),
      "text-allow-overlap": true,
    },
    paint: {
      ...AIRPORT_CODE_LABEL_HALO,
      "icon-opacity": 1,
      "text-opacity": zoomInterpolate([
        [3, 0],
        [4, 0.5],
        [6, 1],
      ]),
    },
  },
];

export const AIRPORT_LAYER_IDS = AIRPORT_LAYERS.map((layer) => layer.id);

function addOpenAipLayer(map, layer) {
  const definition = {
    id: layer.id,
    type: layer.type,
    source: OPENAIP_SOURCE_ID,
    "source-layer": layer.sourceLayer,
    minzoom: layer.minzoom ?? 0,
    filter: layer.filter,
    layout: layer.layout ?? { visibility: "visible" },
    paint: layer.paint ?? {},
  };
  if (layer.maxzoom != null) {
    definition.maxzoom = layer.maxzoom;
  }
  map.addLayer(definition);
}

export function addAirportLayers(map) {
  for (const layer of AIRPORT_LAYERS) {
    addOpenAipLayer(map, layer);
  }
}
