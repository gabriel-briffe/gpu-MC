export function formatCacheBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 MB";
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDaysUntilExpiry(days) {
  if (days == null) {
    return "no data cached";
  }
  if (days <= 0) {
    return "expires soon";
  }
  if (days === 1) {
    return "will disappear in 1 day";
  }
  return `will disappear in ${days} days`;
}
