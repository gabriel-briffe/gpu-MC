/** First wait after a 429. Doubles on each following 429 in the same fetch. */
export const OPENAIP_429_INITIAL_WAIT_MS = 3000;

export function formatOpenAip429WaitLabel(ms) {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

export function isOpenAip429Error(error) {
  return error?.status === 429;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared 429 backoff for OpenAIP cell fetches.
 * On success, the next 429 starts at the last wait used (previous step), then doubles again.
 */
export function createOpenAip429Backoff({ sleep } = {}) {
  const sleepFn = sleep ?? defaultSleep;
  let nextWaitMs = OPENAIP_429_INITIAL_WAIT_MS;

  return {
    get nextWaitMs() {
      return nextWaitMs;
    },

    async waitAfter429(onStatus, statusPrefix = "") {
      const waitMs = nextWaitMs;
      onStatus?.(
        `${statusPrefix}rate limited (429) — waiting ${formatOpenAip429WaitLabel(waitMs)}…`
      );
      await sleepFn(waitMs);
      nextWaitMs = waitMs * 2;
    },

    noteSuccess() {
      nextWaitMs = Math.max(OPENAIP_429_INITIAL_WAIT_MS, nextWaitMs / 2);
    },
  };
}

/**
 * Retry `run` after 429s instead of moving on. Rate limit is time-based, not per cell.
 */
export async function retryOpenAipFetchOn429(
  run,
  backoff,
  onStatus,
  statusPrefix,
  { on429 } = {}
) {
  while (true) {
    try {
      const result = await run();
      backoff.noteSuccess();
      return result;
    } catch (error) {
      if (!isOpenAip429Error(error)) {
        throw error;
      }
      on429?.(error);
      await backoff.waitAfter429(onStatus, statusPrefix);
    }
  }
}
