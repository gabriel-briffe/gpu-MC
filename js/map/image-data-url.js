/**
 * MapLibre 5.6 ImageSource.updateImage only accepts `url` (no canvas / ImageBitmap).
 * PNG via canvas.toDataURL is expensive on large grids; uncompressed BMP blobs are cheap.
 * Use BITMAPV4HEADER + BI_BITFIELDS so browsers keep alpha (BI_RGB 32 ignores it → black).
 */

const BMP_FILE_HEADER = 14;
const BMP_V4_HEADER = 108;
const BMP_PIXEL_OFFSET = BMP_FILE_HEADER + BMP_V4_HEADER; // 122
const BI_BITFIELDS = 3;
const LCS_SRGB = 0x73524742; // 'sRGB'

/** Pack ImageData as a 32-bit BGRA BMP with alpha (top-down). */
export function imageDataToBmpBlob(imageData) {
  const width = imageData.width;
  const height = imageData.height;
  const pixels = imageData.data;
  const pixelBytes = width * height * 4;
  const fileSize = BMP_PIXEL_OFFSET + pixelBytes;
  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // BITMAPFILEHEADER
  view.setUint16(0, 0x4d42, true); // "BM"
  view.setUint32(2, fileSize, true);
  view.setUint32(10, BMP_PIXEL_OFFSET, true);

  // BITMAPV4HEADER
  view.setUint32(14, BMP_V4_HEADER, true);
  view.setInt32(18, width, true);
  view.setInt32(22, -height, true); // top-down
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  view.setUint32(30, BI_BITFIELDS, true);
  view.setUint32(34, pixelBytes, true);
  // masks at 54–69
  view.setUint32(54, 0x00ff0000, true); // red
  view.setUint32(58, 0x0000ff00, true); // green
  view.setUint32(62, 0x000000ff, true); // blue
  view.setUint32(66, 0xff000000, true); // alpha
  view.setUint32(70, LCS_SRGB, true);
  // endpoints + gamma left zero (bytes 74–121)

  // BGRA from RGBA
  let dst = BMP_PIXEL_OFFSET;
  for (let i = 0; i < pixels.length; i += 4) {
    bytes[dst] = pixels[i + 2];
    bytes[dst + 1] = pixels[i + 1];
    bytes[dst + 2] = pixels[i];
    bytes[dst + 3] = pixels[i + 3];
    dst += 4;
  }

  return new Blob([buffer], { type: "image/bmp" });
}

/** Object URL for an ImageSource; revoke the previous URL when replacing. */
export function replaceImageObjectUrl(previousUrl, imageData) {
  if (previousUrl) {
    URL.revokeObjectURL(previousUrl);
  }
  return URL.createObjectURL(imageDataToBmpBlob(imageData));
}

export function revokeImageObjectUrl(url) {
  if (url) {
    URL.revokeObjectURL(url);
  }
}
