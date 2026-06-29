const GCS_BASE =
  "https://storage.googleapis.com/29f98e10-a489-4c82-ae5e-489dbcd4912f";
const PROXY_URL = "https://edl-proxy.gabriel-briffe.workers.dev/?url=";

export const AIRPORT_COUNTRIES = [
  { code: "at", name: "Austria" },
  { code: "be", name: "Belgium" },
  { code: "bg", name: "Bulgaria" },
  { code: "ch", name: "Switzerland" },
  { code: "cy", name: "Cyprus" },
  { code: "cz", name: "Czech Republic" },
  { code: "de", name: "Germany" },
  { code: "dk", name: "Denmark" },
  { code: "ee", name: "Estonia" },
  { code: "es", name: "Spain" },
  { code: "fi", name: "Finland" },
  { code: "fr", name: "France" },
  { code: "gb", name: "United Kingdom" },
  { code: "gr", name: "Greece" },
  { code: "hr", name: "Croatia" },
  { code: "hu", name: "Hungary" },
  { code: "ie", name: "Ireland" },
  { code: "it", name: "Italy" },
  { code: "lt", name: "Lithuania" },
  { code: "lu", name: "Luxembourg" },
  { code: "lv", name: "Latvia" },
  { code: "mt", name: "Malta" },
  { code: "nl", name: "Netherlands" },
  { code: "no", name: "Norway" },
  { code: "pl", name: "Poland" },
  { code: "pt", name: "Portugal" },
  { code: "ro", name: "Romania" },
  { code: "se", name: "Sweden" },
  { code: "si", name: "Slovenia" },
  { code: "sk", name: "Slovakia" },
];

const EMPTY_COLLECTION = {
  type: "FeatureCollection",
  features: [],
};

// OpenAIP airport type codes: 4 = Heliport Military, 7 = Heliport Civil
const HELIPORT_TYPES = new Set([4, 7]);

function withoutHeliports(features) {
  return features.filter((feature) => !HELIPORT_TYPES.has(feature.properties?.type));
}

function airportDataUrl(countryCode) {
  return `${GCS_BASE}/${countryCode}_apt.geojson`;
}

async function fetchCountryAirports(countryCode) {
  const sourceUrl = airportDataUrl(countryCode);
  const response = await fetch(`${PROXY_URL}${encodeURIComponent(sourceUrl)}`);
  if (!response.ok) {
    throw new Error(`${countryCode.toUpperCase()}: HTTP ${response.status}`);
  }

  const geojson = await response.json();
  if (!Array.isArray(geojson?.features)) {
    throw new Error(`${countryCode.toUpperCase()}: invalid GeoJSON`);
  }

  return geojson;
}

export async function loadAirportsForCountries(countryCodes, onStatus = () => {}) {
  if (countryCodes.length === 0) {
    throw new Error("Select at least one country");
  }

  const combined = {
    type: "FeatureCollection",
    features: [],
  };

  for (const countryCode of countryCodes) {
    const country = AIRPORT_COUNTRIES.find((entry) => entry.code === countryCode);
    onStatus(`Loading ${country?.name ?? countryCode.toUpperCase()}…`);

    try {
      const geojson = await fetchCountryAirports(countryCode);
      combined.features.push(...withoutHeliports(geojson.features));
    } catch (error) {
      console.warn(error);
      onStatus(`Skipped ${country?.name ?? countryCode}: ${error.message}`);
    }
  }

  if (combined.features.length === 0) {
    throw new Error("No airport data loaded");
  }

  return combined;
}

export function ensureAirportLayers(map) {
  if (map.getSource("airports")) {
    return;
  }

  map.addSource("airports", {
    type: "geojson",
    data: EMPTY_COLLECTION,
  });

  map.addLayer({
    id: "airports-dots",
    type: "circle",
    source: "airports",
    minzoom: 7,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 2, 12, 5],
      "circle-color": "#bf2d2d",
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff",
    },
  });

  map.addLayer({
    id: "airports-labels",
    type: "symbol",
    source: "airports",
    minzoom: 9,
    layout: {
      "text-field": ["coalesce", ["get", "icaoCode"], ["get", "name"]],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-offset": [0, -1.2],
      "text-anchor": "bottom",
      "text-max-width": 12,
    },
    paint: {
      "text-color": "#f5f7fa",
      "text-halo-color": "rgba(18, 22, 28, 0.92)",
      "text-halo-width": 2,
    },
  });
}

export function setAirportData(map, geojson) {
  ensureAirportLayers(map);
  map.getSource("airports").setData(geojson);
}

export function clearAirportData(map) {
  if (!map.getSource("airports")) {
    return;
  }
  map.getSource("airports").setData(EMPTY_COLLECTION);
}

function getSelectedCountryCodes(root) {
  return [...root.querySelectorAll('input[type="checkbox"][data-country]:checked')].map(
    (input) => input.dataset.country
  );
}

function setAllCountries(root, checked) {
  root.querySelectorAll('input[type="checkbox"][data-country]').forEach((input) => {
    input.checked = checked;
  });
}

export function initAirportsPanel(map, { onStatus = () => {} } = {}) {
  const panel = document.getElementById("airports-panel");
  const countryGrid = document.getElementById("airports-countries");
  const loadBtn = document.getElementById("airports-load");
  const clearBtn = document.getElementById("airports-clear");
  const selectAllBtn = document.getElementById("airports-select-all");
  const selectNoneBtn = document.getElementById("airports-select-none");

  if (!panel || !countryGrid || !loadBtn || !clearBtn) {
    return;
  }

  for (const country of AIRPORT_COUNTRIES) {
    const label = document.createElement("label");
    label.className = "airport-country";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.country = country.code;
    checkbox.checked = country.code === "ch";

    const text = document.createElement("span");
    text.textContent = country.name;

    label.append(checkbox, text);
    countryGrid.append(label);
  }

  selectAllBtn?.addEventListener("click", () => {
    setAllCountries(countryGrid, true);
  });

  selectNoneBtn?.addEventListener("click", () => {
    setAllCountries(countryGrid, false);
  });

  loadBtn.addEventListener("click", async () => {
    const selected = getSelectedCountryCodes(countryGrid);
    loadBtn.disabled = true;
    clearBtn.disabled = true;

    try {
      const geojson = await loadAirportsForCountries(selected, onStatus);
      setAirportData(map, geojson);
      onStatus(`Loaded ${geojson.features.length} airports`);
    } catch (error) {
      onStatus(`Airports: ${error.message}`);
      console.error(error);
    } finally {
      loadBtn.disabled = false;
      clearBtn.disabled = false;
    }
  });

  clearBtn.addEventListener("click", () => {
    clearAirportData(map);
    onStatus("Airports cleared");
  });

  if (map.loaded()) {
    ensureAirportLayers(map);
  } else {
    map.on("load", () => {
      ensureAirportLayers(map);
    });
  }
}
