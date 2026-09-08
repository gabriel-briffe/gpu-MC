import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPENAIP_429_INITIAL_WAIT_MS,
  createOpenAip429Backoff,
  formatOpenAip429WaitLabel,
  retryOpenAipFetchOn429,
} from "./openaip-429-backoff.js";

function rateLimitError() {
  const error = new Error("OpenAIP airports 429");
  error.status = 429;
  error.proxy = { hits: 0, missesOk: 0, misses429: 1, missesOther: 0 };
  return error;
}

test("wait labels are whole seconds", () => {
  assert.equal(formatOpenAip429WaitLabel(3000), "3s");
  assert.equal(formatOpenAip429WaitLabel(6000), "6s");
  assert.equal(formatOpenAip429WaitLabel(12000), "12s");
});

test("first 429 waits 3s then doubles; success uses previous step for the next cell", async () => {
  const sleeps = [];
  const statuses = [];
  const backoff = createOpenAip429Backoff({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(backoff.nextWaitMs, OPENAIP_429_INITIAL_WAIT_MS);

  await backoff.waitAfter429((text) => statuses.push(text), "Airports 1/2: ");
  assert.deepEqual(sleeps, [3000]);
  assert.equal(backoff.nextWaitMs, 6000);
  assert.equal(statuses.at(-1), "Airports 1/2: rate limited (429) — waiting 3s…");

  await backoff.waitAfter429((text) => statuses.push(text), "Airports 1/2: ");
  assert.deepEqual(sleeps, [3000, 6000]);
  assert.equal(backoff.nextWaitMs, 12000);
  assert.equal(statuses.at(-1), "Airports 1/2: rate limited (429) — waiting 6s…");

  backoff.noteSuccess();
  assert.equal(backoff.nextWaitMs, 6000);

  await backoff.waitAfter429((text) => statuses.push(text), "Airports 2/2: ");
  assert.deepEqual(sleeps, [3000, 6000, 6000]);
  assert.equal(backoff.nextWaitMs, 12000);
  assert.equal(statuses.at(-1), "Airports 2/2: rate limited (429) — waiting 6s…");

  backoff.noteSuccess();
  assert.equal(backoff.nextWaitMs, 6000);
});

test("retryOpenAipFetchOn429 retries the same fetch and does not skip", async () => {
  const sleeps = [];
  const backoff = createOpenAip429Backoff({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const attempts = [];
  const statuses = [];
  const rateLimits = [];

  const result = await retryOpenAipFetchOn429(
    async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length < 3) {
        throw rateLimitError();
      }
      return { airports: [1], proxy: { missesOk: 1 } };
    },
    backoff,
    (text) => statuses.push(text),
    "Airports 1/2: ",
    { on429: (error) => rateLimits.push(error.status) }
  );

  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(sleeps, [3000, 6000]);
  assert.deepEqual(rateLimits, [429, 429]);
  assert.deepEqual(result.airports, [1]);
  assert.equal(backoff.nextWaitMs, 6000);
  assert.deepEqual(statuses, [
    "Airports 1/2: rate limited (429) — waiting 3s…",
    "Airports 1/2: rate limited (429) — waiting 6s…",
  ]);
});

test("next cell starts from previous wait and doubles from there", async () => {
  const sleeps = [];
  const backoff = createOpenAip429Backoff({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  await retryOpenAipFetchOn429(
    async () => {
      if (sleeps.length < 2) {
        throw rateLimitError();
      }
      return { ok: true };
    },
    backoff,
    () => {},
    ""
  );
  assert.deepEqual(sleeps, [3000, 6000]);
  assert.equal(backoff.nextWaitMs, 6000);

  await retryOpenAipFetchOn429(
    async () => {
      if (sleeps.length < 4) {
        throw rateLimitError();
      }
      return { ok: true };
    },
    backoff,
    () => {},
    ""
  );
  assert.deepEqual(sleeps, [3000, 6000, 6000, 12000]);
  assert.equal(backoff.nextWaitMs, 12000);
});

test("non-429 errors are not retried", async () => {
  const backoff = createOpenAip429Backoff({ sleep: async () => {} });
  const error = new Error("OpenAIP airports 500");
  error.status = 500;

  await assert.rejects(
    () => retryOpenAipFetchOn429(async () => {
      throw error;
    }, backoff, () => {}, ""),
    (caught) => caught.status === 500
  );
  assert.equal(backoff.nextWaitMs, OPENAIP_429_INITIAL_WAIT_MS);
});
