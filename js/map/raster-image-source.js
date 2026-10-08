/**
 * Georeferenced raster overlays via MapLibre ImageSource.
 * MapLibre 6+ accepts updateImage({ image }) — canvas / ImageData, no PNG/BMP round-trip.
 */

export function putImageDataOnCanvas(canvasKey, imageData, app) {
  let canvas = app[canvasKey];
  if (!canvas) {
    canvas = document.createElement("canvas");
    app[canvasKey] = canvas;
  }
  if (canvas.width !== imageData.width || canvas.height !== imageData.height) {
    canvas.width = imageData.width;
    canvas.height = imageData.height;
  }
  canvas.getContext("2d", { willReadFrequently: true }).putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Create or refresh an image source from a canvas (pixels already drawn).
 * Source may be created without a url (empty until first updateImage).
 */
export function setRasterImageSource(map, sourceId, canvas, coordinates) {
  const source = map.getSource(sourceId);
  if (source) {
    source.updateImage({ image: canvas, coordinates });
    return;
  }
  map.addSource(sourceId, {
    type: "image",
    coordinates,
  });
  map.getSource(sourceId).updateImage({ image: canvas, coordinates });
}
