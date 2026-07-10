let activeLock = null;

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) {
    return;
  }
  try {
    if (activeLock && !activeLock.released) {
      return;
    }
    activeLock = await navigator.wakeLock.request("screen");
    activeLock.addEventListener("release", () => {
      activeLock = null;
    });
  } catch {
    // Ignored — unsupported, denied, or low-power mode.
  }
}

function releaseWakeLock() {
  if (!activeLock) {
    return;
  }
  void activeLock.release();
  activeLock = null;
}

export function initWakeLock() {
  if (!("wakeLock" in navigator)) {
    return;
  }

  const syncWakeLock = () => {
    if (document.visibilityState === "visible") {
      void requestWakeLock();
    } else {
      releaseWakeLock();
    }
  };

  syncWakeLock();
  document.addEventListener("visibilitychange", syncWakeLock);
  window.addEventListener("pagehide", releaseWakeLock);
}
