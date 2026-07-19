/**
 * Short click vs long press (or context menu) on a pointer target.
 * Long press fires as soon as the threshold elapses; short fires on pointerup
 * only if the long press did not already fire.
 */
export function bindLongPress(element, { onShort, onLong, thresholdMs = 500 }) {
  if (!element) {
    return;
  }

  let timer = null;
  let longPressed = false;
  let startX = 0;
  let startY = 0;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = null;
  };

  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    longPressed = false;
    startX = event.clientX;
    startY = event.clientY;
    clearTimer();
    timer = setTimeout(() => {
      longPressed = true;
      onLong?.();
    }, thresholdMs);
  });

  element.addEventListener("pointermove", (event) => {
    if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) {
      clearTimer();
    }
  });

  element.addEventListener("pointerup", () => {
    clearTimer();
    if (!longPressed) {
      onShort?.();
    }
  });

  element.addEventListener("pointercancel", clearTimer);
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    clearTimer();
    longPressed = true;
    onLong?.();
  });
}
