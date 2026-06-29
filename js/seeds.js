const SEED_COLORS = [
  "#ff6b6b",
  "#4ecdc4",
  "#ffe66d",
  "#a78bfa",
  "#fb923c",
  "#38bdf8",
  "#f472b6",
  "#34d399",
];

const EMPTY_COLLECTION = {
  type: "FeatureCollection",
  features: [],
};

let seeds = [];
let nextSeedId = 1;
let mapRef = null;

function seedColor(index) {
  return SEED_COLORS[index % SEED_COLORS.length];
}

function seedsToGeoJson() {
  return {
    type: "FeatureCollection",
    features: seeds.map((seed, index) => ({
      type: "Feature",
      id: seed.id,
      properties: {
        index: index + 1,
        color: seedColor(index),
      },
      geometry: {
        type: "Point",
        coordinates: [seed.lng, seed.lat],
      },
    })),
  };
}

export function getPendingSeeds() {
  return seeds.map((seed) => ({ lng: seed.lng, lat: seed.lat }));
}

export function getPendingSeedCount() {
  return seeds.length;
}

export function clearPendingSeeds() {
  seeds = [];
  refreshSeedMarkers();
}

export function addPendingSeed(lng, lat) {
  const seed = { id: nextSeedId, lng, lat };
  nextSeedId += 1;
  seeds.push(seed);
  refreshSeedMarkers();
  return seed;
}

export function removeLastPendingSeed() {
  if (seeds.length === 0) {
    return false;
  }
  seeds.pop();
  refreshSeedMarkers();
  return true;
}

function refreshSeedMarkers() {
  if (!mapRef?.getSource("seed-markers")) {
    return;
  }
  mapRef.getSource("seed-markers").setData(seedsToGeoJson());
}

export function ensureSeedLayers(map) {
  if (map.getSource("seed-markers")) {
    return;
  }

  map.addSource("seed-markers", {
    type: "geojson",
    data: EMPTY_COLLECTION,
  });

  map.addLayer({
    id: "seed-markers-halo",
    type: "circle",
    source: "seed-markers",
    paint: {
      "circle-radius": 12,
      "circle-color": ["get", "color"],
      "circle-opacity": 0.25,
      "circle-stroke-width": 0,
    },
  });

  map.addLayer({
    id: "seed-markers-dot",
    type: "circle",
    source: "seed-markers",
    paint: {
      "circle-radius": 7,
      "circle-color": ["get", "color"],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });

  map.addLayer({
    id: "seed-markers-label",
    type: "symbol",
    source: "seed-markers",
    layout: {
      "text-field": ["to-string", ["get", "index"]],
      "text-size": 11,
      "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
    },
    paint: {
      "text-color": "#12161c",
    },
  });
}

export function initSeeds(map) {
  mapRef = map;
  if (map.loaded()) {
    ensureSeedLayers(map);
    refreshSeedMarkers();
  } else {
    map.on("load", () => {
      ensureSeedLayers(map);
      refreshSeedMarkers();
    });
  }
}
