export const USER_LOCATION_SOURCE_ID = "user-location";
export const USER_LOCATION_WEDGE_LAYER_ID = "user-location-wedge";
export const USER_LOCATION_ICON_ID = "user-location-wedge-icon";

/** Default wedge heading when stationary (degrees, north-up). */
const TRACK_NORTH_DEG = 0;

let lastPosition = null;
let currentTrack = TRACK_NORTH_DEG;
let markerVisible = false;

function bearingDegrees(lng1, lat1, lng2, lat2) {
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/** Static wedge pointing north — rotated at render time via icon-rotate. */
export function createUserLocationWedgeImageData() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.translate(size / 2, size / 2);

  const triangleHeight = size * 0.7;
  const triangleWidth = triangleHeight * 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -triangleHeight / 2);
  ctx.lineTo(triangleWidth / 2, triangleHeight / 2);
  ctx.lineTo(-triangleWidth / 2, triangleHeight / 2);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, -triangleHeight / 2, 0, triangleHeight / 2);
  gradient.addColorStop(0, "#4a90e2");
  gradient.addColorStop(1, "#0066FF");
  ctx.fillStyle = gradient;
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;
  ctx.fill();
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}

function ensureUserLocationIcon(map) {
  if (map.hasImage(USER_LOCATION_ICON_ID)) {
    return;
  }
  map.addImage(USER_LOCATION_ICON_ID, createUserLocationWedgeImageData(), {
    pixelRatio: 1,
  });
}

export function ensureUserLocationLayers(map, onLayersAdded) {
  if (!map || map.getSource(USER_LOCATION_SOURCE_ID)) {
    return;
  }
  ensureUserLocationIcon(map);
  map.addSource(USER_LOCATION_SOURCE_ID, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: USER_LOCATION_WEDGE_LAYER_ID,
    type: "symbol",
    source: USER_LOCATION_SOURCE_ID,
    layout: {
      "icon-image": USER_LOCATION_ICON_ID,
      "icon-size": 0.7,
      "icon-rotate": ["get", "track"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      visibility: "none",
    },
    paint: {
      "icon-opacity": 1,
    },
  });
  onLayersAdded?.();
}

function syncUserLocationMarkerData(map, lng, lat) {
  map.getSource(USER_LOCATION_SOURCE_ID).setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { track: currentTrack },
        geometry: { type: "Point", coordinates: [lng, lat] },
      },
    ],
  });
}

export function setUserLocationMarkerVisible(map, visible) {
  markerVisible = visible;
  if (!map?.getLayer(USER_LOCATION_WEDGE_LAYER_ID)) {
    return;
  }
  map.setLayoutProperty(
    USER_LOCATION_WEDGE_LAYER_ID,
    "visibility",
    visible ? "visible" : "none"
  );
  if (!visible) {
    map.getSource(USER_LOCATION_SOURCE_ID)?.setData({
      type: "FeatureCollection",
      features: [],
    });
  }
}

export function resetUserLocationTrack() {
  lastPosition = null;
  currentTrack = TRACK_NORTH_DEG;
}

export function updateUserLocationFromPosition(map, lng, lat) {
  if (!map || !markerVisible) {
    return;
  }
  ensureUserLocationLayers(map);
  setUserLocationMarkerVisible(map, true);

  if (
    lastPosition &&
    (lastPosition.lng !== lng || lastPosition.lat !== lat)
  ) {
    currentTrack = bearingDegrees(lastPosition.lng, lastPosition.lat, lng, lat);
  } else {
    currentTrack = TRACK_NORTH_DEG;
  }

  lastPosition = { lng, lat };
  syncUserLocationMarkerData(map, lng, lat);
}
