/** Resolve a site-relative asset path (works on GitHub Pages project sites). */
export function assetUrl(relativePath) {
  return new URL(relativePath, document.baseURI).href;
}
