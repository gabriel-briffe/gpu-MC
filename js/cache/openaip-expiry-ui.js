import {
  buildCacheBundle,
  daysUntilOpenAipExpiry,
  getDeclaredCachedCellKeys,
  shouldWarnOpenAipExpiry,
} from "../cache-area.js";
import {
  OPENAIP_EXPIRY_WARN_DAYS,
  OPENAIP_UPDATE_OK_COUNTDOWN_STEP_MS,
} from "../constants.js";

let hooks;
let app;
let closeTimers = [];

function clearCloseTimers() {
  for (const timer of closeTimers) {
    window.clearTimeout(timer);
  }
  closeTimers = [];
}

function setExpiryCellsUpdated(count) {
  const el = hooks.openAipExpiryCellsUpdatedEl;
  if (!el) {
    return;
  }
  if (count == null || count <= 0) {
    el.textContent = "";
    el.hidden = true;
    return;
  }
  el.textContent = `${count} cell${count === 1 ? "" : "s"} updated`;
  el.hidden = false;
}

function scheduleSuccessClose(cellsUpdated) {
  clearCloseTimers();
  setExpiryCellsUpdated(cellsUpdated);
  const steps = [
    "All good — this window will self-destruct in 3",
    "All good — this window will self-destruct in 2",
    "All good — this window will self-destruct in 1",
    "All good — close",
  ];
  for (let i = 0; i < steps.length; i += 1) {
    closeTimers.push(
      window.setTimeout(() => {
        setExpiryDialogStatus(steps[i]);
        if (i === steps.length - 1) {
          clearCloseTimers();
          closeOpenAipExpiryDialog();
        }
      }, OPENAIP_UPDATE_OK_COUNTDOWN_STEP_MS * i)
    );
  }
}

function renderExpiryWarnings(container, messages) {
  if (!container) {
    return;
  }
  container.replaceChildren();
  if (!messages.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const maxShown = 12;
  for (const message of messages.slice(0, maxShown)) {
    const warning = document.createElement("div");
    warning.className = "cache-data-warning";
    warning.textContent = message;
    container.append(warning);
  }
  if (messages.length > maxShown) {
    const more = document.createElement("div");
    more.className = "cache-data-warning";
    more.textContent = `…and ${messages.length - maxShown} more`;
    container.append(more);
  }
}

function setExpiryDialogStatus(text) {
  if (hooks.openAipExpiryStatusEl) {
    hooks.openAipExpiryStatusEl.textContent = text;
  }
  hooks.setStatus?.(text);
}

function syncExpiryWarnings(messages) {
  renderExpiryWarnings(hooks.openAipExpiryWarningsEl, messages);
  hooks.setCacheDataWarnings?.(messages);
}

function closeOpenAipExpiryDialog() {
  clearCloseTimers();
  if (hooks.openAipExpiryDialog) {
    hooks.openAipExpiryDialog.hidden = true;
  }
  hooks.clearCacheDataWarnings?.();
  renderExpiryWarnings(hooks.openAipExpiryWarningsEl, []);
  setExpiryCellsUpdated(null);
  setExpiryDialogStatus("");
}

function syncExpiryDialogCopy() {
  const days = daysUntilOpenAipExpiry();
  const cellCount = getDeclaredCachedCellKeys().length;
  if (hooks.openAipExpiryMessageEl) {
    const warnAdvance =
      OPENAIP_EXPIRY_WARN_DAYS === 1
        ? "1 day"
        : `${OPENAIP_EXPIRY_WARN_DAYS} days`;
    const cellLabel = `${cellCount} cached cell${cellCount === 1 ? "" : "s"}`;
    if (days === null) {
      hooks.openAipExpiryMessageEl.textContent =
        `Cached OpenAIP airport and prohibited airspace data is missing or expired. Update now to refresh from OpenAIP for your ${cellLabel}.`;
    } else {
      const expiryPhrase =
        days <= 0
          ? "will disappear automatically soon"
          : days === 1
            ? "will disappear automatically in 1 day"
            : `will disappear automatically in ${days} days`;
      hooks.openAipExpiryMessageEl.textContent =
        `Cached OpenAIP airport and prohibited airspace data ${expiryPhrase}. You are warned ${warnAdvance} in advance. Update now to refresh from OpenAIP for your ${cellLabel}.`;
    }
  }
  if (hooks.openAipExpiryUpdateBtn) {
    hooks.openAipExpiryUpdateBtn.disabled = cellCount === 0 || app.openAipExpiryUpdateInProgress;
  }
  if (hooks.openAipExpiryLaterBtn) {
    hooks.openAipExpiryLaterBtn.disabled = app.openAipExpiryUpdateInProgress;
  }
}

export function initOpenAipExpiryUi(h) {
  hooks = h;
  app = h.app;

  hooks.maybeShowOpenAipExpiryDialog = maybeShowOpenAipExpiryDialog;

  hooks.openAipExpiryLaterBtn?.addEventListener("click", closeOpenAipExpiryDialog);
  hooks.openAipExpiryDialogBackdrop?.addEventListener("click", () => {
    if (!app.openAipExpiryUpdateInProgress) {
      closeOpenAipExpiryDialog();
    }
  });
  hooks.openAipExpiryUpdateBtn?.addEventListener("click", () => {
    void runOpenAipExpiryUpdate();
  });
}

export function maybeShowOpenAipExpiryDialog() {
  if (
    app.cacheSelectMode ||
    app.openAipExpiryUpdateInProgress ||
    !hooks.areOpenAipAirportsAvailable?.() ||
    !shouldWarnOpenAipExpiry(OPENAIP_EXPIRY_WARN_DAYS)
  ) {
    return false;
  }

  const cellKeys = getDeclaredCachedCellKeys();
  if (!cellKeys.length) {
    return false;
  }

  if (hooks.openAipExpiryDialog) {
    hooks.openAipExpiryDialog.hidden = false;
  }
  renderExpiryWarnings(hooks.openAipExpiryWarningsEl, []);
  setExpiryCellsUpdated(null);
  setExpiryDialogStatus("");
  syncExpiryDialogCopy();
  return true;
}

async function runOpenAipExpiryUpdate() {
  if (app.openAipExpiryUpdateInProgress) {
    return;
  }

  const cellKeys = getDeclaredCachedCellKeys();
  if (!cellKeys.length) {
    setExpiryDialogStatus("No cached cells — use Add data first");
    return;
  }

  app.openAipExpiryUpdateInProgress = true;
  syncExpiryDialogCopy();
  const warnings = [];
  hooks.clearCacheDataWarnings?.();
  renderExpiryWarnings(hooks.openAipExpiryWarningsEl, []);
  setExpiryCellsUpdated(null);

  try {
    const result = await buildCacheBundle(
      cellKeys,
      hooks.getOpenAipConfig(),
      setExpiryDialogStatus,
      (message) => {
        warnings.push(message);
        syncExpiryWarnings(warnings);
      },
      { openAipOnly: true }
    );

    hooks.refreshCachedAirportMapLayer?.();
    hooks.refreshRestAirspaceLayerData?.();

    const allGood = result.cellsFailed === 0 && warnings.length === 0;
    if (allGood) {
      scheduleSuccessClose(result.cellsFetched);
    }
  } catch (error) {
    setExpiryDialogStatus(`Cache error: ${error.message}`);
    console.error(error);
  } finally {
    app.openAipExpiryUpdateInProgress = false;
    syncExpiryDialogCopy();
  }
}
