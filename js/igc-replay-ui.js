import { dom } from "./dom.js";
import { fixAt, parseIgc } from "./igc-replay.js";

const SPEEDS = [1, 5, 10, 20, 50];
const SEEK_SECONDS = 5;

let hooks;
let fixes = [];
let speedIndex = 0;
let playing = false;
let seconds = 0;
let lastTick = 0;
let frame = 0;

function writeAltitude(meters) {
  const value = String(Math.round(meters));
  if (dom.emulatedAltitudeInput && dom.emulatedAltitudeInput.value !== value) {
    dom.emulatedAltitudeInput.value = value;
  }
}

function duration() {
  return fixes.length ? fixes[fixes.length - 1].t : 0;
}

function setTransportEnabled(enabled) {
  if (dom.igcSlider) {
    dom.igcSlider.hidden = !enabled;
    dom.igcSlider.disabled = !enabled;
    dom.igcSlider.max = String(Math.max(0, Math.round(duration())));
  }
  if (dom.igcPlayBtn) {
    dom.igcPlayBtn.hidden = !enabled;
    dom.igcPlayBtn.disabled = !enabled;
  }
  if (dom.igcSpeedBtn) {
    dom.igcSpeedBtn.hidden = !enabled;
    dom.igcSpeedBtn.disabled = !enabled;
  }
  if (dom.igcClearBtn) {
    dom.igcClearBtn.hidden = !enabled;
  }
}

function applyFix(second) {
  const fix = fixAt(fixes, second);
  if (!fix || !hooks?.app) {
    return;
  }
  seconds = Math.max(0, Math.min(duration(), second));
  hooks.app.simGlider = { lng: fix.lng, lat: fix.lat };
  if (Number.isFinite(fix.alt)) {
    writeAltitude(fix.alt);
  }
  if (dom.igcSlider && document.activeElement !== dom.igcSlider) {
    dom.igcSlider.value = String(Math.round(seconds));
  }
  hooks.onAutoModeAnchorMoved?.(fix.lng, fix.lat);
  hooks.updateGeoLocationPath?.();
  hooks.syncComputeContextBar?.();
  if (playing) {
    hooks.getMap?.()?.easeTo({ center: [fix.lng, fix.lat], duration: 0 });
  }
}

function stop() {
  playing = false;
  if (frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  if (dom.igcPlayBtn) {
    dom.igcPlayBtn.textContent = "Play";
    dom.igcPlayBtn.setAttribute("aria-label", "Play flight");
  }
}

function tick(now) {
  if (!playing) {
    return;
  }
  const dt = lastTick ? (now - lastTick) / 1000 : 0;
  lastTick = now;
  const next = seconds + dt * SPEEDS[speedIndex];
  if (next >= duration()) {
    applyFix(duration());
    stop();
    return;
  }
  applyFix(next);
  frame = requestAnimationFrame(tick);
}

function play() {
  if (!fixes.length || seconds >= duration()) {
    seconds = 0;
  }
  playing = true;
  lastTick = 0;
  if (dom.igcPlayBtn) {
    dom.igcPlayBtn.textContent = "Pause";
    dom.igcPlayBtn.setAttribute("aria-label", "Pause flight");
  }
  // During play: highest arrival only — drop glider→option / option→airport.
  hooks.clearOptionInspectPaths?.();
  frame = requestAnimationFrame(tick);
}

function seekBy(deltaSeconds) {
  if (!fixes.length) {
    return false;
  }
  applyFix(seconds + deltaSeconds);
  return true;
}

function togglePlayPause() {
  if (!fixes.length) {
    return false;
  }
  if (playing) {
    stop();
  } else {
    play();
  }
  return true;
}

function isTypingTarget(target) {
  if (!target || !(target instanceof Element)) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

function clearLoadedIgc() {
  stopIgcReplay();
  if (hooks?.app) {
    hooks.app.simGlider = null;
  }
  hooks?.updateGeoLocationPath?.();
  hooks?.syncComputeContextBar?.();
  hooks?.setStatus?.("IGC cleared");
}

export function isIgcReplayOn() {
  return fixes.length > 0;
}

export function isIgcPlaying() {
  return playing;
}

export function stopIgcReplay() {
  stop();
  fixes = [];
  seconds = 0;
  setTransportEnabled(false);
  if (dom.igcSlider) {
    dom.igcSlider.value = "0";
  }
  if (dom.igcSpeedBtn) {
    speedIndex = 0;
    dom.igcSpeedBtn.textContent = "1x";
  }
}

export function syncIgcReplayBar(sim) {
  if (dom.simReplayEl) {
    dom.simReplayEl.hidden = !sim;
  }
  if (!sim) {
    stop();
  }
}

export function initIgcReplay(h) {
  hooks = h;
  setTransportEnabled(false);
  dom.igcBtn?.addEventListener("click", () => {
    dom.igcFileInput?.click();
  });
  dom.igcClearBtn?.addEventListener("click", () => {
    clearLoadedIgc();
  });
  dom.igcFileInput?.addEventListener("change", async () => {
    const file = dom.igcFileInput.files?.[0];
    dom.igcFileInput.value = "";
    if (!file) {
      return;
    }
    const text = await file.text();
    const parsed = parseIgc(text);
    if (!parsed.length) {
      hooks.setStatus?.("No fixes in that IGC file");
      return;
    }
    stop();
    fixes = parsed;
    seconds = 0;
    setTransportEnabled(true);
    applyFix(0);
    hooks.setStatus?.(`IGC loaded, ${fixes.length} fixes`);
  });
  dom.igcSlider?.addEventListener("input", () => {
    if (!fixes.length) {
      return;
    }
    applyFix(Number(dom.igcSlider.value));
  });
  dom.igcPlayBtn?.addEventListener("click", () => {
    togglePlayPause();
  });
  dom.igcSpeedBtn?.addEventListener("click", () => {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    if (dom.igcSpeedBtn) {
      dom.igcSpeedBtn.textContent = `${SPEEDS[speedIndex]}x`;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (isTypingTarget(event.target)) {
      return;
    }
    if (!fixes.length || dom.simReplayEl?.hidden) {
      return;
    }
    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      togglePlayPause();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekBy(-SEEK_SECONDS);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      seekBy(SEEK_SECONDS);
    }
  });
}
